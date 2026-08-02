# Watch credentials migration — AKV → Tencent MySQL

A one-off Node.js utility that copies per-user **watch login credentials** (COROS
and Garmin) from **Azure Key Vault** into the **Tencent MySQL** `provider_credentials`
table read by the Go worker (`src/go/`).

It is a standalone project — it has its own `package.json` and does **not** import
anything from the rest of the repo.

## What it does

1. Reads the credential secrets from Key Vault (`coros-config-<uuid>`,
   `garmin-config-<uuid>`) using `DefaultAzureCredential`.
2. Transforms each secret into a `provider_credentials` row whose `secret` BLOB is
   **byte-compatible** with what the Go worker writes/reads
   (`src/go/internal/provider/{coros,garmin}/creds.go`), so an imported credential
   is immediately usable by the worker.
3. Upserts the rows (`INSERT … ON DUPLICATE KEY UPDATE`, matching the Go store's
   `OnConflict{UpdateAll}`).

**Dry-run by default** — nothing is written until you pass `--commit`.

## Column mapping

| `provider_credentials` | Source |
|---|---|
| `user_id` (PK, CHAR(36)) | the **app UUID** from the secret *name* suffix (validated; non-UUIDs skipped) |
| `provider` (PK) | `coros` / `garmin` |
| `email` | secret `email` (NULL if empty) |
| `region` | secret `region` (NULL if empty; Garmin defaults to `cn`) |
| `provider_user_id` | COROS: secret `user_id` (numeric account id) · Garmin: NULL |
| `secret` (BLOB) | COROS: `{"pwd_hash":…,"access_token":…}` · Garmin: `{"oauth1":…,"oauth2":…}` decoded from the garth `tokens_dump` |
| `updated_at` | run time, UTC `datetime(6)` |

> The numeric COROS account id lives in `provider_user_id`, **never** in `user_id` —
> the same invariant the Go store's `canonicalUserID` enforces.

## Prerequisites

- Node.js ≥ 18.17
- Azure access to the vault. Locally: `az login` (or set
  `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET`). Your identity
  needs **Key Vault Secrets User** (get + list) on the vault.
- A reachable Tencent MySQL and its DSN.

## Setup

```bash
cd src/migration
npm install
cp .env.example .env   # then edit .env
```

Configure `.env` (see `.env.example` for the full list):

- `AKV_VAULT_URL` — default `https://stride-kv-common.vault.azure.net/`
- MySQL — either `STRIDE_WORKER_MYSQL_DSN` (the Go worker's DSN verbatim) **or**
  the discrete `MYSQL_HOST/PORT/USER/PASSWORD/DATABASE` (+ `MYSQL_SSL`).

## Usage

```bash
# 1) Dry-run everything (reads AKV, prints a redacted plan, writes nothing)
npm run migrate

# 2) Scope it down while testing
node src/index.js --provider coros
node src/index.js --user f10bc353-01ab-4db1-af9f-d9305ea9a532
node src/index.js --limit 5

# 3) Commit for real (optionally create the table first on a fresh DB)
node src/index.js --commit
node src/index.js --commit --ensure-schema
```

Options: `--commit`, `--provider coros|garmin|all`, `--user <uuid>` (repeatable /
comma list), `--limit <n>`, `--vault-url <url>`, `--ensure-schema`,
`--show-email`, `--verbose`, `--help`.

Recommended flow: dry-run → dry-run for one `--user` → `--commit --limit 1` on a
single test user → verify in the DB and via a Go worker read → full `--commit`.

## Safety / secrets

- Logs are redacted: emails are masked (unless `--show-email`), and the `secret`
  blob is only ever shown as a byte count. No password hash, access token, or
  garth token is printed.
- `.env` and any `akv-export*.json` are git-ignored. Never commit real DSNs or
  credential dumps.
- The credential `secret` is stored **plaintext-v1** in MySQL, exactly like the Go
  worker's current model (envelope encryption is a separate, deferred follow-up).

## Schema

The target table is normally created by the Go worker's `AutoMigrateWatch`. For a
fresh DB, `schema.sql` holds the equivalent DDL, and `--ensure-schema` runs it.

## Tests

Pure transform + config logic is covered without touching Azure or MySQL:

```bash
npm test
```
