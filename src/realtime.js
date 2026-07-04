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
        turn_detection: { type: "server_vad", silence_duration_ms: 600 },
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
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          turn_detection: { type: "server_vad", silence_duration_ms: 600 },
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
      case "session.updated":
      case "session.created":
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

      // Track when the model is / isn't actively generating a response.
      case "response.created":
        responseActive = true;
        break;
      case "response.done":
      case "response.cancelled":
        responseActive = false;
        if (pendingResponse) {
          pendingResponse = false;
          requestResponse(); // fire the response that was waiting
        }
        break;

      case "response.output_audio.delta":
      case "response.audio.delta": {
        if (streamSid && evt.delta) {
          twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: evt.delta },
            })
          );
        }
        break;
      }

      case "input_audio_buffer.speech_started": {
        if (streamSid) {
          twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
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
