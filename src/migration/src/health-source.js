// health-source.js — read a user's health-domain rows from the local coros.db
// SQLite snapshot (the per-user watch database downloaded from prod Azure Files).
// Uses Node's built-in `node:sqlite` (Node >= 22.5), so the migration project
// stays dependency-light — no native SQLite driver to build.
//
// The db is opened READ-ONLY: this migration never writes to the source. Only
// the four health-domain tables are read; everything else in coros.db
// (activities, laps, timeseries, calibration, plans, …) is out of scope.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { HEALTH_TABLES } from "./health-transform.js";

/** Absolute path to a user's SQLite watch db: `<dataDir>/<userId>/coros.db`. */
export function dbPathFor(dataDir, userId) {
  return join(dataDir, userId, "coros.db");
}

/**
 * Open a user's coros.db and return the raw rows of the requested health tables.
 * Returns `null` when the db file does not exist (the user has no local
 * snapshot — the caller skips them). A requested table that is absent from the
 * schema yields an empty array rather than an error.
 *
 * @param {string} dataDir root holding `<uuid>/coros.db`
 * @param {string} userId app UUID
 * @param {string[]} tables health tables to read (default: all four)
 * @returns {{[table: string]: object[]} | null}
 */
export function readHealthTables(dataDir, userId, tables = HEALTH_TABLES) {
  const path = dbPathFor(dataDir, userId);
  if (!existsSync(path)) return null;

  const db = openReadonly(path);
  try {
    const out = {};
    for (const table of tables) {
      out[table] = tableExists(db, table)
        ? db.prepare(`SELECT * FROM ${table}`).all()
        : [];
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * Open the db read-only. A WAL-mode database whose -wal/-shm sidecars are absent
 * (the case for the "main file only" prod download) opens read-only fine; the
 * fallback to a normal open covers any driver/db combination that refuses a
 * read-only WAL open (it never writes — we only run SELECTs).
 */
function openReadonly(path) {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    return new DatabaseSync(path);
  }
}

function tableExists(db, name) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
}
