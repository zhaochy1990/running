#!/usr/bin/env node
// migrate-master-plans.js — migrate the athlete's active 赛季训练计划 from Azure into
// the Tencent MySQL `master_plan` table read by the Go #6 endpoint (ADR 0024).
//
// One logical artifact, two content formats:
//   v2 structured — the active row in Azure Table `stridemasterplan`; plan_json
//                   is stored verbatim as content (content_version=2).
//   v1 markdown   — the user's Azure Blob `TRAINING_PLAN.md`; stored as content
//                   (content_version=1). These users have no structured goal, so
//                   a reviewed per-user seed (masterplan-transform.js V1_GOAL_SEED)
//                   supplies the goal, and we ALSO mint a race_goal row so the
//                   master_plan.goal_id soft reference resolves.
//
// Only the ACTIVE plan is migrated. A user with neither (a 健康跑 user, e.g.
// pan-friend) is skipped. SAFE BY DEFAULT: dry-run unless --commit. ONLY the real
// users in src/users.js are ever touched (src/migration/AGENTS.md).
//
//   node src/migrate-master-plans.js                 # dry-run, all real users
//   node src/migrate-master-plans.js --user <uuid>   # one real user (repeatable)
//   node src/migrate-master-plans.js --commit --ensure-schema

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { DefaultAzureCredential } from "@azure/identity";
import { odata, TableClient } from "@azure/data-tables";
import { BlobServiceClient } from "@azure/storage-blob";

import { parseMasterPlanConfig } from "./masterplan-azure.js";
import {
  MasterPlanTransformError,
  V1_GOAL_SEED,
  markdownRow,
  raceGoalRowFromSeed,
  rebindStructuredGoal,
  structuredRowFromEntity,
} from "./masterplan-transform.js";
import {
  connect,
  ensureSchema,
  formatUpdatedAt,
  getActiveMasterPlanId,
  getActiveRaceGoalId,
  parseMysqlConfig,
  splitSqlStatements,
  upsertMasterPlan,
  upsertRaceGoal,
} from "./mysql.js";
import { selectUserIds } from "./profiles.js";
import { users as REAL_USERS } from "./users.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, "..");

