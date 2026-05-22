# Backend E2E Smoke Test Design

## Goal

After every prod deploy of the STRIDE backend (`stride-app` on Azure Container Apps), run a manual one-command smoke test that hits the live prod API end-to-end and reports pass/fail on the core read paths within ~30s. Failure means "do not consider the deploy green" — the human operator decides whether to roll back.

This is **v1**: read-only, manually triggered, single test user, no GitHub Actions integration. Wider coverage (writes, sync triggering, scheduled cron) is explicitly out of scope and deferred.

## Non-Goals

- **Not** wired into `deploy.yml` or any other workflow. v1 is local-machine `pytest` only.
- **Not** running on every PR — `ci.yml` continues to run unit + frontend tests, never hits prod.
- **Not** mutating prod data. All requests are GET. No `POST /sync`, no feedback writes, no commentary push.
- **Not** auto-rolling back on failure. The smoke run prints a report; the human reads it.
- **Not** covering the coach agent (S1/S2/S3 generation) — too slow and side-effectful for a smoke gate.
- **Not** covering frontend behavior — backend response only. (One test does hit `GET /` to verify the SPA bundle is served, but does not exercise JS.)

## Current State

- Prod backend: `stride-app` Container App in `rg-running-prod`, fronted by a fixed FQDN.
- Auth: external auth-service (Rust/Axum) issues RS256 JWTs. STRIDE backend verifies signature locally via public key env var. `/api/health` is the only unauthenticated route; everything else under `/api/*` requires `Authorization: Bearer <jwt>`.
- Deploy gate: `.github/workflows/deploy.yml` already curls `/api/health` against the new revision and asserts `runningState=Running` before declaring success. This catches "container failed to boot" but **not** "boot succeeded yet auth/DB/Azure-Files mount is broken."
- Existing tests: `tests/` is unit-only, uses FastAPI `TestClient`, never makes outbound network calls.
- Pytest config (`pyproject.toml`): `testpaths = ["tests"]`, `pythonpath = ["src"]`.

The gap this design fills: no automated way to confirm "the live prod URL actually serves correct authenticated responses" after a deploy.

## Architecture

### Directory layout

```
tests/e2e/
  __init__.py
  conftest.py                  # session fixtures: config, token, user_id, http client
  test_smoke.py                # 7 read-only test cases
  e2e.config.example.json      # committed template
  e2e.config.local.json        # .gitignore'd — real credentials
  README.md                    # how to run, prerequisites, seed steps
scripts/
  smoke-prod.sh                # one-line entrypoint wrapping pytest
```

`tests/e2e/` sits beside the existing `tests/` flat unit tests but is opt-in via a pytest marker (see below) so the default `pytest` invocation used in `ci.yml` never reaches it.

### Pytest marker / discovery

- Register a custom marker `e2e` in `pyproject.toml` under `[tool.pytest.ini_options].markers`.
- Add `addopts = "-m 'not e2e'"` to the same section so a bare `pytest` skips e2e cases.
- All cases in `tests/e2e/test_smoke.py` are decorated `@pytest.mark.e2e`.
- The smoke runner explicitly passes `-m e2e` to flip the filter on.

This means the existing `pytest tests/` invocation in `ci.yml` continues to run only unit tests with no changes to CI.

### Configuration file

Configuration lives in a single git-ignored JSON file at `tests/e2e/e2e.config.local.json`. No environment variables. The committed `e2e.config.example.json` is the schema-by-example:

```json
{
  "prod_url": "https://stride-app.victoriousdesert-bd552447.southeastasia.azurecontainerapps.io",
  "auth_url": "https://auth-backend.delightfulwave-240938c0.southeastasia.azurecontainerapps.io",
  "client_id": "app_62978bf2803346878a2e4805",
  "e2e_email": "stride-e2e@example.com",
  "e2e_password": "<fill in>"
}
```

All five fields are required. The loader:

