# Daily Auto-Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync every user's watch data daily at 24:00 Asia/Shanghai via a GitHub Actions scheduled workflow that POSTs to a new internal FastAPI endpoint.

**Architecture:** Mirror of `.github/workflows/weekly-running-calibration.yml`. New `POST /internal/sync?user={uuid}` endpoint in `src/stride_server/routes/sync.py` behind `X-Internal-Token`, sharing core sync logic with the existing Bearer-protected `/api/{user}/sync` route. New `.github/workflows/daily-sync.yml` runs `on: schedule: cron: '0 16 * * *'` and curl-loops over UUIDs from `data/.slug_aliases.json`.

**Tech Stack:** FastAPI, pytest + `fastapi.testclient.TestClient`, GitHub Actions, curl.

**Spec:** `docs/superpowers/specs/2026-05-21-daily-auto-sync-design.md`

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `src/stride_server/routes/sync.py` | Modify | Extract `_run_sync(user, full, source)` shared helper; add `internal_router` with `POST /internal/sync`. |
| `src/stride_server/app.py` | Modify | One new `app.include_router(sync.internal_router)` line in the internal-router block (~line 158). |
| `tests/stride_server/test_sync_internal.py` | Create | Cover 401 (missing/bad token), 422 (bad UUID), 200 (happy path), 400 (user not logged in). |
| `.github/workflows/daily-sync.yml` | Create | Scheduled workflow, cron `0 16 * * *`, loop POST per UUID. |

---

## Task 1: Refactor `trigger_sync` to extract shared `_run_sync` helper

**Files:**
- Modify: `src/stride_server/routes/sync.py`

This is a pure refactor — `trigger_sync` keeps its current behavior; we just hoist its body so Task 2's new handler can call the same code.

- [ ] **Step 1: Verify existing sync route file compiles and import works**

Run: `python -c "from stride_server.routes.sync import router, trigger_sync; print('ok')"`
Expected: `ok` (no traceback).

- [ ] **Step 2: Replace `src/stride_server/routes/sync.py` with refactored version**

Open `src/stride_server/routes/sync.py` and replace the entire file content with the following. The imports include `re`, `HTTPException`, `Query`, `Request`, `status`, `ProviderRegistry`, `UnknownProvider`, and `require_internal_token` — these are unused in this task but pre-seated so Task 3 only needs to append the new route block (no top-of-file import shuffling).

```python
"""Full-user sync endpoints — delegates to the configured DataSource.

Two routes:
- POST /api/{user}/sync  — Bearer JWT, called from frontend
- POST /internal/sync    — X-Internal-Token, called from scheduled workflows
                           (see .github/workflows/daily-sync.yml)
Both share `_run_sync` so behavior stays in lockstep.
"""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status

from stride_core.post_sync import run_post_sync_for_result
from stride_core.registry import ProviderRegistry, UnknownProvider
from stride_core.source import DataSource

from ..bearer import require_bearer
from ..deps import get_source_for_user
from .plan import require_internal_token

logger = logging.getLogger(__name__)

router = APIRouter()

_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _run_sync(user: str, full: bool, source: DataSource) -> dict:
    """Shared sync handler used by both the Bearer and internal-token routes."""
    try:
        if not source.is_logged_in(user):
            return {
                "success": False,
                "error": f"用户 {user} 未登录，请先运行: coros-sync --profile {user} login",
            }
        result = source.sync_user(user, full=full)
        try:
            run_post_sync_for_result(
                user=user,
                provider=source.info.name,
                operation="sync",
                result=result,
            )
        except Exception:
            logger.exception("post-sync events failed for user %s", user)
        return {
            "success": True,
            "output": f"同步完成: {result.activities} 条活动, {result.health} 条健康记录",
        }
    except Exception:
        logger.exception("sync failed for user %s", user)
        return {"success": False, "error": "sync failed"}


@router.post("/api/{user}/sync")
def trigger_sync(
    user: str,
    full: bool = False,
    source: DataSource = Depends(get_source_for_user),
    _claims: dict = Depends(require_bearer),
):
    """Trigger a data sync for the given user (via the configured adapter).

    Pass `?full=true` to bypass the incremental cutoff and re-pull a deeper
    activity history. Useful when the cached snapshot needs older activities
    to populate (e.g. the L3 endurance dimension needs a 25km+ run within
    the 90d window — without `full=1` after a fresh onboard, the user's
    longest historical run may have been truncated by `activity_limit`).

    Protected by Bearer auth when STRIDE_AUTH_PUBLIC_KEY_PEM/PATH is set.
    """
    return _run_sync(user, full, source)
```

