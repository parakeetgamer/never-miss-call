// admin.js
// Self-contained Express router for the CLIENT ONBOARDING panel.
// Served at /clients so it does NOT collide with the existing /admin demo page.
// Mount in server.js with one line:  app.use(adminRouter());
// Gated by ADMIN_PASSWORD (falls back to DASHBOARD_PASSWORD, then "changeme").

import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { listClients, getClient, saveClient, removeClient } from "./clients.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PASSWORD =
  process.env.ADMIN_PASSWORD || process.env.DASHBOARD_PASSWORD || "changeme";

export function adminRouter() {
  const router = express.Router();
  router.use(express.json());

  function auth(req, res, next) {
    const pw = req.get("x-admin-password") || req.query.pw || (req.body && req.body.pw);
    if (pw !== PASSWORD) return res.status(401).json({ error: "unauthorized" });
    next();
  }

  router.get("/clients", (_req, res) =>
    res.sendFile(join(__dirname, "..", "public", "clients.html"))
  );

  router.post("/clients/api/login", (req, res) => {
    if ((req.body && req.body.pw) !== PASSWORD) return res.status(401).json({ ok: false });
    res.json({ ok: true });
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
        ownerCell: b.ownerCell.trim(),
        twilioNumber: b.twilioNumber.trim(),
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
      });
      res.json({ ok: true, client: record });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete("/clients/api/clients/:id", auth, (req, res) => {
    res.json({ ok: removeClient(req.params.id) });
  });

  return router;
}
