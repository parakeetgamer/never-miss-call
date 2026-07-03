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
  const audioQueue = [];

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
        while (audioQueue.length) {
          openAi.send(
            JSON.stringify({ type: "input_audio_buffer.append", audio: audioQueue.shift() })
          );
        }
        if (!greeted) {
          greeted = true;
          requestResponse(); // kick off the greeting exactly once
        }
        break;

      // Track when the model is/ isn't actively generating a response.
      case "response.created":
        responseActive = true;
        break;
      case "response.done":
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
        console.error("[openai] error:", JSON.stringify(evt.error || evt));
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

    // end_call: acknowledge, let the goodbye play, then hang up the phone.
    if (evt.name === "end_call") {
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
      console.log(`[call] end_call requested (${args.reason || "no reason"}) — hanging up shortly`);
      setTimeout(() => hangUp(), HANGUP_GRACE_MS);
      return;
    }

    const type = evt.name === "book_job" ? "job" : "message";
    const lead = saveLead({
      type,
      ...args,
      call_sid: callSid,
      caller_number: callerNumber,
    });
    await notifyOwner(biz, lead);

    openAi.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: evt.call_id,
          output: JSON.stringify({
            ok: true,
            saved_id: lead.id,
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
