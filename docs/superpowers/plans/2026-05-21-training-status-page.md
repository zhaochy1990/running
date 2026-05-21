# 训练状态（STRIDE）页面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 sidebar "数据/分析" 组新增 `训练状态（STRIDE）` 页面，专门展示 STRIDE 自研算法计算出的训练状态（阈值、区间、训练负荷），加上手表原始 RHR / HRV 数据。

**Architecture:** 新增 `/api/{user}/stride/*` namespace（2 个 endpoint），新增 `/training-status` 前端页面。旧 endpoints（`/api/{user}/health`、`/api/{user}/hrv`）和旧页面（HealthPage、AbilityPage、BodyCompositionPage）完全不动。

**Tech Stack:** FastAPI + SQLite（后端）；React + Vite + Recharts + Tailwind + SWR-less Promise.all 数据流（前端）；pytest + vitest（测试）。

**Reference Design Spec:** `docs/superpowers/specs/2026-05-21-training-status-page-design.md`

---

## File Structure

**Backend (new)**:
- `src/stride_server/routes/stride.py` — 2 endpoints: `GET /api/{user}/stride/zones`, `GET /api/{user}/stride/training-load`
- `tests/test_stride_routes.py` — pytest coverage for both endpoints

**Backend (modified)**:
- `src/stride_server/app.py` — register `stride.router`

**Frontend (new)**:
- `frontend/src/pages/TrainingStatusPage.tsx` — main page (single-file, inline subcomponents, follows BodyCompositionPage pattern)
- `frontend/src/pages/__tests__/TrainingStatusPage.test.tsx` — vitest + RTL coverage

**Frontend (modified)**:
- `frontend/src/api.ts` — add 2 fetchers + types
- `frontend/src/App.tsx` — register route
- `frontend/src/components/AppLayout.tsx` — sidebar nav item

---

## Phase 0: Workspace Setup

### Task 0: Create isolated git worktree

**Files:** N/A (workspace operation)

- [ ] **Step 1: Create worktree on a new branch**

Run from main repo root `C:\Users\zhaochaoyi\workspace\running`:
```powershell
git worktree add -b training-status-page ../running-training-status master
```
Expected: New directory `C:\Users\zhaochaoyi\workspace\running-training-status` checked out at master, branch `training-status-page`.

- [ ] **Step 2: Verify worktree state**

```powershell
cd C:\Users\zhaochaoyi\workspace\running-training-status
git status
git branch --show-current
```
Expected: clean tree, `training-status-page` branch.

- [ ] **Step 3: Verify Python + frontend deps installed**

```powershell
python -c "import fastapi, pytest; print('ok')"
cd frontend; npm ci ; cd ..
```
Expected: `ok` and `npm ci` runs without errors.

All subsequent tasks happen inside this worktree.

---

## Phase 1: Backend — `GET /api/{user}/stride/zones`

### Task 1: Create stride.py route file with zones endpoint (happy path TDD)

**Files:**
- Create: `src/stride_server/routes/stride.py`
- Create: `tests/test_stride_routes.py`

- [ ] **Step 1: Write the failing test for happy path**

Create `tests/test_stride_routes.py` with this content (mirrors `tests/test_ability_api.py` Bearer + fixture pattern):

```python
"""Tests for src/stride_server/routes/stride.py — STRIDE algorithm endpoints.

Covers /api/{user}/stride/zones and /api/{user}/stride/training-load.
"""

from __future__ import annotations

import time
from pathlib import Path

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from stride_core.db import Database


# ---------------------------------------------------------------------------
# RSA keypair + token issuance — copied verbatim from test_ability_api.py
# ---------------------------------------------------------------------------

USER_ID = "00000000-0000-4000-8000-000000000001"


@pytest.fixture
def rsa_keypair():
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = private.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode()
    public_pem = private.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    return private_pem, public_pem


def _issue_token(private_pem: str, **overrides) -> str:
    now = int(time.time())
    claims = {
        "sub": USER_ID,
        "aud": "stride-client",
        "iss": "auth-service",
        "exp": now + 3600,
        "iat": now,
        "role": "user",
    }
    claims.update(overrides)
    return jwt.encode(claims, private_pem, algorithm="RS256")


def _reset_bearer_module(monkeypatch, public_pem: str | None = None):
    import stride_server.bearer as bearer
    monkeypatch.setattr(bearer, "_cached_public_key", None)
    monkeypatch.setattr(bearer, "_warned_open", False)
    for k in (
        "STRIDE_AUTH_PUBLIC_KEY_PEM",
        "STRIDE_AUTH_PUBLIC_KEY_PATH",
        "STRIDE_AUTH_ISSUER",
        "STRIDE_AUTH_AUDIENCE",
    ):
        monkeypatch.delenv(k, raising=False)
    if public_pem is not None:
        monkeypatch.setenv("STRIDE_AUTH_PUBLIC_KEY_PEM", public_pem)


@pytest.fixture
def seeded_db(tmp_path, monkeypatch) -> Path:
    """Set USER_DATA_DIR to tmp; create empty DB for USER_ID."""
    monkeypatch.setenv("STRIDE_USER_DATA_DIR", str(tmp_path))
    import stride_core.db as db_mod
    monkeypatch.setattr(db_mod, "USER_DATA_DIR", tmp_path)
    user_dir = tmp_path / USER_ID
    user_dir.mkdir(parents=True, exist_ok=True)
    # Database() auto-creates tables on first open
    db = Database(user=USER_ID)
    db.close()
    return tmp_path


def _seed_calibration(user_id: str):
    """Insert a fully-populated calibration + zones."""
    db = Database(user=user_id)
    try:
        cur = db._conn.execute(
            """INSERT INTO running_calibration_snapshot
               (as_of_date, algorithm_version, threshold_hr, threshold_speed_mps,
                threshold_hr_confidence, threshold_speed_confidence,
                rhr_baseline, observed_max_hr, hrmax_estimate, hrmax_confidence)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("2026-05-15", 1, 175.0, 4.65, "medium", "medium", 47.0, 188.0, 188.0, "medium"),
        )
        snap_id = cur.lastrowid
        zones = [
            (snap_id, "hr", "Z1", 105.0, 140.0, None, None, "medium"),
            (snap_id, "hr", "Z2", 140.0, 154.0, None, None, "medium"),
            (snap_id, "hr", "Z3", 154.0, 165.0, None, None, "medium"),
            (snap_id, "hr", "Z4", 165.0, 175.0, None, None, "medium"),
            (snap_id, "hr", "Z5", 175.0, 188.0, None, None, "medium"),
            (snap_id, "pace", "Z1", None, None, 2.79, 3.35, "medium"),
            (snap_id, "pace", "Z2", None, None, 3.35, 3.91, "medium"),
            (snap_id, "pace", "Z3", None, None, 3.91, 4.51, "medium"),
            (snap_id, "pace", "Z4", None, None, 4.51, 4.79, "medium"),
            (snap_id, "pace", "Z5", None, None, 4.79, 5.16, "medium"),
        ]
        db._conn.executemany(
            """INSERT INTO running_calibration_zone
               (snapshot_id, zone_kind, name, min_value, max_value, min_speed_mps, max_speed_mps, confidence)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            zones,
        )
        db._conn.commit()
    finally:
        db.close()


def _build_client(public_pem: str) -> TestClient:
    from stride_server.app import build_app
    from stride_server.config.models import AuthConfig, ServerConfig
    cfg = ServerConfig(auth=AuthConfig(public_key_pem=public_pem))
    return TestClient(build_app(cfg))


def test_stride_zones_happy_path(rsa_keypair, monkeypatch, seeded_db):
    private_pem, public_pem = rsa_keypair
    _reset_bearer_module(monkeypatch, public_pem)
    _seed_calibration(USER_ID)

    client = _build_client(public_pem)
    token = _issue_token(private_pem)
    resp = client.get(
        f"/api/{USER_ID}/stride/zones",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["threshold"]["speed_mps"] == pytest.approx(4.65)
    assert body["threshold"]["hr_bpm"] == pytest.approx(175.0)
    assert body["threshold"]["pace_per_km_sec"] == pytest.approx(1000 / 4.65, rel=1e-3)
    assert body["threshold"]["as_of_date"] == "2026-05-15"
    assert len(body["pace_zones"]) == 5
    assert len(body["hr_zones"]) == 5
    assert body["hr_zones"][0]["name"] == "Z1"
    assert body["hr_zones"][0]["lower_bpm"] == 105
    assert body["hr_zones"][0]["upper_bpm"] == 140
    # Pace zones are stored as speeds; endpoint converts to "M:SS" /km strings
    assert body["pace_zones"][0]["name"] == "Z1"
    assert ":" in body["pace_zones"][0]["lower_pace"]
    assert ":" in body["pace_zones"][0]["upper_pace"]
```

