# Migrations → Tencent MySQL

One-off Node.js utilities that copy per-user data into the **Tencent MySQL**
tables read by the Go worker (`src/go/`). It is a standalone project — it has its
own `package.json` and does **not** import anything from the rest of the repo.

Nine migrations live here:

| Command | Source | Target table(s) |
|---|---|---|
| `npm run migrate` (`src/index.js`) | Azure Key Vault watch-credential secrets | `provider_credentials` |
| `npm run migrate:profiles` (`src/migrate-profiles.js`) | local `data/<uuid>/{profile,onboarding}.json` | `user_profile`, `user_onboarding` |
| `npm run migrate:health` (`src/migrate-health.js`) | local `data/<uuid>/coros.db` SQLite | `daily_health`, `daily_hrv`, `dashboard`, `race_predictions` |
| `npm run migrate:training-goals` (`src/migrate-training-goals.js`) | local `data/<uuid>/training_goal.json` (+ Azure master-plan snapshots) | `race_goal` |
| `npm run migrate:master-plans` (`src/migrate-master-plans.js`) | Azure Table/Blob season plans | `master_plan` |
| `npm run migrate:weekly-plans` (`src/migrate-weekly-plans.js`) | Azure Table canonical weekly plans, with Blob `plan.md` fallback | `weekly_plan` |
| `npm run migrate:running-age` (`src/migrate-running-age.js`) | local `data/<uuid>/running_profile.json` | existing `user_profile` rows |
| `npm run migrate:weekly-feedback` (`src/migrate-weekly-feedback.js`) | local SQLite `weekly_feedback`, with `feedback.md` fallback | `weekly_feedback` |
| `npm run migrate:activity-start-gps` (`src/activity-start-gps-backfill.js`) | first valid GPS pair from each activity's MySQL `timeseries` rows | existing `activities.start_gps_lat`, `activities.start_gps_lon` |

## Production migration status

| Data | Target | Status | Completed |
|---|---|---|---|
| Watch credentials | `provider_credentials` | Completed | 2026-08-05 |
| Profile + onboarding | `user_profile`, `user_onboarding` | Completed | 2026-08-05 |
| Health data | `daily_health`, `daily_hrv`, `dashboard`, `race_predictions` | Completed | 2026-08-05 |
| Training goals | `race_goal` | Completed (8 users; Daisy has no race goal) | 2026-08-06 |
| Master plans | `master_plan` | Not recorded | — |
| Weekly plans | `weekly_plan` | Not recorded | — |

All are **dry-run by default** and write only with `--commit`.

Only **real users** (the UUIDs in `src/users.js`) are migrated; every other UUID
is a test account and is discarded (see `AGENTS.md`). The creds migration prunes
test accounts by `--exclude-email`; the profile migration enforces the
`src/users.js` allowlist directly.

---

## Activity-start GPS backfill — `timeseries` → `activities`

This one-off backfill populates the activity-level start-coordinate cache added
for race detection. It is dry-run by default and accepts only real-user UUIDs
from `src/users.js`. Missing activities are keyset-paged; every activity performs
one indexed `(user_id, label_id)` lookup with `ORDER BY id LIMIT 1`. It never
groups or aggregates the full `timeseries` table.

```bash
# Preview one real user without writing.
npm run migrate:activity-start-gps -- \
  --user f10bc353-01ab-4db1-af9f-d9305ea9a532 --limit 25

# Apply a bounded validation batch, then run without --limit after review.
npm run migrate:activity-start-gps -- \
  --commit --user f10bc353-01ab-4db1-af9f-d9305ea9a532 --limit 25
npm run migrate:activity-start-gps -- --commit
```

`--batch-size` controls activity keyset pages (default `25`, maximum `500`), and
`--delay-ms` throttles after each timeseries lookup (default `25`). `--limit` is
a total activity cap for the run; it is intended for validation, not as a resume
cursor. Commit mode updates only rows whose two cache
columns are still `NULL`, immediately reads each updated row back, continues past
per-activity failures, and exits non-zero when any failures occurred. Re-running
is safe: already cached activities never query `timeseries` and are never
overwritten.

Production should start with a small `--limit` and the default delay while MySQL
CPU and query latency are monitored. Increase scope only while database load
remains healthy. MySQL uses `STRIDE_WORKER_MYSQL_DSN` or the discrete `MYSQL_*`
variables; credentials and coordinates are never printed.

---

## Weekly-feedback backfill — local history → `weekly_feedback`

Dry-run writes a redacted review manifest; SQLite wins over Markdown for each
validated natural week. Apply requires the unchanged manifest and its exact hash.

```bash
npm run migrate:weekly-feedback -- --manifest-out ./weekly-feedback-review.json
npm run migrate:weekly-feedback -- --commit \
  --reviewed-manifest ./weekly-feedback-review.json \
  --reviewed-hash sha256:<hash-from-manifest>
```

`--user` is repeatable or comma-separated and remains gated by `src/users.js`.
`--limit` caps users. Sources default to repository `data/`; use `--data-dir`
for a local snapshot override. MySQL uses `STRIDE_WORKER_MYSQL_DSN` or `MYSQL_*`.