function usage() {
  process.stdout.write(
    `migrate-master-plans — Azure 赛季训练计划 -> Tencent MySQL master_plan (ADR 0024)

Usage: node src/migrate-master-plans.js [options]

  --commit             Actually write to MySQL. Default is dry-run.
  --user <uuid>        Restrict to a user UUID. Repeatable / comma list. Must be
                       in the real-user allowlist (src/users.js).
  --limit <n>          Process at most n users.
  --ensure-schema      Apply schema.sql (CREATE TABLE IF NOT EXISTS) before writing.
  --verbose            Extra logging.
  --help               Show this help.

MySQL env (or .env here): STRIDE_WORKER_MYSQL_DSN or the discrete MYSQL_* vars.
Azure source env: STRIDE_MASTER_PLAN_TABLE_ACCOUNT_URL (table), and content-store
STRIDE_CONTENT_BLOB_ACCOUNT_URL / STRIDE_CONTENT_BLOB_CONTAINER / STRIDE_CONTENT_BLOB_PREFIX
(defaults match config/server.prod.toml). Auth via DefaultAzureCredential ('az login').
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
      limit: { type: "string" },
      "ensure-schema": { type: "boolean", default: false },
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
    verbose: values.verbose,
    help: values.help,
    users,
    limit,
  };
}

function parseContentConfig(env) {
  return {
    accountUrl: (env.STRIDE_CONTENT_BLOB_ACCOUNT_URL || "https://authstorage2026.blob.core.windows.net/").trim(),
    container: (
      env.STRIDE_CONTENT_BLOB_CONTAINER || env.STRIDE_CONTENT_CONTAINER || "stride-data"
    ).trim(),
    prefix: (
      env.STRIDE_CONTENT_BLOB_PREFIX ?? env.STRIDE_CONTENT_PREFIX ?? "users"
    ).trim().replace(/^\/+|\/+$/g, ""),
  };
}

async function readActivePlanEntity(tableClient, uid) {
  const found = [];
  for await (const e of tableClient.listEntities({
    queryOptions: { filter: odata`PartitionKey eq ${uid} and status eq ${"active"}` },
  })) {
    found.push(e);
  }
  if (found.length === 0) return null;
  if (found.length > 1) {
    throw new Error(`user ${uid} has ${found.length} active structured plans (expected 1)`);
  }
  return found[0];
}

async function readMarkdown(containerClient, name) {
  const blob = containerClient.getBlobClient(name);
  if (!(await blob.exists())) return null;
  const buf = await blob.downloadToBuffer();
  const props = await blob.getProperties();
  return { text: buf.toString("utf8"), lastModified: props.lastModified ?? null };
}

async function main() {
  loadDotEnv(PROJECT_DIR);
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) {
    usage();
    return 0;
  }

  console.log(
    `mode=${opts.commit ? "COMMIT" : "dry-run"} allowlist=${REAL_USERS.length} real user(s)`,
  );
  const { ids, rejected } = selectUserIds(REAL_USERS, opts.users, opts.limit);
  for (const r of rejected) {
    console.warn(`  ignore --user ${r}: not in real-user allowlist (test account)`);
  }
  console.log(`selected ${ids.length} user(s)\n`);

  const cred = new DefaultAzureCredential();
  const mpCfg = parseMasterPlanConfig(process.env);
  if (!mpCfg.accountUrl) throw new Error("STRIDE_MASTER_PLAN_TABLE_ACCOUNT_URL is required");
  const plansTable = new TableClient(mpCfg.accountUrl, mpCfg.tableName, cred);
  const contentCfg = parseContentConfig(process.env);
  const container = new BlobServiceClient(contentCfg.accountUrl, cred).getContainerClient(
    contentCfg.container,
  );

  // ── plan phase (read + classify from Azure; no MySQL writes, no mint) ────────
  const planned = []; // { uid, kind: 'v2'|'v1', v2?, v1? }
  const skipped = [];
  const errors = [];

  for (const uid of ids) {
    try {
      const entity = await readActivePlanEntity(plansTable, uid);
      if (entity) {
        const row = structuredRowFromEntity(entity); // validates plan_json + goal_id + version
        planned.push({ uid, kind: "v2", v2: row });
        console.log(
          `  plan v2 ${uid} plan=${row.plan_id.slice(0, 8)} version=${row.version} ` +
            `goal_id=${row.goal_id} content=${row.content.length}B`,
        );
        continue;
      }
      const seed = V1_GOAL_SEED[uid];
      if (seed) {
        const name = `${contentCfg.prefix ? contentCfg.prefix + "/" : ""}${uid}/TRAINING_PLAN.md`;
        const md = await readMarkdown(container, name);
        if (!md) {
          errors.push({ uid, kind: "v1", message: `seed present but no blob ${name}` });
          console.error(`  ERROR v1 ${uid}: no markdown blob ${name}`);
          continue;
        }
        planned.push({ uid, kind: "v1", v1: { md, seed } });
        console.log(
          `  plan v1 ${uid} markdown=${md.text.length}B race=${seed.race_name ?? "-"} ` +
            `date=${seed.race_date} target=${seed.target_finish_time}`,
        );
        continue;
      }
      skipped.push(uid);
      console.warn(`  skip ${uid}: no active structured plan and not a markdown user`);
    } catch (err) {
      const message = err instanceof MasterPlanTransformError ? err.message : String(err?.message || err);
      errors.push({ uid, kind: "plan", message });
      console.error(`  ERROR ${uid}: ${message}`);
    }
  }

  const v2Count = planned.filter((p) => p.kind === "v2").length;
  const v1Count = planned.filter((p) => p.kind === "v1").length;
  console.log(
    `\nplanned ${planned.length} plan(s) (v2=${v2Count}, v1=${v1Count}), ` +
      `skipped ${skipped.length}, errors ${errors.length}`,
  );

  if (!opts.commit) {
    console.log("\ndry-run complete — nothing written. Re-run with --commit to apply.");
    return errors.length > 0 ? 1 : 0;
  }
  if (planned.length === 0) {
    console.log("\nnothing to write.");
    return errors.length > 0 ? 1 : 0;
  }

  // ── commit phase (MySQL) ─────────────────────────────────────────────────────
  const dbConfig = parseMysqlConfig(process.env);
  console.log(
    `\nconnecting to mysql ${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}${dbConfig.ssl ? " (tls)" : ""}`,
  );
  const conn = await connect(dbConfig);
  let mpInserted = 0, mpUpdated = 0, goalInserted = 0, goalUpdated = 0;
  try {
    if (opts.ensureSchema) {
      const ddl = readFileSync(join(PROJECT_DIR, "schema.sql"), "utf8");
      for (const stmt of splitSqlStatements(ddl)) await ensureSchema(conn, stmt);
      console.log("ensured schema (schema.sql)");
    }
    const now = formatUpdatedAt();
    for (const item of planned) {
      try {
        if (item.kind === "v2") {
          const activeGoalId = await getActiveRaceGoalId(conn, item.uid);
          if (!activeGoalId) {
            throw new Error("no active race_goal; run migrate-training-goals before migrating this structured plan");
          }
          const row = rebindStructuredGoal(item.v2, activeGoalId);
          const outcome = await upsertMasterPlan(conn, row, now);
          if (outcome === "inserted") mpInserted++; else mpUpdated++;
          console.log(`  ${outcome} v2 ${item.uid} plan=${row.plan_id.slice(0, 8)} goal=${activeGoalId.slice(0, 8)}`);
        } else {
          // v1: mint stable goal_id + plan_id (reuse prior on re-run for idempotency).
          const goalId = (await getActiveRaceGoalId(conn, item.uid)) ?? randomUUID();
          const planId = (await getActiveMasterPlanId(conn, item.uid, 1)) ?? randomUUID();
          const goalRow = raceGoalRowFromSeed(item.uid, goalId, item.v1.seed);
          const gOut = await upsertRaceGoal(conn, goalRow, now);
          if (gOut === "inserted") goalInserted++; else goalUpdated++;
          const mpRow = markdownRow(item.uid, planId, item.v1.md.text, goalId, {
            createdAt: item.v1.md.lastModified,
            updatedAt: item.v1.md.lastModified,
          });
          const mOut = await upsertMasterPlan(conn, mpRow, now);
          if (mOut === "inserted") mpInserted++; else mpUpdated++;
          console.log(
            `  ${mOut} v1 ${item.uid} plan=${planId.slice(0, 8)} + ${gOut} race_goal=${goalId.slice(0, 8)}`,
          );
        }
      } catch (err) {
        errors.push({ uid: item.uid, kind: "commit", message: String(err?.message || err) });
        console.error(`  ERROR committing ${item.uid}: ${err?.message || err}`);
      }
    }
  } finally {
    await conn.end();
  }

  console.log(
    `\ncommit complete — master_plan(inserted ${mpInserted}, updated ${mpUpdated}), ` +
      `race_goal(inserted ${goalInserted}, updated ${goalUpdated}), errors ${errors.length}`,
  );
  return errors.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(`fatal: ${err?.stack || err?.message || err}`);
    process.exit(2);
  });
