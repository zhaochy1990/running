// profiles.js — read a user's local profile.json / onboarding.json and resolve
// which users to migrate. The migration reads from the repo's on-disk
// `data/<uuid>/` snapshot (the Azure-Blob content store's filesystem mirror),
// not from a live cloud source.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Read and JSON-parse `<dataDir>/<userId>/<file>`.
 * Returns `null` when the file does not exist (a user may have one file but not
 * the other); other IO/parse errors propagate.
 *
 * @returns {object|null}
 */
export function readUserJsonFile(dataDir, userId, file) {
  let text;
  try {
    text = readFileSync(join(dataDir, userId, file), "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(text);
}

/**
 * Resolve the ordered, de-duplicated set of user UUIDs to migrate.
 *
 * Enforces the real-user allowlist (src/users.js): only UUIDs in `allowlist` are
 * ever returned, so test accounts can never be migrated — even if named via
 * `--user`. Any requested UUID outside the allowlist is returned in `rejected`
 * so the caller can warn; it is never migrated.
 *
 * @param {string[]} allowlist real-user UUIDs (from users.js)
 * @param {string[]} requested UUIDs from --user (empty = whole allowlist)
 * @param {number} limit cap on selected users (default: no cap)
 * @returns {{ ids: string[], rejected: string[] }}
 */
export function selectUserIds(allowlist, requested = [], limit = Infinity) {
  const allow = new Set(allowlist.map((u) => u.trim().toLowerCase()));

  let candidates;
  const rejected = [];
  if (requested.length > 0) {
    candidates = [];
    for (const raw of requested) {
      const u = raw.trim().toLowerCase();
      if (!u) continue;
      if (allow.has(u)) candidates.push(u);
      else rejected.push(u);
    }
  } else {
    candidates = allowlist.map((u) => u.trim().toLowerCase());
  }

  const seen = new Set();
  const ids = [];
  for (const u of candidates) {
    if (seen.has(u)) continue;
    seen.add(u);
    ids.push(u);
    if (ids.length >= limit) break;
  }
  return { ids, rejected };
}