- [ ] **Step 3: Verify import + module-level behavior unchanged**

Run: `python -c "from stride_server.routes.sync import router, trigger_sync, _run_sync; print('ok')"`
Expected: `ok` (no traceback).

- [ ] **Step 4: Run full backend test suite to confirm no regression**

Run: `pytest tests/ -x -q 2>&1 | tail -20`
Expected: All tests pass. If any sync-related test fails, the extraction broke behavior — debug before continuing.

- [ ] **Step 5: Commit**

```bash
git add src/stride_server/routes/sync.py
git commit -m "refactor(sync): extract _run_sync helper for reuse by internal route"
```

---

## Task 2: Write failing test — `POST /internal/sync` rejects missing X-Internal-Token with 401

**Files:**
- Create: `tests/stride_server/test_sync_internal.py`

Establish the test harness with `FakeSource` + `FakeRegistry` and write the first test.

- [ ] **Step 1: Verify the target tests dir exists**

Run: `ls tests/stride_server/ | head -3`
Expected: see existing files like `test_training_load_backfill.py`.

- [ ] **Step 2: Create the test file with the harness + first failing test**

Create `tests/stride_server/test_sync_internal.py`:

```python
"""Tests for the internal POST /internal/sync endpoint.

Mirrors the test pattern from test_training_load_backfill.py: build a minimal
FastAPI app mounting only the internal_router, stub the data source registry
on app.state, and exercise the route with TestClient.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from stride_core.source import ProviderInfo, SyncResult

INTERNAL_TOKEN = "test-internal-token-12345678"
USER_UUID = "f10bc353-01ab-4db1-af9f-d9305ea9a532"  # valid UUID4, from .slug_aliases.json


class FakeSource:
    """Minimal DataSource stand-in. Only the attrs the route reads."""

    def __init__(self, logged_in: bool = True, activities: int = 7, health: int = 1):
        self._logged_in = logged_in
        self._activities = activities
        self._health = health
        self.info = ProviderInfo(
            name="coros",
            display_name="高驰",
            regions=("global",),
            capabilities=frozenset(),
        )

    def is_logged_in(self, user: str) -> bool:
        return self._logged_in

    def sync_user(self, user: str, full: bool = False) -> SyncResult:
        return SyncResult(activities=self._activities, health=self._health)


class FakeRegistry:
    def __init__(self, source: FakeSource):
        self._source = source

    def for_user(self, user: str) -> FakeSource:
        return self._source


def _build_app(monkeypatch, source: FakeSource | None = None) -> FastAPI:
    """Build a minimal app with just internal_router mounted, registry stubbed."""
    monkeypatch.setenv("STRIDE_INTERNAL_TOKEN", INTERNAL_TOKEN)

    import stride_server.routes.sync as sync_mod
    from stride_server.config import clear_server_config_cache

    # No-op post-sync hook so tests don't touch DB / external services.
    monkeypatch.setattr(sync_mod, "run_post_sync_for_result", lambda **kw: None)
    clear_server_config_cache()

    app = FastAPI()
    app.state.registry = FakeRegistry(source or FakeSource())
    app.include_router(sync_mod.internal_router)
    return app


def test_missing_internal_token_returns_401(monkeypatch):
    app = _build_app(monkeypatch)
    client = TestClient(app, raise_server_exceptions=False)

    resp = client.post(f"/internal/sync?user={USER_UUID}")

    assert resp.status_code == 401, resp.text
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pytest tests/stride_server/test_sync_internal.py::test_missing_internal_token_returns_401 -v`
Expected: FAIL with `AttributeError: module 'stride_server.routes.sync' has no attribute 'internal_router'` (because Task 2's impl hasn't been written yet).

- [ ] **Step 4: Commit the failing test**

```bash
git add tests/stride_server/test_sync_internal.py
git commit -m "test(sync): scaffold internal /internal/sync test harness + 401-missing-token case"
```

