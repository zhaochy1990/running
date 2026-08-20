#!/usr/bin/env node
// migrate-training-goals.js — migrate the athlete's active training goal from the
// repo's local data/ snapshot into the Tencent MySQL race_goal table read by the
// Go API (src/go/), and keep the Azure master-plan snapshots consistent when a
// legacy slug goal_id has to be re-minted to a uuid.
//
// SAFE BY DEFAULT: runs in dry-run mode (reads local JSON, prints a plan, never
// writes to MySQL or Azure) unless you pass --commit.
//
//   node src/migrate-training-goals.js                    # dry-run, all real users
//   node src/migrate-training-goals.js --user <uuid>      # one real user (repeatable)
//   node src/migrate-training-goals.js --data-dir <path>  # override the data/ root
//   node src/migrate-training-goals.js --commit           # actually upsert + rewrite
//   node src/migrate-training-goals.js --commit --ensure-schema
//
// Two phases at --commit:
//   1. race_goal upsert  — one active row per athlete. A goal_id that is already
//      a uuid is migrated verbatim; a legacy slug (e.g. s1-2026-chengdu-fm) is
//      re-minted to a fresh uuid4 (reusing a prior re-mint if the row already
//      exists, so re-runs are idempotent).
//   2. master-plan rewrite — for each re-minted slug, rewrite the embedded
//      .goal.goal_id inside the user's Azure master-plan snapshots (plans +
//      versions tables) so they point at the new uuid. Skippable with
//      --skip-master-plan (the snapshots then keep the old slug).
//
// ONLY the real users listed in src/users.js are ever migrated; every other UUID
// is a test account and is discarded (src/migration/AGENTS.md). See README.md.

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  GoalTransformError,
  isUuidGoalId,
  raceGoalRowFromCurrent,
  readCurrentGoal,
} from "./goal-transform.js";
import {
  makeTableClients,
  parseMasterPlanConfig,
  rewriteUserGoalId,
} from "./masterplan-azure.js";
import {
  connect,
  ensureSchema,
  formatUpdatedAt,
  getActiveRaceGoalId,
  parseMysqlConfig,
  splitSqlStatements,
  upsertRaceGoal,
} from "./mysql.js";
import { readUserJsonFile, selectUserIds } from "./profiles.js";
import { users as REAL_USERS } from "./users.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, "..");
// PROJECT_DIR = <repo>/src/migration → the repo-root data/ dir is two up.
const DEFAULT_DATA_DIR = resolve(PROJECT_DIR, "..", "..", "data");

