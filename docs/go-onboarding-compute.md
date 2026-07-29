# Go onboarding compute — implementation spec

Status: **proposed** (design agreed via grilling; tolerances subject to review).
Companion to **ADR 0015**. Scope decisions and rationale live in the ADR; this
file is the actionable build plan.

## Goal

Complete the Go stride-api user onboarding flow: a native Go port of the
onboarding compute, wired as a two-step pipeline the browser/app can trigger,
running alongside the Python stack and validated by `reconcile` parity.

## What already exists (do not rebuild)

- `watch_sync` job handler — full/incremental watch-data sync into MySQL (ADR 0011).
- Pipeline orchestrator — `StartPipeline` / advance-on-complete (`internal/pipeline`).
- `cmd/api` — `POST /pipelines/{name}` + `GET /pipelines/{pk}/{run_id}`, dual auth,
  idempotency (ADR 0012). Trigger + poll are done.
- `internal/catalog` — shared source of truth; `Pipelines()` currently returns
  `nil`, so `POST /pipelines/onboarding` returns `400 unknown pipeline`.
- `reconcile` — tolerance-aware Go-vs-Python diff engine + `cmd/reconcile`, today
  covering activities only (ADR 0005).

## Target shape

```
POST /pipelines/onboarding  (user-initiable)
  └─ pipeline "onboarding"
       ├─ step "full_sync"           → job type "watch_sync"        (exists)
       └─ step "onboarding_compute"  → job type "onboarding_compute" (NEW, internal-only)
```

`onboarding_compute` opens a MySQL reader for the user, runs one merged compute
pass (parse each activity's timeseries **once**), and persists derived tables in
dependency order: **calibration + PBs → training load → ability**.

## New MySQL derived tables (Go owns schema — ADR 0006)

GORM models in `internal/storage/watch_models.go`, migrated by `AutoMigrateWatch`.
Mirror the Python SQLite columns so `reconcile` compares like-for-like:

| Go model / table | Mirrors Python (`stride_storage/sqlite/database.py`) | Key |
|---|---|---|
| `RunningCalibrationSnapshot` / `running_calibration_snapshot` | same (calibration_connector.py) | `(user_id, id)` autoincrement; latest by `as_of_date` |
| `ActivityTrainingLoad` / `activity_training_load` | same | `(user_id, label_id)` |
| `DailyTrainingLoad` / `daily_training_load` | same | `(user_id, date)` |
| `AbilitySnapshot` / `ability_snapshot` | same | `(user_id, date, level, dimension)` |
| `PersonalBest` / `personal_bests` | same | `(user_id, distance)` |

Every table gains the `user_id char(36)` column absent in per-user SQLite (MySQL
is multi-user). Baseline scalars to carry on the calibration snapshot: `threshold_hr`,
`threshold_speed_mps`, `rhr_baseline`, `observed_max_hr`, `hrmax_estimate`,
`high_hr_reference`, `critical_power_w`, `critical_speed_mps`, `d_prime_m`,
plus confidence enums, `algorithm_version`, `source_json`, and HR/pace zones.

## Go package layout (pure math, infra-free — mirrors `stride_core`)

The ported math stays I/O-free so it unit-tests and reconciles like the Python
single source. The handler is the only DB-aware piece.

```
internal/compute/calibration/   ← port of stride_core/running_calibration/{core,segments,zones,prediction}
internal/compute/trainingload/  ← port of stride_core/training_load/core (+ types)
internal/compute/ability/       ← port of stride_core/ability.py
internal/compute/pb/            ← port of stride_core/pb_records
internal/handlers/onboardingcompute/  ← job handler: reader → pure compute → persist
```

Handler mirrors `internal/handlers/watchsync`: a minimal reader/writer interface
+ per-user resolution, unit-tested against fakes; `cmd/worker` injects the
MySQL-backed store. Emits `Heartbeat(stage, progressPct)` — bands: calibration
`0→33`, load `33→66`, ability `66→100`.

## Delivery — tracer-bullet by dependency slice

Same pipeline + handler throughout; each slice is one PR that ships only when its
derived table reconciles clean.

**Slice 1 — calibration + PBs (makes the flow live end-to-end).**
- Add `RunningCalibrationSnapshot` + `PersonalBest` models + migrate.
- Port calibration + PB math; handler writes both.
- Register `onboarding_compute` (internal) + `onboarding` pipeline (user-initiable)
  in `catalog`. `POST /pipelines/onboarding` goes live.
- Extend `reconcile` for `running_calibration_snapshot` + `personal_bests`.
- **Gate:** reconcile clean vs Python for the athlete.

**Slice 2 — training load.**
- Add `ActivityTrainingLoad` + `DailyTrainingLoad` models + migrate.
- Port `training_load/core` (per-activity dose + 365-day CTL/ATL/Form warm);
  handler extends the same pass to write them after calibration.
- Extend `reconcile` for both tables.
- **Gate:** reconcile clean.

**Slice 3 — ability.**
- Add `AbilitySnapshot` model + migrate.
- Port `ability.py`; handler seeds 180-day ability snapshots reading the
  persisted calibration + load.
- Extend `reconcile` for `ability_snapshot`.
- **Gate:** reconcile clean.

## Reconcile parity gate

Hard, manual (needs a real synced athlete DB on both sides — CI has none),
**blocking** per slice. Zero `Exact` mismatches; floats within the tolerances
below. Proposed epsilons (tight on baselines, documented looser band on ability):

| Field group | Kind | Tol (proposed) |
|---|---|---|
| ids, enums, dates, `level`/`dimension`/`distance` keys, `algorithm_version`, `*_confidence`, `coverage_status`, `source` | Exact | 0 |
| `threshold_hr`, `hrmax_estimate`, `observed_max_hr`, `rhr_baseline`, `high_hr_reference` (bpm) | Float | ±0.5 |
| `threshold_speed_mps`, `critical_speed_mps` (m/s) | Float | ±0.01 |
| `critical_power_w` (W) | Float | ±1.0 |
| HR zone bounds / pace zone bounds | Float | ±1.0 bpm / ±0.01 m/s |
| `pb_time_sec` (s) | Float | ±0.5 |
| `training_dose`, `acute_load`, `chronic_load`, `form` | Float | ±0.5 |
| `load_ratio` | Float | ±0.01 |
| ability `value` (L2/L3/L4 scores, 0–100) | Float | ±1.0 *(documented — float accumulation over the ability chain)* |
| marathon/HM estimate seconds | Float | ±2.0 |

Run: `go run ./cmd/reconcile -profile <uuid> -sqlite data/<uuid>/coros.db` (extended
to diff derived tables). Never log credentials/PII.

## Explicit out-of-scope (tracked gaps)

- **Browser credential-submit endpoint** — assume creds pre-provisioned via
  `cmd/stride-sync import-creds`; browser onboarding is not fully complete until
  this ships.
- **Consumer read API** — this work stops at producing validated MySQL rows.
- **Python compute retirement** — separate, gated on parity holding over real
  athletes + all Python readers re-pointed to Go/MySQL.

## Single-source discipline (AGENTS.md)

Baseline math still lands in `stride_core/running_calibration/` (the Python single
source) **first**, then is ported to Go. The Go port is a knowing, time-boxed
second implementation; `reconcile` is the drift guard until Python retires
(ADR 0015).

## Verification per slice

- `cd src/go && go test ./...` (unit tests for the ported math + handler).
- `go build ./cmd/...` (worker + api compile; api needs `swag init` first).
- `go run ./cmd/reconcile ...` clean against the athlete — the blocking gate.
- `PYTHONPATH=src lint-imports` unaffected (Go-only change).