- [ ] **Step 2: Run test to verify it fails (route does not exist yet)**

```powershell
pytest tests/test_stride_routes.py::test_stride_zones_happy_path -v
```
Expected: FAIL with 404 from `/api/{USER_ID}/stride/zones`.

- [ ] **Step 3: Create stride.py with minimal implementation**

Create `src/stride_server/routes/stride.py`:

```python
"""STRIDE self-developed metric endpoints — /api/{user}/stride/*.

These endpoints expose STRIDE-algorithm-computed values (calibration
thresholds, training zones, daily training load) explicitly separate
from watch-passthrough fields served by /api/{user}/health and /hrv.

Owns: running_calibration_snapshot, running_calibration_zone,
      daily_training_load.
Strictly avoids: daily_health.ati / cti / training_load_*
                 (those are COROS-reported pass-throughs).
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Query

from ..deps import get_db

router = APIRouter()


def _pace_per_km_sec(speed_mps: float | None) -> int | None:
    if not speed_mps or speed_mps <= 0:
        return None
    return int(round(1000.0 / speed_mps))


def _pace_fmt(speed_mps: float | None) -> str | None:
    """Convert speed (m/s) to 'M:SS' /km."""
    secs = _pace_per_km_sec(speed_mps)
    if secs is None:
        return None
    return f"{secs // 60}:{secs % 60:02d}"


_ZONE_LABELS_HR = {
    "Z1": "恢复", "Z2": "有氧", "Z3": "节奏", "Z4": "阈值", "Z5": "VO2max",
}
_ZONE_LABELS_PACE = {
    "Z1": "轻松", "Z2": "有氧", "Z3": "节奏", "Z4": "阈值", "Z5": "VO2max",
}


@router.get("/api/{user}/stride/zones")
def get_stride_zones(user: str) -> dict[str, Any]:
    db = get_db(user)
    try:
        snap_rows = db._conn.execute(
            """SELECT id, as_of_date, threshold_hr, threshold_speed_mps,
                      threshold_hr_confidence, threshold_speed_confidence
               FROM running_calibration_snapshot
               ORDER BY as_of_date DESC, id DESC
               LIMIT 1"""
        ).fetchall()
        if not snap_rows:
            return {"threshold": None, "pace_zones": [], "hr_zones": []}
        snap = dict(snap_rows[0])

        threshold = {
            "speed_mps": snap["threshold_speed_mps"],
            "pace_per_km_sec": _pace_per_km_sec(snap["threshold_speed_mps"]),
            "hr_bpm": snap["threshold_hr"],
            "speed_confidence": snap["threshold_speed_confidence"],
            "hr_confidence": snap["threshold_hr_confidence"],
            "as_of_date": snap["as_of_date"],
            "calibration_id": snap["id"],
        }

        zone_rows = db._conn.execute(
            """SELECT zone_kind, name, min_value, max_value,
                      min_speed_mps, max_speed_mps
               FROM running_calibration_zone
               WHERE snapshot_id = ?
               ORDER BY zone_kind, name""",
            (snap["id"],),
        ).fetchall()

        hr_zones = []
        pace_zones = []
        for row in zone_rows:
            r = dict(row)
            if r["zone_kind"] == "hr":
                hr_zones.append({
                    "name": r["name"],
                    "label": _ZONE_LABELS_HR.get(r["name"], r["name"]),
                    "lower_bpm": int(r["min_value"]) if r["min_value"] is not None else None,
                    "upper_bpm": int(r["max_value"]) if r["max_value"] is not None else None,
                })
            elif r["zone_kind"] == "pace":
                # Stored as speeds — slower zones have smaller min_speed.
                # Pace string display: lower_pace = slower edge (larger seconds);
                # upper_pace = faster edge (smaller seconds).
                pace_zones.append({
                    "name": r["name"],
                    "label": _ZONE_LABELS_PACE.get(r["name"], r["name"]),
                    "lower_pace": _pace_fmt(r["min_speed_mps"]),
                    "upper_pace": _pace_fmt(r["max_speed_mps"]),
                })

        return {
            "threshold": threshold,
            "pace_zones": pace_zones,
            "hr_zones": hr_zones,
        }
    finally:
        db.close()
```

- [ ] **Step 4: Register router in app.py**

Modify `src/stride_server/app.py` — after the line `app.include_router(ability.router, dependencies=protected_user)` (around line 136), add an `from .routes import stride` import alongside the other route imports near the top, then append:

```python
    app.include_router(stride.router, dependencies=protected_user)
```

Run grep to find the import block:
```powershell
findstr /n "from .routes" src\stride_server\app.py
```
Add `stride` to the existing `from .routes import (...)` tuple or as a new line, matching the existing style.

- [ ] **Step 5: Run test to verify it passes**

```powershell
pytest tests/test_stride_routes.py::test_stride_zones_happy_path -v
```
Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/stride_server/routes/stride.py src/stride_server/app.py tests/test_stride_routes.py
git commit -m "feat(stride): add GET /api/{user}/stride/zones endpoint"
```

---

### Task 2: Zones endpoint — null / empty calibration cases

**Files:**
- Modify: `tests/test_stride_routes.py`

- [ ] **Step 1: Add failing tests for empty / partial cases**

Append to `tests/test_stride_routes.py`:

```python
def test_stride_zones_no_calibration(rsa_keypair, monkeypatch, seeded_db):
    """User exists but has no calibration row → null threshold + empty zones."""
    private_pem, public_pem = rsa_keypair
    _reset_bearer_module(monkeypatch, public_pem)
    # Note: no _seed_calibration() call

    client = _build_client(public_pem)
    token = _issue_token(private_pem)
    resp = client.get(
        f"/api/{USER_ID}/stride/zones",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"threshold": None, "pace_zones": [], "hr_zones": []}


