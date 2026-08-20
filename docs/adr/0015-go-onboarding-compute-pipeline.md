# Go onboarding pipeline: native compute port (2-step), dual-run toward Python retirement

> **Runtime topology superseded.** This historical decision records the original
> two-step proposal. The deployed Go catalog in `internal/catalog/catalog.go` is
> `sync → race_detection (optional) → calibration → compute` (ADR 0020 / 0029),
> not `full_sync → onboarding_compute`.
> Generic sync starts a pipeline only; a successful run is finalized separately by
> explicit `run_id` submission after the user selects **Enter STRIDE**.

The Go worker can already sync a user's watch data (`watch_sync`, ADR 0011) and
`cmd/api` (ADR 0012) can start pipelines, but the onboarding *pipeline* has no
definition and the Python-only calibration/backfill compute passes have no Go
handler. This ADR records how we complete the Go onboarding flow: a native Go
port of the onboarding compute, wired as a two-step pipeline, run alongside the
Python stack and gated on `reconcile` parity.

Python onboarding runs three worker steps — `full_sync → calibration → backfill`
(`stride_core/onboarding_compute.py`): calibration persists the athlete
baselines (HRmax / LTHR / threshold speed / RHR / critical power / zones) plus
personal bests; backfill warms a 365-day training-load (CTL/ATL/Form) series and
seeds 180 days of ability snapshots. Backfill *reads* the calibration snapshot,
so the order is a data dependency, not duplicate work.

## Decision

- **Two-step pipeline, not three.** The Go `onboarding` pipeline is
  `full_sync → onboarding_compute`. `full_sync` maps to the existing
  `watch_sync` job type (empty payload → full + all, ADR 0011). `onboarding_compute`
  is one handler that runs calibration, load, ability, and PBs. We collapse
  Python's `calibration` + `backfill` into a single step because the split forces
  a second job dispatch, a second DB open, and — most concretely — a **second
  parse of every activity's timeseries** (calibration fits thresholds from the HR
  streams; the load pass re-reads the same streams for dose). One merged pass
  parses each activity once and feeds calibration → load → ability in dependency
  order.
- **`onboarding_compute` is a native Go port**, reading the canonical MySQL watch
  data and writing new MySQL derived tables (calibration snapshot, daily training
  load, ability snapshot, personal bests — Go owns the schema, ADR 0006). Not a
  stub, not a call-back into Python: the destination is Go owning this compute.
- **Catalog wiring.** `onboarding_compute` is added to the catalog as an
  **internal-only** job type (users start the *pipeline*, never the compute step
  directly); the `onboarding` pipeline is added as **user-initiable**. That single
  catalog edit flips `POST /pipelines/onboarding` from `400 unknown pipeline` to
  live — no new HTTP surface (ADR 0012 already ships the endpoint, auth, and
  idempotency).
- **Dual-run this iteration; Python untouched.** The end-state is Go replacing the
  Python compute, but this iteration ships only the Go side running *alongside*
  Python. The Python/SQLite stack keeps computing and keeps serving today's Azure
  users. **Python remains the authoritative number** during the dual-run.
- **`reconcile` parity is the correctness gate and the retirement trigger.** Each
  derived table is validated Go-vs-Python with the tolerance-aware diff engine
  (ADR 0005), extended with readers + a `[]Field` tolerance spec per table.
  Retiring the Python compute is **separate, later work**, gated on (a) parity
  holding over real athletes within tolerance and (b) every Python reader of these
  tables re-pointed to Go/MySQL.
- **Single-source exception is deliberate and time-boxed.** AGENTS.md requires
  athlete baselines to live *only* in `src/stride_core/running_calibration/`.
  The Go port is a knowing, temporary second implementation of that single-source
  math in another language — justified solely by the Go-replaces-Python migration.
  `reconcile` is the drift guard while both exist; the end-state has exactly one
  implementation (Go) once Python retires. New baseline logic still lands in the
  Python single source first, then is ported.
- **Tracer-bullet delivery by dependency slice.** `onboarding_compute` grows in
  three PRs behind the same pipeline/handler: (1) calibration + PBs, (2) daily
  training load, (3) ability. Each slice ships only when its derived table
  reconciles clean; the pipeline shape never changes.
- **Hard, tolerance-defined parity gate.** A slice cannot ship until `reconcile`
  runs clean against a real athlete: **zero** `Exact` mismatches (ids / enums /
  dates), baseline scalars within a **tight** float tolerance, ability composites
  within a **documented, looser** per-dimension band. Manual (needs a real synced
  DB on both sides, so CI cannot run it) but **blocking**, like the repo's browser
  smoke test.

## Considered options

- **Keep Python's 3-step shape for parity.** Rejected — the split buys nothing in
  Go and pays a double timeseries parse plus extra orchestration; merging is a
  pure structural win with no behavior change.
- **Stub the compute / call back into Python.** Rejected — a stub feeds a consumer
  nothing; calling Python re-tethers the Tencent worker to the Azure stack the
  rewrite exists to decouple.
- **Two canonicals allowed to diverge.** Rejected — the baselines are the same
  physiological facts about one athlete; two apps showing different numbers is a
  trust bug, and it is exactly what AGENTS.md's single-source rule prevents.
- **Retire Python compute in this iteration.** Rejected — retiring battle-tested
  code before parity is proven ships silently-wrong baselines, and it would strand
  the live Python readers that still consume these tables from SQLite.
- **Big-bang the ~6,500-line port, reconcile at the end.** Rejected — reconciling
  three modules diverging at once is intractable; slice-by-slice isolates drift.
- **CI-automated parity gate.** Rejected for now — `reconcile` needs a real synced
  athlete DB on both sides, which CI has no source for; the gate is a blocking
  manual step instead.
- **Build a browser credential-submit endpoint + a consumer read API here.**
  Deferred — credential submission is a security-sensitive surface that belongs
  with the "connect watch" UX; the read API's shape depends on the consumer's UI.
  Both are tracked follow-ups.

## Consequences

- **A second implementation of the single-source baseline math now exists**
  (Python/SQLite + Go/MySQL). This is a knowing exception to AGENTS.md, valid only
  through the migration; `reconcile` is the mechanical drift guard and its parity
  gate is load-bearing.
- **New canonical MySQL derived tables** (calibration snapshot, daily training
  load, ability snapshot, personal bests) join the Go-owned schema (ADR 0006), with
  matching GORM models + `AutoMigrateWatch`.
- **`reconcile` grows** derived-table readers on both stores and per-metric
  tolerances; it stays a manual dev tool.
- **Historical gap closed elsewhere.** Browser watch credential submission now
  exists at `POST /api/users/me/watch/login`. It remains separate from the Web
  sync/finalize handshake: generic full sync returns `run_id`; only explicit
  finalization of the completed run marks onboarding complete.
- **Python compute retirement is a tracked future flip**, unblocked only once
  parity holds and readers are migrated; nothing here removes Python.
