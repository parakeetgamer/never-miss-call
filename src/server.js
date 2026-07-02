// server.js — the web server tying everything together.
//   POST /incoming-call  -> Twilio hits this when the phone rings; we return
//                           TwiML that opens a media stream to /media-stream.
//   WSS  /media-stream    -> Twilio streams call audio here; we bridge to OpenAI.
//   GET  /                -> simple password-gated leads dashboard.
//   GET  /api/leads       -> JSON list of captured leads (for the dashboard).

import "dotenv/config";
import express from "express";
import { WebSocketServer } from "ws";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { startCallBridge } from "./realtime.js";
import { listLeads } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- load business config ----
const BUSINESS = process.env.BUSINESS || "business.example";
const biz = JSON.parse(
  readFileSync(join(__dirname, "..", "config", `${BUSINESS}.json`), "utf8")
);

const env = {
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.REALTIME_MODEL || "gpt-realtime-2",
  mode: process.env.REALTIME_API_MODE || "ga",
  voice: process.env.REALTIME_VOICE || "marin",
};
const PUBLIC_HOST = process.env.PUBLIC_HOST || "localhost:3000";
const PORT = process.env.PORT || 3000;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || "changeme";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Twilio voice webhook: return TwiML telling Twilio to open a media stream.
app.post("/incoming-call", (req, res) => {
  const from = req.body?.From || "";
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${PUBLIC_HOST}/media-stream">
      <Parameter name="from" value="${from}" />
    </Stream>
  </Connect>
</Response>`;
  res.type("text/xml").send(twiml);
});

// Health check
app.get("/healthz", (_req, res) => res.json({ ok: true, business: biz.businessName }));

// ---- dashboard ----
app.get("/api/leads", (req, res) => {
  if (req.query.pw !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: "unauthorized" });
  }
  res.json(listLeads(200));
});

app.use(express.static(join(__dirname, "..", "public")));
app.get("/", (_req, res) =>
  res.sendFile(join(__dirname, "..", "public", "dashboard.html"))
);

// ---- start HTTP + WS server ----
const server = app.listen(PORT, () => {
  console.log(`\n  ${biz.businessName} receptionist running on port ${PORT}`);
  console.log(`  Dashboard:  http://localhost:${PORT}/  (password: ${DASHBOARD_PASSWORD})`);
  console.log(`  Twilio webhook: POST https://${PUBLIC_HOST}/incoming-call`);
  console.log(`  Model: ${env.model}  Mode: ${env.mode}  Voice: ${env.voice}\n`);
});

// Twilio connects its media stream to this websocket path.
const wss = new WebSocketServer({ server, path: "/media-stream" });
wss.on("connection", (twilioWs) => {
  if (!env.apiKey) {
    console.error("[server] OPENAI_API_KEY missing — cannot bridge call.");
    twilioWs.close();
    return;
  }
  startCallBridge(twilioWs, biz, env);
});
