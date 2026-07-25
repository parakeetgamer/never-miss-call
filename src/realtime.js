// realtime.js
// Bridges ONE phone call: Twilio Media Stream (G.711 μ-law, 8kHz) <-> OpenAI
// Realtime API (speech-to-speech). Handles audio in both directions, barge-in
// interruptions, and function/tool calls (book_job / take_message / end_call).

import WebSocket from "ws";
import twilio from "twilio";
import { buildInstructions, tools } from "./agent.js";
import { saveLead } from "./db.js";
import { notifyOwner } from "./sms.js";

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";

// After the goodbye finishes generating, wait this long so the audio Twilio
// has buffered actually finishes playing before we cut the line.
const GOODBYE_FLUSH_MS = 2500;
// Absolute backstop: hang up this long after end_call even if the goodbye
// never completes (model error, caller silence, etc).
const HANGUP_MAX_MS = 15000;

// Twilio REST client (for definitively hanging up a call by its SID).
const twilioRest =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

// ---- turn detection (how fast the bot decides you're done talking) ----
// server_vad replies a fixed moment after you go quiet — snappy and predictable.
// semantic_vad waits until your sentence sounds finished — more polite, slower.
// Tune without redeploying:  VAD_MODE=server_vad|semantic_vad
//                            VAD_SILENCE_MS=450   (server_vad: lower = faster)
//                            VAD_EAGERNESS=high   (semantic_vad only)
function buildTurnDetection() {
  const mode = process.env.VAD_MODE || "server_vad";
  if (mode === "semantic_vad") {
    return {
      type: "semantic_vad",
      eagerness: process.env.VAD_EAGERNESS || "high",
      interrupt_response: true,
    };
  }
  const ms = Number(process.env.VAD_SILENCE_MS || 620);
  const threshold = Number(process.env.VAD_THRESHOLD || 0.6);
  return {
    type: "server_vad",
    silence_duration_ms: Number.isFinite(ms) ? ms : 620,
    prefix_padding_ms: 250,
    // Higher threshold = less likely to mistake background noise (or the echo
    // of our own voice) for the caller speaking. Too low and the bot keeps
    // interrupting itself, which shreds the conversation.
    threshold: Number.isFinite(threshold) ? threshold : 0.6,
    interrupt_response: true,
  };
}

/**
 * Build the session.update payload for the chosen API mode.
 */
function buildSessionUpdate(biz, { mode, voice }) {
  const instructions = buildInstructions(biz);

  if (mode === "beta") {
    return {
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        instructions,
        voice,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        // Longer pause tolerance so mid-sentence gaps (reading off a phone
        // number, thinking of an address) don't get mistaken for "done talking".
        turn_detection: buildTurnDetection(),
        // Hard cap so the model physically cannot chain several questions (or
        // a whole mini-script) into one uninterrupted turn — it's forced to
        // stop short and hand the turn back to the caller. Generous enough to
        // never clip a normal reply or a tool call's arguments; only kicks in
        // on a genuine multi-question run-on.
        max_response_output_tokens: 600,
        tools,
        tool_choice: "auto",
      },
    };
  }

  return {
    type: "session.update",
    session: {
      type: "realtime",
      output_modalities: ["audio"],
      instructions,
      // Hard cap so the model physically cannot chain several questions (or
      // a whole mini-script) into one uninterrupted turn — it's forced to
      // stop short and hand the turn back to the caller. Generous enough to
      // never clip a normal reply or a tool call's arguments; only kicks in
      // on a genuine multi-question run-on.
      max_output_tokens: 600,
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          // Phone lines are noisy; without this the VAD fires on background
          // sound and the bot talks over itself. near_field = handset,
          // far_field = speakerphone/room. Set NOISE_REDUCTION=off to remove
          // the field entirely if the API ever rejects it (a rejected
          // session.update means SILENT calls, so this is the escape hatch).
          ...(process.env.NOISE_REDUCTION === "off"
            ? {}
            : { noise_reduction: { type: process.env.NOISE_REDUCTION || "near_field" } }),
          // semantic_vad waits for the caller to actually finish a thought
          // instead of a fixed silence timer, so it stops cutting people off
          // mid-sentence. Eagerness sets the MAX wait before deciding they're
          // done: low=8s, medium=4s, high=2s. "low" left painful dead air
          // after short answers like a bare name, so "medium" — barge-in
          // handling (cancel+truncate) covers us if it ever jumps in early.
          turn_detection: buildTurnDetection(),
        },
        output: {
          format: { type: "audio/pcmu" },
          voice,
        },
      },
      tools,
      tool_choice: "auto",
    },
  };
}

