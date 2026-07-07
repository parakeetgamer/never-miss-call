// e2e_fake_call.mjs — pretend to be Twilio: open a media-stream websocket,
// send μ-law silence like a real phone line, and inspect what the bot sends
// back. Verifies the greeting actually arrives and is plausibly 8kHz μ-law.
//
// Usage: start the server first (PORT=3100 npm start), then in another
// terminal: PORT=3100 npm run test:call
// Passes (exit 0) if a greeting of sane size arrives; look for
// "session config confirmed (output format: audio/pcmu)" in the server log.
import WebSocket from "ws";

const PORT = process.env.PORT || 3100;
const ws = new WebSocket(`ws://localhost:${PORT}/media-stream`);

// 20ms of μ-law "silence" (0xFF ≈ zero amplitude), like a quiet phone line.
const SILENCE = Buffer.alloc(160, 0xff).toString("base64");

let audioBytes = 0;
let firstAudioAt = null;
let lastAudioAt = null;
let cleared = 0;

ws.on("open", () => {
  console.log("[fake-twilio] connected, sending start event");
  ws.send(
    JSON.stringify({
      event: "start",
      start: {
        streamSid: "MZfake",
        callSid: "CAfake",
        customParameters: { from: "+15550001111" },
      },
    })
  );
  // stream silence frames every 20ms like a live call
  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return clearInterval(timer);
    ws.send(JSON.stringify({ event: "media", media: { payload: SILENCE } }));
  }, 20);
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.event === "media") {
    const bytes = Buffer.from(msg.media.payload, "base64").length;
    audioBytes += bytes;
    const now = Date.now();
    if (!firstAudioAt) {
      firstAudioAt = now;
      console.log("[fake-twilio] first greeting audio arrived");
    }
    lastAudioAt = now;
  } else if (msg.event === "clear") {
    cleared++;
  }
});

ws.on("close", () => finish("server closed connection"));
ws.on("error", (e) => {
  console.error("[fake-twilio] error:", e.message);
  process.exit(1);
});

// Poll: once we've received audio and then 2s of nothing, greeting is done.
const poll = setInterval(() => {
  if (firstAudioAt && Date.now() - lastAudioAt > 2000) finish("greeting finished");
}, 250);
setTimeout(() => finish("timeout (15s)"), 15000);

function finish(why) {
  clearInterval(poll);
  console.log(`\n[fake-twilio] done: ${why}`);
  console.log(`[fake-twilio] greeting audio: ${audioBytes} bytes`);
  if (audioBytes > 0) {
    // μ-law is 8000 bytes per second of speech.
    console.log(
      `[fake-twilio] ≈ ${(audioBytes / 8000).toFixed(1)}s of speech if μ-law@8kHz (sane: 2–10s)`
    );
  }
  console.log(`[fake-twilio] clear events (barge-in resets): ${cleared}`);
  process.exit(audioBytes > 8000 ? 0 : 1);
}