1. Looks for `tests/e2e/e2e.config.local.json`.
2. If missing → fixture raises `pytest.skip("e2e config not found at <path>; copy e2e.config.example.json and fill in credentials")`. The whole suite shows as skipped, not failed.
3. If present but missing fields → fixture fails loudly with the missing key list.
4. CLI override: a custom pytest flag `--e2e-config=<path>` lets a future staging environment use a sibling file (e.g., `e2e.config.staging.json`). Not required for v1 — the flag exists but the default path is enough.

`.gitignore` gets one new line: `tests/e2e/e2e.config.local.json`.

### Auth bootstrap

`conftest.py` exposes session-scoped fixtures:

- `e2e_config` — parsed JSON dict.
- `e2e_token` — depends on `e2e_config`. POSTs `{auth_url}/api/auth/login` with `X-Client-Id: {client_id}` and body `{"email": ..., "password": ...}`, returns `access_token`. Login failure → fixture errors with the auth-service status code and response body so debugging is trivial.
- `e2e_user_id` — decodes the JWT (no signature verification — we already trust the token we just got) and returns `payload["sub"]`. This is the UUID the per-user routes need.
- `prod_client` — an `httpx.Client(base_url=prod_url, headers={"Authorization": f"Bearer {e2e_token}"}, timeout=15.0)`.

`httpx` is already a project dependency. No new packages needed for the core suite. An optional `pytest-html` is treated separately — see Reporting; the suite must pass without it installed.

### Test cases

Seven cases. Each is one `def test_*` function, one or two assertions. Together they take well under 30 seconds against prod (real network latency dominates).

| # | Name | Method/Path | Auth | Asserts |
|---|------|-------------|------|---------|
| 1 | `test_liveness` | `GET /api/health` | none | 200; body equals `{"status": "ok"}` |
| 2 | `test_unauthenticated_is_401` | `GET /api/users` (raw client, no Bearer) | none | 401 |
| 3 | `test_users_returns_current_user` | `GET /api/users` | bearer | 200; response is a list; at least one entry has `id == e2e_user_id` |
| 4 | `test_home_dashboard` | `GET /api/{user}/home` | bearer | 200; JSON; contains the keys the home page expects — concrete list pulled from `HomeResponse` schema (see Implementation Plan note below) |
| 5 | `test_weeks_list` | `GET /api/{user}/weeks` | bearer | 200; list non-empty (proves Azure Files mount + plan.md discovery works); each entry has a `folder` field |
| 6 | `test_activities_list_and_timezone` | `GET /api/{user}/activities?limit=5` | bearer | 200; list non-empty; for each row, `date` string parses as ISO and represents a Shanghai-day-aligned timestamp (i.e., the route applied `utc_iso_to_shanghai_iso`, not raw UTC) |
| 7 | `test_spa_bundle_served` | `GET /` | none | 200; `content-type` starts with `text/html`; body contains `id="root"` |

Notes per case:

- **Case 2** uses a raw `httpx.Client` (no auth header) rather than `prod_client`, so it actually exercises the unauthenticated path. It does not reuse the session client.
- **Case 4** asserts schema-shape, not specific values, because the dashboard content varies day-to-day. The exact list of expected keys is finalized during plan implementation by reading `HomeResponse` in `src/stride_server/routes/home.py`.
- **Case 6** is the one case that catches the timezone regression class. It does not need to verify the *correct* Shanghai day for today — just that the offset is applied. The cheapest check: parse the timestamp and confirm it has a `+08:00` offset (or matches the format produced by `utc_iso_to_shanghai_iso`), which is enough to catch the bug where a route forgets to call the helper.
- **Case 7** catches the deploy class of bug "Docker stage 1 (Vite build) silently failed and the image shipped without the SPA bundle." Cheap insurance.

### Test user seed

The e2e user must have **at least one activity** (case 6) and **at least one weekly plan folder** (case 5) so the read endpoints return non-empty. Without seed data these cases would false-fail on a fresh account.

Seed steps, done once by a human before the first smoke run (documented in `tests/e2e/README.md`, not automated by this design):

