# Go `POST /api/{user}/sync`: async data-sync pipeline (sync + compute)

The browser's manual "sync now" pill calls Python's synchronous `POST /api/{user}/sync`, which holds the request open for the whole sync and returns `{success, output}`. We add the Go equivalent as an **async façade over a pipeline**: it starts a data-sync pipeline for the user and returns **202 `{run_id, pipeline_name}`**; the Web BFF/client polls `GET /api/pipelines/{run_id}`. It is the `/api/*`-shaped door the browser needs, since the path-preserving BFF (ADR 0017) proxies only `/api/*` and cannot reach Go's root-level `POST /jobs` / `POST /pipelines/{name}`.

**A sync is sync + compute, not just sync.** A watch sync only lands raw activity/health rows; the derived metrics (per-activity training load, daily PMC — CTL/ATL/Form — and personal bests) still need computing, which Python did in its post-sync hook. So `/api/{user}/sync` starts a pipeline, and `mode` picks which one:

- **`incremental`** (default): `data_sync` = `watch_sync(incremental)` → `compute(incremental)`. Syncs only new activities and computes only those.
- **`full`**: `onboarding` = `watch_sync(full)` → `calibration` → `compute(full)`. Re-syncs history, recomputes the athlete baseline, and does a full compute. This is also the new-user onboarding path.

The user tier may sync only its own id (path `{user}` must equal the JWT `sub`, else 403); the internal tier may sync any user (path must be a UUID), collapsing Python's separate `/internal/sync` route into the same path.

**Build-only, not cut over.** The route-table entry is marked `goReady: true` but left `upstream: 'python'`. Go's compute writes the MySQL shadow store (ADR 0005) that no read endpoint consumes yet, so flipping now would make the pill "succeed" while the user's activities/health (still read from Python SQLite) don't change. The flip is a later step gated on the read endpoints migrating, and it also needs the pill to poll instead of await — so the cutover is not "just routing".

**Onboarding completion is implemented separately.** `POST /api/{user}/sync` with `mode:"full"` starts the full-history `onboarding` pipeline and returns `run_id`; it does not alter onboarding completion state. The Web client polls that run through `GET /api/pipelines/{run_id}`. A `done` status only makes the run eligible for `POST /api/users/me/onboarding/complete {"run_id":"..."}`. When the user selects **Enter STRIDE**, that finalizer verifies the caller, pipeline name, and terminal success before recording completion; it never starts, resumes, or retries work. `GET /api/users/me/sync-status` is legacy/read-only associated-run status and is not part of Web onboarding.

## The compute split (calibration vs compute)

The former single `onboarding_compute` job is split into two job types, because the derived metrics have different update cadences:

- **`calibration`** — the athlete baseline (HRmax / LTHR / threshold pace / RHR / critical power + zones) is a **180-day-window constant**, not a per-activity value. It cannot be computed "for the new activity"; it is recomputed over the window. It runs once at onboarding (a step of the `onboarding` pipeline) and, later, on a weekly cadence (a standalone job — the weekly trigger itself is deferred; Python's `weekly-running-calibration.yml` is the model). `compute` **reads** the latest snapshot (single-source rule) rather than recomputing it.
- **`compute`** — per-activity training load + daily PMC + PBs, mode-aware:
  - **full**: recompute the window and replace-all.
  - **incremental**: per-activity load only for this sync's new `label_ids` (upsert by label); daily PMC seeded from the prior day's CTL/ATL and extended over `[earliest-new-day, today]`; PBs detected among the new activities and upserted only where they beat the existing best. This respects each metric's nature — per-activity metrics are truly incremental, the cumulative PMC continues from prior state, and the window baseline is out of scope here.

## Pipeline I/O threading

Pipelines gained a run-level `InputJSON` (persisted on `pipeline_runs`) that the orchestrator threads into every step, **merged with the previous step's `ResultJSON`** (run input wins on key conflict). This lets `mode` reach both the sync and compute steps, and lets `watch_sync` hand its `label_ids` to the incremental `compute` step. (In the 3-step `onboarding` pipeline the intermediate `calibration` result sits between sync and compute, so its `label_ids` don't reach compute — which is fine, because onboarding's compute is *full* and does not need them.)

## Considered options

- **Synchronous façade** (block the request until the sync+compute finish, return Python's `{success, output}`): keeps the pill unchanged, but holds a public gin ingress open for the whole run and couples API latency to worker throughput — exactly the anti-pattern ADR 0012's async design avoids. Rejected.
- **Reuse `POST /jobs {type: watch_sync}` and drop the new endpoint**: the browser cannot reach `/jobs` through the path-preserving BFF, it exposes the generic infra endpoint to the browser tier, and (crucially) a bare `watch_sync` job does no post-sync compute. Rejected for the browser pill.
- **One `data_sync` pipeline with a mode-gated calibration step** (skip calibration when incremental): matches "one pipeline, two modes" but needs new conditional-step machinery in the orchestrator. Rejected in favour of two pipeline definitions behind one endpoint (the endpoint maps `mode` → pipeline name), which needs no new machinery and keeps `calibration` a real, independently-triggerable job.

## Consequences

- **Pipeline and onboarding state are distinct.** `pipeline_runs.status = done` means derived data is ready; `user_onboarding.completed_at != NULL` is a later, explicit user-confirmed transition. The latter can occur only when the finalizer verifies the submitted successful onboarding `run_id`.
- **Python's per-user sync lock is intentionally dropped.** Python serialized syncs per user via an in-process `threading.Lock` (`sqlite_writer.py`) because SQLite is single-writer and a concurrent sync errors hard. Go's work runs out-of-process in the worker with no partition affinity, so two runs for one user can overlap. This is safe (not prevented): writes are cursor-based upserts into MySQL, which tolerates concurrent writers, so overlap is idempotent — wasteful, not corrupting. True per-user serialization (partition→consumer affinity or a distributed lock) is a worker-layer follow-up.
- **Shared payload contract.** The `{mode, content, limit}` schema lives once in `internal/provider` (`SyncOptionsInput` + `ParseSyncOptions`), used by both the API edge (validate → 400) and the `watch_sync` handler.
- **The API stays decoupled from `internal/catalog`:** the `watch_sync` job-type name and the two pipeline names are injected via `Config` (`WatchSyncJobType`, `SyncPipelineFull`, `SyncPipelineIncremental`), not imported.
- **Deferred:** the weekly `calibration` trigger, and the incremental PMC's handling of far-backdated activities (an activity dated far in the past widens the recompute window, which is correct but larger than the common recent-activity case).
