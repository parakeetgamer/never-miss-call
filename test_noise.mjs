import "dotenv/config";
import WebSocket from "ws";

const model = process.env.REALTIME_MODEL || "gpt-realtime-2";
const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
  headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
});

const session = {
  type: "session.update",
  session: {
    type: "realtime",
    output_modalities: ["audio"],
    instructions: "test",
    max_output_tokens: 600,
    audio: {
      input: {
        format: { type: "audio/pcmu" },
        noise_reduction: { type: "far_field" },
        turn_detection: { type: "semantic_vad", eagerness: "medium", interrupt_response: true },
      },
      output: { format: { type: "audio/pcmu" }, voice: "marin" },
    },
    tools: [],
    tool_choice: "auto",
  },
};

ws.on("open", () => ws.send(JSON.stringify(session)));
ws.on("message", (raw) => {
  const evt = JSON.parse(raw.toString());
  if (evt.type === "session.updated") {
    console.log("ACCEPTED. input config:", JSON.stringify(evt.session.audio.input));
    process.exit(0);
  }
  if (evt.type === "error") {
    console.log("REJECTED:", JSON.stringify(evt.error));
    process.exit(1);
  }
});
ws.on("error", (e) => { console.error("WS", e.message); process.exit(1); });
setTimeout(() => { console.error("timeout"); process.exit(1); }, 10000);
