// clients.js
// Flat-JSON store for onboarded clients — one record per business, keyed by the
// Twilio number that routes to them. Mirrors db.js (no external database).
//
// Each client record is a full business config PLUS a twilioNumber, so the call
// path can look up "which business owns the number that was dialed."

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const FILE = join(DATA_DIR, "clients.json");

function ensure() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(FILE)) writeFileSync(FILE, "[]");
}
function load() {
  ensure();
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return [];
  }
}
function persist(list) {
  ensure();
  writeFileSync(FILE, JSON.stringify(list, null, 2));
}

// Keep only the last 10 digits so "+15035551212", "(503) 555-1212" all match.
export function normalizeNumber(n) {
  return String(n || "").replace(/\D/g, "").slice(-10);
}

export function listClients() {
  return load().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export function getClient(id) {
  return load().find((c) => c.id === id) || null;
}

// The call path uses this: given the dialed Twilio number, return that client's config.
export function getClientByNumber(twilioNumber) {
  const key = normalizeNumber(twilioNumber);
  if (!key) return null;
  return load().find((c) => normalizeNumber(c.twilioNumber) === key) || null;
}

// Resolve a client from their private dashboard token (server-side only).
export function getClientByToken(token) {
  const t = String(token || "").trim();
  if (!t) return null;
  return load().find((c) => c.dashToken === t) || null;
}

// URL-safe, hard-to-guess token for a client's private dashboard link.
function newToken() {
  return randomBytes(16).toString("hex");
}

// Turn a stored client record into the exact config shape agent.js expects.
export function toBizConfig(client) {
  return {
    clientId: client.id,
    businessName: client.businessName,
    trade: client.trade,
    ownerName: client.ownerName,
    ownerCell: client.ownerCell,
    city: client.city,
    serviceArea: client.serviceArea,
    hours: client.hours,
    emergencyAvailable: !!client.emergencyAvailable,
    services: client.services || [],
    doesNotDo: client.doesNotDo || [],
    bookingQuestions:
      client.bookingQuestions && client.bookingQuestions.length
        ? client.bookingQuestions
        : ["their name", "the best callback number", "what they need help with", "how urgent it is"],
    greeting: client.greeting,
    tone: client.tone || "warm, friendly, and easygoing",
    // If we scraped their site during onboarding, the bot answers questions
    // from it (and uses the "ask the owner" fallback for anything it can't find).
    websiteInfo: client.websiteInfo || "",
  };
}

function slugId(name) {
  return (
    String(name || "client")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "client"
  );
}

// Add a new client or update an existing one (by id). Returns the saved record.
export function saveClient(data) {
  const list = load();
  const now = Date.now();

  // block two clients sharing one Twilio number (that would break routing)
  const dupNum = list.find(
    (c) =>
      c.id !== data.id &&
      data.twilioNumber &&
      normalizeNumber(c.twilioNumber) === normalizeNumber(data.twilioNumber)
  );
  if (dupNum) {
    throw new Error(`That Twilio number is already assigned to "${dupNum.businessName}".`);
  }

  if (data.id) {
    const i = list.findIndex((c) => c.id === data.id);
    if (i === -1) throw new Error("Client not found.");
    list[i] = { ...list[i], ...data, id: list[i].id, updatedAt: now };
    if (!list[i].dashToken) list[i].dashToken = newToken();
    persist(list);
    return list[i];
  }

  // new client — generate a unique id from the business name
  let id = slugId(data.businessName);
  let n = 1;
  while (list.some((c) => c.id === id)) id = `${slugId(data.businessName)}-${++n}`;

  // Spread data FIRST, then pin the authoritative id/timestamps so a stray
  // `id: undefined` coming from the form can never clobber the generated id.
  const record = { ...data, id, createdAt: now, updatedAt: now };
  if (!record.dashToken) record.dashToken = newToken();
  list.push(record);
  persist(list);
  return record;
}

export function removeClient(id) {
  const list = load();
  const next = list.filter((c) => c.id !== id);
  persist(next);
  return list.length !== next.length;
}


