// server.js — web server + live demo control + multi-tenant client routing.
//   POST /incoming-call     -> Twilio webhook; opens the media stream (passes dialed number).
//   WSS  /media-stream       -> Twilio audio <-> OpenAI bridge (answers as the RIGHT business).
//   POST /api/demo/*         -> live demo control (activate as a business, text the number).
//   GET  /admin              -> demo control page.
//   GET  /clients            -> client onboarding panel (add/manage paying clients).
//   GET  / , /api/leads      -> the leads dashboard.

import "dotenv/config";
import express from "express";
import { WebSocketServer } from "ws";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import twilio from "twilio";
import { startCallBridge } from "./realtime.js";
import { listLeads, listLeadsByClient } from "./db.js";
import { adminRouter } from "./admin.js";
import { PASSWORD, checkAdmin } from "./auth.js";
import { getClientByNumber, toBizConfig, getClientByToken } from "./clients.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- default business (fallback demo) ----
const BUSINESS = process.env.BUSINESS || "business.example";
const defaultBiz = JSON.parse(
  readFileSync(join(__dirname, "..", "config", `${BUSINESS}.json`), "utf8")
);
// The business the demo currently answers as. Changed live via /api/demo/activate.
let activeDemo = { ...defaultBiz, demoMode: process.env.DEMO_SERVER === "true" };

const env = {
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.REALTIME_MODEL || "gpt-realtime-2",
  mode: process.env.REALTIME_API_MODE || "ga",
  voice: process.env.REALTIME_VOICE || "marin",
};
const PUBLIC_HOST = process.env.PUBLIC_HOST || "localhost:3000";
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = PASSWORD;   // shared with admin.js via auth.js

const twilioRest =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;
const TWILIO_NUMBER = process.env.TWILIO_PHONE_NUMBER || "";

const app = express();
app.use(adminRouter());               // client onboarding panel at /clients
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ---- helper: fetch a business website and return cleaned text (best effort) ----
async function fetchSiteText(url) {
  if (!url) return "";
  let target = url.trim();
  if (!/^https?:\/\//i.test(target)) target = "https://" + target;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(target, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0" } });
    clearTimeout(t);
    if (!res.ok) return "";
    let html = await res.text();
    html = html.replace(/<script[\s\S]*?<\/script>/gi, " ")
               .replace(/<style[\s\S]*?<\/style>/gi, " ")
               .replace(/<[^>]+>/g, " ")
               .replace(/&nbsp;/g, " ")
               .replace(/&amp;/g, "&")
               .replace(/\s+/g, " ")
               .trim();
    return html.slice(0, 2500);
  } catch {
    return "";
  }
}

// ---- helper: build a demo business config from minimal admin input ----
async function buildDemoBiz({ businessName, ownerName, website, trade, city }) {
  const websiteInfo = await fetchSiteText(website);
  const owner = (ownerName && ownerName.trim()) || "the owner";
  const name = (businessName && businessName.trim()) || "the business";
  return {
    businessName: name,
    trade: (trade && trade.trim()) || "home services",
    ownerName: owner,
    city: (city && city.trim()) || "your area",
    serviceArea: (city && city.trim()) || "the local area",
    hours: "our regular business hours",
    emergencyAvailable: true,
    services: ["general service calls", "repairs", "installations", "estimates"],
    doesNotDo: [],
    bookingQuestions: ["the caller's name", "the best callback number", "a description of what they need"],
    greeting: `Thanks for calling ${name}, this is the assistant — how can I help you today?`,
    tone: "warm, friendly, and easygoing",
    websiteInfo,
    demoMode: true,
  };
}

// ---- Twilio request verification ----
// Without this, ANY unauthenticated POST to /incoming-call returns valid TwiML
// and can open a media stream — i.e. a stranger can burn your OpenAI balance.
// Twilio signs every webhook; we verify that signature.
// Kill switch: set SKIP_TWILIO_VALIDATION=true if this ever blocks real calls.
function verifyTwilio(req, res, next) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token || process.env.SKIP_TWILIO_VALIDATION === "true") {
    return next(); // not configured (local dev) — nothing to verify against
  }
  const signature = req.get("X-Twilio-Signature") || "";
  const url = `https://${PUBLIC_HOST}${req.originalUrl}`;
  let ok = false;
  try {
    ok = twilio.validateRequest(token, signature, url, req.body || {});
  } catch {
    ok = false;
  }
  if (!ok) {
    console.warn(`[server] REJECTED unsigned request to ${req.originalUrl}`);
    return res.status(403).type("text/plain").send("Forbidden");
  }
  next();
}