---

## Weekly-plan backfill — Azure Table/Blob → `weekly_plan`

This source-read-only tool processes only UUIDs in `src/users.js`. For each
Shanghai natural week it selects the canonical `strideweeklyplan` Table entity
when present; only a week with no structured entity falls back to Blob
`users/<uuid>/logs/<week>/plan.md`. Invalid structured JSON therefore blocks
Markdown fallback and is reported for manual handling.

Structured JSON is cleaned for ADR 0025 and validated before insertion. The
tool reports ambiguous sources, invalid Monday-Sunday bounds, missing source
timestamps, ambiguous master-plan ownership, and target conflicts. Existing
active rows are never overwritten; byte-equal Markdown or semantically equal
JSON is reported as `existing`. UUIDv4 IDs are generated only immediately
before a `--commit` insert.

```bash
# Dry-run all real users.
npm run migrate:weekly-plans

# Dry-run one allowlisted user, then insert missing rows.
node src/migrate-weekly-plans.js --user <uuid>
node src/migrate-weekly-plans.js --commit --user <uuid>
```

Migrate master plans first. For a confirmed health-running user whose weekly
plans intentionally have no season-plan owner, pass
`--allow-unowned-user <uuid>` together with the selected `--user`; otherwise
the rows remain in the manual-review report instead of silently receiving a
NULL `master_plan_id`.

Required source env: `STRIDE_WEEKLY_PLAN_TABLE_ACCOUNT_URL` and
`STRIDE_CONTENT_BLOB_ACCOUNT_URL`; optional table/container/prefix overrides are
listed in `.env.example`. Azure auth uses `DefaultAzureCredential`. Target MySQL
uses the same `STRIDE_WORKER_MYSQL_DSN` or `MYSQL_*` settings as other tools.

The final JSON report is suitable for retaining as the manual-review manifest.
The command exits non-zero when manual findings or conflicts remain.

---

## 7) Running-age migration — local `running_profile.json` → `user_profile`

Backfills only the declared running-age value from each real user's local
`running_profile.json`. It accepts `current.running_age` and the transitional
`current.running_age_range` key, normalizes `lt6m` to `lt_6m`, and ignores legacy
injury strings. Values outside `lt_6m`, `6m_1y`, `1y_3y`, and `3y_plus` are
reported as failures. The command never inserts a profile and updates only an
existing row whose `running_age_range` is still `unknown`; the conditional SQL
makes reruns safe under concurrent profile edits.

```bash
# Dry-run is the default and emits only {migrated, skipped, missing, failed} JSON.
npm run migrate:running-age
node src/migrate-running-age.js --user zhaochaoyi

# Write the selected real user after reviewing the dry-run report.
node src/migrate-running-age.js --commit --user zhaochaoyi
node src/migrate-running-age.js --commit --ensure-schema
```

`--user` accepts a UUID or an alias from `data/.slug_aliases.json`; aliases are
still gated by the real-user allowlist in `src/users.js`. Use `--data-dir` or
`STRIDE_DATA_DIR` for another local snapshot root. The migration prints no source
values, user content, database configuration, or credentials.

---

## 1) Watch credentials migration — AKV → `provider_credentials`

A utility that copies per-user **watch login credentials** (COROS and Garmin)
from **Azure Key Vault** into the `provider_credentials` table. The command
remains available for idempotent repair or backfill runs after the production
migration recorded above.

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

## 4) Training-goal migration — local `data/` → `race_goal` (+ Azure master-plan rewrite)

Copies each real user's **active training goal** from the repo's on-disk
`data/<uuid>/training_goal.json` snapshot into the `race_goal` table read by the
new Go training-goal API (`src/go/`). The source file is the filesystem mirror of
the old Python Azure-Blob goal store; only its `current` (active) goal is
migrated — `history` is dropped, matching the redesigned API which only surfaces
a single active goal.

This is a **two-phase** tool:

1. **`race_goal` upsert** — one active row per athlete (`status='active'`,
   `active_flag=1`). A `goal_id` that is already a UUID is migrated verbatim; a
   legacy human slug (e.g. `s1-2026-chengdu-fm`) is **re-minted** to a fresh
   `uuid4` so MySQL's `CHAR(36)` id space is uniform and the id stays opaque.
2. **master-plan snapshot rewrite** — for each re-minted slug, the tool rewrites
   the embedded `.goal.goal_id` inside the user's **Azure master-plan snapshots**
   (the plans + versions tables) so those plans keep pointing at the same goal.
   Skip this phase with `--skip-master-plan` (the snapshots then keep the old
   slug, which will dangle).

**Idempotency:** before minting, the tool resolves the athlete's existing active
`goal_id` (`getActiveRaceGoalId`). A slug user whose row already exists reuses the
previously minted UUID instead of minting a new one, so re-runs are stable — the
row count stays put and the master-plan linkage never drifts. (`inserted` vs
`updated` is reported from a PK pre-existence probe, not `affectedRows`, because
this row's `updated_at` is carried from the blob unchanged and mysql2 reports
`affectedRows=1` for such a no-op re-upsert.)

### Column mapping