def test_stride_zones_unauthenticated(rsa_keypair, monkeypatch, seeded_db):
    """No Bearer token → 401."""
    _, public_pem = rsa_keypair
    _reset_bearer_module(monkeypatch, public_pem)

    client = _build_client(public_pem)
    resp = client.get(f"/api/{USER_ID}/stride/zones")
    assert resp.status_code == 401
```

- [ ] **Step 2: Run new tests to verify behavior**

```powershell
pytest tests/test_stride_routes.py -v
```
Expected: All 3 tests PASS (no calibration case already handled by Task 1 implementation; 401 enforced by middleware).

- [ ] **Step 3: Commit**

```powershell
git add tests/test_stride_routes.py
git commit -m "test(stride): cover zones empty + unauthenticated cases"
```

---

## Phase 2: Backend — `GET /api/{user}/stride/training-load`

### Task 3: Implement training-load endpoint (TDD)

**Files:**
- Modify: `src/stride_server/routes/stride.py`
- Modify: `tests/test_stride_routes.py`

- [ ] **Step 1: Add failing test for happy path**

Append to `tests/test_stride_routes.py`:

```python
def _seed_training_load(user_id: str):
    """Insert 5 days of daily_training_load."""
    db = Database(user=user_id)
    try:
        rows = [
            ("2026-05-17", 1, None, 60.0, 70.0, 70.0, 0.0, 1.00, "go",  '["ok"]'),
            ("2026-05-18", 1, None, 75.0, 72.0, 70.5, -1.5, 1.02, "go",  '["ok"]'),
            ("2026-05-19", 1, None, 80.0, 75.0, 71.5, -3.5, 1.05, "caution", '["high_load"]'),
            ("2026-05-20", 1, None, 70.0, 76.0, 72.5, -3.5, 1.05, "go",  '["ok"]'),
            ("2026-05-21", 1, None, 75.2, 78.0, 72.0, -6.0, 1.08, "go",  '["ok"]'),
        ]
        db._conn.executemany(
            """INSERT INTO daily_training_load
               (date, algorithm_version, calibration_id, training_dose,
                acute_load, chronic_load, form, load_ratio,
                readiness_gate, readiness_reasons_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            rows,
        )
        db._conn.commit()
    finally:
        db.close()


def test_stride_training_load_happy_path(rsa_keypair, monkeypatch, seeded_db):
    private_pem, public_pem = rsa_keypair
    _reset_bearer_module(monkeypatch, public_pem)
    _seed_training_load(USER_ID)

    client = _build_client(public_pem)
    token = _issue_token(private_pem)
    resp = client.get(
        f"/api/{USER_ID}/stride/training-load?days=30",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["current"]["date"] == "2026-05-21"
    assert body["current"]["acute_load"] == 78.0
    assert body["current"]["chronic_load"] == 72.0
    assert body["current"]["form"] == -6.0
    assert body["current"]["load_ratio"] == 1.08
    assert body["current"]["readiness_gate"] == "go"
    assert body["current"]["readiness_reasons"] == ["ok"]
    assert len(body["series"]) == 5
    # series oldest-first
    assert body["series"][0]["date"] == "2026-05-17"
    assert body["series"][-1]["date"] == "2026-05-21"


def test_stride_training_load_no_data(rsa_keypair, monkeypatch, seeded_db):
    private_pem, public_pem = rsa_keypair
    _reset_bearer_module(monkeypatch, public_pem)

    client = _build_client(public_pem)
    token = _issue_token(private_pem)
    resp = client.get(
        f"/api/{USER_ID}/stride/training-load?days=30",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"current": None, "series": []}


def test_stride_training_load_validates_days(rsa_keypair, monkeypatch, seeded_db):
    private_pem, public_pem = rsa_keypair
    _reset_bearer_module(monkeypatch, public_pem)

    client = _build_client(public_pem)
    token = _issue_token(private_pem)
    for bad in (0, 6, 400, -1):
        resp = client.get(
            f"/api/{USER_ID}/stride/training-load?days={bad}",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 422, f"days={bad} should 422"
```

- [ ] **Step 2: Run failing tests**

```powershell
pytest tests/test_stride_routes.py -v -k training_load
```
Expected: 3 tests FAIL (404 / route not found).

- [ ] **Step 3: Add training-load endpoint to stride.py**

Append to `src/stride_server/routes/stride.py`:

```python
@router.get("/api/{user}/stride/training-load")
def get_stride_training_load(
    user: str,
    days: int = Query(90, ge=7, le=365),
) -> dict[str, Any]:
    db = get_db(user)
    try:
        rows = db._conn.execute(
            """SELECT date, algorithm_version, training_dose, acute_load,
                      chronic_load, form, load_ratio, readiness_gate,
                      readiness_reasons_json
               FROM daily_training_load
               ORDER BY date DESC
               LIMIT ?""",
            (days,),
        ).fetchall()
        if not rows:
            return {"current": None, "series": []}

        records: list[dict[str, Any]] = []
        for r in rows:
            rec = dict(r)
            reasons_raw = rec.pop("readiness_reasons_json", None)
            try:
                reasons = json.loads(reasons_raw) if reasons_raw else []
            except (TypeError, ValueError):
                reasons = []
            rec["readiness_reasons"] = reasons if isinstance(reasons, list) else []
            records.append(rec)

        # Sort oldest-first for client charts; "current" is latest (last).
        records.sort(key=lambda r: r["date"])
        current = dict(records[-1])
        return {"current": current, "series": records}
    finally:
        db.close()
```

- [ ] **Step 4: Run tests — verify all pass**

```powershell
pytest tests/test_stride_routes.py -v
```
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/stride_server/routes/stride.py tests/test_stride_routes.py
git commit -m "feat(stride): add GET /api/{user}/stride/training-load endpoint"
```

---

### Task 4: Backend lint + full suite green

**Files:** N/A (gate check)

- [ ] **Step 1: Run import-linter (`.importlinter` contracts)**

```powershell
$env:PYTHONPATH = "src"; lint-imports
```
Expected: All contracts pass. `stride_server.routes.stride` may import `stride_core.db` + `fastapi` — both allowed by existing rules.

- [ ] **Step 2: Run full backend test suite**

```powershell
pytest tests/ -q
```
Expected: No previously-passing tests have broken (regression check).

- [ ] **Step 3: Commit any minor lint fixes if needed (otherwise skip)**

---

## Phase 3: Frontend — API client + Routing

### Task 5: Add types + fetchers to api.ts

**Files:**
- Modify: `frontend/src/api.ts`

- [ ] **Step 1: Append types + fetchers to api.ts**

Add at the end of `frontend/src/api.ts` (after `getPMC` and related types):

```typescript
// =============================================================
// STRIDE self-developed endpoints (/api/{user}/stride/*)
// =============================================================

export interface StrideThreshold {
  speed_mps: number | null
  pace_per_km_sec: number | null
  hr_bpm: number | null
  speed_confidence: string | null
  hr_confidence: string | null
  as_of_date: string
  calibration_id: number
}

export interface StridePaceZone {
  name: string             // 'Z1' | 'Z2' | 'Z3' | 'Z4' | 'Z5'
  label: string            // '轻松' / '有氧' / ...
  lower_pace: string | null  // 'M:SS' /km (slower edge)
  upper_pace: string | null  // 'M:SS' /km (faster edge)
}

export interface StrideHrZone {
  name: string
  label: string
  lower_bpm: number | null
  upper_bpm: number | null
}

export interface StrideZonesResponse {
  threshold: StrideThreshold | null
  pace_zones: StridePaceZone[]
  hr_zones: StrideHrZone[]
}

export function getStrideZones(user: string) {
  return fetchJSON<StrideZonesResponse>(`/${user}/stride/zones`)
}

export interface StrideTrainingLoadRecord {
  date: string
  algorithm_version: number
  training_dose: number | null
  acute_load: number | null
  chronic_load: number | null
  form: number | null
  load_ratio: number | null
  readiness_gate: string | null
  readiness_reasons: string[]
}

export interface StrideTrainingLoadResponse {
  current: StrideTrainingLoadRecord | null
  series: StrideTrainingLoadRecord[]
}

export function getStrideTrainingLoad(user: string, days = 90) {
  return fetchJSON<StrideTrainingLoadResponse>(`/${user}/stride/training-load?days=${days}`)
}
```

- [ ] **Step 2: TypeScript compile check**

```powershell
cd frontend; npx tsc --noEmit
```
Expected: Exits 0 (no type errors).

- [ ] **Step 3: Commit**

```powershell
git add frontend/src/api.ts
git commit -m "feat(frontend): add stride API fetchers + types"
```

---

### Task 6: Add sidebar nav entry

**Files:**
- Modify: `frontend/src/components/AppLayout.tsx`

(Route registration is deferred to Task 7 to keep TypeScript compile green between commits — `App.tsx` won't reference `TrainingStatusPage` until the file exists.)

- [ ] **Step 1: Add sidebar NavItem**

In `frontend/src/components/AppLayout.tsx`, locate the "数据 / 分析" `<NavSection>` block (around lines 108-127). After the `to="/body-composition"` NavItem, add:

```tsx
              <NavItem
                to="/training-status"
                collapsed={collapsed}
                icon={<PulseIcon />}
                text="训练状态（STRIDE）"
              />
```

Use `PulseIcon` (already imported, used by 身体指标). Visual polish (a distinctive icon) can be a follow-up — not blocking.

- [ ] **Step 2: TypeScript compile**

```powershell
cd frontend; npx tsc --noEmit
```
Expected: Exits 0. (The new nav item links to a route that does not exist yet — clicking it will hit React Router's NotFound fallback or render an empty `<Outlet />`. This is intentional and resolved in Task 7.)

- [ ] **Step 3: Commit**

```powershell
git add frontend/src/components/AppLayout.tsx
git commit -m "feat(frontend): add 训练状态（STRIDE）sidebar nav item"
```

---

## Phase 4: Frontend — TrainingStatusPage

### Task 7: Create page skeleton with data fetching + time-range toggle

**Files:**
- Create: `frontend/src/pages/TrainingStatusPage.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Create TrainingStatusPage.tsx skeleton**

Create `frontend/src/pages/TrainingStatusPage.tsx`:

```tsx
import { useEffect, useState } from 'react'
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from 'recharts'
import {
  getHealth, getHrv, getStrideZones, getStrideTrainingLoad,
  type HealthRecord, type HrvDailyRecord,
  type StrideZonesResponse, type StrideTrainingLoadResponse,
} from '../api'
import { useUser } from '../UserContextValue'
import ViewHead from '../components/ViewHead'

const AXIS_TICK = { fontSize: 10, fontFamily: 'JetBrains Mono', fill: '#8888a0' }
const TOOLTIP_STYLE = {
  contentStyle: { background: '#ffffff', border: '1px solid #d8dae5', borderRadius: 8, fontFamily: 'JetBrains Mono', fontSize: 12, color: '#1a1c2e' },
  labelStyle: { color: '#8888a0' },
}
const GRID_STYLE = { stroke: '#e8eaf0', strokeDasharray: '3 3' }

type DaysWindow = 14 | 30 | 60 | 90

function formatDateShort(iso: string): string {
  if (!iso || iso.length < 10) return iso
  return `${parseInt(iso.slice(5, 7), 10)}/${parseInt(iso.slice(8, 10), 10)}`
}

export default function TrainingStatusPage() {
  const { user } = useUser()
  const [days, setDays] = useState<DaysWindow>(30)
  const [health, setHealth] = useState<{ health: HealthRecord[]; rhr_baseline: number | null } | null>(null)
  const [hrv, setHrv] = useState<{ hrv: HrvDailyRecord[] } | null>(null)
  const [zones, setZones] = useState<StrideZonesResponse | null>(null)
  const [load, setLoad] = useState<StrideTrainingLoadResponse | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!user) return
    let cancelled = false
    setLoaded(false)
    setError(null)
    Promise.all([
      getHealth(user, 90),
      getHrv(user, 90),
      getStrideZones(user),
      getStrideTrainingLoad(user, days),
    ])
      .then(([h, hv, z, ld]) => {
        if (cancelled) return
        setHealth({ health: h.health, rhr_baseline: h.rhr_baseline })
        setHrv({ hrv: hv.hrv })
        setZones(z)
        setLoad(ld)
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => { cancelled = true }
  }, [user, days])

  if (!loaded) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-6 h-6 border-2 border-accent-green/30 border-t-accent-green rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 sm:px-8 sm:py-8 animate-fade-in">
      <div className="flex items-start justify-between gap-4 mb-4">
        <ViewHead eyebrow="STRIDE 自研算法" title="训练状态" lede="Threshold · Zones · Training Load" />
        <TimeRangeToggle value={days} onChange={setDays} />
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 mb-4 text-sm font-mono">
          加载失败：{error}
        </div>
      )}

      {/* Sections to be filled in by subsequent tasks */}
      <MetricsRow health={health} hrv={hrv} zones={zones} />
      <TrendsRow health={health} hrv={hrv} days={days} />
      <ZonesRow zones={zones} />
      <TrainingLoadSection load={load} />
      <DataStatusFooter zones={zones} load={load} />
    </div>
  )
}

function TimeRangeToggle({ value, onChange }: { value: DaysWindow; onChange: (d: DaysWindow) => void }) {
  const opts: DaysWindow[] = [14, 30, 60, 90]
  return (
    <div className="inline-flex rounded-md border border-border-subtle bg-bg-card p-0.5">
      {opts.map((d) => (
        <button
          key={d}
          type="button"
          onClick={() => onChange(d)}
          className={`px-3 py-1 text-xs font-mono rounded ${
            value === d ? 'bg-accent-green/15 text-accent-green' : 'text-text-muted hover:text-text-primary'
          }`}
        >
          {d}d
        </button>
      ))}
    </div>
  )
}

// === Placeholders filled by Tasks 8–11 ===
function MetricsRow(_props: { health: any; hrv: any; zones: any }) { return <div data-section="metrics" /> }
function TrendsRow(_props: { health: any; hrv: any; days: DaysWindow }) { return <div data-section="trends" /> }
function ZonesRow(_props: { zones: any }) { return <div data-section="zones" /> }
function TrainingLoadSection(_props: { load: any }) { return <div data-section="load" /> }
function DataStatusFooter(_props: { zones: any; load: any }) { return <div data-section="footer" /> }
```

- [ ] **Step 2: Re-enable route in App.tsx**

Now `TrainingStatusPage` exists. Add the import (line ~12):
```tsx
import TrainingStatusPage from './pages/TrainingStatusPage'
```

Add the route after `/ability` (around line 93):
```tsx
                    <Route path="/training-status" element={<TrainingStatusPage />} />
```

- [ ] **Step 3: TypeScript compile**

```powershell
cd frontend; npx tsc --noEmit
```
Expected: Exits 0.

- [ ] **Step 4: Smoke check via dev server**

```powershell
cd frontend; npm run dev
```
Open browser to `http://localhost:5173/training-status`. Expected:
- Page header "训练状态" visible
- Time range toggle (14/30/60/90) visible, 30 highlighted
- 5 empty placeholder `<div data-section="*">` slots in DOM
- No console errors (4 API requests all 200; UI just doesn't render their content yet)

Kill dev server with Ctrl+C.

- [ ] **Step 5: Commit**

```powershell
git add frontend/src/pages/TrainingStatusPage.tsx frontend/src/App.tsx
git commit -m "feat(frontend): scaffold TrainingStatusPage with data fetching + time toggle"
```

---

### Task 8: Implement 4 metric cards (RHR / HRV / 阈值配速 / 阈值心率)

**Files:**
- Modify: `frontend/src/pages/TrainingStatusPage.tsx`

- [ ] **Step 1: Replace the `MetricsRow` placeholder + add `MetricCard` component**

In `TrainingStatusPage.tsx`, replace the placeholder `function MetricsRow(...)` with:

```tsx
function MetricCard({
  label, sublabel, value, unit, baseline, color,
}: {
  label: string
  sublabel: string
  value: string
  unit: string
  baseline?: string | null
  color: string
}) {
  return (
    <div className="bg-bg-card border border-border-subtle rounded-2xl p-4 flex flex-col gap-1">
      <div className="text-xs font-mono text-text-muted">{label}</div>
      <div className="text-[10px] font-mono text-text-faint">{sublabel}</div>
      <div className="flex items-baseline gap-1 mt-1">
        <span className="text-2xl font-mono font-medium" style={{ color }}>{value}</span>
        <span className="text-xs font-mono text-text-muted">{unit}</span>
      </div>
      {baseline != null && (
        <div className="text-[10px] font-mono text-text-muted mt-0.5">基线 {baseline}</div>
      )}
    </div>
  )
}

function MetricsRow({
  health, hrv, zones,
}: {
  health: { health: HealthRecord[]; rhr_baseline: number | null } | null
  hrv: { hrv: HrvDailyRecord[] } | null
  zones: StrideZonesResponse | null
}) {
  const latestRhr = health?.health.find((r) => r.rhr != null)?.rhr ?? null
  const rhrBaseline = health?.rhr_baseline ?? null
  const latestHrv = hrv?.hrv.slice().reverse().find((r) => r.last_night_avg != null)?.last_night_avg ?? null
  const threshold = zones?.threshold

  const pacePerKm = threshold?.pace_per_km_sec
  const paceStr = pacePerKm != null ? `${Math.floor(pacePerKm / 60)}:${String(pacePerKm % 60).padStart(2, '0')}` : '—'
  const hrStr = threshold?.hr_bpm != null ? String(Math.round(threshold.hr_bpm)) : '—'

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      <MetricCard
        label="RHR" sublabel="Resting HR · 手表读数"
        value={latestRhr != null ? String(latestRhr) : '—'}
        unit="bpm"
        baseline={rhrBaseline != null ? `${rhrBaseline} bpm` : null}
        color="#0097a7"
      />
      <MetricCard
        label="HRV" sublabel="Last-night avg · 手表读数"
        value={latestHrv != null ? String(latestHrv) : '—'}
        unit="ms"
        color="#7a4dd4"
      />
      <MetricCard
        label="阈值配速" sublabel="STRIDE Threshold Pace"
        value={paceStr}
        unit="/km"
        baseline={threshold?.speed_confidence ? `置信 ${threshold.speed_confidence}` : null}
        color="#00a85a"
      />
      <MetricCard
        label="阈值心率" sublabel="STRIDE Threshold HR"
        value={hrStr}
        unit="bpm"
        baseline={threshold?.hr_confidence ? `置信 ${threshold.hr_confidence}` : null}
        color="#d97706"
      />
    </div>
  )
}
```

- [ ] **Step 2: TypeScript compile**

```powershell
cd frontend; npx tsc --noEmit
```
Expected: Exits 0.

- [ ] **Step 3: Visual check via dev server**

```powershell
cd frontend; npm run dev
```
Open `/training-status`. Expected: 4 cards render horizontally on desktop, 2×2 on narrow viewport. RHR + 阈值配速 + 阈值心率 show real numbers (HRV may show — if user has no Garmin sync).

- [ ] **Step 4: Commit**

```powershell
git add frontend/src/pages/TrainingStatusPage.tsx
git commit -m "feat(frontend): implement 4 metric cards in TrainingStatusPage"
```

---

### Task 9: Implement RHR + HRV trend charts (each half-row)

**Files:**
- Modify: `frontend/src/pages/TrainingStatusPage.tsx`

- [ ] **Step 1: Replace `TrendsRow` placeholder**

```tsx
function TrendsRow({
  health, hrv, days,
}: {
  health: { health: HealthRecord[]; rhr_baseline: number | null } | null
  hrv: { hrv: HrvDailyRecord[] } | null
  days: DaysWindow
}) {
  // health.health is newest-first; reverse to oldest-first; slice to window
  const rhrData = (health?.health ?? [])
    .slice()
    .reverse()
    .filter((r) => r.rhr != null)
    .slice(-days)
    .map((r) => ({ date: r.date, dateLabel: formatDateShort(r.date.length === 8 ? `${r.date.slice(0,4)}-${r.date.slice(4,6)}-${r.date.slice(6,8)}` : r.date), rhr: r.rhr }))

  const hrvData = (hrv?.hrv ?? [])
    .slice()
    .filter((r) => r.last_night_avg != null)
    .slice(-days)
    .map((r) => ({ date: r.date, dateLabel: formatDateShort(r.date), hrv: r.last_night_avg }))

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
      <ChartCard title="RHR 趋势" sublabel={`最近 ${days} 天 · 手表读数`}>
        {rhrData.length === 0 ? (
          <EmptyChart text="暂无 RHR 数据" />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={rhrData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="dateLabel" tick={AXIS_TICK} />
              <YAxis tick={AXIS_TICK} domain={['dataMin - 2', 'dataMax + 2']} />
              <Tooltip {...TOOLTIP_STYLE} />
              <Area type="monotone" dataKey="rhr" stroke="#0097a7" fill="#0097a7" fillOpacity={0.15} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
      <ChartCard title="HRV 趋势" sublabel={`最近 ${days} 天 · 手表读数`}>
        {hrvData.length === 0 ? (
          <EmptyChart text="暂无 HRV 数据" />
        ) : (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={hrvData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid {...GRID_STYLE} />
              <XAxis dataKey="dateLabel" tick={AXIS_TICK} />
              <YAxis tick={AXIS_TICK} domain={['dataMin - 5', 'dataMax + 5']} />
              <Tooltip {...TOOLTIP_STYLE} />
              <Area type="monotone" dataKey="hrv" stroke="#7a4dd4" fill="#7a4dd4" fillOpacity={0.15} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </ChartCard>
    </div>
  )
}

function ChartCard({ title, sublabel, children }: { title: string; sublabel: string; children: React.ReactNode }) {
  return (
    <div className="bg-bg-card border border-border-subtle rounded-2xl p-4">
      <div className="text-xs font-mono text-text-muted">{title}</div>
      <div className="text-[10px] font-mono text-text-faint mb-2">{sublabel}</div>
      {children}
    </div>
  )
}

function EmptyChart({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center h-[200px] text-xs font-mono text-text-muted">{text}</div>
  )
}
```

- [ ] **Step 2: TypeScript compile**

```powershell
cd frontend; npx tsc --noEmit
```
Expected: 0 errors.

- [ ] **Step 3: Visual check**

```powershell
cd frontend; npm run dev
```
Open `/training-status`. Expected: 2 chart cards below the 4 metric cards. RHR chart shows last 30 days. Switching to 90d re-renders with more points.

- [ ] **Step 4: Commit**

```powershell
git add frontend/src/pages/TrainingStatusPage.tsx
git commit -m "feat(frontend): add RHR + HRV trend charts (half-row each)"
```

---

### Task 10: Implement pace + HR zones list (each half-row)

**Files:**
- Modify: `frontend/src/pages/TrainingStatusPage.tsx`

- [ ] **Step 1: Replace `ZonesRow` placeholder**

```tsx
function ZonesRow({ zones }: { zones: StrideZonesResponse | null }) {
  const hasData = !!zones?.threshold && zones.pace_zones.length > 0 && zones.hr_zones.length > 0

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
      <ChartCard title="配速区间" sublabel="STRIDE-derived from threshold pace">
        {hasData ? (
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-text-faint border-b border-border-subtle">
                <th className="text-left py-1">Zone</th>
                <th className="text-left py-1">名称</th>
                <th className="text-right py-1">慢边</th>
                <th className="text-right py-1">快边</th>
              </tr>
            </thead>
            <tbody>
              {zones!.pace_zones.map((z) => (
                <tr key={z.name} className="border-b border-border-subtle/50 last:border-0">
                  <td className="py-1.5 text-accent-green">{z.name}</td>
                  <td className="py-1.5 text-text-primary">{z.label}</td>
                  <td className="py-1.5 text-right text-text-muted">{z.lower_pace ?? '—'}</td>
                  <td className="py-1.5 text-right text-text-muted">{z.upper_pace ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyZones />
        )}
      </ChartCard>

      <ChartCard title="心率区间" sublabel="STRIDE-derived from threshold HR">
        {hasData ? (
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="text-text-faint border-b border-border-subtle">
                <th className="text-left py-1">Zone</th>
                <th className="text-left py-1">名称</th>
                <th className="text-right py-1">下限</th>
                <th className="text-right py-1">上限</th>
              </tr>
            </thead>
            <tbody>
              {zones!.hr_zones.map((z) => (
                <tr key={z.name} className="border-b border-border-subtle/50 last:border-0">
                  <td className="py-1.5 text-accent-amber">{z.name}</td>
                  <td className="py-1.5 text-text-primary">{z.label}</td>
                  <td className="py-1.5 text-right text-text-muted">{z.lower_bpm ?? '—'}</td>
                  <td className="py-1.5 text-right text-text-muted">{z.upper_bpm ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <EmptyZones />
        )}
      </ChartCard>
    </div>
  )
}

function EmptyZones() {
  return (
    <div className="text-xs font-mono text-text-muted py-6 text-center">
      暂无 STRIDE 校准数据
      <br />
      需先完成一定次数的跑步活动
    </div>
  )
}
```

- [ ] **Step 2: TypeScript compile + visual check**

```powershell
cd frontend; npx tsc --noEmit
cd frontend; npm run dev
```
Open `/training-status`. Expected: 2 zone tables render with 5 rows each.

- [ ] **Step 3: Commit**

```powershell
git add frontend/src/pages/TrainingStatusPage.tsx
git commit -m "feat(frontend): add pace + HR zone lists (half-row each)"
```

---

### Task 11: Implement training load section (full row) + PMC chart

**Files:**
- Modify: `frontend/src/pages/TrainingStatusPage.tsx`

- [ ] **Step 1: Replace `TrainingLoadSection` placeholder**

```tsx
function TrainingLoadSection({ load }: { load: StrideTrainingLoadResponse | null }) {
  const cur = load?.current
  const series = (load?.series ?? []).map((r) => ({
    ...r,
    dateLabel: formatDateShort(r.date),
  }))

  const stateLabel = (() => {
    const ratio = cur?.load_ratio
    if (ratio == null) return '—'
    if (ratio < 0.8) return '恢复期'
    if (ratio < 1.0) return '正常训练'
    if (ratio < 1.3) return '产出期'
    return '过度负荷'
  })()

  return (
    <div className="bg-bg-card border border-border-subtle rounded-2xl p-4 mb-6">
      <div className="text-xs font-mono text-text-muted mb-2">训练负荷（STRIDE）</div>
      {!cur ? (
        <div className="text-xs font-mono text-text-muted py-6 text-center">暂无训练负荷数据</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
            <LoadStat label="Acute" value={cur.acute_load?.toFixed(1) ?? '—'} color="#d97706" />
            <LoadStat label="Chronic" value={cur.chronic_load?.toFixed(1) ?? '—'} color="#0097a7" />
            <LoadStat label="Form" value={cur.form != null ? (cur.form > 0 ? `+${cur.form.toFixed(1)}` : cur.form.toFixed(1)) : '—'} color={cur.form != null && cur.form < -10 ? '#d32f2f' : '#00a85a'} />
            <LoadStat label="Ratio" value={cur.load_ratio?.toFixed(2) ?? '—'} color="#7a4dd4" />
            <LoadStat label="状态" value={stateLabel} color="#1a1c2e" />
          </div>
          <div className="text-[11px] font-mono text-text-muted mb-2">
            Readiness: <span className="text-text-primary">{cur.readiness_gate ?? '—'}</span>
            {cur.readiness_reasons.length > 0 && (
              <span className="ml-2 text-text-faint">· {cur.readiness_reasons.join(' · ')}</span>
            )}
          </div>
          {series.length > 0 && (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid {...GRID_STYLE} />
                <XAxis dataKey="dateLabel" tick={AXIS_TICK} />
                <YAxis tick={AXIS_TICK} />
                <Tooltip {...TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: 10, fontFamily: 'JetBrains Mono' }} />
                <Area type="monotone" dataKey="acute_load" name="Acute" stroke="#d97706" fill="#d97706" fillOpacity={0.15} />
                <Area type="monotone" dataKey="chronic_load" name="Chronic" stroke="#0097a7" fill="#0097a7" fillOpacity={0.15} />
                <Area type="monotone" dataKey="form" name="Form" stroke="#00a85a" fill="#00a85a" fillOpacity={0.1} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </>
      )}
    </div>
  )
}

function LoadStat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="flex flex-col">
      <div className="text-[10px] font-mono text-text-faint">{label}</div>
      <div className="text-lg font-mono font-medium" style={{ color }}>{value}</div>
    </div>
  )
}
```

- [ ] **Step 2: TypeScript compile + visual**

```powershell
cd frontend; npx tsc --noEmit
cd frontend; npm run dev
```
Open `/training-status`. Expected: training load card shows 5 stats + readiness line + stacked area chart. Switching 14/30/60/90 re-fetches and re-renders.

- [ ] **Step 3: Commit**

```powershell
git add frontend/src/pages/TrainingStatusPage.tsx
git commit -m "feat(frontend): add training load section + PMC area chart"
```

---

### Task 12: Implement data status footer

**Files:**
- Modify: `frontend/src/pages/TrainingStatusPage.tsx`

- [ ] **Step 1: Replace `DataStatusFooter` placeholder**

```tsx
function DataStatusFooter({
  zones, load,
}: {
  zones: StrideZonesResponse | null
  load: StrideTrainingLoadResponse | null
}) {
  return (
    <div className="text-[10px] font-mono text-text-faint border-t border-border-subtle pt-3 mt-4 space-y-0.5">
      <div>
        Calibration: {zones?.threshold?.as_of_date ?? '—'} · 来源：STRIDE 自研算法
      </div>
      <div>Training load latest: {load?.current?.date ?? '—'}</div>
      <div>RHR / HRV: 来自手表原始读数（COROS / Garmin）</div>
    </div>
  )
}
```

- [ ] **Step 2: Compile + visual**

```powershell
cd frontend; npx tsc --noEmit
cd frontend; npm run dev
```
Open `/training-status`. Expected: 3-line footer at the bottom.

- [ ] **Step 3: Commit**

```powershell
git add frontend/src/pages/TrainingStatusPage.tsx
git commit -m "feat(frontend): add data status footer to TrainingStatusPage"
```

---

## Phase 5: Frontend Tests

### Task 13: Write TrainingStatusPage vitest coverage

**Files:**
- Create: `frontend/src/pages/__tests__/TrainingStatusPage.test.tsx`

- [ ] **Step 1: Write the test file**

```tsx
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'

import * as api from '../../api'
import { UserContext } from '../../UserContextValue'
import TrainingStatusPage from '../TrainingStatusPage'

vi.mock('recharts', () => {
  const NullChartElement = () => null
  return {
    ResponsiveContainer: NullChartElement,
    AreaChart: NullChartElement,
    Area: NullChartElement,
    LineChart: NullChartElement,
    Line: NullChartElement,
    XAxis: NullChartElement,
    YAxis: NullChartElement,
    Tooltip: NullChartElement,
    CartesianGrid: NullChartElement,
    Legend: NullChartElement,
  }
})

vi.mock('../../api', async () => {
  const actual = await vi.importActual<typeof api>('../../api')
  return {
    ...actual,
    getHealth: vi.fn(),
    getHrv: vi.fn(),
    getStrideZones: vi.fn(),
    getStrideTrainingLoad: vi.fn(),
  }
})

const USER = '00000000-0000-4000-8000-000000000001'

function renderPage() {
  return render(
    <MemoryRouter>
      <UserContext.Provider value={{ user: USER, setUser: vi.fn() }}>
        <TrainingStatusPage />
      </UserContext.Provider>
    </MemoryRouter>,
  )
}

const happyZones: api.StrideZonesResponse = {
  threshold: {
    speed_mps: 4.65,
    pace_per_km_sec: 215,
    hr_bpm: 175,
    speed_confidence: 'medium',
    hr_confidence: 'medium',
    as_of_date: '2026-05-15',
    calibration_id: 1,
  },
  pace_zones: [
    { name: 'Z1', label: '轻松', lower_pace: '6:42', upper_pace: '5:58' },
    { name: 'Z2', label: '有氧', lower_pace: '5:58', upper_pace: '5:06' },
    { name: 'Z3', label: '节奏', lower_pace: '5:06', upper_pace: '4:36' },
    { name: 'Z4', label: '阈值', lower_pace: '4:36', upper_pace: '4:18' },
    { name: 'Z5', label: 'VO2max', lower_pace: '4:18', upper_pace: '3:52' },
  ],
  hr_zones: [
    { name: 'Z1', label: '恢复', lower_bpm: 105, upper_bpm: 140 },
    { name: 'Z2', label: '有氧', lower_bpm: 140, upper_bpm: 154 },
    { name: 'Z3', label: '节奏', lower_bpm: 154, upper_bpm: 165 },
    { name: 'Z4', label: '阈值', lower_bpm: 165, upper_bpm: 175 },
    { name: 'Z5', label: 'VO2max', lower_bpm: 175, upper_bpm: 188 },
  ],
}

const happyLoad: api.StrideTrainingLoadResponse = {
  current: {
    date: '2026-05-21', algorithm_version: 1, training_dose: 75.2,
    acute_load: 78, chronic_load: 72, form: -6, load_ratio: 1.08,
    readiness_gate: 'go', readiness_reasons: ['ok'],
  },
  series: [
    { date: '2026-05-17', algorithm_version: 1, training_dose: 60, acute_load: 70, chronic_load: 70, form: 0, load_ratio: 1.0, readiness_gate: 'go', readiness_reasons: [] },
    { date: '2026-05-21', algorithm_version: 1, training_dose: 75.2, acute_load: 78, chronic_load: 72, form: -6, load_ratio: 1.08, readiness_gate: 'go', readiness_reasons: [] },
  ],
}

beforeEach(() => {
  vi.mocked(api.getHealth).mockResolvedValue({
    health: [{ date: '20260521', rhr: 47 } as any],
    hrv: {} as any,
    rhr_baseline: 49,
  })
  vi.mocked(api.getHrv).mockResolvedValue({
    hrv: [{ date: '2026-05-21', last_night_avg: 62 } as any],
    summary: {} as any,
  })
  vi.mocked(api.getStrideZones).mockResolvedValue(happyZones)
  vi.mocked(api.getStrideTrainingLoad).mockResolvedValue(happyLoad)
})

describe('TrainingStatusPage', () => {
  it('renders all 5 sections on happy path', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('训练状态')).toBeInTheDocument())

    // Metric cards
    expect(screen.getByText('47')).toBeInTheDocument()  // RHR
    expect(screen.getByText('62')).toBeInTheDocument()  // HRV
    expect(screen.getByText('3:35')).toBeInTheDocument() // 阈值配速 = 215s/km = 3:35
    expect(screen.getByText('175')).toBeInTheDocument()  // 阈值心率

    // Zone tables — 5 rows each
    expect(screen.getAllByText('Z1').length).toBe(2)
    expect(screen.getByText('轻松')).toBeInTheDocument()
    expect(screen.getByText('恢复')).toBeInTheDocument()

    // Training load
    expect(screen.getByText('Acute')).toBeInTheDocument()
    expect(screen.getByText('78.0')).toBeInTheDocument()

    // Footer
    expect(screen.getByText(/Calibration:.*2026-05-15/)).toBeInTheDocument()
  })

  it('shows empty-state when zones threshold is null', async () => {
    vi.mocked(api.getStrideZones).mockResolvedValue({
      threshold: null, pace_zones: [], hr_zones: [],
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('训练状态')).toBeInTheDocument())
    expect(screen.getAllByText(/暂无 STRIDE 校准数据/).length).toBeGreaterThan(0)
  })

  it('shows empty-state when training load is empty', async () => {
    vi.mocked(api.getStrideTrainingLoad).mockResolvedValue({
      current: null, series: [],
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('训练状态')).toBeInTheDocument())
    expect(screen.getByText('暂无训练负荷数据')).toBeInTheDocument()
  })

  it('refetches training-load on time-range toggle', async () => {
    renderPage()
    await waitFor(() => expect(api.getStrideTrainingLoad).toHaveBeenCalledWith(USER, 30))

    fireEvent.click(screen.getByRole('button', { name: '90d' }))
    await waitFor(() => expect(api.getStrideTrainingLoad).toHaveBeenCalledWith(USER, 90))
  })

  it('does NOT use COROS pass-through fields from /health', async () => {
    // Feed /health with COROS fields populated; assert UI never displays them
    vi.mocked(api.getHealth).mockResolvedValue({
      health: [{ date: '20260521', rhr: 47, ati: 99, cti: 99, tsb: 99 } as any],
      hrv: {} as any,
      rhr_baseline: 49,
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('训练状态')).toBeInTheDocument())
    // The number 99 should NOT appear anywhere on the page
    expect(screen.queryByText('99')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the new tests**

```powershell
cd frontend; npx vitest run src/pages/__tests__/TrainingStatusPage.test.tsx
```
Expected: All 5 tests PASS.

- [ ] **Step 3: Run full frontend test suite (regression check)**

```powershell
cd frontend; npx vitest run
```
Expected: All previously-passing tests still pass.

- [ ] **Step 4: Commit**

```powershell
git add frontend/src/pages/__tests__/TrainingStatusPage.test.tsx
git commit -m "test(frontend): cover TrainingStatusPage happy + empty + toggle paths"
```

---

## Phase 6: Manual Verification + PR

### Task 14: End-to-end manual verification

**Files:** N/A (verification only)

- [ ] **Step 1: Sync latest data**

```powershell
$env:PYTHONIOENCODING = "utf-8"
python -m coros_sync -P zhaochaoyi sync
```
Expected: Sync completes successfully, no errors.

- [ ] **Step 2: Start backend**

In one terminal (worktree root):
```powershell
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONPATH = "src"
python -m stride_server
```
Expected: Server starts on default port (e.g., 8000).

- [ ] **Step 3: Start frontend**

In another terminal:
```powershell
cd frontend; npm run dev
```
Expected: Vite dev server on http://localhost:5173.

- [ ] **Step 4: Browser checks**

Open http://localhost:5173/training-status and verify:

1. Sidebar shows `训练状态（STRIDE）` under "数据 / 分析"
2. 4 metric cards render with real numbers:
   - RHR within [40, 60]
   - HRV non-null (if Garmin synced) or `—`
   - 阈值配速 within [3:30, 5:30] /km range
   - 阈值心率 within [150, 190] bpm
3. RHR + HRV trend charts: 30 days of data, continuous
4. Pace + HR zone tables: 5 rows each, Z1 < Z2 < Z3 < Z4 < Z5 strictly increasing
5. Training load stacked area chart: Acute / Chronic / Form three series visible
6. Toggle 14/30/60/90: training load chart re-fetches and re-renders; RHR/HRV trends crop window
7. Footer shows calibration date + data source notes

- [ ] **Step 5: Cross-page consistency check (核心价值证明)**

Visit `/health` (old 身体指标 page). Note its ATI / CTI / TSB current numbers.
Visit `/training-status`. Note Acute / Chronic / Form.

Expected: **The numbers SHOULD differ.** /health shows COROS pass-through; /training-status shows STRIDE algorithm output. If they're identical, the wrong endpoint is being read.

- [ ] **Step 6: No-calibration smoke test**

If you have access to a second user without calibration data (or temporarily clear `running_calibration_snapshot` rows in a tmp DB), verify the page does not crash and shows "暂无 STRIDE 校准数据" placeholders.

- [ ] **Step 7: Take a screenshot of the working page for the PR**

Use Windows Snipping Tool or browser dev tools full-page screenshot. Save to `.tmp/training-status-screenshot.png` (gitignored).

---

### Task 15: Final lint + push branch + open PR

**Files:** N/A (CI / GitHub operations)

- [ ] **Step 1: Run full backend test suite again**

```powershell
$env:PYTHONPATH = "src"; pytest tests/ -q
$env:PYTHONPATH = "src"; lint-imports
```
Expected: All green.

- [ ] **Step 2: Run full frontend test suite + tsc**

```powershell
cd frontend; npx tsc --noEmit; npx vitest run
```
Expected: All green.

- [ ] **Step 3: Push branch**

```powershell
git push -u origin training-status-page
```

- [ ] **Step 4: Open PR via gh CLI**

```powershell
gh pr create --title "feat: 训练状态（STRIDE）page — new STRIDE-self-developed metrics view" --body @"
## Summary
- New ``/training-status`` page under sidebar 数据/分析 group
- 2 new endpoints under ``/api/{user}/stride/*`` namespace (zones, training-load)
- Strictly serves STRIDE-self-computed values; ignores COROS pass-through (ati/cti/training_load_state)
- Old endpoints (``/health``, ``/hrv``, ``/pmc``) and old pages unchanged

## Test plan
- [x] ``pytest tests/test_stride_routes.py`` — 6 tests cover happy / empty / unauth / validation
- [x] ``pytest tests/`` full backend suite green
- [x] ``lint-imports`` green
- [x] ``vitest run src/pages/__tests__/TrainingStatusPage.test.tsx`` — 5 tests
- [x] ``vitest run`` full frontend suite green
- [x] ``tsc --noEmit`` green
- [x] Manual browser check: all 4 cards + 2 trend charts + 2 zone tables + training load section + footer render
- [x] Time range toggle (14/30/60/90) re-fetches training-load
- [x] Cross-page check: ``/training-status`` Acute/Chronic numbers differ from ``/health`` ATI/CTI (proves STRIDE algorithm is in use, not COROS pass-through)

Design spec: ``docs/superpowers/specs/2026-05-21-training-status-page-design.md``
Implementation plan: ``docs/superpowers/plans/2026-05-21-training-status-page.md``

🤖 Generated with [Claude Code](https://claude.com/claude-code)
"@
```

- [ ] **Step 5: Report PR URL**

Capture the URL printed by ``gh pr create`` and share with the user.

---

## Done Criteria

- [ ] All 16 tasks above checked
- [ ] PR open, CI green
- [ ] User has visually verified the page in their browser
- [ ] Cross-page sanity: training load on new page ≠ on old page (proves STRIDE algorithm in use)