/**
 * Start the bridge for a single call.
 */
export function startCallBridge(twilioWs, biz, env, initialMsg) {
  let streamSid = null;
  let callSid = null;
  let callerNumber = null;
  let openAiReady = false;
  let greeted = false;          // ensure we greet only once
  let responseActive = false;   // is a model response currently being generated?
  let pendingResponse = false;  // a response was requested while one was active
  let activeResponseId = null;  // id of the response currently generating/playing
  let activeItemId = null;      // id of the assistant message item streaming audio
  let playedAudioMs = 0;        // ms of that item's audio actually sent to the caller
  let leadBooked = false;       // has a job/message been saved this call yet?
  let pendingHangup = false;    // end_call approved — a goodbye is owed
  let goodbyeStarted = false;   // has the goodbye response actually been fired?
  let responseAudioMs = 0;      // ms of audio generated for the current response
  let responseFirstAudioAt = 0; // when the first audio chunk of it was sent
  let haveName = false;         // captured caller's name?
  let haveNumber = false;       // captured callback number?
  let haveSituation = false;    // captured the problem/reason?
  let haveAddress = false;      // captured a service address?
  let bookedJob = false;        // was this a job (needs an address) vs a message?
  const audioQueue = [];

  // Treat blanks and filler like "Unknown" / "N/A" as NOT captured.
  const present = (v) =>
    v != null &&
    String(v).trim().length > 0 &&
    !/^(unknown|n\/?a|none|not provided|no name( given)?|tbd)$/i.test(String(v).trim());

  // Ask the model to speak — but only if it isn't already speaking. If a
  // response is in flight, remember to trigger one as soon as it finishes.
  // This prevents the "conversation_already_has_active_response" error that
  // wedges the call.
  function requestResponse() {
    if (responseActive) {
      pendingResponse = true;
    } else {
      responseActive = true;
      openAi.send(JSON.stringify({ type: "response.create" }));
    }
  }

  // Fire the closing line. Called once the line is free — a tool call happens
  // INSIDE an active response, so we can't just ask for a new one immediately.
  function startGoodbye() {
    if (goodbyeStarted) return;
    goodbyeStarted = true;
    responseActive = true;
    openAi.send(JSON.stringify({ type: "response.create" }));
  }

  const openAi = new WebSocket(
    `${OPENAI_REALTIME_URL}?model=${encodeURIComponent(env.model)}`,
    {
      headers: { Authorization: `Bearer ${env.apiKey}` },
      ...(env.mode === "beta"
        ? { headers: { Authorization: `Bearer ${env.apiKey}`, "OpenAI-Beta": "realtime=v1" } }
        : {}),
    }
  );

  // ---- OpenAI -> us ----
  openAi.on("open", () => {
    openAi.send(JSON.stringify(buildSessionUpdate(biz, env)));
  });

  openAi.on("message", async (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (evt.type) {
      case "session.created":
        // The session exists but OUR config (μ-law audio, VAD, tools) has not
        // been confirmed yet. Do NOT greet or forward audio here: speaking now
        // would use the default 24kHz PCM format, which comes out of the phone
        // as pure static. Wait for session.updated below.
        break;

      case "session.updated": {
        const outFmt =
          evt.session?.audio?.output?.format?.type || // GA shape
          evt.session?.output_audio_format ||          // beta shape
          "unknown";
        console.log(`[openai] session config confirmed (output format: ${outFmt})`);
        openAiReady = true;
        // Greet FIRST, before processing any caller audio. If we flushed queued
        // audio first, the initial line noise could trip voice-detection into
        // auto-starting a response, which then collides with the greeting and
        // wedges the call. Greeting first avoids that race entirely.
        if (!greeted) {
          greeted = true;
          audioQueue.length = 0; // drop pre-greeting noise from the pickup moment
          requestResponse();     // kick off the greeting exactly once
        } else {
          while (audioQueue.length) {
            openAi.send(
              JSON.stringify({ type: "input_audio_buffer.append", audio: audioQueue.shift() })
            );
          }
        }
        break;
      }

      // Track when the model is / isn't actively generating a response.
      case "response.created":
        responseActive = true;
        activeResponseId = evt.response?.id || null;
        activeItemId = null;
        playedAudioMs = 0;
        responseAudioMs = 0;
        responseFirstAudioAt = 0;
        break;
      case "response.done":
      case "response.cancelled":
        responseActive = false;
        activeResponseId = null;
        activeItemId = null;
        playedAudioMs = 0;
        if (pendingHangup) {
          if (!goodbyeStarted) {
            // The response that contained end_call just ended, so the line is
            // finally free — NOW say goodbye. (Previously we hung up here and
            // the queued goodbye was silently discarded.)
            console.log("[call] saying goodbye before hangup");
            startGoodbye();
            break;
          }
          // The goodbye finished GENERATING — but Twilio plays it back in real
          // time, so there is still unplayed audio buffered. Wait for exactly
          // that much (plus a small cushion) instead of a fixed guess, or the
          // closing line gets cut off mid-sentence.
          const elapsed = responseFirstAudioAt ? Date.now() - responseFirstAudioAt : 0;
          const remaining = Math.max(0, responseAudioMs - elapsed);
          const waitMs = Math.min(15000, Math.max(1500, Math.round(remaining) + GOODBYE_FLUSH_MS));
          console.log(
            `[call] goodbye is ${Math.round(responseAudioMs)}ms of audio, ` +
              `${Math.round(remaining)}ms still playing — hanging up in ${waitMs}ms`
          );
          setTimeout(() => hangUp(), waitMs);
          break;
        }
        if (pendingResponse) {
          pendingResponse = false;
          requestResponse(); // fire the response that was waiting
        }
        break;

      // Track which conversation item is currently streaming audio, so a
      // barge-in can truncate it to what was actually played.
      case "response.output_item.added":
        if (evt.item?.id) activeItemId = evt.item.id;
        break;

      case "response.output_audio.delta":
      case "response.audio.delta": {
        // Ignore stray deltas from a response we already cancelled.
        if (evt.response_id && activeResponseId && evt.response_id !== activeResponseId) break;
        if (evt.item_id) activeItemId = evt.item_id;
        if (streamSid && evt.delta) {
          twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: evt.delta },
            })
          );
          // g711 u-law @ 8kHz = 8 bytes/ms, so this tracks how much of this
          // item's audio the caller has actually heard so far.
          const chunkMs = Buffer.from(evt.delta, "base64").length / 8;
          playedAudioMs += chunkMs;
          responseAudioMs += chunkMs;
          if (!responseFirstAudioAt) responseFirstAudioAt = Date.now();
        }
        break;
      }

      // The caller started talking. Stop the bot mid-sentence: clear whatever
      // audio Twilio has buffered to play, cancel the in-flight response so
      // the model stops generating more, and truncate its memory of what it
      // "said" down to what the caller actually heard. Without the cancel +
      // truncate, the model keeps talking over the caller and later acts as
      // if it finished a line (or got an answer) that never actually happened.
      case "input_audio_buffer.speech_started": {
        if (streamSid) {
          twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
        }
        if (responseActive && activeResponseId) {
          openAi.send(JSON.stringify({ type: "response.cancel" }));
          if (activeItemId) {
            openAi.send(
              JSON.stringify({
                type: "conversation.item.truncate",
                item_id: activeItemId,
                content_index: 0,
                audio_end_ms: Math.max(0, Math.floor(playedAudioMs)),
              })
            );
          }
          responseActive = false;
          activeResponseId = null;
          activeItemId = null;
          playedAudioMs = 0;
        }
        break;
      }

      case "response.function_call_arguments.done": {
        await handleToolCall(evt);
        break;
      }

      case "error":
        // Self-heal the startup race: if we ever try to start a response while
        // one is already active, don't crash — just mark ourselves busy so the
        // already-active response plays out and the call keeps going.
        if (evt.error?.code === "conversation_already_has_active_response") {
          responseActive = true;
          console.log("[openai] recovered from response collision (harmless)");
        } else if (evt.error?.code === "response_cancel_not_active") {
          console.log("[openai] recovered from redundant cancel (harmless)");
        } else if (String(evt.error?.param || "").startsWith("session.")) {
          // Our session.update was REJECTED. The session is stuck on default
          // 24kHz PCM audio — any speech now reaches the phone as static, and
          // since we only greet after session.updated, the call will be silent.
          // Either way the call is unusable; make the cause impossible to miss.
          console.error(
            "[openai] *** SESSION CONFIG REJECTED — call audio will NOT work ***\n" +
              `[openai] *** ${JSON.stringify(evt.error)}\n` +
              "[openai] *** Fix the session.update payload in buildSessionUpdate(), or flip REALTIME_API_MODE (ga|beta)."
          );
        } else {
          console.error("[openai] error:", JSON.stringify(evt.error || evt));
        }
        break;

      default:
        break;
    }
  });

  openAi.on("close", () => closeAll());
  openAi.on("error", (e) => {
    console.error("[openai] socket error:", e.message);
    closeAll();
  });

  // ---- Tool execution ----
  async function handleToolCall(evt) {
    let args = {};
    try {
      args = JSON.parse(evt.arguments || "{}");
    } catch {
      args = {};
    }
    console.log(`[call] tool: ${evt.name} ${JSON.stringify(args)}`);

    // end_call: only allow it once we have the caller's NAME, NUMBER, and
    // SITUATION (or it's a genuine 911 emergency). Otherwise REFUSE to hang up
    // and tell the model exactly what's still missing. This is the hard guard
    // against dropping a caller before we've captured a usable lead.
    if (evt.name === "end_call") {
      // DEMO MODE: never hang up during a demo — the demo call is the sales
      // moment, so keep the conversation alive no matter what the caller says.
      if (biz.demoMode) {
        console.log("[call] end_call ignored (demo mode — never hangs up)");
        openAi.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: evt.call_id,
              output: JSON.stringify({
                ok: false,
                error:
                  "This is a live demo. Do NOT end the call. Stay warm and helpful, keep answering questions and taking their details, and let the caller hang up whenever they're ready.",
              }),
            },
          })
        );
        requestResponse();
        return;
      }
      const reason = (args.reason || "").toLowerCase();
      const isEmergency = /911|emergency|fire|gas|safety|hurt|injur/.test(reason);
      // A booked JOB also needs somewhere to send the truck.
      const ready =
        haveName && haveNumber && haveSituation && (!bookedJob || haveAddress);
      if (!ready && !isEmergency) {
        const missing = [
          !haveName ? "the caller's name" : null,
          !haveNumber ? "a callback number" : null,
          !haveSituation ? "what they need help with" : null,
          bookedJob && !haveAddress ? "the service address" : null,
        ].filter(Boolean).join(", ");
        console.log(`[call] end_call BLOCKED — still missing: ${missing}`);
        openAi.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: evt.call_id,
              output: JSON.stringify({
                ok: false,
                error:
                  `Do NOT hang up — this caller's details have NOT been saved yet. ` +
                  `You have not successfully called book_job (or take_message). ` +
                  `If the caller ALREADY told you ${missing}, do NOT ask them again — ` +
                  `just call book_job right now with what they gave you. ` +
                  `Only ask the caller for something if you genuinely never got it. ` +
                  `Once the tool call succeeds you may say goodbye and end the call.`,
              }),
            },
          })
        );
        requestResponse();
        return;
      }
      // Allowed to end — but DON'T drop the line silently. Ask the model to
      // deliver one short, warm closing line first, then hang up once that
      // audio has actually played.
      openAi.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: evt.call_id,
            output: JSON.stringify({
              ok: true,
              instruction:
                "Now say your closing out loud, warmly and unhurried — this is the " +
                "last thing they hear. Cover three things in two or three short " +
                "sentences: (1) briefly acknowledge what they are dealing with, " +
                "(2) tell them by name that " + (biz.ownerName || "the owner") +
                " has everything and will call them right back, and (3) a genuine " +
                "sign-off — for example: \"Alright Dana, I\'ve got all of that down. " +
                "Eric will give you a call right back to get someone out to you. " +
                "Hang in there, and thanks for calling us.\" Do NOT ask another " +
                "question and do NOT call any more tools.",
            }),
          },
        })
      );
      pendingHangup = true;
      // If nothing is currently speaking, say it now; otherwise response.done
      // will kick it off as soon as the current response finishes.
      if (!responseActive) startGoodbye();
      console.log(`[call] end_call allowed (${args.reason || "no reason"}) — saying goodbye`);
      setTimeout(() => hangUp(), HANGUP_MAX_MS);   // backstop
      return;
    }

    // book_job / take_message — save the lead. Wrapped so a storage/SMS hiccup
    // can never crash the call.
    const type = evt.name === "book_job" ? "job" : "message";
    if (present(args.customer_name)) haveName = true;
    if (present(args.callback_number)) haveNumber = true;
    if (present(args.problem) || present(args.message)) haveSituation = true;
    if (present(args.service_address)) haveAddress = true;
    if (type === "job") bookedJob = true;
    let lead = null;
    try {
      lead = saveLead({
        type,
        ...args,
        call_sid: callSid,
        caller_number: callerNumber,
        client_id: biz.clientId || "demo",
      });
      leadBooked = true;
      await notifyOwner(biz, lead);
    } catch (e) {
      console.error("[call] saveLead/notify failed:", e.message);
    }

    openAi.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: evt.call_id,
          output: JSON.stringify({
            ok: true,
            saved_id: lead ? lead.id : null,
            confirmation: "Saved. The owner has been texted and will call back.",
          }),
        },
      })
    );
    requestResponse();
  }

  // ---- Twilio -> us ----
  // server.js consumes the first "start" event (to learn which number was
  // dialed and pick the right client), then hands it to us as initialMsg so
  // nothing is lost. Both paths go through the same handler.
  function handleTwilioMessage(msg) {
    switch (msg.event) {
      case "start":
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        callerNumber =
          msg.start.customParameters?.from || msg.start.customParameters?.caller || null;
        console.log(`[call] started ${callSid} from ${callerNumber || "unknown"}`);
        break;

      case "media": {
        const payload = msg.media?.payload;
        if (!payload) break;
        if (openAiReady && openAi.readyState === WebSocket.OPEN) {
          openAi.send(
            JSON.stringify({ type: "input_audio_buffer.append", audio: payload })
          );
        } else {
          audioQueue.push(payload);
        }
        break;
      }

      case "stop":
        console.log(`[call] stopped ${callSid}`);
        closeAll();
        break;

      default:
        break;
    }
  }

  twilioWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    handleTwilioMessage(msg);
  });

  // replay the start event that was read before this bridge existed
  if (initialMsg) handleTwilioMessage(initialMsg);

  twilioWs.on("close", () => closeAll());
  twilioWs.on("error", (e) => {
    console.error("[twilio] socket error:", e.message);
    closeAll();
  });

  // Definitively end the phone call, then tear down the sockets.
  async function hangUp() {
    if (twilioRest && callSid) {
      try {
        await twilioRest.calls(callSid).update({ status: "completed" });
        console.log(`[call] hung up ${callSid}`);
      } catch (e) {
        console.error("[call] REST hangup failed:", e.message);
      }
    }
    closeAll();
  }

  let closed = false;
  function closeAll() {
    if (closed) return;
    closed = true;
    try { if (openAi.readyState === WebSocket.OPEN) openAi.close(); } catch {}
    try { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); } catch {}
  }
}




