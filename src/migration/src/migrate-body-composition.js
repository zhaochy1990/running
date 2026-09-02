#!/usr/bin/env node
// migrate-body-composition.js — migrate body-composition scans + segments from
// each user's local coros.db SQLite snapshot into the Tencent MySQL tables read
// by the Go API (src/go/):
//   user_body_composition_scan · user_body_composition_segment
//
// The source coros.db files are the per-user watch databases downloaded from
// prod Azure Files into the repo-root data/<uuid>/ dir. This migration reads
// them read-only; it never touches prod storage.
//
// SAFE BY DEFAULT: runs in dry-run mode (reads SQLite, prints a per-user plan,
// never writes) unless you pass --commit.
//
//   node src/migrate-body-composition.js                    # dry-run, all real users
//   node src/migrate-body-composition.js --user <uuid>      # one real user (repeatable)
//   node src/migrate-body-composition.js --data-dir <path>  # override the data/ root
//   node src/migrate-body-composition.js --commit           # actually upsert into MySQL
//   node src/migrate-body-composition.js --commit --ensure-schema
//
// ONLY the real users listed in src/users.js are ever migrated; every other UUID
// is a test account and is discarded (src/migration/AGENTS.md). See README.md.
//
// Requires Node >= 22.5 for the built-in node:sqlite reader.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { readBodyComposition } from "./body-composition-source.js";
import {
  connect,
  ensureSchema,
  parseMysqlConfig,
  splitSqlStatements,
  upsertBodyCompositionScan,
} from "./mysql.js";
import { selectUserIds } from "./profiles.js";
import { users as REAL_USERS } from "./users.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, "..");
const DEFAULT_DATA_DIR = resolve(PROJECT_DIR, "..", "..", "data");

function usage() {
  process.stdout.write(
    `migrate-body-composition — local coros.db body-composition -> Tencent MySQL

Usage: node src/migrate-body-composition.js [options]

  --commit           Actually write to MySQL. Default is dry-run (no writes).
  --user <uuid>      Restrict to a user UUID. Repeatable; also accepts a comma
                     list. Must be in the real-user allowlist (src/users.js);
                     anything else is ignored. Default: all real users.
  --data-dir <path>  Root holding <uuid>/coros.db. Default: STRIDE_DATA_DIR or
                     the repo-root data/ dir.
  --limit <n>        Process at most n users.
  --ensure-schema    Apply schema.sql (CREATE TABLE IF NOT EXISTS) before writing.
  --verbose          Log every scan upsert (default logs per-user counts).
  --help             Show this help.

MySQL env (or .env in this directory): see .env.example — either
STRIDE_WORKER_MYSQL_DSN or the discrete MYSQL_* vars.
`,
  );
}

