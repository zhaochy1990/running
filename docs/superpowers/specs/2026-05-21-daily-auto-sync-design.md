# Daily Auto-Sync Design

## Goal

Sync every registered user's watch data (COROS / Garmin) once per day at 24:00
Asia/Shanghai automatically, without requiring the user's local machine to be
running or anyone clicking a button.

## Scope

This change adds a scheduled GitHub Actions workflow plus one new internal
FastAPI endpoint. It does not change sync logic, post-sync hooks, the
database schema, deployment of `stride-app`, or any frontend behavior.

It does not add new credential storage: each user's COROS/Garmin credentials
already live in prod at `data/{uuid}/config.json` (Azure Files mount). The
workflow only triggers prod to act; it never sees credentials.

## Architecture

The pattern is a direct twin of `.github/workflows/weekly-running-calibration.yml`:

```
GitHub Actions cron (24:00 Asia/Shanghai)
  └─ for each UUID in data/.slug_aliases.json:
       curl POST $STRIDE_PROD_URL/internal/sync?user={uuid}
       with X-Internal-Token: $STRIDE_INTERNAL_TOKEN
            │
            ▼
       stride-app (Azure Container App)
            └─ source.sync_user(uuid) + run_post_sync_for_result(...)
```

The workflow does no sync work itself; it only fires HTTP webhooks at prod.
All COROS/Garmin API traffic, DB writes, post-sync events, and per-activity
logging happen inside the long-running `stride-app` container, exactly as
they do today for manual `/api/{user}/sync` calls.

## New Endpoint: `POST /internal/sync`

Location: `src/stride_server/routes/sync.py` (existing file).

The current file exports `router` mounted at `/api/{user}/sync` behind Bearer
JWT. The change adds a sibling `internal_router` that does the same work
behind `X-Internal-Token` instead:

| Field | Value |
|-------|-------|
| Method | `POST` |
| Path | `/internal/sync` |
| Query | `user={uuid}` (required), `full=false` (optional) |
| Auth | `Depends(require_internal_token)` — the helper already used by `plan.internal_router` and `training_load.internal_router` |
| Body | none |
| Response | same shape as `/api/{user}/sync`: `{"success": bool, "output": str}` or `{"success": false, "error": str}` |

Implementation extracts the existing sync body of `trigger_sync` into a
private helper `_run_sync(user, full, source)` so both routes (`/api/{user}/sync`
and `/internal/sync`) call the same code path. The Bearer-protected route is
not changed in behavior.

Mounting: in `src/stride_server/app.py`, add
`app.include_router(sync.internal_router)` next to the existing
`plan.internal_router` / `training_load.internal_router` lines.

User resolution: the endpoint takes a UUID, not a slug. The workflow already
resolves slugs to UUIDs by reading `data/.slug_aliases.json` (same as the
calibration workflow). Path validation: reject any `user` that does not match
the `_UUID4_RE` pattern used elsewhere in the codebase (return 422).

Provider selection: reuses `get_source_for_user`, which reads
`data/{uuid}/config.json` to pick between `CorosDataSource` and
`GarminDataSource`. No change there.

## New Workflow: `.github/workflows/daily-sync.yml`

Structurally copied from `weekly-running-calibration.yml`:

```yaml
name: Daily auto-sync

on:
  schedule:
    # 16:00 UTC = 24:00 (00:00 next day) Asia/Shanghai. UTC+8 has no DST.
    - cron: '0 16 * * *'
  workflow_dispatch: {}

jobs:
  sync:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - name: Build user UUID list from data/.slug_aliases.json
        ...
      - name: Trigger sync per user
        ...
```

Differences from the calibration workflow:

- **Cron**: `'0 16 * * *'` (daily) instead of `'0 4 * * 0'` (weekly Sunday).
- **Endpoint**: `/internal/sync?user=$uuid` instead of
  `/internal/training-load/calibration/refresh?user=$uuid`.
- **Timeout**: `--max-time 300` per user. Calibration uses 60s because it
  reads cached values; a full COROS sync occasionally takes 1–3 minutes when
  pulling many new activities + timeseries. Generous timeout, single retry
  via `workflow_dispatch` if a user fails.

