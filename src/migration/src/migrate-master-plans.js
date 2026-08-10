#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  assertManifestUserSelection,
  buildMasterPlanManifest,
  commitMasterPlanManifest,
} from "./master-plan-migration.js";
import {
  createMasterPlanSchemaAdapter,
  createMasterPlanTarget,
} from "./master-plan-mysql.js";
import { upgradeMasterPlanSchema } from "./master-plan-schema.js";
import {
  makeMasterPlanSource,
  parseMasterPlanSourceConfig,
} from "./masterplan-azure.js";
import { V1_GOAL_SEED } from "./masterplan-transform.js";
import { connect, parseMysqlConfig } from "./mysql.js";
import { selectUserIds } from "./profiles.js";
import { users as REAL_USERS } from "./users.js";

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  process.stdout.write(`migrate-master-plans — Azure 赛季训练计划 -> Tencent MySQL

Usage:
  npm run migrate:master-plans -- [--user <uuid>] [--limit <n>] [--manifest-out <path>]
  npm run migrate:master-plans -- --commit --reviewed-manifest <path> --reviewed-hash <sha256:...>
  npm run migrate:master-plans -- --commit --schema-upgrade

Dry-run always reads both Azure sources and the MySQL target and prints a
redacted canonical manifest. Structured JSON supersedes Markdown.

Options:
  --commit                    Enable the explicitly requested write operation.
  --reviewed-manifest <path>  Reviewed dry-run manifest required for data commit.
  --reviewed-hash <hash>      Reviewed manifest hash required for data commit.
  --manifest-out <path>       Also write the dry-run manifest to this local path.
  --schema-upgrade            Validate or upgrade version -> revision. Requires --commit.
  --user <uuid>               Restrict to a real user. Repeatable/comma-separated.
  --limit <n>                 Process at most n real users.
  --help                      Show help.

Never run --commit while an old Go API instance is active. The command never
prints plan content, credentials, tokens, or DSNs.
`);
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
      const separator = line.indexOf("=");
      if (separator < 0) continue;
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      commit: { type: "boolean", default: false },
      "reviewed-manifest": { type: "string" },
      "reviewed-hash": { type: "string" },
      "manifest-out": { type: "string" },
      "schema-upgrade": { type: "boolean", default: false },
      user: { type: "string", multiple: true, default: [] },
      limit: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const users = values.user.flatMap((item) => item.split(","))
    .map((item) => item.trim()).filter(Boolean);
  const limit = values.limit == null ? Infinity : Number(values.limit);
  if (!(limit > 0)) throw new Error("--limit must be a positive number");
  if (values["schema-upgrade"] && !values.commit) {
    throw new Error("--schema-upgrade requires --commit");
  }
  if (values.commit && !values["schema-upgrade"] &&
      (!values["reviewed-manifest"] || !values["reviewed-hash"])) {
    throw new Error("data commit requires --reviewed-manifest and --reviewed-hash");
  }
  if (!values.commit && (values["reviewed-manifest"] || values["reviewed-hash"])) {
    throw new Error("reviewed manifest options require --commit");
  }
  if (values["schema-upgrade"] && (values["reviewed-manifest"] || values["reviewed-hash"])) {
    throw new Error("run schema upgrade and data commit as separate explicit operations");
  }
  return {
    commit: values.commit,
    schemaUpgrade: values["schema-upgrade"],
    reviewedManifest: values["reviewed-manifest"],
    reviewedHash: values["reviewed-hash"],
    manifestOut: values["manifest-out"],
    users,
    limit,
    help: values.help,
  };
}

function schemaColumn(inspection) {
  if (inspection.columns.includes("revision") && !inspection.columns.includes("version")) {
    return "revision";
  }
  if (inspection.columns.includes("version") && !inspection.columns.includes("revision")) {
    return "version";
  }
  throw new Error("master_plan must have exactly one of version or revision");
}

function parseReviewedManifest(file) {
  const value = JSON.parse(readFileSync(resolve(file), "utf8"));
  if (!value || typeof value !== "object") throw new Error("reviewed manifest must be a JSON object");
  return value;
}

async function main() {
  loadDotEnv(PROJECT_DIR);
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    usage();
    return 0;
  }

  const { ids, rejected } = selectUserIds(REAL_USERS, options.users, options.limit);
  if (rejected.length > 0) {
    process.stderr.write(`ignored ${rejected.length} user selection(s) outside the real-user allowlist\n`);
  }
  const connection = await connect(parseMysqlConfig(process.env));
  try {
    const schemaAdapter = createMasterPlanSchemaAdapter(connection);
    if (options.schemaUpgrade) {
      const result = await upgradeMasterPlanSchema(schemaAdapter);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }

    const inspection = await schemaAdapter.inspect();
    const target = createMasterPlanTarget(connection, { revisionColumn: schemaColumn(inspection) });
    const sourceConfig = parseMasterPlanSourceConfig(process.env);
    if (!sourceConfig.tableAccountUrl) throw new Error("STRIDE_MASTER_PLAN_TABLE_ACCOUNT_URL is required");
    if (!sourceConfig.blobAccountUrl) throw new Error("STRIDE_CONTENT_BLOB_ACCOUNT_URL is required");
    const source = makeMasterPlanSource(sourceConfig);

    if (!options.commit) {
      const manifest = await buildMasterPlanManifest({
        userIds: ids,
        source,
        target,
        goalSeeds: V1_GOAL_SEED,
      });
      const output = `${JSON.stringify(manifest, null, 2)}\n`;
      process.stdout.write(output);
      if (options.manifestOut) {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(resolve(options.manifestOut), output, { encoding: "utf8", mode: 0o600 });
      }
      return manifest.users.some((record) => record.action === "conflict") ? 1 : 0;
    }

    if (schemaColumn(inspection) !== "revision") {
      throw new Error("data commit requires the revision-only schema; run --commit --schema-upgrade first");
    }
    await upgradeMasterPlanSchema(schemaAdapter);
    const reviewedManifest = parseReviewedManifest(options.reviewedManifest);
    assertManifestUserSelection(reviewedManifest, ids);
    const result = await commitMasterPlanManifest({
      reviewedManifest,
      reviewedHash: options.reviewedHash,
      source,
      target,
      goalSeeds: V1_GOAL_SEED,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } finally {
    await connection.end();
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    process.stderr.write(`fatal: ${error?.message ?? String(error)}\n`);
    process.exit(2);
  });