| `race_goal` | Source (`training_goal.current.*`) | Notes |
|---|---|---|
| `goal_id` (PK) | `goal_id` | UUID kept as-is; slug re-minted to `uuid4` |
| `user_id` | the real-user UUID | must be in `src/users.js` |
| `status` | — | always `active` |
| `active_flag` | — | always `1` (part of `UNIQUE(user_id, active_flag)`) |
| `race_date` | `race_date` | required |
| `race_distance` | `race_distance` | required |
| `race_name` | `race_name` | NULL if empty |
| `target_finish_time` | `target_finish_time` | NULL if empty |
| `weekly_training_days` | `weekly_training_days` | missing → `0` (Go int zero) |
| `available_time_slots` | `available_time_slots` | JSON-array text (`[]`, `["morning"]`); absent → NULL |
| `strength_willingness` | `strength_willingness` | NULL if empty |
| `race_location` / `race_timezone` | — | always NULL (the Python blob never carried them; the Go generator applies its Asia/Shanghai default downstream) |
| `created_at` / `updated_at` | same | ISO-8601 → UTC `datetime(6)`; carried from the blob (original authoring instant preserved), run time only as a fallback |

### Usage

```bash
# 1) Dry-run all real users (reads local JSON, prints a plan, writes nothing).
#    Reports which goals are UUIDs (kept) vs slugs (re-mint + snapshot rewrite).
npm run migrate:training-goals

# 2) Scope it down while testing
node src/migrate-training-goals.js --user f10bc353-01ab-4db1-af9f-d9305ea9a532
node src/migrate-training-goals.js --data-dir /path/to/repo/data --limit 3

# 3) Commit for real (recommended: one user first, verify, then all)
node src/migrate-training-goals.js --commit --user f10bc353-01ab-4db1-af9f-d9305ea9a532
node src/migrate-training-goals.js --commit
node src/migrate-training-goals.js --commit --ensure-schema      # create race_goal on a fresh DB
node src/migrate-training-goals.js --commit --skip-master-plan   # MySQL row only, no snapshot rewrite
```

Options: `--commit`, `--user <uuid>` (repeatable / comma list, allowlist-gated),
`--data-dir <path>`, `--limit <n>`, `--ensure-schema`, `--skip-master-plan`,
`--verbose`, `--help`. The data root resolves to `--data-dir` → `STRIDE_DATA_DIR`
→ the repo-root `data/` dir.

Env: the MySQL vars (as above) plus — for the phase-2 rewrite —
`STRIDE_MASTER_PLAN_TABLE_ACCOUNT_URL` (and optional
`STRIDE_MASTER_PLAN_TABLE_NAME`, default `stridemasterplan`; the versions table is
`<name>versions`). Point these at the **same** account the server uses
(`config/server.prod.toml` `[storage.master_plan]`); auth is
`DefaultAzureCredential` (run `az login`). See `.env.example`. With
`--skip-master-plan` no Azure access is needed.

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

The target tables are normally created by the corresponding runtime migration.
For a fresh DB, `schema.sql` holds the equivalent DDL for all ten tables;
migrations that expose `--ensure-schema` can apply it directly.

### Current season-plan cutover

The master-plan migration owns the explicit, outage-only transition from
`master_plan.version` to `master_plan.revision`; Go AutoMigrate must not infer the
rename. Dry-run always reads both Azure forms and MySQL, applies structured-over-
Markdown precedence, and emits only a redacted canonical manifest plus stable hash.

```bash
# Target-aware dry-run. The local manifest file is created mode 0600.
npm run migrate:master-plans -- --user <real-user-uuid> \
  --manifest-out ./reviewed-season-plans.json

# During the full Go API maintenance window, validate/upgrade the schema.
npm run migrate:master-plans:schema

# After manual review, commit exactly the reviewed manifest/hash.
npm run migrate:master-plans -- --commit --user <real-user-uuid> \
  --reviewed-manifest ./reviewed-season-plans.json \
  --reviewed-hash sha256:<hash-from-the-manifest>
```

The selected real-user set must exactly match the manifest. Every action binds the
selected UUID, Azure partition/blob owner, embedded user/plan IDs, manifest IDs,
and MySQL target IDs. Target discovery uses `active_flag=1 OR status='active'`;
duplicates, marker drift in either direction, target-only rows, or a different
current plan are conflicts and are never overwritten.

Commit re-reads every source and target before the first write and rejects any
identity/hash/classification drift. Inserts are per-user transactions; each commit
is independently read back and must produce exactly one valid current row with the
expected hash. Conflict manifests cannot commit. Legacy source `version` maps to
canonical `revision` without changing Azure.

Schema upgrade accepts only `version`-only (validate rows, rename, replace checks,
then validate) or `revision`-only (validate/no-op) states. Both/neither are
conflicts. Stop every old Go API instance before schema/data commit; on failure,
leave Go stopped and repair/re-run. Do not restart or roll back the old image
without manually reversing the schema first. See
`../../spec/go-current-season-plan-cutover.md` and ADR 0024.

## Tests

Pure transform + config + selection logic is covered without touching Azure,
MySQL, or the filesystem:

```bash
npm test
```
