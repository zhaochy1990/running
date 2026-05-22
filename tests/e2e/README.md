# E2E smoke tests (prod)

End-to-end checks that exercise the deployed `stride-app`, not local dev
servers. Use these to confirm a release actually rendered the change you
expected, not just that unit tests pass.

These are intentionally *not* wired into CI:

- They depend on real user credentials that live outside the repo.
- They hit prod, so a flake here is a real signal worth investigating
  interactively, not auto-retrying in CI.

## Suites

| File                      | Stack          | Verifies                                                |
|---------------------------|----------------|---------------------------------------------------------|
| `prod-health-check.mjs`   | Node + Playwright | Login + `/health` rendering (HRV trend chart, adaptive Watch Extras cards). Written for PR #39 to validate COROS HRV ingestion + the WatchExtrasSection rename end-to-end. |
| `test_smoke.py` (run via `scripts/smoke-prod.sh`) | Python + pytest + httpx | Backend API smoke: liveness, auth (200 + 401), `/api/users`, `/api/{user}/home`, `/api/{user}/weeks`, `/api/{user}/activities` (Shanghai `+08:00` offset), and the SPA bundle at `/`. |

The two suites use independent credential mechanisms (Playwright reads
`.credentials.local`; the pytest suite reads `tests/e2e/e2e.config.local.json`)
so you can run either without configuring the other.

---

## Playwright suite — `prod-health-check.mjs`

### Prerequisites

1. **Playwright + chromium** — easiest is a throwaway install:
   ```bash
   cd /tmp && npm install playwright
   npx --no-install -p playwright playwright install chromium
   ```
   System libs that chromium needs on Debian/Ubuntu (one-time `sudo`):
   ```bash
   sudo apt install -y libnspr4 libnss3 libasound2t64 libatk-bridge2.0-0 \
     libcups2 libgbm1 libpango-1.0-0 libxcomposite1 libxdamage1 libxfixes3 \
     libxrandr2 libxkbcommon0
   ```

2. **Credentials** — hand-write `.credentials.local` (or a named override):
   ```
   email=you@example.com
   password=...
   ```
   File is git-ignored (see `.gitignore`). Same file the COROS CLI uses; see
   `docs/auth-wiring.md`.

   For ongoing per-provider regression coverage, also keep:
   - `.credentials.zhaochaoyi.local` — exercises the COROS code path
   - `.credentials.dingchentao.local` — exercises Garmin

   The script picks the right file via `--profile <name>`; without the
   flag it falls back to `.credentials.local`.

3. **Prod URL** — optional. The script defaults to the documented prod URL;
   override with `STRIDE_PROD_URL` if you're pointing at a staging slot.

### Run

```bash
# Default — reads .credentials.local
node tests/e2e/prod-health-check.mjs

# Provider-targeted — reads .credentials.<profile>.local, switches the
# Sleep / BodyBattery / Stress visibility expectations to match what
# WatchExtrasSection should render for that provider:
node tests/e2e/prod-health-check.mjs --profile zhaochaoyi   # COROS
node tests/e2e/prod-health-check.mjs --profile dingchentao  # Garmin

# Skip screenshots if you only want the boolean pass/fail:
node tests/e2e/prod-health-check.mjs --no-screenshots
```

Screenshots land in `tests/e2e/.shots/` (git-ignored). Exit code is 0 when
every assertion passes, 1 otherwise — suitable for chaining with `&&`.

---

## Backend pytest suite — `test_smoke.py`

### One-time setup

#### 1. Seed the e2e test user

The seven test cases assume a dedicated user exists in prod with at least one synced activity and one weekly plan folder. If you have not done this yet:

1. **Register `stride-e2e@<your-domain>` via the auth-service signup flow.** Keep the password handy.
2. **Note the resulting UUID** — visible in the JWT `sub` claim after first login, or via auth-service admin.
3. **Seed at least one activity:** either link a real COROS account to that user and run `coros-sync -P <uuid> sync`, or insert one synthetic row directly into `data/<uuid>/coros.db` via SQL. The real-data path also validates COROS sync, so prefer it.
4. **Seed at least one weekly plan folder:** create `data/<uuid>/logs/2026-05-22_05-22(e2e)/plan.md` plus a valid `plan.json` (per `docs/plan-json-schema.md`). Commit and push so `sync-data.yml` uploads them to Azure Files.

#### 2. Fill in the local config

```bash
cp tests/e2e/e2e.config.example.json tests/e2e/e2e.config.local.json
# edit tests/e2e/e2e.config.local.json — fill in e2e_email + e2e_password
```

`tests/e2e/e2e.config.local.json` is git-ignored. Do not commit it.

### Running the smoke

```bash
./scripts/smoke-prod.sh
```

That runs all 7 cases against prod and prints results. If `pytest-html` is installed (it is in the `dev` extras), an HTML report also lands at `out/e2e-report.html`.

Useful variants:

```bash
./scripts/smoke-prod.sh -k weeks          # only the weeks case
./scripts/smoke-prod.sh -x                # stop on first failure
./scripts/smoke-prod.sh --e2e-config=...  # alternate config file (e.g. staging)
```

### What each case proves

| # | Test | If it fails, suspect |
|---|------|----------------------|
| 1 | `test_liveness` | Container not running, or `/api/health` route removed |
| 2 | `test_unauthenticated_is_401` | `require_bearer` dependency dropped — public key env var missing or `allow_insecure_without_key=true` enabled in prod |
| 3 | `test_users_returns_current_user` | Auth verification failing OR Azure Files share not mounted (no `data/<uuid>/` dirs visible) |
| 4 | `test_home_dashboard` | `HomeResponse` schema regressed |
| 5 | `test_weeks_list` | `sync-data.yml` failed; seed plan.md never reached Azure Files |
| 6 | `test_activities_list_and_timezone` | SQLite mount broken OR a route forgot to call `utc_iso_to_shanghai_iso` |
| 7 | `test_spa_bundle_served` | Docker stage-1 (Vite build) silently failed; image shipped without `frontend/dist` |

### Why this suite is excluded from default `pytest`

Every case has `@pytest.mark.e2e`. `pyproject.toml` sets `addopts = "-m 'not e2e'"`, so the bare `pytest` invocation used by `ci.yml` skips them automatically. `scripts/smoke-prod.sh` adds `-m e2e` to flip the filter on.

### Manual validation checklist for first merge

After merging this suite, before declaring v1 done:

- [ ] Run `./scripts/smoke-prod.sh` → all 7 cases pass.
- [ ] Edit `e2e.config.local.json` to flip one byte of `e2e_password` → run; expect cases 3-6 to fail with a clear auth error, cases 1, 2, 7 still pass.
- [ ] Edit `e2e.config.local.json` to set `prod_url` to a bogus host → run; expect a clean connection-error failure mode, not a misleading assertion.
- [ ] Run plain `pytest` (no args) → confirm e2e cases are skipped and the existing unit suite passes unchanged.
