#!/usr/bin/env node
// index.js — migrate watch credentials from Azure Key Vault to Tencent MySQL.
//
// SAFE BY DEFAULT: runs in dry-run mode (reads AKV, prints a redacted plan, never
// writes) unless you pass --commit.
//
//   node src/index.js                     # dry-run, all providers, all users
//   node src/index.js --provider coros    # only COROS
//   node src/index.js --user <uuid>       # one user (repeatable)
//   node src/index.js --commit            # actually upsert into MySQL
//   node src/index.js --commit --ensure-schema
//
// See README.md for full options and the env contract.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { getSecretValue, listSecretNames, makeSecretClient } from "./akv.js";
import {
  connect,
  ensureSchema,
  formatUpdatedAt,
  parseMysqlConfig,
  upsertCredential,
} from "./mysql.js";
import {
  corosRowFromSecret,
  garminRowFromSecret,
  redactRow,
  secretNameToUserId,
  TransformError,
} from "./transform.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, "..");

const PROVIDERS = {
  coros: {
    prefixEnv: "COROS_SECRET_PREFIX",
    prefixDefault: "coros-config",
    build: corosRowFromSecret,
  },
  garmin: {
    prefixEnv: "GARMIN_SECRET_PREFIX",
    prefixDefault: "garmin-config",
    build: garminRowFromSecret,
  },
};