---

## Task 3: Implement `internal_router` with `POST /internal/sync` to make Task 2's test pass

**Files:**
- Modify: `src/stride_server/routes/sync.py`
- Modify: `src/stride_server/app.py`

Add the internal route, manually resolving the DataSource from `app.state.registry` (since `?user=` is a query param, we can't reuse the path-based `get_source_for_user` dep).

- [ ] **Step 1: Append `internal_router` to `src/stride_server/routes/sync.py`**

All required imports + the `_UUID4_RE` constant were already added by Task 1. Append ONLY the route block to the end of `src/stride_server/routes/sync.py`:

```python


# ─────────────────────────────────────────────────────────────────────────────
# Internal route — used by scheduled workflows (see .github/workflows/daily-sync.yml)
# Auth via X-Internal-Token, NOT bearer. Path is /internal/... so future
# bearer-prefix middleware on /api/* won't accidentally catch it.
# ─────────────────────────────────────────────────────────────────────────────

internal_router = APIRouter()


@internal_router.post("/internal/sync")
def internal_trigger_sync(
    request: Request,
    user: str = Query(..., description="User UUID"),
    full: bool = Query(False),
    _token: None = Depends(require_internal_token),
) -> dict:
    """Trigger a sync for `user` — same logic as POST /api/{user}/sync but
    authenticated via X-Internal-Token instead of Bearer JWT.
    """
    if not _UUID4_RE.match(user):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="user must be a UUID4",
        )
    registry: ProviderRegistry = request.app.state.registry
    try:
        source: DataSource = registry.for_user(user)
    except UnknownProvider as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Configured watch provider {exc.name!r} is not available in this deployment",
        ) from exc
    return _run_sync(user, full, source)
```

- [ ] **Step 2: Mount `internal_router` in `src/stride_server/app.py`**

Find the internal-router block in `src/stride_server/app.py` (around line 154–158). It currently reads:

```python
    # Internal webhook router — gated by X-Internal-Token, NOT bearer JWT.
    # Path is /internal/... (not /api/internal/...) so future bearer-prefix
    # middleware on /api/* cannot accidentally catch it.
    app.include_router(plan.internal_router)
    app.include_router(training_load.internal_router)
```

Add one line so it becomes:

```python
    # Internal webhook router — gated by X-Internal-Token, NOT bearer JWT.
    # Path is /internal/... (not /api/internal/...) so future bearer-prefix
    # middleware on /api/* cannot accidentally catch it.
    app.include_router(plan.internal_router)
    app.include_router(training_load.internal_router)
    app.include_router(sync.internal_router)
```

Confirm `sync` is already imported at the top of `app.py`. If not (check via `grep "from .routes import\|import sync" src/stride_server/app.py`), add `sync` to the existing routes import line — do NOT add a new `import` line.

- [ ] **Step 3: Run the Task-2 test to verify it now passes**

Run: `pytest tests/stride_server/test_sync_internal.py::test_missing_internal_token_returns_401 -v`
Expected: PASS.

- [ ] **Step 4: Run full backend tests to confirm no regression**

Run: `pytest tests/ -x -q 2>&1 | tail -20`
Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/stride_server/routes/sync.py src/stride_server/app.py
git commit -m "feat(sync): add POST /internal/sync for scheduled workflows"
```

---

## Task 4: Write failing test — bad X-Internal-Token returns 401

**Files:**
- Modify: `tests/stride_server/test_sync_internal.py`

- [ ] **Step 1: Append the test**

Append to `tests/stride_server/test_sync_internal.py`:

```python


def test_bad_internal_token_returns_401(monkeypatch):
    app = _build_app(monkeypatch)
    client = TestClient(app, raise_server_exceptions=False)

    resp = client.post(
        f"/internal/sync?user={USER_UUID}",
        headers={"X-Internal-Token": "wrong-token-value"},
    )

    assert resp.status_code == 401, resp.text
```

- [ ] **Step 2: Run the test**

Run: `pytest tests/stride_server/test_sync_internal.py::test_bad_internal_token_returns_401 -v`
Expected: PASS (the existing `require_internal_token` dep already rejects mismatched tokens — this is a defense-in-depth assertion, not a new behavior).

- [ ] **Step 3: Commit**

```bash
git add tests/stride_server/test_sync_internal.py
git commit -m "test(sync): assert bad X-Internal-Token returns 401 on /internal/sync"
```

---

## Task 5: Write failing test — invalid UUID returns 422

**Files:**
- Modify: `tests/stride_server/test_sync_internal.py`

- [ ] **Step 1: Append the test**

Append:

```python


def test_invalid_uuid_returns_422(monkeypatch):
    app = _build_app(monkeypatch)
    client = TestClient(app, raise_server_exceptions=False)

    resp = client.post(
        "/internal/sync?user=not-a-uuid",
        headers={"X-Internal-Token": INTERNAL_TOKEN},
    )

    assert resp.status_code == 422, resp.text
    assert "UUID4" in resp.json()["detail"]
```

- [ ] **Step 2: Run the test**

Run: `pytest tests/stride_server/test_sync_internal.py::test_invalid_uuid_returns_422 -v`
Expected: PASS (handler validates in Task 3's code).

- [ ] **Step 3: Commit**

```bash
git add tests/stride_server/test_sync_internal.py
git commit -m "test(sync): assert invalid UUID returns 422 on /internal/sync"
```

---

## Task 6: Write failing test — happy path returns 200 + delegates to source.sync_user

**Files:**
- Modify: `tests/stride_server/test_sync_internal.py`

- [ ] **Step 1: Append the test**

Append:

```python


def test_happy_path_returns_200_and_calls_sync_user(monkeypatch):
    calls: list[tuple[str, bool]] = []

    class RecordingSource(FakeSource):
        def sync_user(self, user: str, full: bool = False) -> SyncResult:
            calls.append((user, full))
            return SyncResult(activities=3, health=1)

    source = RecordingSource()
    app = _build_app(monkeypatch, source=source)
    client = TestClient(app, raise_server_exceptions=False)

    resp = client.post(
        f"/internal/sync?user={USER_UUID}",
        headers={"X-Internal-Token": INTERNAL_TOKEN},
    )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["success"] is True
    assert "3 条活动" in body["output"]
    assert "1 条健康记录" in body["output"]
    assert calls == [(USER_UUID, False)]


def test_full_flag_forwarded_to_sync_user(monkeypatch):
    calls: list[tuple[str, bool]] = []

    class RecordingSource(FakeSource):
        def sync_user(self, user: str, full: bool = False) -> SyncResult:
            calls.append((user, full))
            return SyncResult(activities=0, health=0)

    source = RecordingSource()
    app = _build_app(monkeypatch, source=source)
    client = TestClient(app, raise_server_exceptions=False)

    resp = client.post(
        f"/internal/sync?user={USER_UUID}&full=true",
        headers={"X-Internal-Token": INTERNAL_TOKEN},
    )

    assert resp.status_code == 200, resp.text
    assert calls == [(USER_UUID, True)]
```

- [ ] **Step 2: Run both tests**

Run: `pytest tests/stride_server/test_sync_internal.py -v`
Expected: All 5 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/stride_server/test_sync_internal.py
git commit -m "test(sync): cover /internal/sync happy path + full=true forwarding"
```

---

## Task 7: Write failing test — not-logged-in user returns success:false with friendly message

**Files:**
- Modify: `tests/stride_server/test_sync_internal.py`

This verifies the "未登录" branch of `_run_sync` is reachable via the internal route (regression guard if `_run_sync` is later changed).

- [ ] **Step 1: Append the test**

Append:

```python


def test_not_logged_in_returns_success_false(monkeypatch):
    source = FakeSource(logged_in=False)
    app = _build_app(monkeypatch, source=source)
    client = TestClient(app, raise_server_exceptions=False)

    resp = client.post(
        f"/internal/sync?user={USER_UUID}",
        headers={"X-Internal-Token": INTERNAL_TOKEN},
    )

    # HTTP is 200 — the route returns a structured error body, not an HTTP error,
    # because the GH Action consumes the body to surface the reason per-user.
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["success"] is False
    assert "未登录" in body["error"]
```

- [ ] **Step 2: Run the test**

Run: `pytest tests/stride_server/test_sync_internal.py::test_not_logged_in_returns_success_false -v`
Expected: PASS.

- [ ] **Step 3: Run the full sync-internal file**

Run: `pytest tests/stride_server/test_sync_internal.py -v`
Expected: All 6 tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/stride_server/test_sync_internal.py
git commit -m "test(sync): assert not-logged-in returns structured success:false body"
```

---

## Task 8: Create `.github/workflows/daily-sync.yml`

**Files:**
- Create: `.github/workflows/daily-sync.yml`

Mirror of `.github/workflows/weekly-running-calibration.yml` with cron + endpoint + timeout differences spelled out in the spec.

- [ ] **Step 1: Verify the reference workflow exists in the repo (you may be on a branch where it isn't yet merged)**

Run: `ls .github/workflows/weekly-running-calibration.yml 2>/dev/null && echo present || echo "absent — see commit a80c0fa for the reference template"`

If absent, the file used as the structural reference is at git ref `a80c0fa:.github/workflows/weekly-running-calibration.yml`. The plan below is self-contained — you do NOT need that file to write `daily-sync.yml`.

- [ ] **Step 2: Create `.github/workflows/daily-sync.yml`**

Create the file with this exact content:

```yaml
name: Daily auto-sync

# Required GitHub Actions secrets (configured in repo settings):
#   STRIDE_PROD_URL           — base URL of the deployed stride-app, e.g.
#                               https://stride-app.<region>.azurecontainerapps.io
#   STRIDE_INTERNAL_TOKEN     — random 32+ char string. Same value must be set
#                               on the Azure Container App as STRIDE_INTERNAL_TOKEN
#                               env var.
# If either secret is unset the workflow fails so the omission is visible.

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
        id: users
        run: |
          if [ ! -f data/.slug_aliases.json ]; then
            echo "No data/.slug_aliases.json found — nothing to sync"
            : > users.txt
            echo "count=0" >> "$GITHUB_OUTPUT"
          else
            python3 -c "
          import json
          aliases = json.load(open('data/.slug_aliases.json'))
          uuids = sorted(set(str(v) for v in aliases.values()))
          print('\n'.join(uuids))
          " > users.txt
            count=$(wc -l < users.txt | tr -d ' ')
            echo "count=$count" >> "$GITHUB_OUTPUT"
            echo "Found $count user(s):"
            cat users.txt
          fi

      - name: Trigger daily sync per user
        if: steps.users.outputs.count != '0'
        env:
          STRIDE_PROD_URL: ${{ secrets.STRIDE_PROD_URL }}
          INTERNAL_TOKEN: ${{ secrets.STRIDE_INTERNAL_TOKEN }}
        run: |
          set -u
          if [ -z "$STRIDE_PROD_URL" ] || [ -z "$INTERNAL_TOKEN" ]; then
            echo "::error::STRIDE_PROD_URL or STRIDE_INTERNAL_TOKEN secret missing"
            exit 1
          fi

          echo "## Daily auto-sync" >> "$GITHUB_STEP_SUMMARY"
          echo "" >> "$GITHUB_STEP_SUMMARY"
          echo "| user | http | response |" >> "$GITHUB_STEP_SUMMARY"
          echo "|------|------|----------|" >> "$GITHUB_STEP_SUMMARY"

          fail=0
          ok=0
          while read -r user; do
            [ -z "$user" ] && continue
            echo "==> POST /internal/sync user=$user"
            # max-time 300s: full COROS sync occasionally takes 1–3 min when
            # pulling many new activities + timeseries. Generous timeout;
            # manual workflow_dispatch is the retry mechanism if a user fails.
            http=$(curl -s -o /tmp/resp.json -w "%{http_code}" \
              --max-time 300 \
              -X POST \
              -H "X-Internal-Token: $INTERNAL_TOKEN" \
              "$STRIDE_PROD_URL/internal/sync?user=$user")
            body=$(head -c 500 /tmp/resp.json | tr '\n' ' ')
            if [ "$http" = "200" ]; then
              # Endpoint returns {success:true|false, ...} even on HTTP 200 —
              # surface the body so GH Actions log shows per-user outcome.
              ok=$((ok+1))
              echo "  ✓ $user (HTTP $http)"
              echo "| $user | $http | $body |" >> "$GITHUB_STEP_SUMMARY"
            else
              fail=$((fail+1))
              echo "::warning::Sync failed for $user (HTTP $http): $body"
              echo "| $user | $http | $body |" >> "$GITHUB_STEP_SUMMARY"
            fi
          done < users.txt

          echo "" >> "$GITHUB_STEP_SUMMARY"
          echo "**Summary: $ok ok, $fail failed**" >> "$GITHUB_STEP_SUMMARY"
          echo "Summary: $ok ok, $fail failed"
          if [ "$fail" -gt 0 ]; then
            exit 1
          fi
```

- [ ] **Step 3: Validate YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/daily-sync.yml'))" && echo ok`
Expected: `ok` (no traceback).

- [ ] **Step 4: Sanity-check the user-list builder against the real `data/.slug_aliases.json`**

Run:
```bash
python3 -c "
import json
aliases = json.load(open('data/.slug_aliases.json'))
uuids = sorted(set(str(v) for v in aliases.values()))
print('\n'.join(uuids))
print('count:', len(uuids))
"
```
Expected: 6 UUIDs printed, `count: 6`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/daily-sync.yml
git commit -m "feat(ci): daily-sync workflow — POST /internal/sync per user at 24:00 SH"
```

---

## Task 9: Final integration check

**Files:** none (verification only)

- [ ] **Step 1: Confirm the full plan's commits are present**

Run: `git log --oneline master..HEAD`
Expected: ~8 commits including `docs: add daily auto-sync design spec`, the refactor, the internal route, the test commits, and the workflow.

- [ ] **Step 2: Run the entire backend test suite**

Run: `pytest tests/ -x -q 2>&1 | tail -30`
Expected: All pass.

- [ ] **Step 3: Confirm both routers register without import errors**

Run:
```bash
python3 -c "
from stride_server.routes.sync import router, internal_router
print('public routes:', [r.path for r in router.routes])
print('internal routes:', [r.path for r in internal_router.routes])
"
```
Expected:
```
public routes: ['/api/{user}/sync']
internal routes: ['/internal/sync']
```

- [ ] **Step 4: Confirm `app.include_router(sync.internal_router)` actually executes (no `AttributeError`)**

Run:
```bash
python3 -c "
import os
os.environ.setdefault('STRIDE_INTERNAL_TOKEN', 'placeholder-for-import-check-only')
from stride_server.app import create_app
app = create_app()
paths = [r.path for r in app.routes]
assert '/internal/sync' in paths, f'/internal/sync missing from app routes: {paths}'
print('ok: /internal/sync mounted')
"
```
Expected: `ok: /internal/sync mounted`. If `create_app()` requires more env vars to boot, set them as needed; the goal is just to confirm the new line in `app.py` doesn't crash startup.

- [ ] **Step 5: Confirm the workflow file is well-formed and the cron is right**

Run:
```bash
python3 -c "
import yaml
wf = yaml.safe_load(open('.github/workflows/daily-sync.yml'))
# PyYAML parses bare 'on' as Python True — match either form.
trig = wf.get('on') or wf.get(True)
assert trig['schedule'][0]['cron'] == '0 16 * * *', trig
assert 'workflow_dispatch' in trig, trig
print('ok: cron 0 16 * * * (= 24:00 Asia/Shanghai)')
"
```
Expected: `ok: cron 0 16 * * * (= 24:00 Asia/Shanghai)`.

- [ ] **Step 6: Push and let CI run**

```bash
git push -u origin zhaochy/auto-sync
```

Expected: CI workflows (`ci`, etc.) on the PR run green. The new `daily-sync` workflow itself will NOT run until merged to master (scheduled workflows only fire from the default branch) — but you can hand-test post-merge via `gh workflow run daily-sync.yml -R <repo>`.

---

## Out of Scope (do NOT do in this plan)

- Parallel per-user curl (`xargs -P`). Sequential is fine for 6 users.
- Per-user opt-out toggle. All users in `.slug_aliases.json` are synced.
- New SQLite tables.
- Changes to `deploy.yml`.
- Changes to the existing `/api/{user}/sync` route's contract.
- A separate Azure Container App Job (this was the alternative architecture we rejected).
