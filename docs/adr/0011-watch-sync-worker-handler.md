# watch_sync worker handler

The COROS sync core (`internal/coros.Provider.SyncUser`) writes watch data to the canonical MySQL store via dependency injection and was built to back "a future worker job handler". This ADR records how that handler is wired into the async-job worker — the first real handler (the worker previously registered only `hello`).

## Decision

- **Job type `watch_sync`** — provider-agnostic. The handler resolves the provider (COROS or Garmin) **per user** via the registry, so one job type serves both. `job.PartitionKey` is the STRIDE user UUID.
- **Handler in `internal/handlers/watchsync`**, depending on a **minimal provider interface** (`IsLoggedIn(user)` + `SyncUser(ctx, user, opts)`) plus a `Resolver func(ctx, user) (Provider, error)`, so it unit-tests against a fake resolver + provider. `cmd/worker` injects the registry-backed resolver.
- **Payload-parameterized** via optional `InputJSON` `{ "mode": "incremental"|"full", "content": "all"|"activities"|"health", "limit": N }`. Absent/empty → **full + all + unlimited** (Python `onboarding_full_sync` parity). One job type serves both onboarding full syncs and routine incremental syncs.
- **Error classification** (a sync retry is safe — `SyncUser` upserts idempotently and advances a `last_label_id` cursor, so a retry resumes):
  - `IsLoggedIn(user)` false → **`PermanentError("not_logged_in")`** (checked up front; retrying can't fix a missing credential).
  - `AuthError` from `SyncUser` → **`PermanentError("auth_failed")`**.
  - Any other error → **retryable** (worker backoff → poison), resuming from the cursor.
- **Per-user provider resolution** (`registry.Resolve`): the MySQL binding wins — `store.ProviderForUser(user)` reads the provider of the user's most-recently-updated `provider_credentials` row; if the user has **no** MySQL credential, fall back to the file-based `registry.ProviderName` (`data/<uid>/config.json`, default `coros`). This realizes ADR 0010's "migrate the binding to `provider_credentials` (MySQL) later" for the worker path. A resolution fault (MySQL down) is retryable.
- **Progress → job row only.** Complete the sync client's declared-but-unwired `Progress` callback: `syncActivities` collects the activity list first (so the total is known), then emits `{phase, current, total, percent}` per activity-detail fetch; `syncHealth` emits per day. The handler bridges each event to `Heartbeat(stage=phase, progressPct=percent)`. Percent bands: activities `10→80`, health `80→95`; the terminal `100` is set by the dispatcher's `finishDone` on success (not the handler). No notification-center push.
- **Wiring:** reuse the worker's existing MySQL store (`AutoMigrateWatch` at boot); the resolver builds the provider via `registry.Build(name, store, 500ms)`. The only new config is `runtime.data-dir` (`STRIDE_WORKER_RUNTIME_DATA_DIR`, default `data`) used solely by the file-fallback binding.

## Considered options

- **`coros_sync` job type:** honest about the single implementation, but bakes the provider into the contract and forces a parallel `garmin_sync` later. Rejected for the provider-agnostic name.
- **Default incremental:** cheaper for routine runs, but the operator chose **default full** for Python parity / safe first sync; incremental is opt-in via payload.
- **Coarse handler-only heartbeats (no sync-client change):** functionally adequate because RabbitMQ needs no lease renewal, but gives no per-activity progress on long full syncs. Rejected — granular progress is where a 20-30 min onboarding sync pays off, and the `Progress` field exists for exactly this.
- **`sync.request-delay` worker config knob:** dropped — `coros.New` already defaults to 500ms; a tunable knob is premature until a deployment needs to change the rate.
- **Notification-center push (`syncing N/M`):** deferred — needs a Go notifications client + the Azure-Table notifications store in the worker; out of scope for wiring the handler.
- **File-only provider binding (`registry.ProviderName` + a worker data-dir mount):** rejected as primary — the worker is MySQL-canonical and has no per-user `config.json` volume, so it would resolve everyone to the default. Kept as the *fallback* for legacy file-bound users until they migrate to `provider_credentials`.
- **Provider in the job payload:** rejected — defers resolution to a trigger/API that doesn't exist yet; the handler should resolve per user autonomously.

## Consequences

- **Garmin users now sync correctly**: their `watch_sync` jobs resolve to the Garmin provider from the MySQL binding, rather than always using COROS.
- Progress heartbeats are **observability only** (no queue lease to renew under RabbitMQ); a job-status reader (future onboarding progress bar) consumes `stage`/`progress_pct`.
- `coros/sync.go` gains progress emission (behavior change to the "ready" sync client) covered by new tests; the CLI (`cmd/stride-sync`) can pass a nil `Progress` and is unaffected.
- **Out of scope (follow-ups):** the trigger (a scheduler, or wiring API→RabbitMQ enqueue), the notification-center push, and the Python-only calibration/backfill compute passes.
