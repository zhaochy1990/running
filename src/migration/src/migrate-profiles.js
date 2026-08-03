#!/usr/bin/env node
// migrate-profiles.js — migrate user profile + onboarding state from the repo's
// local data/ snapshot into the Tencent MySQL user_profile / user_onboarding
// tables read by the Go worker (src/go/).
//
// SAFE BY DEFAULT: runs in dry-run mode (reads local JSON, prints a redacted
// plan, never writes) unless you pass --commit.
//
//   node src/migrate-profiles.js                     # dry-run, all real users
//   node src/migrate-profiles.js --user <uuid>       # one real user (repeatable)
//   node src/migrate-profiles.js --data-dir <path>   # override the data/ root
//   node src/migrate-profiles.js --commit            # actually upsert into MySQL
//   node src/migrate-profiles.js --commit --ensure-schema
//
// ONLY the real users listed in src/users.js are ever migrated; every other UUID
// is a test account and is discarded (src/migration/AGENTS.md). See README.md.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  connect,
  ensureSchema,
  formatUpdatedAt,
  parseMysqlConfig,
  splitSqlStatements,
  upsertUserOnboarding,
  upsertUserProfile,
} from "./mysql.js";
import {
  onboardingRowFromJson,
  ProfileTransformError,
  profileRowFromJson,
  redactProfileRow,
} from "./profile-transform.js";
import { readUserJsonFile, selectUserIds } from "./profiles.js";
import { users as REAL_USERS } from "./users.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, "..");
// PROJECT_DIR = <repo>/src/migration → the repo-root data/ dir is two up.
const DEFAULT_DATA_DIR = resolve(PROJECT_DIR, "..", "..", "data");