Everything else is identical: same secret names (`STRIDE_PROD_URL`,
`STRIDE_INTERNAL_TOKEN`), same fail-loud behavior when secrets are unset,
same `$GITHUB_STEP_SUMMARY` table, same "single user fail does not block
others; exit 1 if any failed."

## Why GitHub Actions, not Azure Container App Job

The repo already has a precedent for daily cron jobs as Azure Container App
Jobs (`stride-plan-reminder`, fires the JPush notification job daily at
07:55 SH). We pick GitHub Actions instead because:

- The user explicitly preferred this pattern.
- `weekly-running-calibration.yml` already proves the cron-+-internal-webhook
  shape works for this exact problem class.
- Schedule lives in git and is reviewable via PR; an Azure Container App Job
  schedule lives only in `az containerapp job` state and is invisible to
  reviewers.
- One less infrastructure piece to maintain (no `deploy.yml` change to keep
  the job's image tag in sync).

The trade-off: GitHub Actions scheduled jobs are not punctual — they can be
delayed by several minutes (GitHub's own SLO disclaimer). Auto-sync is
delay-tolerant; a 24:05 sync is as good as a 24:00 sync.

## Why not reuse `/api/{user}/sync`

The existing Bearer-protected route requires a real user's JWT. GitHub
Actions can't (and shouldn't) hold a per-user JWT. The `X-Internal-Token`
pattern is the established server-to-server seam in this repo
(`plan.internal_router`, `training_load.internal_router`, sync-data.yml
reparse webhook). Reusing it keeps the auth surface uniform and avoids
fabricating a service-account JWT just for this.

## Failure Modes & Observability

| Failure | Behavior |
|---------|----------|
| User missing `config.json` (not logged in) | Endpoint returns `{success: false, error: "未登录…"}` (existing behavior). Workflow logs HTTP 200 + the error message in the summary table. No retry. |
| COROS API down for one user | `source.sync_user` raises; endpoint returns `{success: false, error: "sync failed"}`. Workflow marks that row failed; loop continues. |
| Prod endpoint unreachable | curl returns HTTP 000 / non-2xx. Workflow marks row failed; loop continues; workflow exits 1 so it's visible in GitHub Actions. |
| `STRIDE_PROD_URL` or `STRIDE_INTERNAL_TOKEN` missing | Workflow exits 1 immediately at the secret check (matches calibration workflow). |
| Post-sync hook throws | Already swallowed and logged by existing `trigger_sync` code; the sync result still returns success. No change. |
| Whole workflow not scheduled by GitHub on time | Tolerated. Manual `workflow_dispatch` available. If a sync is skipped for 24h, the next day's run captures the gap (each `source.sync_user` is incremental and idempotent). |

Per-activity sync log goes to the `stride-app` container stdout (Azure
Container App log stream), same as today. The GitHub Actions run only
records the endpoint's summary string per user.

## Out of Scope

- Parallel per-user sync (current `xargs -P` style). Six users × ≤3 min serial
  = ≤18 min wall time, well within GitHub Actions runner quota. Revisit when
  user count grows.
- Adaptive retry on transient COROS failures. Manual re-trigger via
  `workflow_dispatch` is the escape hatch.
- New SQLite tables or new fields. Auto-sync writes through the existing
  sync path; no new data shape.
- Per-user opt-out. All users in `data/.slug_aliases.json` are synced. An
  opt-out toggle in Azure Table prefs is a future change if needed.
- Local-machine cron. Out of scope; this design only touches prod sync state.

## File Changes Summary

| File | Change |
|------|--------|
| `src/stride_server/routes/sync.py` | Add `internal_router` with `POST /internal/sync`; extract shared `_run_sync` helper. |
| `src/stride_server/app.py` | One `app.include_router(sync.internal_router)` line in the internal-router block. |
| `.github/workflows/daily-sync.yml` | New file, ~90 lines, mirrors `weekly-running-calibration.yml`. |
| Tests | One new test under `tests/` covering the new internal route: 401 when token missing, 422 on bad UUID, success path with a stubbed `DataSource`. |