// ---- Twilio voice webhook: pass the DIALED number so we can route to the right client ----
app.post("/incoming-call", verifyTwilio, (req, res) => {
  const from = req.body?.From || "";
  const to = req.body?.To || "";
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${PUBLIC_HOST}/media-stream?to=${encodeURIComponent(to)}">
      <Parameter name="from" value="${from}" />
      <Parameter name="to" value="${to}" />
    </Stream>
  </Connect>
</Response>`;
  res.type("text/xml").send(twiml);
});

// ---- demo control (password-gated) ----
function checkAuth(req, res) {
  return checkAdmin(req, res);
}

app.post("/api/demo/activate", async (req, res) => {
  if (!checkAuth(req, res)) return;
  try {
    activeDemo = await buildDemoBiz(req.body || {});
    console.log(`[demo] activated as "${activeDemo.businessName}" (site info: ${activeDemo.websiteInfo ? "yes" : "none"})`);
    res.json({
      ok: true,
      businessName: activeDemo.businessName,
      foundWebsiteInfo: !!activeDemo.websiteInfo,
      demoNumber: TWILIO_NUMBER,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/demo/reset", (req, res) => {
  if (!checkAuth(req, res)) return;
  activeDemo = { ...defaultBiz, demoMode: process.env.DEMO_SERVER === "true" };
  res.json({ ok: true, businessName: activeDemo.businessName });
});

app.post("/api/demo/text", async (req, res) => {
  if (!checkAuth(req, res)) return;
  const to = (req.body?.toNumber || "").trim();
  if (!to) return res.status(400).json({ ok: false, error: "no number" });
  if (!twilioRest || !TWILIO_NUMBER) {
    return res.status(400).json({ ok: false, error: "Twilio SMS not configured" });
  }
  try {
    const body = `Give your AI receptionist a try — call this number and talk to it like a customer: ${TWILIO_NUMBER}`;
    await twilioRest.messages.create({ from: TWILIO_NUMBER, to, body });
    console.log(`[demo] texted demo number to ${to}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/healthz", (_req, res) =>
  res.json({ ok: true, activeDemo: activeDemo.businessName })
);

// ---- leads dashboard ----
app.get("/api/leads", (req, res) => {
  if (!checkAdmin(req, res)) return;
  res.json(listLeads(200));
});

// ---- per-client private dashboard (token in the URL = access) ----
// Data API: resolve the client FROM the token server-side, return ONLY their
// leads. A clientId from the browser is never trusted.
app.get("/d/:token/leads", (req, res) => {
  const client = getClientByToken(req.params.token);
  if (!client) return res.status(404).json({ error: "not found" });
  res.json({
    business: client.businessName,
    owner: client.ownerName || "",
    trade: client.trade || "",
    city: client.city || client.serviceArea || "",
    leads: listLeadsByClient(client.id, 200),
  });
});
// The dashboard page itself (static file; it reads its own token from the URL).
app.get("/d/:token", (req, res) => {
  const client = getClientByToken(req.params.token);
  if (!client) return res.status(404).send("Not found");
  res.sendFile(join(__dirname, "..", "public", "client-dashboard.html"));
});

app.use(express.static(join(__dirname, "..", "public")));
app.get("/admin", (_req, res) => res.sendFile(join(__dirname, "..", "public", "admin.html")));
app.get("/", (_req, res) => res.sendFile(join(__dirname, "..", "public", "dashboard.html")));

// ---- start HTTP + WS ----
const server = app.listen(PORT, () => {
  console.log(`\n  Receptionist server on port ${PORT}`);
  console.log(`  Demo control:      http://localhost:${PORT}/admin`);
  console.log(`  Client onboarding: http://localhost:${PORT}/clients`);
  console.log(`  Dashboard:         http://localhost:${PORT}/`);
  console.log(`  Demo number: ${TWILIO_NUMBER || "(set TWILIO_PHONE_NUMBER)"}`);
  console.log(`  Model: ${env.model}  Mode: ${env.mode}  Voice: ${env.voice}\n`);
});

const wss = new WebSocketServer({ server, path: "/media-stream" });
wss.on("connection", (twilioWs, req) => {
  if (!env.apiKey) {
    console.error("[server] OPENAI_API_KEY missing — cannot bridge call.");
    twilioWs.close();
    return;
  }

  // The dialed number decides WHICH business answers. Twilio sends it two ways:
  //   1. <Parameter name="to"> -> arrives in the "start" event's customParameters
  //   2. the ?to= query string on the stream URL
  // (1) is the reliable one, but it only arrives on the first message — so we
  // wait for "start", pick the client, then hand that same message to the
  // bridge so nothing is lost.
  let urlTo = "";
  try {
    urlTo = new URL(req.url, "http://x").searchParams.get("to") || "";
  } catch {}

  // If Twilio never sends "start", nothing will ever close this socket.
  const startTimeout = setTimeout(() => {
    if (!handedOff) {
      console.warn("[server] no start event within 15s — closing idle stream");
      try { twilioWs.close(); } catch {}
    }
  }, 15000);

  let handedOff = false;
  function onFirstMessages(raw) {
    if (handedOff) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.event !== "start") return; // Twilio sends "connected" first — ignore it

    handedOff = true;
    clearTimeout(startTimeout);
    twilioWs.off("message", onFirstMessages);

    const paramTo = msg.start?.customParameters?.to || "";
    const dialed = paramTo || urlTo;
    const client = getClientByNumber(dialed);
    const biz = client ? toBizConfig(client) : activeDemo;

    if (client) {
      console.log(`[call] routed to client "${biz.businessName}" (dialed ${dialed})`);
    } else {
      console.log(
        `[call] no client for "${dialed || "(none)"}" — using demo "${biz.businessName}" ` +
          `[param="${paramTo}" url="${urlTo}"]`
      );
    }
    startCallBridge(twilioWs, biz, env, msg);
  }
  twilioWs.on("message", onFirstMessages);
});




