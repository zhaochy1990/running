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
 * `--user`. When supplied, `aliases` maps friendly selectors to UUIDs, but an
 * alias is accepted only when its target is also in the real-user allowlist.
 *
 * @param {string[]} allowlist real-user UUIDs (from users.js)
 * @param {string[]} requested UUIDs or friendly aliases from --user
 * @param {number} limit cap on selected users (default: no cap)
 * @param {Record<string, string>} aliases friendly selector → UUID mappings
 * @returns {{ ids: string[], rejected: string[] }}
 */
export function selectUserIds(
  allowlist,
  requested = [],
  limit = Infinity,
  aliases = {},
) {
  const allow = new Set(allowlist.map((u) => u.trim().toLowerCase()));
  const aliasMap = new Map(
    Object.entries(aliases).map(([alias, userId]) => [
      alias.trim().toLowerCase(),
      String(userId).trim().toLowerCase(),
    ]),
  );

  let candidates;
  const rejected = [];
  if (requested.length > 0) {
    candidates = [];
    for (const raw of requested) {
      const selector = raw.trim().toLowerCase();
      if (!selector) continue;
      const userId = allow.has(selector) ? selector : aliasMap.get(selector);
      if (userId && allow.has(userId)) candidates.push(userId);
      else rejected.push(selector);
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