function usage() {
  process.stdout.write(
    `migrate-profiles — local data/ profile+onboarding -> Tencent MySQL

Usage: node src/migrate-profiles.js [options]

  --commit           Actually write to MySQL. Default is dry-run (no writes).
  --user <uuid>      Restrict to a user UUID. Repeatable; also accepts a comma
                     list. Must be in the real-user allowlist (src/users.js);
                     anything else is ignored. Default: all real users.
  --data-dir <path>  Root holding <uuid>/profile.json + onboarding.json.
                     Default: STRIDE_DATA_DIR or the repo-root data/ dir.
  --limit <n>        Process at most n users.
  --ensure-schema    Apply schema.sql (CREATE TABLE IF NOT EXISTS) before writing.
  --show-pii         Print full dob / height / weight instead of redacting them.
  --verbose          Extra logging.
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
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  }
}

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      commit: { type: "boolean", default: false },
      user: { type: "string", multiple: true, default: [] },
      "data-dir": { type: "string" },
      limit: { type: "string" },
      "ensure-schema": { type: "boolean", default: false },
      "show-pii": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const users = values.user
    .flatMap((u) => u.split(","))
    .map((u) => u.trim())
    .filter(Boolean);

  const limit = values.limit != null ? Number(values.limit) : Infinity;
  if (!(limit > 0)) throw new Error(`--limit must be a positive number`);

  return {
    commit: values.commit,
    ensureSchema: values["ensure-schema"],
    showPii: values["show-pii"],
    verbose: values.verbose,
    help: values.help,
    users,
    dataDir: values["data-dir"],
    limit,
  };
}

async function main() {
  loadDotEnv(PROJECT_DIR);
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) {
    usage();
    return 0;
  }

  const dataDir = opts.dataDir || process.env.STRIDE_DATA_DIR || DEFAULT_DATA_DIR;
  console.log(
    `mode=${opts.commit ? "COMMIT" : "dry-run"} data=${dataDir} allowlist=${REAL_USERS.length} real user(s)`,
  );

  const { ids, rejected } = selectUserIds(REAL_USERS, opts.users, opts.limit);
  for (const r of rejected) {
    console.warn(`  ignore --user ${r}: not in real-user allowlist (test account)`);
  }
  console.log(`selected ${ids.length} user(s)\n`);

  const profileRows = [];
  const onboardingRows = [];
  const errors = [];
  const skipped = [];

  for (const uid of ids) {
    let profileJson;
    let onboardingJson;
    try {
      profileJson = readUserJsonFile(dataDir, uid, "profile.json");
      onboardingJson = readUserJsonFile(dataDir, uid, "onboarding.json");
    } catch (err) {
      errors.push({ id: uid, kind: "read", message: err.message });
      console.error(`  ERROR reading ${uid}: ${err.message}`);
      continue;
    }

    if (profileJson == null && onboardingJson == null) {
      skipped.push(uid);
      console.warn(
        `  skip ${uid}: no profile.json or onboarding.json under ${dataDir}`,
      );
      continue;
    }

    if (profileJson != null) {
      try {
        const row = profileRowFromJson(uid, profileJson);
        profileRows.push(row);
        const shown = opts.showPii ? row : redactProfileRow(row);
        console.log(
          `  plan profile     ${uid} name=${shown.display_name ?? "-"} ` +
            `dob=${shown.dob ?? "-"} sex=${shown.sex || "-"} ` +
            `height_cm=${shown.height_cm ?? "-"} weight_kg=${shown.weight_kg ?? "-"}`,
        );
      } catch (err) {
        const message =
          err instanceof ProfileTransformError ? err.message : String(err);
        errors.push({ id: uid, kind: "profile", message });
        console.error(`  ERROR profile ${uid}: ${message}`);
      }
    }

    if (onboardingJson != null) {
      try {
        const row = onboardingRowFromJson(uid, onboardingJson);
        onboardingRows.push(row);
        console.log(
          `  plan onboarding  ${uid} watch_ready=${row.watch_ready} ` +
            `profile_ready=${row.profile_ready} completed_at=${row.completed_at ?? "-"}`,
        );
      } catch (err) {
        const message =
          err instanceof ProfileTransformError ? err.message : String(err);
        errors.push({ id: uid, kind: "onboarding", message });
        console.error(`  ERROR onboarding ${uid}: ${message}`);
      }
    }
  }

  console.log(
    `\nplanned ${profileRows.length} profile row(s), ${onboardingRows.length} onboarding row(s), ` +
      `skipped ${skipped.length}, errors ${errors.length}`,
  );

  if (!opts.commit) {
    console.log(
      "\ndry-run complete — nothing written. Re-run with --commit to apply.",
    );
    return errors.length > 0 ? 1 : 0;
  }

  if (profileRows.length === 0 && onboardingRows.length === 0) {
    console.log("\nnothing to write.");
    return errors.length > 0 ? 1 : 0;
  }

  // ── write phase ────────────────────────────────────────────────────────────
  const dbConfig = parseMysqlConfig(process.env);
  console.log(
    `\nconnecting to mysql ${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}${dbConfig.ssl ? " (tls)" : ""}`,
  );
  const conn = await connect(dbConfig);
  let profileInserted = 0;
  let profileUpdated = 0;
  let onboardingInserted = 0;
  let onboardingUpdated = 0;
  try {
    if (opts.ensureSchema) {
      const ddl = readFileSync(join(PROJECT_DIR, "schema.sql"), "utf8");
      for (const stmt of splitSqlStatements(ddl)) {
        await ensureSchema(conn, stmt);
      }
      console.log("ensured user_profile / user_onboarding schema");
    }
    const now = formatUpdatedAt();
    for (const row of profileRows) {
      try {
        const outcome = await upsertUserProfile(conn, row, now);
        if (outcome === "inserted") profileInserted++;
        else profileUpdated++;
        if (opts.verbose) console.log(`  ${outcome} profile ${row.user_id}`);
      } catch (err) {
        errors.push({ id: row.user_id, kind: "profile", message: err.message });
        console.error(`  ERROR upserting profile ${row.user_id}: ${err.message}`);
      }
    }
    for (const row of onboardingRows) {
      try {
        const outcome = await upsertUserOnboarding(conn, row, now);
        if (outcome === "inserted") onboardingInserted++;
        else onboardingUpdated++;
        if (opts.verbose) console.log(`  ${outcome} onboarding ${row.user_id}`);
      } catch (err) {
        errors.push({ id: row.user_id, kind: "onboarding", message: err.message });
        console.error(
          `  ERROR upserting onboarding ${row.user_id}: ${err.message}`,
        );
      }
    }
  } finally {
    await conn.end();
  }

  console.log(
    `\ncommit complete — profile(inserted ${profileInserted}, updated ${profileUpdated}), ` +
      `onboarding(inserted ${onboardingInserted}, updated ${onboardingUpdated}), errors ${errors.length}`,
  );
  return errors.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(`fatal: ${err?.stack || err?.message || err}`);
    process.exit(2);
  });
