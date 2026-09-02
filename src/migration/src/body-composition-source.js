// body-composition-source.js — read a user's body-composition scans + segments
// from the local coros.db SQLite snapshot (the per-user watch database).
// Uses Node's built-in `node:sqlite` (Node >= 22.5).
//
// The db is opened READ-ONLY: this migration never writes to the source.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Absolute path to a user's SQLite db: `<dataDir>/<userId>/coros.db`. */
export function dbPathFor(dataDir, userId) {
  return join(dataDir, userId, "coros.db");
}

/**
 * Read all body-composition scans + their segments from a user's SQLite db.
 * Returns `null` when the db file does not exist. If the
 * body_composition_scan table is absent, returns `{scans: [], segments: []}`.
 *
 * @param {string} dataDir root holding `<uuid>/coros.db`
 * @param {string} userId app UUID
 * @returns {{scans: object[], segments: object[]} | null}
 */
export function readBodyComposition(dataDir, userId) {
  const path = dbPathFor(dataDir, userId);
  if (!existsSync(path)) return null;

  const db = openReadonly(path);
  try {
    const hasScanTable = tableExists(db, "body_composition_scan");
    const hasSegTable = tableExists(db, "body_composition_segment");
    const scans = hasScanTable
      ? db.prepare("SELECT * FROM body_composition_scan ORDER BY scan_date").all()
      : [];
    const segments = hasSegTable
      ? db.prepare("SELECT * FROM body_composition_segment ORDER BY scan_date, segment").all()
      : [];
    return { scans, segments };
  } finally {
    db.close();
  }
}

function openReadonly(path) {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    return new DatabaseSync(path);
  }
}

function tableExists(db, name) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(name);
  return !!row;
}
