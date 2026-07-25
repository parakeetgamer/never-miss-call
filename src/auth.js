// auth.js
// Shared admin authentication for the dashboard, demo control, and onboarding
// panel. Centralised so every entry point agrees on the same password and the
// same brute-force protection.

import { randomBytes, timingSafeEqual } from "crypto";

function resolvePassword() {
  const p = process.env.ADMIN_PASSWORD || process.env.DASHBOARD_PASSWORD;
  if (p && p.trim()) return p;

  // No hard-coded "changeme" fallback: a known default on a public URL is an
  // open door. Generate a random one and print it so the operator isn't locked
  // out, but the internet can't guess it.
  const generated = randomBytes(9).toString("base64url");
  console.warn(
    "\n  ⚠️  No ADMIN_PASSWORD / DASHBOARD_PASSWORD set.\n" +
      `  ⚠️  Using a random password for this run: ${generated}\n` +
      "  ⚠️  Set one in your environment to make it stable.\n"
  );
  return generated;
}

export const PASSWORD = resolvePassword();

/** Constant-time comparison so response timing can't leak the password. */
export function passwordMatches(supplied) {
  if (typeof supplied !== "string") return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(PASSWORD);
  if (a.length !== b.length) return false; // length isn't secret enough to matter
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ---- brute-force protection -------------------------------------------------
// Simple in-memory limiter. Plenty for a single-instance deployment; swap for
// a shared store if this ever runs on multiple instances.
const MAX_FAILURES = 8;
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const failures = new Map(); // ip -> { count, firstAt }

function keyFor(req) {
  return (
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

export function isLockedOut(req) {
  const rec = failures.get(keyFor(req));
  if (!rec) return false;
  if (Date.now() - rec.firstAt > WINDOW_MS) {
    failures.delete(keyFor(req));
    return false;
  }
  return rec.count >= MAX_FAILURES;
}

export function noteFailure(req) {
  const k = keyFor(req);
  const rec = failures.get(k);
  if (!rec || Date.now() - rec.firstAt > WINDOW_MS) {
    failures.set(k, { count: 1, firstAt: Date.now() });
  } else {
    rec.count++;
    if (rec.count === MAX_FAILURES) {
      console.warn(`[auth] locking out ${k} after ${MAX_FAILURES} failed attempts`);
    }
  }
}

export function noteSuccess(req) {
  failures.delete(keyFor(req));
}

/**
 * Express-style check. Returns true if authorised; otherwise it has already
 * sent the response.
 */
export function checkAdmin(req, res) {
  if (isLockedOut(req)) {
    res.status(429).json({ error: "too many attempts — try again later" });
    return false;
  }
  // Password may arrive as a header or in the JSON body. NOT via query string:
  // query strings end up in access logs, browser history and referrer headers.
  const supplied = req.get("x-admin-password") || (req.body && req.body.pw);
  if (!passwordMatches(supplied)) {
    noteFailure(req);
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  noteSuccess(req);
  return true;
}