function usage() {
  process.stdout.write(
    `migrate-watch-creds — AKV -> Tencent MySQL provider_credentials

Usage: node src/index.js [options]

  --commit               Actually write to MySQL. Default is dry-run (no writes).
  --provider <p>         coros | garmin | all   (default: all)
  --user <uuid>          Restrict to a user UUID. Repeatable; also accepts a
                         comma-separated list. Default: every secret in the vault.
  --limit <n>            Process at most n records.
  --vault-url <url>      Override AKV_VAULT_URL.
  --ensure-schema        CREATE TABLE IF NOT EXISTS before writing (with --commit).
  --show-email           Print full emails instead of masked ones.
  --verbose              Extra logging.
  --help                 Show this help.

Env (or .env in this directory): see .env.example.
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
      provider: { type: "string", default: "all" },
      user: { type: "string", multiple: true, default: [] },
      limit: { type: "string" },
      "vault-url": { type: "string" },
      "ensure-schema": { type: "boolean", default: false },
      "show-email": { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const providers =
    values.provider === "all"
      ? ["coros", "garmin"]
      : values.provider.split(",").map((s) => s.trim());
  for (const p of providers) {
    if (!PROVIDERS[p]) {
      throw new Error(`unknown --provider "${p}" (want coros|garmin|all)`);
    }
  }

  const users = values.user
    .flatMap((u) => u.split(","))
    .map((u) => u.trim())
    .filter(Boolean);

  const limit = values.limit != null ? Number(values.limit) : Infinity;
  if (!(limit > 0)) throw new Error(`--limit must be a positive number`);

  return {
    commit: values.commit,
    ensureSchema: values["ensure-schema"],
    showEmail: values["show-email"],
    verbose: values.verbose,
    help: values.help,
    providers,
    users,
    limit,
    vaultUrl: values["vault-url"],
  };
}

function prefixFor(providerName) {
  const spec = PROVIDERS[providerName];
  return process.env[spec.prefixEnv]?.trim() || spec.prefixDefault;
}

/** Collect { name, provider } secret refs to process, honoring --user / --limit. */
async function planSecretRefs(client, opts) {
  const refs = [];
  for (const providerName of opts.providers) {
    const prefix = prefixFor(providerName);
    let names;
    if (opts.users.length > 0) {
      names = opts.users.map((u) => `${prefix}-${u}`);
    } else {
      names = await listSecretNames(client, prefix);
    }
    for (const name of names) refs.push({ name, provider: providerName });
  }
  return refs.slice(0, opts.limit);
}

function isNotFound(err) {
  return (
    err?.statusCode === 404 ||
    err?.code === "SecretNotFound" ||
    /was not found in this key vault/i.test(err?.message || "")
  );
}

async function main() {
  loadDotEnv(PROJECT_DIR);
  const opts = parseCli(process.argv.slice(2));
  if (opts.help) {
    usage();
    return 0;
  }

  const vaultUrl = opts.vaultUrl || process.env.AKV_VAULT_URL;
  if (!vaultUrl) {
    throw new Error("AKV_VAULT_URL is required (set env or pass --vault-url)");
  }

  console.log(
    `mode=${opts.commit ? "COMMIT" : "dry-run"} providers=${opts.providers.join(",")} vault=${vaultUrl}`,
  );

  const client = makeSecretClient(vaultUrl);
  const refs = await planSecretRefs(client, opts);
  console.log(`discovered ${refs.length} secret(s) to consider\n`);

  const rows = [];
  const errors = [];
  const skipped = [];

  for (const ref of refs) {
    const prefix = prefixFor(ref.provider);
    let userId;
    try {
      userId = secretNameToUserId(ref.name, prefix);
    } catch (err) {
      // Non-UUID secret (e.g. "coros-config-default"): skip, don't fail the run.
      skipped.push({ name: ref.name, reason: err.message });
      if (opts.verbose) console.warn(`  skip ${ref.name}: ${err.message}`);
      continue;
    }

    let value;
    try {
      value = await getSecretValue(client, ref.name);
    } catch (err) {
      if (isNotFound(err)) {
        skipped.push({ name: ref.name, reason: "not found in vault" });
        console.warn(`  skip ${ref.name}: not found in vault`);
        continue;
      }
      errors.push({ name: ref.name, message: err.message });
      console.error(`  ERROR reading ${ref.name}: ${err.message}`);
      continue;
    }

    try {
      const row = PROVIDERS[ref.provider].build(userId, value);
      rows.push(row);
      const shown = opts.showEmail
        ? { ...redactRow(row), email: row.email ?? null }
        : redactRow(row);
      console.log(
        `  plan ${row.provider}/${row.user_id} ` +
          `email=${shown.email ?? "-"} region=${shown.region ?? "-"} ` +
          `provider_user_id=${shown.provider_user_id ?? "-"} ` +
          `secret_bytes=${shown.secret_bytes}`,
      );
    } catch (err) {
      const message = err instanceof TransformError ? err.message : String(err);
      errors.push({ name: ref.name, message });
      console.error(`  ERROR transforming ${ref.name}: ${message}`);
    }
  }

  console.log(
    `\nplanned ${rows.length} row(s), skipped ${skipped.length}, errors ${errors.length}`,
  );

  if (!opts.commit) {
    console.log("\ndry-run complete — nothing written. Re-run with --commit to apply.");
    return errors.length > 0 ? 1 : 0;
  }

  if (rows.length === 0) {
    console.log("\nnothing to write.");
    return errors.length > 0 ? 1 : 0;
  }

  // ── write phase ────────────────────────────────────────────────────────────
  const dbConfig = parseMysqlConfig(process.env);
  console.log(
    `\nconnecting to mysql ${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}${dbConfig.ssl ? " (tls)" : ""}`,
  );
  const conn = await connect(dbConfig);
  let inserted = 0;
  let updated = 0;
  try {
    if (opts.ensureSchema) {
      const ddl = readFileSync(join(PROJECT_DIR, "schema.sql"), "utf8");
      await ensureSchema(conn, ddl);
      console.log("ensured provider_credentials schema");
    }
    const updatedAt = formatUpdatedAt();
    for (const row of rows) {
      try {
        const outcome = await upsertCredential(conn, row, updatedAt);
        if (outcome === "inserted") inserted++;
        else updated++;
        if (opts.verbose) {
          console.log(`  ${outcome} ${row.provider}/${row.user_id}`);
        }
      } catch (err) {
        errors.push({ name: `${row.provider}/${row.user_id}`, message: err.message });
        console.error(`  ERROR upserting ${row.provider}/${row.user_id}: ${err.message}`);
      }
    }
  } finally {
    await conn.end();
  }

  console.log(
    `\ncommit complete — inserted ${inserted}, updated ${updated}, errors ${errors.length}`,
  );
  return errors.length > 0 ? 1 : 0;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(`fatal: ${err?.stack || err?.message || err}`);
    process.exit(2);
  });
