# Migrations → Tencent MySQL

One-off Node.js utilities that copy per-user data into the **Tencent MySQL**
tables read by the Go worker (`src/go/`). It is a standalone project — it has its
own `package.json` and does **not** import anything from the rest of the repo.

Three migrations live here:

| Command | Source | Target table(s) |
|---|---|---|
| `npm run migrate` (`src/index.js`) | Azure Key Vault watch-credential secrets | `provider_credentials` |
| `npm run migrate:profiles` (`src/migrate-profiles.js`) | local `data/<uuid>/{profile,onboarding}.json` | `user_profile`, `user_onboarding` |
| `npm run migrate:health` (`src/migrate-health.js`) | local `data/<uuid>/coros.db` SQLite | `daily_health`, `daily_hrv`, `dashboard`, `race_predictions` |

All are **dry-run by default** — nothing is written until you pass `--commit`.

Only **real users** (the UUIDs in `src/users.js`) are migrated; every other UUID
is a test account and is discarded (see `AGENTS.md`). The creds migration prunes
test accounts by `--exclude-email`; the profile migration enforces the
`src/users.js` allowlist directly.

---

## 1) Watch credentials migration — AKV → `provider_credentials`

A utility that copies per-user **watch login credentials** (COROS and Garmin)
from **Azure Key Vault** into the `provider_credentials` table.

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

---

## 2) Profile + onboarding migration — local `data/` → `user_profile` / `user_onboarding`

Copies each real user's **profile** and **onboarding** state from the repo's
on-disk `data/<uuid>/` snapshot into the `user_profile` and `user_onboarding`
tables. The source files (`profile.json`, `onboarding.json`) are the filesystem
mirror of the Azure Blob content store; download them first if your `data/` dir
does not have them.

No Azure access is needed for this migration — it reads local files only.

### Column mapping

**`user_profile`** (from `profile.json`; only the five onboarding core fields —
legacy CJK keys and race/training goals are ignored):

