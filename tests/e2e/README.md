# E2E smoke tests (prod)

End-to-end checks that exercise the deployed `stride-app`, not local dev
servers. Use these to confirm a release actually rendered the change you
expected, not just that unit tests pass.

These are intentionally *not* wired into CI:

- They depend on real user credentials that live outside the repo.
- They hit prod, so a flake here is a real signal worth investigating
  interactively, not auto-retrying in CI.

## Scripts

| File                      | Verifies                                                |
|---------------------------|---------------------------------------------------------|
| `prod-health-check.mjs`   | Login + `/health` rendering (HRV trend chart, adaptive Watch Extras cards). Written for PR #39 to validate COROS HRV ingestion + the WatchExtrasSection rename end-to-end. |

## Prerequisites

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

2. **Credentials** — copy `.credentials.local.example` (or hand-write):
   ```
   email=you@example.com
   password=...
   ```
   File is git-ignored (see `.gitignore`). Same file the COROS CLI uses; see
   `docs/auth-wiring.md`.

3. **Prod URL** — optional. The script defaults to the documented prod URL;
   override with `STRIDE_PROD_URL` if you're pointing at a staging slot.

## Run

```bash
node tests/e2e/prod-health-check.mjs
# Skip screenshots if you only want the boolean pass/fail:
node tests/e2e/prod-health-check.mjs --no-screenshots
```

Screenshots land in `tests/e2e/.shots/` (git-ignored). Exit code is 0 when
every assertion passes, 1 otherwise — suitable for chaining with `&&`.