function usage() {
  process.stdout.write(
    `migrate-training-goals — local data/ training_goal -> Tencent MySQL race_goal
                          (+ Azure master-plan snapshot goal_id rewrite)

Usage: node src/migrate-training-goals.js [options]

  --commit             Actually write to MySQL + Azure. Default is dry-run.
  --user <uuid>        Restrict to a user UUID. Repeatable; also accepts a comma
                       list. Must be in the real-user allowlist (src/users.js);
                       anything else is ignored. Default: all real users.
  --data-dir <path>    Root holding <uuid>/training_goal.json.
                       Default: STRIDE_DATA_DIR or the repo-root data/ dir.
  --limit <n>          Process at most n users.
  --ensure-schema      Apply schema.sql (CREATE TABLE IF NOT EXISTS) before writing.
  --skip-master-plan   Do NOT rewrite Azure master-plan snapshots for re-minted
                       slug goal_ids (MySQL race_goal only).
  --verbose            Extra logging.
  --help               Show this help.

MySQL env (or .env in this directory): see .env.example — either
STRIDE_WORKER_MYSQL_DSN or the discrete MYSQL_* vars.
Master-plan rewrite env: STRIDE_MASTER_PLAN_TABLE_ACCOUNT_URL (+ optional
STRIDE_MASTER_PLAN_TABLE_NAME); auth via DefaultAzureCredential (run 'az login').
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
      "skip-master-plan": { type: "boolean", default: false },
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
    skipMasterPlan: values["skip-master-plan"],
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

  // ── plan phase (pure: read + classify, no writes, no mint) ──────────────────
  const planned = []; // { uid, current, sourceGoalId, isSlug }
  const errors = [];
  const skipped = [];

  for (const uid of ids) {
    let blob;
    try {
      blob = readUserJsonFile(dataDir, uid, "training_goal.json");
    } catch (err) {
      errors.push({ id: uid, kind: "read", message: err.message });
      console.error(`  ERROR reading ${uid}: ${err.message}`);
      continue;
    }
    if (blob == null) {
      skipped.push(uid);
      console.warn(`  skip ${uid}: no training_goal.json under ${dataDir}`);
      continue;
    }
    try {
      const { goalId, current } = readCurrentGoal(blob);
      const isSlug = !isUuidGoalId(goalId);
      planned.push({ uid, current, sourceGoalId: goalId, isSlug });
      console.log(
        `  plan goal ${uid} distance=${current.race_distance} ` +
          `race=${current.race_name ?? "-"} goal_id=${goalId} ` +
          `[${isSlug ? "slug → re-mint uuid + rewrite snapshots" : "uuid → keep"}]`,
      );
    } catch (err) {
      const message =
        err instanceof GoalTransformError ? err.message : String(err);
      errors.push({ id: uid, kind: "goal", message });
      console.error(`  ERROR goal ${uid}: ${message}`);
    }
  }

  const slugCount = planned.filter((p) => p.isSlug).length;
  console.log(
    `\nplanned ${planned.length} goal row(s) (${slugCount} slug re-mint), ` +
      `skipped ${skipped.length}, errors ${errors.length}`,
  );

  if (!opts.commit) {
    if (slugCount > 0 && !opts.skipMasterPlan) {
      const mp = parseMasterPlanConfig(process.env);
      console.log(
        `dry-run: ${slugCount} slug user(s) would be re-minted and their master-plan ` +
          `snapshots rewritten in ${mp.accountUrl || "(STRIDE_MASTER_PLAN_TABLE_ACCOUNT_URL unset!)"}` +
          ` tables ${mp.tableName}/${mp.versionsTableName}`,
      );
    }
    console.log(
      "\ndry-run complete — nothing written. Re-run with --commit to apply.",
    );
    return errors.length > 0 ? 1 : 0;
  }

  if (planned.length === 0) {
    console.log("\nnothing to write.");
    return errors.length > 0 ? 1 : 0;
  }

  // ── phase 1: race_goal upsert ───────────────────────────────────────────────
  const dbConfig = parseMysqlConfig(process.env);
  console.log(
    `\nconnecting to mysql ${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}${dbConfig.ssl ? " (tls)" : ""}`,
  );
  const conn = await connect(dbConfig);
  const remaps = []; // { uid, oldId, newId } for slug users
  let inserted = 0;
  let updated = 0;
  try {
    if (opts.ensureSchema) {
      const ddl = readFileSync(join(PROJECT_DIR, "schema.sql"), "utf8");
      for (const stmt of splitSqlStatements(ddl)) {
        await ensureSchema(conn, stmt);
      }
      console.log("ensured race_goal schema");
    }
    const now = formatUpdatedAt();
    for (const item of planned) {
      try {
        // Resolve a stable goal_id: uuid blobs pass through; slug blobs reuse a
        // prior re-mint (idempotent) or mint a fresh uuid4.
        let goalId = item.sourceGoalId;
        if (item.isSlug) {
          const existing = await getActiveRaceGoalId(conn, item.uid);
          goalId = existing ?? randomUUID();
          if (goalId !== item.sourceGoalId) {
            remaps.push({ uid: item.uid, oldId: item.sourceGoalId, newId: goalId });
          }
        }
        const row = raceGoalRowFromCurrent(item.uid, item.current, goalId);
        const outcome = await upsertRaceGoal(conn, row, now);
        if (outcome === "inserted") inserted++;
        else updated++;
        console.log(
          `  ${outcome} goal ${item.uid} goal_id=${goalId}` +
            (item.isSlug ? ` (was ${item.sourceGoalId})` : ""),
        );
      } catch (err) {
        const message =
          err instanceof GoalTransformError ? err.message : err.message;
        errors.push({ id: item.uid, kind: "goal", message });
        console.error(`  ERROR upserting goal ${item.uid}: ${message}`);
      }
    }
  } finally {
    await conn.end();
  }
  console.log(
    `\nrace_goal commit — inserted ${inserted}, updated ${updated}, ` +
      `re-mint ${remaps.length}, errors ${errors.length}`,
  );

  // ── phase 2: master-plan snapshot rewrite (only for re-minted slugs) ─────────
  if (remaps.length > 0 && opts.skipMasterPlan) {
    console.warn(
      `\n--skip-master-plan: ${remaps.length} re-minted goal_id(s) NOT rewritten in ` +
        `master-plan snapshots — those snapshots still reference the old slug.`,
    );
  } else if (remaps.length > 0) {
    const mpConfig = parseMasterPlanConfig(process.env);
    console.log(
      `\nrewriting master-plan snapshots for ${remaps.length} user(s) via ` +
        `${mpConfig.accountUrl} (${mpConfig.tableName}/${mpConfig.versionsTableName})`,
    );
    const clients = makeTableClients(mpConfig);
    for (const r of remaps) {
      try {
        const s = await rewriteUserGoalId(clients, r.uid, r.oldId, r.newId, {
          commit: true,
        });
        console.log(
          `  rewrote ${r.uid} ${r.oldId} → ${r.newId}: ` +
            `plans ${s.plansRewritten}/${s.plansScanned}, ` +
            `versions ${s.versionsRewritten}/${s.versionsScanned}`,
        );
      } catch (err) {
        errors.push({ id: r.uid, kind: "master-plan", message: err.message });
        console.error(`  ERROR rewriting snapshots ${r.uid}: ${err.message}`);
      }
    }
  }

  console.log(
    `\ncommit complete — race_goal(inserted ${inserted}, updated ${updated}), ` +
      `snapshot re-mint ${remaps.length}, errors ${errors.length}`,
  );
  return errors.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(`fatal: ${err?.stack || err?.message || err}`);
    process.exit(2);
  });
