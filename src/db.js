// db.js — dependency-free JSON-file store for captured leads.
// Zero native modules = deploys cleanly anywhere (Render, Railway, Fly, a VPS).
// Plenty for a solo operator's volume. Swap for Postgres later if you scale.
import { existsSync, mkdirSync, statSync } from "fs";
import { readJSON, writeJSON } from "./store.js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// DATA_DIR can point at a mounted persistent disk (e.g. /var/data on Render)
// so clients and leads survive deploys/restarts. Falls back to ./data locally.
const DATA_DIR = process.env.DATA_DIR || join(__dirname, "..", "data");
const FILE = join(DATA_DIR, "leads.json");

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const EMPTY = { seq: 0, leads: [] };

// NOTE: read() intentionally propagates a corrupt-file error instead of
// returning empty — see store.js. Silently returning "no leads" is what would
// let the next save wipe a client's history.
// Client dashboards poll every few seconds. Without a cache that means
// re-reading and re-parsing the ENTIRE leads file on every poll, synchronously,
// which blocks the event loop that's bridging live call audio. Cache the parsed
// state and only re-read when the file actually changes on disk.
let _cache = null;
let _cacheKey = "";

function fileKey() {
  try {
    const st = statSync(FILE);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "none";
  }
}

function read() {
  const key = fileKey();
  if (_cache && key === _cacheKey) return _cache;
  _cache = readJSON(FILE, EMPTY);
  _cacheKey = key;
  return _cache;
}
function write(state) {
  writeJSON(FILE, state);
  _cache = state;          // we just wrote it — no need to re-read
  _cacheKey = fileKey();
}

export function saveLead(lead) {
  const state = read();
  state.seq += 1;
  const row = {
    id: state.seq,
    created_at: new Date().toISOString(),
    type: lead.type,
    customer_name: lead.customer_name ?? null,
    callback_number: lead.callback_number ?? null,
    service_address: lead.service_address ?? null,
    problem: lead.problem ?? null,
    is_emergency: lead.is_emergency ? 1 : 0,
    message: lead.message ?? null,
    notes: lead.notes ?? null,
    call_sid: lead.call_sid ?? null,
    caller_number: lead.caller_number ?? null,
    client_id: lead.client_id ?? null,
  };
  state.leads.push(row);
  write(state);
  return row;
}

export function listLeads(limit = 200) {
  const state = read();
  return state.leads.slice(-limit).reverse();
}

// Only the leads belonging to one client (by clientId). Untagged legacy leads
// (client_id === null) never match a real client, so they stay private to the
// admin/all view.
export function listLeadsByClient(clientId, limit = 200) {
  if (!clientId) return [];
  const state = read();
  return state.leads.filter((l) => l.client_id === clientId).slice(-limit).reverse();
}

// Remove every lead belonging to a client. Called when a client is deleted so
// their data doesn't linger (and can never surface under a re-used id).
export function deleteLeadsByClient(clientId) {
  if (!clientId) return 0;
  const state = read();
  const before = state.leads.length;
  state.leads = state.leads.filter((l) => l.client_id !== clientId);
  const removed = before - state.leads.length;
  if (removed) write(state);
  return removed;
}

export default { saveLead, listLeads, listLeadsByClient, deleteLeadsByClient };






