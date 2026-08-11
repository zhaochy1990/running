#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { connect, parseMysqlConfig } from "./mysql.js";
import { selectUserIds } from "./profiles.js";
import { users as REAL_USERS } from "./users.js";
import {
  applyWeeklyFeedbackManifest,
  buildWeeklyFeedbackManifest,
} from "./weekly-feedback-migration.js";
import { createWeeklyFeedbackTarget } from "./weekly-feedback-mysql.js";
import { makeWeeklyFeedbackSource } from "./weekly-feedback-source.js";

const REPO_DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../..", "data");

function userList(values) {
  return values.flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase()).filter(Boolean);
}

/** Parse CLI arguments without performing I/O, suitable for allowlist unit tests. */
export function parseWeeklyFeedbackCli(argv, { defaultDataDir = REPO_DATA_DIR } = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      commit: { type: "boolean", default: false },
      user: { type: "string", multiple: true, default: [] },
      limit: { type: "string" },
      "data-dir": { type: "string", default: defaultDataDir },
      "manifest-out": { type: "string" },
      "reviewed-manifest": { type: "string" },
      "reviewed-hash": { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const limit = values.limit == null ? Infinity : Number(values.limit);
  if (limit !== Infinity && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error("--limit must be a positive integer");
  }
  if (values.commit && (!values["reviewed-manifest"] || !values["reviewed-hash"])) {
    throw new Error("--commit requires --reviewed-manifest and --reviewed-hash");
  }
  if (values["reviewed-hash"] && !/^sha256:[0-9a-f]{64}$/.test(values["reviewed-hash"])) {
    throw new Error("--reviewed-hash must be a lowercase sha256 hash");
  }
  if (!values.commit && (values["reviewed-manifest"] || values["reviewed-hash"])) {
    throw new Error("reviewed manifest options are valid only with --commit");
  }
  return {
    commit: values.commit,
    requestedUsers: userList(values.user),
    limit,
    dataDir: resolve(values["data-dir"]),
    manifestOut: values["manifest-out"] ? resolve(values["manifest-out"]) : null,
    reviewedManifest: values["reviewed-manifest"] ? resolve(values["reviewed-manifest"]) : null,
    reviewedHash: values["reviewed-hash"] ?? null,
    help: values.help,
  };
}

function usage() {
  process.stdout.write(`migrate-weekly-feedback — local SQLite/Markdown -> MySQL weekly_feedback

Usage: migrate-weekly-feedback [options]

  --user <uuid>              Real-user UUID; repeatable or comma-separated.
  --limit <n>                Process at most n users.
  --data-dir <path>          Local source root (default: repository data/).
  --manifest-out <path>      Write the redacted JSON result to a local file.
  --commit                   Apply an already-reviewed zero-error manifest.
  --reviewed-manifest <path> Reviewed dry-run manifest required by --commit.
  --reviewed-hash <sha256:…> Exact reviewed hash required by --commit.
  --help                     Show this help. Default mode is dry-run.
`);
}

async function output(report, path) {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (path) await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(text);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseWeeklyFeedbackCli(argv);
  if (options.help) {
    usage();
    return 0;
  }
  const { ids, rejected } = selectUserIds(REAL_USERS, options.requestedUsers, options.limit);
  if (rejected.length > 0) {
    throw new Error(`--user is not in src/users.js real-user allowlist: ${rejected.join(",")}`);
  }
  if (ids.length === 0) throw new Error("no real users selected");

  const source = makeWeeklyFeedbackSource(options.dataDir);
  const connection = await connect(parseMysqlConfig(env));
  try {
    const target = createWeeklyFeedbackTarget(connection);
    let report;
    if (options.commit) {
      const reviewedManifest = JSON.parse(await readFile(options.reviewedManifest, "utf8"));
      report = await applyWeeklyFeedbackManifest({
        reviewedManifest,
        reviewedHash: options.reviewedHash,
        userIds: ids,
        source,
        target,
      });
    } else {
      report = await buildWeeklyFeedbackManifest({ userIds: ids, source, target });
    }
    await output(report, options.manifestOut);
    return report.error_count > 0 ? 1 : 0;
  } finally {
    await connection.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exitCode = code).catch((error) => {
    console.error(`fatal: ${error?.stack || error}`);
    process.exitCode = 2;
  });
}
