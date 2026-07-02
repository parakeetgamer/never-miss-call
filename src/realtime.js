// realtime.js
// Bridges ONE phone call: Twilio Media Stream (G.711 μ-law, 8kHz) <-> OpenAI
// Realtime API (speech-to-speech). Handles audio in both directions, barge-in
// interruptions, and function/tool calls (book_job / take_message).
//
// Notes on the API:
//  - Twilio media payloads are base64 G.711 μ-law @ 8kHz. The Realtime API can
//    consume and produce that exact format, so NO transcoding is needed.
//  - The GA model (gpt-realtime-2) uses a nested session.audio.* config and
//    renamed some server events vs the older beta. We support both via
//    REALTIME_API_MODE and by listening for both event names defensively.

import WebSocket from "ws";
import { buildInstructions, tools } from "./agent.js";
import { saveLead } from "./db.js";
import { notifyOwner } from "./sms.js";

const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime";

/**
 * Build the session.update payload for the chosen API mode.
 */
function buildSessionUpdate(biz, { mode, voice }) {
  const instructions = buildInstructions(biz);

  if (mode === "beta") {
    // Older beta schema (flat audio format fields).
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

  // GA schema (nested audio config). G.711 μ-law is "audio/pcmu".
  // If your account rejects "audio/pcmu", check the current Realtime docs for
  // the accepted format type and update the two "type" values below.
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
 *
 * @param {WebSocket} twilioWs - the connected Twilio media-stream socket
 * @param {object} biz - business config
 * @param {object} env - { model, mode, voice, apiKey }
 */
export function startCallBridge(twilioWs, biz, env) {
  let streamSid = null;
  let callSid = null;
  let callerNumber = null;
  let openAiReady = false;
  const audioQueue = []; // hold caller audio until OpenAI session is configured

  const openAi = new WebSocket(
    `${OPENAI_REALTIME_URL}?model=${encodeURIComponent(env.model)}`,
    {
      headers: { Authorization: `Bearer ${env.apiKey}` },
      // GA rejects the OpenAI-Beta header; beta requires it.
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
        // flush any caller audio buffered before the session was ready
        while (audioQueue.length) {
          openAi.send(
            JSON.stringify({ type: "input_audio_buffer.append", audio: audioQueue.shift() })
          );
        }
        // Prompt the model to greet first so the caller isn't met with silence.
        openAi.send(JSON.stringify({ type: "response.create" }));
        break;

      // Audio coming back from the model — GA uses response.output_audio.delta,
      // beta used response.audio.delta. Handle both.
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

      // Caller started talking — barge in: stop Twilio playback immediately.
      case "input_audio_buffer.speech_started": {
        if (streamSid) {
          twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
        }
        break;
      }

      // The model wants to call one of our tools.
      case "response.function_call_arguments.done": {
        await handleToolCall(evt);
        break;
      }

      case "error":
        console.error("[openai] error:", JSON.stringify(evt.error || evt));
        break;

      default:
        // Uncomment for deep debugging:
        // console.log("[openai evt]", evt.type);
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
    const type = evt.name === "book_job" ? "job" : "message";
    const lead = saveLead({
      type,
      ...args,
      call_sid: callSid,
      caller_number: callerNumber,
    });
    await notifyOwner(biz, lead);

    // Tell the model the tool succeeded, then let it respond to the caller.
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
    openAi.send(JSON.stringify({ type: "response.create" }));
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
          audioQueue.push(payload); // buffer until session is ready
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

  let closed = false;
  function closeAll() {
    if (closed) return;
    closed = true;
    try { if (openAi.readyState === WebSocket.OPEN) openAi.close(); } catch {}
    try { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); } catch {}
  }
}