1. Register `stride-e2e@…` via auth-service signup.
2. Note the resulting `user_id` UUID.
3. Either: connect a real COROS account to that user and run `coros-sync -P <uuid> sync` once to pull at least one activity, OR insert one synthetic activity row directly into `data/<uuid>/coros.db` via SQL. Real-data path is preferred since it also validates COROS sync.
4. Create one minimal `data/<uuid>/logs/2026-05-22_05-22(e2e)/plan.md` + `plan.json` and let `sync-data.yml` push them to Azure Files. A minimal valid `plan.json` per `docs/plan-json-schema.md` is enough; running content is irrelevant — only existence matters for the smoke test.

The seed is **stable**: once done it does not need to be redone for subsequent smoke runs. If the seed activity rolls off retention or the plan folder is archived, the smoke would start failing in a way that's easy to diagnose from the report.

### Runner script

`scripts/smoke-prod.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec pytest tests/e2e -m e2e -v "$@"
```

Two-argument forms are forwarded so a user can run `./scripts/smoke-prod.sh -k activities` to filter, or `./scripts/smoke-prod.sh --e2e-config=tests/e2e/e2e.config.staging.json` later.

### Reporting

Default `pytest -v` output to stdout is the primary report. As a stretch convenience, add `pytest-html` as a dev-extras dependency (it is small and unobtrusive) and wire the script to also emit `out/e2e-report.html`. If `pytest-html` is not installed, the script prints a hint and continues — the HTML file is a nice-to-have, not a gate.

`out/` is added to `.gitignore` if it isn't already.

### Failure semantics

- Any test fail → pytest exit code 1 → script exit code 1. The human sees the failed test name + the actual response in the pytest output.
- Auth bootstrap failure (login 401) → fixture errors with `auth-service login failed: {status} {body}`. Distinguishable from API-side failures because no individual test case runs.
- Missing config → suite shows as skipped, with a single clear message. Not a fail.

## Files Added / Modified

| File | Change |
|------|--------|
| `tests/e2e/__init__.py` | new (empty) |
| `tests/e2e/conftest.py` | new — fixtures: config loader, login, user_id, http client |
| `tests/e2e/test_smoke.py` | new — 7 test cases |
| `tests/e2e/e2e.config.example.json` | new — committed template |
| `tests/e2e/README.md` | new — how to set up the test user, fill the config, run the script |
| `scripts/smoke-prod.sh` | new — one-line entrypoint |
| `pyproject.toml` | add `e2e` marker; add `addopts = "-m 'not e2e'"`; add `pytest-html` to `[project.optional-dependencies].dev` |
| `.gitignore` | add `tests/e2e/e2e.config.local.json` and `out/` (if not already ignored) |

No changes to `src/`. No changes to existing tests. No changes to any GitHub Actions workflow.

## Testing the Smoke Test

The smoke test itself is exercised by running it against prod after this design's implementation is merged and deployed. Since it has no unit tests of its own (it *is* a test), the validation plan is:

1. Run it once against prod with a working config → all 7 cases pass.
2. Run it once with a deliberately bad token (e.g., flip a byte) → confirm cases 3–6 fail with 401, case 1 still passes, case 2 still passes (it doesn't use a token), case 7 still passes (no auth).
3. Run it once with the prod URL pointed at a non-existent host → confirm the failure mode is clean (connection error, not a misleading assertion).
4. Run `pytest` (no args) → confirm e2e cases are skipped by the marker filter, unit tests still run normally.

These validation steps are documented in `tests/e2e/README.md` as the acceptance checklist for the first merge, not automated.

## Future Work (Explicitly Deferred)

- `workflow_dispatch` GitHub Action that invokes `scripts/smoke-prod.sh` so the smoke can be triggered from the GH UI without a local checkout. Trivial to add (10 lines of yaml) once v1 is proven.
- Auto-running the smoke as the final step of `deploy.yml`, gating the deploy. Wait until the suite has a track record of zero flakes.
- Scheduled cron (hourly) external uptime smoke. Different concern from deploy smoke; if added, lives in a separate workflow.
- Write-path coverage: a `PUT /api/{user}/weeks/{folder}/feedback` round-trip against the e2e user. Requires deciding on cleanup strategy.
- Rollback automation on smoke fail. Needs separate validation of the rollback path itself.