function loadDotEnv(dir) {
  for (const file of [".env", ".env.local"]) {
    let text;
    try {
      text = readFileSync(join(dir, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  }
}

function schemaDDL() {
  return `
CREATE TABLE IF NOT EXISTS user_body_composition_scan (
  id                    VARCHAR(36) NOT NULL,
  user_id               VARCHAR(64) NOT NULL,
  scan_date             VARCHAR(16) NOT NULL,
  jpg_path              VARCHAR(512),
  weight_kg             DOUBLE NOT NULL,
  body_fat_pct          DOUBLE NOT NULL,
  smm_kg                DOUBLE NOT NULL,
  fat_mass_kg           DOUBLE NOT NULL,
  visceral_fat_level    INT NOT NULL,
  bmr_kcal              INT,
  protein_kg            DOUBLE,
  water_l               DOUBLE,
  smi                   DOUBLE,
  inbody_score          INT,
  ingested_at           DATETIME NOT NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_date (user_id, scan_date),
  INDEX idx_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_body_composition_segment (
  id                    VARCHAR(36) NOT NULL,
  scan_id               VARCHAR(36) NOT NULL,
  segment               VARCHAR(32) NOT NULL,
  lean_mass_kg          DOUBLE NOT NULL,
  fat_mass_kg           DOUBLE NOT NULL,
  lean_pct_of_standard  DOUBLE,
  fat_pct_of_standard   DOUBLE,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_scan_segment (scan_id, segment),
  INDEX idx_scan_id (scan_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`;
}

function transformScans(userId, src) {
  const { scans, segments } = src;
  const segmentsByDate = {};
  for (const seg of segments) {
    if (!segmentsByDate[seg.scan_date]) segmentsByDate[seg.scan_date] = [];
    segmentsByDate[seg.scan_date].push({
      segment: seg.segment,
      lean_mass_kg: seg.lean_mass_kg,
      fat_mass_kg: seg.fat_mass_kg,
      lean_pct_of_standard: seg.lean_pct_of_standard ?? null,
      fat_pct_of_standard: seg.fat_pct_of_standard ?? null,
    });
  }

  return scans.map((s) => ({
    user_id: userId,
    scan_date: s.scan_date,
    jpg_path: s.jpg_path ?? null,
    weight_kg: s.weight_kg,
    body_fat_pct: s.body_fat_pct,
    smm_kg: s.smm_kg,
    fat_mass_kg: s.fat_mass_kg,
    visceral_fat_level: s.visceral_fat_level,
    bmr_kcal: s.bmr_kcal ?? null,
    protein_kg: s.protein_kg ?? null,
    water_l: s.water_l ?? null,
    smi: s.smi ?? null,
    inbody_score: s.inbody_score ?? null,
    ingested_at: s.ingested_at ?? new Date().toISOString().replace("T", " ").slice(0, 19),
    segments: segmentsByDate[s.scan_date] || [],
  }));
}

async function main() {
  loadDotEnv(PROJECT_DIR);

  const { values, positionals } = parseArgs({
    options: {
      commit: { type: "boolean", default: false },
      user: { type: "string", multiple: true, default: [] },
      "data-dir": { type: "string" },
      limit: { type: "string" },
      "ensure-schema": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    usage();
    process.exit(0);
  }

  const dataDir = values["data-dir"] || process.env.STRIDE_DATA_DIR || DEFAULT_DATA_DIR;
  const commit = values.commit;
  const verbose = values.verbose;
  const limit = values.limit ? parseInt(values.limit, 10) : Infinity;

  const userIds = selectUserIds(REAL_USERS, values.user);
  if (userIds.length === 0) {
    console.error("No matching real users. Use --user <uuid> or check the allowlist.");
    process.exit(1);
  }

  let conn = null;
  if (commit) {
    const mysqlCfg = parseMysqlConfig(process.env);
    conn = await connect(mysqlCfg);
    if (values["ensure-schema"]) {
      await ensureSchema(conn, splitSqlStatements(schemaDDL()));
    }
  }

  let totalUsers = 0;
  let totalScans = 0;
  let totalSegments = 0;
  let skippedNoFile = 0;
  let skippedNoData = 0;

  for (const userId of userIds) {
    if (totalUsers >= limit) break;

    const src = readBodyComposition(dataDir, userId);
    if (src === null) {
      if (verbose) console.log(`[${userId}] no coros.db — skipped`);
      skippedNoFile++;
      continue;
    }

    const rows = transformScans(userId, src);
    if (rows.length === 0) {
      if (verbose) console.log(`[${userId}] no body-composition data — skipped`);
      skippedNoData++;
      continue;
    }

    const segCount = rows.reduce((n, r) => n + r.segments.length, 0);
    console.log(
      `[${userId}] ${rows.length} scan(s), ${segCount} segment(s)`,
      commit ? "→ upserting" : "(dry-run)",
    );

    if (commit) {
      for (const row of rows) {
        try {
          await upsertBodyCompositionScan(conn, row);
          if (verbose) {
            console.log(`  ✓ ${row.scan_date}`);
          }
        } catch (err) {
          console.error(`  ✗ ${row.scan_date}: ${err.message}`);
          throw err;
        }
      }
    }

    totalUsers++;
    totalScans += rows.length;
    totalSegments += segCount;
  }

  if (conn) await conn.end();

  console.log(`\n${commit ? "Migration complete." : "Dry-run complete."}`);
  console.log(`  Users processed:    ${totalUsers}`);
  console.log(`  Scans migrated:     ${totalScans}`);
  console.log(`  Segments migrated:  ${totalSegments}`);
  console.log(`  Skipped (no file):  ${skippedNoFile}`);
  console.log(`  Skipped (no data):  ${skippedNoData}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
