// prospects.js
// Your call list. One record per business you might sell to, plus the log of
// how each call went. Same crash-safe flat-JSON approach as clients.js.

import { existsSync, mkdirSync, readFileSync } from "fs";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readJSON, writeJSON } from "./store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, "..", "data");
const FILE = join(DATA_DIR, "prospects.json");
const SEED = join(__dirname, "..", "config", "prospects.seed.json");

export const STATUSES = ["new", "called", "callback", "demo", "won", "dead"];

function ensure() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensure();
  const list = readJSON(FILE, null);
  if (list) return list;
  // First run: start from the bundled seed list so the call list isn't empty.
  try {
    const seeded = JSON.parse(readFileSync(SEED, "utf8")).map(normalize);
    writeJSON(FILE, seeded);
    console.log(`[prospects] seeded call list with ${seeded.length} businesses`);
    return seeded;
  } catch {
    writeJSON(FILE, []);
    return [];
  }
}

function persist(list) {
  ensure();
  writeJSON(FILE, list);
}

// Last 10 digits — so "(360) 869-1165" and "+13608691165" are the same business.
export function normalizePhone(n) {
  return String(n || "").replace(/\D/g, "").slice(-10);
}

function normalize(p) {
  return {
    id: p.id || `p_${randomBytes(5).toString("hex")}`,
    businessName: p.businessName || p.name || "Unknown",
    phone: p.phone || "",
    website: p.website || "",
    address: p.address || "",
    city: p.city || "",
    trade: p.trade || "",
    rating: p.rating ?? null,
    reviewCount: p.reviewCount ?? null,
    source: p.source || "seed",
    status: STATUSES.includes(p.status) ? p.status : "new",
    calls: Array.isArray(p.calls) ? p.calls : [],
    lastCalledAt: p.lastCalledAt || null,
    onboardedClientId: p.onboardedClientId || null,
    createdAt: p.createdAt || Date.now(),
    updatedAt: p.updatedAt || Date.now(),
  };
}

export function listProspects() {
  // Uncalled first (that's the point of a call list), then most recently touched.
  const order = { new: 0, callback: 1, called: 2, demo: 0, won: 3, dead: 4 };
  return load().sort((a, b) => {
    const d = (order[a.status] ?? 9) - (order[b.status] ?? 9);
    if (d !== 0) return d;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

export function getProspect(id) {
  return load().find((p) => p.id === id) || null;
}

/** Add businesses, skipping any whose phone number we already have. */
export function addProspects(items) {
  const list = load();
  const seen = new Set(list.map((p) => normalizePhone(p.phone)).filter(Boolean));
  const added = [];
  for (const raw of items) {
    const p = normalize(raw);
    const key = normalizePhone(p.phone);
    if (key && seen.has(key)) continue; // already on the list
    seen.add(key);
    list.push(p);
    added.push(p);
  }
  if (added.length) persist(list);
  return added;
}

/** Record how a call went and move the prospect along. */
export function logCall(id, { notes, status }) {
  const list = load();
  const i = list.findIndex((p) => p.id === id);
  if (i === -1) throw new Error("Prospect not found.");
  const now = Date.now();
  if (notes && notes.trim()) {
    list[i].calls.unshift({ at: now, notes: notes.trim(), status: status || "called" });
  }
  if (status && STATUSES.includes(status)) list[i].status = status;
  else if (list[i].status === "new") list[i].status = "called";
  list[i].lastCalledAt = now;
  list[i].updatedAt = now;
  persist(list);
  return list[i];
}

export function updateProspect(id, patch) {
  const list = load();
  const i = list.findIndex((p) => p.id === id);
  if (i === -1) throw new Error("Prospect not found.");
  list[i] = { ...list[i], ...patch, id: list[i].id, updatedAt: Date.now() };
  persist(list);
  return list[i];
}

export function removeProspect(id) {
  const list = load();
  const next = list.filter((p) => p.id !== id);
  persist(next);
  return list.length !== next.length;
}

export function stats() {
  const list = load();
  const by = {};
  for (const s of STATUSES) by[s] = 0;
  for (const p of list) by[p.status] = (by[p.status] || 0) + 1;
  return { total: list.length, ...by };
}
