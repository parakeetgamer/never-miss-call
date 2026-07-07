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

// How long to wait after the model asks to end the call before actually
// hanging up — gives the goodbye audio time to finish playing to the caller.
const HANGUP_GRACE_MS = 3000;

// Twilio REST client (for definitively hanging up a call by its SID).
const twilioRest =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

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
        turn_detection: { type: "server_vad", silence_duration_ms: 700, interrupt_response: true },
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
          // semantic_vad waits for the caller to actually finish a thought
          // instead of a fixed silence timer, so it stops cutting people off
          // mid-sentence. Eagerness sets the MAX wait before deciding they're
          // done: low=8s, medium=4s, high=2s. "low" left painful dead air
          // after short answers like a bare name, so "medium" — barge-in
          // handling (cancel+truncate) covers us if it ever jumps in early.
          turn_detection: { type: "semantic_vad", eagerness: "medium", interrupt_response: true },
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
export function startCallBridge(twilioWs, biz, env) {
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
  let haveName = false;         // captured caller's name?
  let haveNumber = false;       // captured callback number?
  let haveSituation = false;    // captured the problem/reason?
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
        break;
      case "response.done":
      case "response.cancelled":
        responseActive = false;
        activeResponseId = null;
        activeItemId = null;
        playedAudioMs = 0;
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
          playedAudioMs += Buffer.from(evt.delta, "base64").length / 8;
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
      const reason = (args.reason || "").toLowerCase();
      const isEmergency = /911|emergency|fire|gas|safety|hurt|injur/.test(reason);
      const ready = haveName && haveNumber && haveSituation;
      if (!ready && !isEmergency) {
        const missing = [
          !haveName ? "the caller's name" : null,
          !haveNumber ? "a callback number" : null,
          !haveSituation ? "a description of their situation" : null,
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
                  `Do NOT hang up yet. You still need: ${missing}. Stay on the line, warmly ask the caller for the missing details, then call book_job. Only end the call once you have their name, number, and situation.`,
              }),
            },
          })
        );
        requestResponse();
        return;
      }
      openAi.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: evt.call_id,
            output: JSON.stringify({ ok: true }),
          },
        })
      );
      console.log(`[call] end_call allowed (${args.reason || "no reason"}) — hanging up shortly`);
      setTimeout(() => hangUp(), HANGUP_GRACE_MS);
      return;
    }

    // book_job / take_message — save the lead. Wrapped so a storage/SMS hiccup
    // can never crash the call.
    const type = evt.name === "book_job" ? "job" : "message";
    if (present(args.customer_name)) haveName = true;
    if (present(args.callback_number)) haveNumber = true;
    if (present(args.problem) || present(args.message)) haveSituation = true;
    let lead = null;
    try {
      lead = saveLead({
        type,
        ...args,
        call_sid: callSid,
        caller_number: callerNumber,
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
  twilioWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

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
  });

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
