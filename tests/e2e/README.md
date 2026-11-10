# E2E smoke tests (prod)

End-to-end checks that exercise the deployed `stride-app`, not local dev
servers. Use these to confirm a release actually rendered the change you
expected, not just that unit tests pass.

These are intentionally *not* wired into CI:

- They depend on real user credentials that live outside the repo.
- They hit prod, so a flake here is a real signal worth investigating
  interactively, not auto-retrying in CI.

## Scripts

- `poster/` — 分享海报 E2E 驱动脚本（Epic #601 / devops#949 收口轮留档，可复跑）。
  驱动 DevTools 模拟器走 生成→保存→分享 全链路（真实数据双用户），无 mock；前置与
  边界见 `poster/README.md`，测试报告见 `docs/e2e/poster-epic601/`。

The previous prod smoke was retired when the
`WatchExtrasSection` it validated was removed from `/health`. HRV trend
verification is now covered by `frontend/src/pages/__tests__/HealthPage.test.tsx`.