| `user_profile` | Source | Notes |
|---|---|---|
| `user_id` (PK) | the real-user UUID | must be in `src/users.js` |
| `display_name` | `display_name` | missing → `""` |
| `dob` | `dob` (`YYYY-MM-DD`) | Shanghai-local calendar date, never tz-converted |
| `sex` | `sex` | missing → `""` |
| `height_cm` / `weight_kg` | same | missing → `0` (Go zero value; the Go reader can't scan NULL) |
| `created_at` / `updated_at` | run time (UTC) | `created_at` preserved on re-run |

**`user_onboarding`** (from `onboarding.json`):

| `user_onboarding` | Source | Notes |
|---|---|---|
| `user_id` (PK) | the real-user UUID | |
| `watch_ready` | **`coros_ready`** | Python's field → Go's provider-agnostic name |
| `profile_ready` | `profile_ready` | |
| `completed_at` | `completed_at` | ISO-8601 → MySQL `datetime` UTC; NULL if absent |
| `created_at` / `updated_at` | run time (UTC) | |

### Usage

```bash
# 1) Dry-run all real users (reads local JSON, prints a redacted plan, writes nothing)
npm run migrate:profiles

# 2) Scope it down / point at a specific data root
node src/migrate-profiles.js --user f10bc353-01ab-4db1-af9f-d9305ea9a532
node src/migrate-profiles.js --data-dir /path/to/repo/data --limit 3

# 3) Commit for real (optionally create the tables first on a fresh DB)
node src/migrate-profiles.js --commit
node src/migrate-profiles.js --commit --ensure-schema
```

Options: `--commit`, `--user <uuid>` (repeatable / comma list, allowlist-gated),
`--data-dir <path>`, `--limit <n>`, `--ensure-schema`, `--verbose`,
`--help`. The data root resolves to `--data-dir` → `STRIDE_DATA_DIR` → the
repo-root `data/` dir. Only the MySQL env vars are needed (no `AKV_*`).

---

## 3) Health data migration — local `coros.db` → `daily_health` / `daily_hrv` / `dashboard` / `race_predictions`

Copies each real user's **watch health data** from the per-user `data/<uuid>/coros.db`
SQLite snapshot into the four health-domain tables read by the Go worker. The
source `coros.db` files are the per-user watch databases **downloaded from prod
Azure Files** into the repo `data/` dir; download them first if your `data/` dir
does not have them. This migration reads the SQLite **read-only** (via the
built-in `node:sqlite`, so **Node ≥ 22.5** is required) and never touches prod
storage.

Column shapes are 1:1 with the SQLite source, with three adjustments:

- a `user_id` (the app UUID) is injected as the tenant key;
- the SQLite surrogate keys — `dashboard.id` (always 1, a singleton) and
  `race_predictions.id` (autoincrement) — are dropped;
- `dashboard` / `race_predictions` `updated_at` is stamped with the migration run
  time (a wall-clock write time, not synced data — the Go worker overwrites it on
  its next sync), not the SQLite value.

Dates pass through **verbatim** so they stay byte-comparable with what the Go
sync already writes — `daily_health.date` is `YYYYMMDD` (Shanghai calendar day)
and `daily_hrv.date` is ISO `YYYY-MM-DD` — so an upsert updates the same primary
key instead of duplicating it. `daily_health` also carries the Garmin-only
wellness columns (`sleep_*`, `body_battery_*`, `stress_avg`, `respiration_avg`,
`spo2_avg`); COROS users leave them NULL, Garmin users populate them.

### Column mapping

| Table | SQLite PK | MySQL PK | Notes |
|---|---|---|---|
| `daily_health` | `date` | `(user_id, date)` | all columns 1:1; `provider` carried through |
| `daily_hrv` | `(date, provider)` | `(user_id, date, provider)` | all columns 1:1 |
| `dashboard` | `id` (=1) | `(user_id)` | singleton → one row/user; `id` dropped, `updated_at`=run time |
| `race_predictions` | `id` (autoinc) | `(user_id, race_type)` | `id` dropped, `updated_at`=run time; `race_type` verbatim |

### Usage

```bash
# 1) Dry-run all real users (reads each coros.db, prints a per-table plan, writes nothing)
npm run migrate:health

# 2) Scope it down while testing
node src/migrate-health.js --user f10bc353-01ab-4db1-af9f-d9305ea9a532
node src/migrate-health.js --tables daily_health,daily_hrv
node src/migrate-health.js --data-dir /path/to/repo/data --limit 3

# 3) Commit for real (recommended: one user first, verify, then all)
node src/migrate-health.js --commit --user f10bc353-01ab-4db1-af9f-d9305ea9a532
node src/migrate-health.js --commit
node src/migrate-health.js --commit --ensure-schema     # create tables on a fresh DB
```

Options: `--commit`, `--user <uuid>` (repeatable / comma list, allowlist-gated),
`--tables <list>` (subset of `daily_health,daily_hrv,dashboard,race_predictions`;
default all four), `--data-dir <path>`, `--limit <n>`, `--ensure-schema`,
`--verbose`, `--help`. The data root resolves to `--data-dir` → `STRIDE_DATA_DIR`
→ the repo-root `data/` dir. Only the MySQL env vars are needed (no `AKV_*`).

The upsert mirrors the Go store's `OnConflict{UpdateAll}`, so a re-run is
idempotent (every non-PK column is overwritten; no duplicate rows).

---

## Safety / secrets

- Credential-migration logs are redacted: creds emails are masked (unless
  `--show-email`) and the `secret` blob is only ever shown as a byte count. No
  password hash, access token, or garth token is ever printed. The profile
  migration logs full values (display_name, dob, height, weight) so you can
  eyeball what will be written; a missing body metric shows as `null` (it still
  upserts as `0`, the Go zero value).
- `.env` and any `akv-export*.json` are git-ignored. Never commit real DSNs or
  credential dumps.
- The credential `secret` is stored **plaintext-v1** in MySQL, exactly like the Go
  worker's current model (envelope encryption is a separate, deferred follow-up).

## Schema

The target tables are normally created by the Go worker's `AutoMigrateWatch` /
`AutoMigrateUsers`. For a fresh DB, `schema.sql` holds the equivalent DDL for all
three tables, and each migration's `--ensure-schema` runs it.

## Tests

Pure transform + config + selection logic is covered without touching Azure,
MySQL, or the filesystem:

```bash
npm test
```
