// store.js
// Crash-safe JSON persistence shared by db.js and clients.js.
//
// Two guarantees that plain writeFileSync does NOT give you:
//   1. ATOMIC WRITES — data is written to a temp file and then renamed into
//      place. A crash or restart mid-write can never leave a half-written file.
//   2. NO SILENT DATA LOSS — if a file is somehow unreadable we try the .bak
//      copy, and if that fails too we THROW instead of returning "empty".
//      Returning empty is what allows the next save to overwrite everything.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  existsSync,
  mkdirSync,
} from "fs";
import { dirname } from "path";

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

export function ensureDir(file) {
  const d = dirname(file);
  if (d && !existsSync(d)) mkdirSync(d, { recursive: true });
}

/**
 * Read a JSON file.
 * - missing or empty file  -> returns `fallback` (a fresh copy)
 * - corrupt file           -> recovers from <file>.bak if possible
 * - corrupt with no backup -> THROWS (so callers never overwrite good data)
 */
export function readJSON(file, fallback) {
  if (!existsSync(file)) return clone(fallback);

  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`[store] cannot read ${file}: ${e.message}`);
  }
  if (raw.trim() === "") return clone(fallback);

  try {
    return JSON.parse(raw);
  } catch {
    const bak = file + ".bak";
    if (existsSync(bak)) {
      try {
        const recovered = JSON.parse(readFileSync(bak, "utf8"));
        console.error(`[store] ${file} was CORRUPT — recovered from ${bak}`);
        // put the good copy back so we're not running off the backup forever
        try {
          writeJSON(file, recovered);
        } catch {}
        return recovered;
      } catch {
        /* fall through */
      }
    }
    // Deliberately fatal: better a loud error than silently reporting "no
    // data" and then overwriting a client's entire history on the next save.
    throw new Error(
      `[store] DATA FILE CORRUPT: ${file} (no usable backup). ` +
        `Refusing to continue so existing data is not overwritten. ` +
        `Inspect the file, or move it aside to start fresh.`
    );
  }
}

/** Write JSON atomically, keeping the previous good copy as <file>.bak */
export function writeJSON(file, data) {
  ensureDir(file);
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file); // atomic on the same filesystem

  // Snapshot AFTER a successful write so the backup always mirrors the latest
  // good state (taking it beforehand would leave .bak one generation stale).
  try {
    copyFileSync(file, file + ".bak");
  } catch {
    /* backup is best-effort */
  }
}
