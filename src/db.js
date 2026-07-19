// db.js — dependency-free JSON-file store for captured leads.
// Zero native modules = deploys cleanly anywhere (Render, Railway, Fly, a VPS).
// Plenty for a solo operator's volume. Swap for Postgres later if you scale.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const FILE = join(DATA_DIR, "leads.json");

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(FILE)) writeFileSync(FILE, JSON.stringify({ seq: 0, leads: [] }, null, 2));

function read() {
  try { return JSON.parse(readFileSync(FILE, "utf8")); }
  catch { return { seq: 0, leads: [] }; }
}
function write(state) {
  writeFileSync(FILE, JSON.stringify(state, null, 2));
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

export default { saveLead, listLeads, listLeadsByClient };


