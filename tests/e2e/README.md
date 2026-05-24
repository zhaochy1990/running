# E2E smoke tests (prod)

End-to-end checks that exercise the deployed `stride-app`, not local dev
servers. Use these to confirm a release actually rendered the change you
expected, not just that unit tests pass.

These are intentionally *not* wired into CI:

- They depend on real user credentials that live outside the repo.
- They hit prod, so a flake here is a real signal worth investigating
  interactively, not auto-retrying in CI.

## Scripts

_None currently._ `prod-health-check.mjs` was retired when the
`WatchExtrasSection` it validated was removed from `/health`. HRV trend
verification is now covered by `frontend/src/pages/__tests__/HealthPage.test.tsx`.
