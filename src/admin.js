// admin.js
// Self-contained Express router for the CLIENT ONBOARDING panel.
// Served at /clients so it does NOT collide with the existing /admin demo page.
// Mount in server.js with one line:  app.use(adminRouter());
// Gated by ADMIN_PASSWORD (falls back to DASHBOARD_PASSWORD, then "changeme").

import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { listClients, getClient, saveClient, removeClient } from "./clients.js";
import { deleteLeadsByClient } from "./db.js";
import { checkAdmin, passwordMatches, isLockedOut, noteFailure, noteSuccess } from "./auth.js";
import { fetchSiteText, extractBusinessInfo } from "./scrape.js";

const __dirname = dirname(fileURLToPath(import.meta.url));


// Normalize a US phone number to E.164 (+1XXXXXXXXXX) so Twilio never rejects
// it. Leaves already-E.164 and non-US numbers alone.
function toE164(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (/^\+/.test(s)) return s.replace(/[^\d+]/g, "");
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d.startsWith("1")) return "+" + d;
  return d ? "+" + d : "";
}

export function adminRouter() {
  const router = express.Router();
  router.use(express.json());

  function auth(req, res, next) {
    if (!checkAdmin(req, res)) return;
    next();
  }

  router.get("/clients", (_req, res) =>
    res.sendFile(join(__dirname, "..", "public", "clients.html"))
  );

  router.post("/clients/api/login", (req, res) => {
    if (isLockedOut(req)) return res.status(429).json({ ok: false, error: "too many attempts" });
    if (!passwordMatches(req.body && req.body.pw)) {
      noteFailure(req);
      return res.status(401).json({ ok: false });
    }
    noteSuccess(req);
    res.json({ ok: true });
  });

  // Autofill: fetch a business's site, extract fields, and return the raw site
  // text so it can be stored on the client (so their bot can answer from it).
  router.post("/clients/api/autofill", auth, async (req, res) => {
    const website = String((req.body && req.body.website) || "").trim();
    if (!website) return res.status(400).json({ error: "no website" });
    try {
      const websiteInfo = await fetchSiteText(website);
      if (!websiteInfo) {
        return res.json({ ok: true, foundSite: false, fields: {}, websiteInfo: "" });
      }
      const fields = await extractBusinessInfo(websiteInfo);
      res.json({ ok: true, foundSite: true, fields, websiteInfo });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/clients/api/clients", auth, (_req, res) => res.json(listClients()));

  router.get("/clients/api/clients/:id", auth, (req, res) => {
    const c = getClient(req.params.id);
    if (!c) return res.status(404).json({ error: "not found" });
    res.json(c);
  });

  router.post("/clients/api/clients", auth, (req, res) => {
    try {
      const b = req.body || {};
      const missing = ["businessName", "ownerName", "ownerCell", "twilioNumber"].filter(
        (k) => !String(b[k] || "").trim()
      );
      if (missing.length) return res.status(400).json({ error: `Missing: ${missing.join(", ")}` });

      const toList = (v) =>
        Array.isArray(v)
          ? v
          : String(v || "").split(/[\n,]/).map((s) => s.trim()).filter(Boolean);

      const record = saveClient({
        id: b.id || undefined,
        businessName: b.businessName.trim(),
        trade: (b.trade || "home services").trim(),
        ownerName: b.ownerName.trim(),
        ownerCell: toE164(b.ownerCell),
        twilioNumber: toE164(b.twilioNumber),
        city: (b.city || "").trim(),
        serviceArea: (b.serviceArea || b.city || "the local area").trim(),
        hours: (b.hours || "our normal business hours").trim(),
        emergencyAvailable: !!b.emergencyAvailable,
        services: toList(b.services),
        doesNotDo: toList(b.doesNotDo),
        bookingQuestions: toList(b.bookingQuestions),
        greeting:
          (b.greeting || "").trim() ||
          `Thanks for calling ${b.businessName.trim()} — how can I help you today?`,
        website: (b.website || "").trim(),
        websiteInfo: typeof b.websiteInfo === "string" ? b.websiteInfo : "",
      });
      res.json({ ok: true, client: record });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete("/clients/api/clients/:id", auth, (req, res) => {
    // Remove their leads too — otherwise the data lingers forever and could
    // surface on someone else's dashboard.
    const removedLeads = deleteLeadsByClient(req.params.id);
    const ok = removeClient(req.params.id);
    console.log(`[admin] deleted client ${req.params.id} (+${removedLeads} leads)`);
    res.json({ ok, removedLeads });
  });

  return router;
}




