# Backend E2E Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a manually-triggered, read-only, JSON-configured pytest smoke suite that hits live prod after a deploy and reports pass/fail on the 7 core read paths.

**Architecture:** New opt-in test directory `tests/e2e/` gated by a pytest `e2e` marker so default `pytest tests/` (used in CI) skips it. Session-scoped fixtures load a git-ignored JSON config, POST to the external auth-service for a Bearer token, decode the JWT to get the test user's UUID, and provide an `httpx.Client` pinned to prod. Seven test functions assert response shape + status; the timezone case asserts the `+08:00` offset is present.

**Tech Stack:** Python 3.12+, pytest, httpx (already in deps), PyJWT (already via `pyjwt[crypto]` in `web` extras), bash for the runner. Optional `pytest-html` for an HTML report.

**Source spec:** `docs/superpowers/specs/2026-05-22-backend-e2e-smoke-design.md`

---

## File Map

| File | Created/Modified | Purpose |
|------|------------------|---------|
| `tests/e2e/__init__.py` | Create | Marks `tests/e2e` as a package so pytest collects it |
| `tests/e2e/_config.py` | Create | Pure helper: load + validate the JSON config |
| `tests/e2e/_jwt.py` | Create | Pure helper: decode `sub` from a JWT without verifying |
| `tests/e2e/conftest.py` | Create | Session fixtures: `e2e_config`, `e2e_token`, `e2e_user_id`, `prod_client`, raw-client; plus `--e2e-config` CLI option |
| `tests/e2e/test_smoke.py` | Create | The 7 read-only smoke cases |
| `tests/e2e/e2e.config.example.json` | Create | Committed schema-by-example |
| `tests/e2e/README.md` | Create | How to seed the test user, fill the config, run, troubleshoot |
| `tests/unit_e2e_helpers/test_config_loader.py` | Create | Unit tests for `_config.py` (no network) |
| `tests/unit_e2e_helpers/test_jwt_sub.py` | Create | Unit tests for `_jwt.py` |
| `tests/unit_e2e_helpers/__init__.py` | Create | Package marker |
| `scripts/smoke-prod.sh` | Create | One-line entrypoint, forwards extra args to pytest |
| `pyproject.toml` | Modify | Register `e2e` marker, add `-m 'not e2e'` default, add `pytest-html` to `dev` extras |
| `.gitignore` | Modify | Add `tests/e2e/e2e.config.local.json` and `out/` |

**Decomposition note:** `_config.py` and `_jwt.py` are extracted from what could have been inline conftest helpers so the logic is unit-testable (no network needed) and the conftest stays thin.

The unit tests for those helpers live under `tests/unit_e2e_helpers/` (NOT inside `tests/e2e/`) so they run as part of the default `pytest tests/` (i.e. on every PR via `ci.yml`) — the `e2e` marker would otherwise hide them.

---

## Task 1: Scaffolding — directory, pytest marker, gitignore, example config

**Files:**
- Create: `tests/e2e/__init__.py`
- Create: `tests/e2e/e2e.config.example.json`
- Create: `tests/unit_e2e_helpers/__init__.py`
- Modify: `pyproject.toml`
- Modify: `.gitignore`

- [ ] **Step 1: Create the empty package markers**

```bash
mkdir -p tests/e2e tests/unit_e2e_helpers
```

Write `tests/e2e/__init__.py`:
```python
```
(intentionally empty)

Write `tests/unit_e2e_helpers/__init__.py`:
```python
```
(intentionally empty)

- [ ] **Step 2: Write the example config**

Write `tests/e2e/e2e.config.example.json`:
```json
{
  "prod_url": "https://stride-app.victoriousdesert-bd552447.southeastasia.azurecontainerapps.io",
  "auth_url": "https://auth-backend.delightfulwave-240938c0.southeastasia.azurecontainerapps.io",
  "client_id": "app_62978bf2803346878a2e4805",
  "e2e_email": "stride-e2e@example.com",
  "e2e_password": "<fill in real password here, then rename file to e2e.config.local.json>"
}
```

- [ ] **Step 3: Register the pytest marker + default exclusion**

Open `pyproject.toml`. The existing `[tool.pytest.ini_options]` block looks like:

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["src"]
```

Replace it with:

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["src"]
addopts = "-m 'not e2e'"
markers = [
    "e2e: prod smoke test; hits live network, opt-in via -m e2e",
]
```

- [ ] **Step 4: Update `.gitignore`**

Append to `.gitignore`:

```
tests/e2e/e2e.config.local.json
out/
```

- [ ] **Step 5: Verify the marker gates correctly**

Run: `pytest tests/ --collect-only -q 2>&1 | tail -5`

Expected: no collection errors; existing test count is reported; the new `tests/e2e/__init__.py` and `tests/unit_e2e_helpers/__init__.py` cause no errors. (No e2e cases exist yet, so the marker filter has nothing to hide.)

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/__init__.py tests/e2e/e2e.config.example.json \
        tests/unit_e2e_helpers/__init__.py pyproject.toml .gitignore
git commit -m "test(e2e): scaffold opt-in tests/e2e directory + e2e marker"
```

---

## Task 2: Config loader (`_config.py`) — TDD

**Files:**
- Create: `tests/unit_e2e_helpers/test_config_loader.py`
- Create: `tests/e2e/_config.py`

- [ ] **Step 1: Write the failing tests**

Write `tests/unit_e2e_helpers/test_config_loader.py`:

```python
"""Unit tests for tests/e2e/_config.py — pure logic, no network."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.e2e._config import E2EConfig, ConfigError, load_config


def _write(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data), encoding="utf-8")


def test_loads_valid_config(tmp_path: Path) -> None:
    cfg_path = tmp_path / "e2e.config.local.json"
    _write(cfg_path, {
        "prod_url": "https://prod.example",
        "auth_url": "https://auth.example",
        "client_id": "client_abc",
        "e2e_email": "e2e@example.com",
        "e2e_password": "pw",
    })
    cfg = load_config(cfg_path)
    assert isinstance(cfg, E2EConfig)
    assert cfg.prod_url == "https://prod.example"
    assert cfg.auth_url == "https://auth.example"
    assert cfg.client_id == "client_abc"
    assert cfg.e2e_email == "e2e@example.com"
    assert cfg.e2e_password == "pw"


def test_strips_trailing_slash_from_urls(tmp_path: Path) -> None:
    cfg_path = tmp_path / "c.json"
    _write(cfg_path, {
        "prod_url": "https://prod.example/",
        "auth_url": "https://auth.example/",
        "client_id": "c",
        "e2e_email": "e",
        "e2e_password": "p",
    })
    cfg = load_config(cfg_path)
    assert cfg.prod_url == "https://prod.example"
    assert cfg.auth_url == "https://auth.example"


def test_missing_file_raises_config_error(tmp_path: Path) -> None:
    with pytest.raises(ConfigError) as exc:
        load_config(tmp_path / "does-not-exist.json")
    assert "not found" in str(exc.value).lower()


def test_missing_required_key_raises_config_error(tmp_path: Path) -> None:
    cfg_path = tmp_path / "c.json"
    _write(cfg_path, {
        "prod_url": "https://prod.example",
        # missing the other four keys
    })
    with pytest.raises(ConfigError) as exc:
        load_config(cfg_path)
    msg = str(exc.value).lower()
    assert "missing" in msg
    assert "auth_url" in msg
    assert "client_id" in msg
    assert "e2e_email" in msg
    assert "e2e_password" in msg


def test_malformed_json_raises_config_error(tmp_path: Path) -> None:
    cfg_path = tmp_path / "c.json"
    cfg_path.write_text("{ this is not valid json", encoding="utf-8")
    with pytest.raises(ConfigError) as exc:
        load_config(cfg_path)
    assert "parse" in str(exc.value).lower() or "json" in str(exc.value).lower()


def test_empty_string_value_treated_as_missing(tmp_path: Path) -> None:
    cfg_path = tmp_path / "c.json"
    _write(cfg_path, {
        "prod_url": "https://prod.example",
        "auth_url": "https://auth.example",
        "client_id": "",
        "e2e_email": "e",
        "e2e_password": "p",
    })
    with pytest.raises(ConfigError) as exc:
        load_config(cfg_path)
    assert "client_id" in str(exc.value)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/unit_e2e_helpers/test_config_loader.py -v`

Expected: ImportError / ModuleNotFoundError for `tests.e2e._config`. All 6 tests fail to even import.

- [ ] **Step 3: Implement `_config.py`**

Write `tests/e2e/_config.py`:

```python
"""Load and validate tests/e2e/e2e.config.local.json. Pure I/O — no network."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


class ConfigError(RuntimeError):
    """Raised when the e2e config file is missing, malformed, or incomplete."""


@dataclass(frozen=True)
class E2EConfig:
    prod_url: str
    auth_url: str
    client_id: str
    e2e_email: str
    e2e_password: str


_REQUIRED = ("prod_url", "auth_url", "client_id", "e2e_email", "e2e_password")


def load_config(path: Path) -> E2EConfig:
    if not path.exists():
        raise ConfigError(
            f"e2e config not found at {path}; "
            f"copy tests/e2e/e2e.config.example.json to "
            f"tests/e2e/e2e.config.local.json and fill in credentials"
        )
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ConfigError(f"failed to parse {path} as JSON: {e}") from e
    if not isinstance(raw, dict):
        raise ConfigError(f"{path} must contain a JSON object, got {type(raw).__name__}")

    missing = [k for k in _REQUIRED if not isinstance(raw.get(k), str) or not raw.get(k).strip()]
    if missing:
        raise ConfigError(
            f"e2e config {path} is missing or empty for required keys: {', '.join(missing)}"
        )

    return E2EConfig(
        prod_url=raw["prod_url"].rstrip("/"),
        auth_url=raw["auth_url"].rstrip("/"),
        client_id=raw["client_id"],
        e2e_email=raw["e2e_email"],
        e2e_password=raw["e2e_password"],
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/unit_e2e_helpers/test_config_loader.py -v`

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/_config.py tests/unit_e2e_helpers/test_config_loader.py
git commit -m "test(e2e): config loader with required-key + URL-normalization checks"
```

---

## Task 3: JWT sub decoder (`_jwt.py`) — TDD

**Files:**
- Create: `tests/unit_e2e_helpers/test_jwt_sub.py`
- Create: `tests/e2e/_jwt.py`

**Context:** We get a token from the auth-service and need the `sub` claim (the user UUID) to build URLs like `/api/{user}/home`. We do **not** need to verify the signature — we just made the request, we trust the response. The decode is a pure base64+json operation; we use PyJWT's `decode(..., options={"verify_signature": False})` to avoid hand-rolling base64url padding.

- [ ] **Step 1: Write the failing tests**

Write `tests/unit_e2e_helpers/test_jwt_sub.py`:

```python
"""Unit tests for tests/e2e/_jwt.py — decode `sub` without signature check."""
from __future__ import annotations

import jwt
import pytest

from tests.e2e._jwt import JwtError, extract_sub


def _token(payload: dict) -> str:
    return jwt.encode(payload, key="unused-secret", algorithm="HS256")


def test_extracts_sub_claim() -> None:
    token = _token({"sub": "550e8400-e29b-41d4-a716-446655440000", "iss": "auth-service"})
    assert extract_sub(token) == "550e8400-e29b-41d4-a716-446655440000"


def test_missing_sub_raises() -> None:
    token = _token({"iss": "auth-service"})
    with pytest.raises(JwtError) as exc:
        extract_sub(token)
    assert "sub" in str(exc.value)


def test_empty_sub_raises() -> None:
    token = _token({"sub": ""})
    with pytest.raises(JwtError) as exc:
        extract_sub(token)
    assert "sub" in str(exc.value)


def test_garbage_token_raises() -> None:
    with pytest.raises(JwtError):
        extract_sub("not-a-jwt")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/unit_e2e_helpers/test_jwt_sub.py -v`

Expected: ImportError for `tests.e2e._jwt`. All 4 tests fail to import.

- [ ] **Step 3: Implement `_jwt.py`**

Write `tests/e2e/_jwt.py`:

```python
"""Decode the `sub` claim from a JWT without verifying the signature.

We only call this on a token we just received from the auth-service over
TLS — verification happens server-side at request time via the public key
config. Here we just want the UUID for URL building.
"""
from __future__ import annotations

import jwt


class JwtError(RuntimeError):
    """Raised when the token cannot be decoded or has no usable `sub`."""


def extract_sub(token: str) -> str:
    try:
        payload = jwt.decode(token, options={"verify_signature": False})
    except jwt.PyJWTError as e:
        raise JwtError(f"failed to decode JWT: {e}") from e
    sub = payload.get("sub")
    if not isinstance(sub, str) or not sub.strip():
        raise JwtError("JWT payload has no `sub` claim (or it is empty)")
    return sub
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/unit_e2e_helpers/test_jwt_sub.py -v`

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/_jwt.py tests/unit_e2e_helpers/test_jwt_sub.py
git commit -m "test(e2e): JWT sub decoder (no signature verify, pure logic)"
```

---

## Task 4: Conftest — fixtures + CLI option

**Files:**
- Create: `tests/e2e/conftest.py`

**Context:** This is the only file in the suite that talks to the auth-service network. All logic that can be unit-tested already lives in `_config.py` / `_jwt.py`. There is no separate unit test for conftest itself; it is exercised end-to-end when any smoke case runs.

- [ ] **Step 1: Write the conftest**

Write `tests/e2e/conftest.py`:

```python
"""Session fixtures for the prod smoke suite.

Layered so the unit-testable bits (`_config`, `_jwt`) stay pure:
  * `e2e_config_path`   — resolves the config file (default + --e2e-config flag)
  * `e2e_config`        — parsed E2EConfig; suite skips if file is missing
  * `e2e_token`         — POSTs auth-service /api/auth/login, returns access_token
  * `e2e_user_id`       — extract_sub(e2e_token)
  * `prod_client`       — httpx.Client(base_url=prod_url, Bearer auth)
  * `prod_client_anon`  — httpx.Client(base_url=prod_url, no auth header)
"""
from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from tests.e2e._config import ConfigError, E2EConfig, load_config
from tests.e2e._jwt import extract_sub

DEFAULT_CONFIG_PATH = Path(__file__).parent / "e2e.config.local.json"
LOGIN_TIMEOUT_S = 15.0
REQUEST_TIMEOUT_S = 15.0


def pytest_addoption(parser: pytest.Parser) -> None:
    parser.addoption(
        "--e2e-config",
        action="store",
        default=None,
        help="Path to e2e config JSON. Defaults to tests/e2e/e2e.config.local.json.",
    )


@pytest.fixture(scope="session")
def e2e_config_path(request: pytest.FixtureRequest) -> Path:
    override = request.config.getoption("--e2e-config")
    return Path(override) if override else DEFAULT_CONFIG_PATH


@pytest.fixture(scope="session")
def e2e_config(e2e_config_path: Path) -> E2EConfig:
    try:
        return load_config(e2e_config_path)
    except ConfigError as e:
        pytest.skip(str(e))


@pytest.fixture(scope="session")
def e2e_token(e2e_config: E2EConfig) -> str:
    url = f"{e2e_config.auth_url}/api/auth/login"
    headers = {"X-Client-Id": e2e_config.client_id}
    body = {"email": e2e_config.e2e_email, "password": e2e_config.e2e_password}
    try:
        resp = httpx.post(url, json=body, headers=headers, timeout=LOGIN_TIMEOUT_S)
    except httpx.HTTPError as e:
        pytest.fail(f"auth-service login network error: {e}")
    if resp.status_code != 200:
        pytest.fail(
            f"auth-service login failed: {resp.status_code} {resp.text[:300]}"
        )
    payload = resp.json()
    token = payload.get("access_token")
    if not isinstance(token, str) or not token.strip():
        pytest.fail(f"auth-service login response missing access_token: {payload}")
    return token


@pytest.fixture(scope="session")
def e2e_user_id(e2e_token: str) -> str:
    return extract_sub(e2e_token)


@pytest.fixture(scope="session")
def prod_client(e2e_config: E2EConfig, e2e_token: str):
    with httpx.Client(
        base_url=e2e_config.prod_url,
        headers={"Authorization": f"Bearer {e2e_token}"},
        timeout=REQUEST_TIMEOUT_S,
    ) as client:
        yield client


@pytest.fixture(scope="session")
def prod_client_anon(e2e_config: E2EConfig):
    """Same base URL, no Authorization header. For 401-assertion tests."""
    with httpx.Client(base_url=e2e_config.prod_url, timeout=REQUEST_TIMEOUT_S) as client:
        yield client
```

- [ ] **Step 2: Verify conftest collects without import errors**

Run: `pytest tests/e2e/ --collect-only -m e2e -q`

Expected: 0 tests collected (no test files yet), no errors. (Without `-m e2e` the marker filter from `addopts` would also produce 0 collected — both are fine here; `-m e2e` mirrors what the smoke runner uses.)

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/conftest.py
git commit -m "test(e2e): conftest with session fixtures (config → login → token → client)"
```

---

## Task 5: Smoke cases 1 + 2 — liveness + unauthenticated 401

**Files:**
- Create: `tests/e2e/test_smoke.py`

**Context:** Cases 1 and 2 are deliberately first because they exercise the `prod_client_anon` fixture, not the auth-bearing one — so they can pass even when credentials are misconfigured. They isolate "auth wiring broken" from "everything broken."

- [ ] **Step 1: Write the file with the first two cases**

Write `tests/e2e/test_smoke.py`:

```python
"""Read-only prod smoke suite. Opt-in via `pytest -m e2e`."""
from __future__ import annotations

import pytest


@pytest.mark.e2e
def test_liveness(prod_client_anon) -> None:
    """Case 1: /api/health is unauthenticated and returns {"status": "ok"}."""
    resp = prod_client_anon.get("/api/health")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"status": "ok"}


@pytest.mark.e2e
def test_unauthenticated_is_401(prod_client_anon) -> None:
    """Case 2: a protected route returns 401 when called without a Bearer.

    Proves the auth middleware is wired — a deploy that accidentally
    disabled require_bearer (e.g. by losing the public key env var)
    would let this slip through with a 200.
    """
    resp = prod_client_anon.get("/api/users")
    assert resp.status_code == 401, f"expected 401, got {resp.status_code}: {resp.text[:200]}"
```

- [ ] **Step 2: Verify collection picks up both cases under the marker**

Run: `pytest tests/e2e/test_smoke.py --collect-only -m e2e -q`

Expected: collected 2 items: `test_liveness`, `test_unauthenticated_is_401`.

- [ ] **Step 3: Verify default `pytest` skips them**

Run: `pytest tests/e2e/test_smoke.py --collect-only -q`

Expected: collected 0 items / 2 deselected (the `addopts = "-m 'not e2e'"` filter hides them).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/test_smoke.py
git commit -m "test(e2e): cases 1-2 — liveness + protected-route 401"
```

---

## Task 6: Smoke case 3 — `/api/users` lists the test user

**Files:**
- Modify: `tests/e2e/test_smoke.py`

**Context:** `/api/users` returns `{"users": ["<uuid>", "<uuid>", ...]}` — UUIDs derived from `data/{user_id}/` directories on the mounted Azure Files share. The e2e user's UUID (from the JWT `sub`) must be in that list once the seed steps are done.

- [ ] **Step 1: Append case 3 to `test_smoke.py`**

Append to `tests/e2e/test_smoke.py`:

```python
@pytest.mark.e2e
def test_users_returns_current_user(prod_client, e2e_user_id) -> None:
    """Case 3: GET /api/users with a valid Bearer includes the e2e user UUID.

    Proves: auth verification succeeds end-to-end (public key env var set on
    prod), AND the Azure Files share is mounted with the e2e user's data dir
    present (the route lists subdirectories of /app/data).
    """
    resp = prod_client.get("/api/users")
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert "users" in payload, f"missing 'users' key: {payload}"
    assert isinstance(payload["users"], list), payload
    assert e2e_user_id in payload["users"], (
        f"e2e user {e2e_user_id} not present in /api/users response "
        f"(got {len(payload['users'])} users) — was the test user seeded?"
    )
```

- [ ] **Step 2: Verify collection grew to 3 cases**

Run: `pytest tests/e2e/test_smoke.py --collect-only -m e2e -q`

Expected: 3 items collected.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/test_smoke.py
git commit -m "test(e2e): case 3 — /api/users includes seeded e2e user"
```

---

## Task 7: Smoke case 4 — `/api/{user}/home` dashboard

**Files:**
- Modify: `tests/e2e/test_smoke.py`

**Context:** `HomeResponse` (defined in `src/stride_server/routes/home.py`) has exactly six top-level fields: `status_ring`, `recent_activities`, `weekly_stats`, `lifetime_stats`, `plan_state`, `watch`. Asserting all six keys exist is robust to value variation (which changes daily) while still catching a route-level schema regression.

- [ ] **Step 1: Append case 4 to `test_smoke.py`**

Append to `tests/e2e/test_smoke.py`:

```python
HOME_REQUIRED_KEYS = frozenset({
    "status_ring", "recent_activities", "weekly_stats",
    "lifetime_stats", "plan_state", "watch",
})


@pytest.mark.e2e
def test_home_dashboard(prod_client, e2e_user_id) -> None:
    """Case 4: /api/{user}/home returns all HomeResponse top-level keys.

    Asserts schema-shape, not values — daily content varies; missing keys
    indicate a real backend regression.
    """
    resp = prod_client.get(f"/api/{e2e_user_id}/home")
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert isinstance(payload, dict), f"expected object, got {type(payload).__name__}"
    missing = HOME_REQUIRED_KEYS - payload.keys()
    assert not missing, f"home response missing keys: {sorted(missing)} (got {sorted(payload.keys())})"
```

- [ ] **Step 2: Verify collection grew to 4 cases**

Run: `pytest tests/e2e/test_smoke.py --collect-only -m e2e -q`

Expected: 4 items collected.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/test_smoke.py
git commit -m "test(e2e): case 4 — /api/{user}/home returns full HomeResponse shape"
```

---

## Task 8: Smoke case 5 — `/api/{user}/weeks` non-empty

**Files:**
- Modify: `tests/e2e/test_smoke.py`

**Context:** `list_weeks` reads weekly folders from Azure Files (the markdown is synced there by `sync-data.yml`, NOT baked into the Docker image). A non-empty response proves the share is mounted AND the seed plan was synced. The response shape is `{"weeks": [{"folder": ..., "date_from": ..., "date_to": ..., "has_plan": ..., ...}, ...]}`.

- [ ] **Step 1: Append case 5 to `test_smoke.py`**

Append to `tests/e2e/test_smoke.py`:

```python
@pytest.mark.e2e
def test_weeks_list(prod_client, e2e_user_id) -> None:
    """Case 5: /api/{user}/weeks returns at least one folder.

    Proves Azure Files mount + week-folder discovery. The e2e user must
    have at least one `data/{uuid}/logs/<date-folder>/plan.md` synced.
    """
    resp = prod_client.get(f"/api/{e2e_user_id}/weeks")
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert "weeks" in payload and isinstance(payload["weeks"], list), payload
    assert len(payload["weeks"]) > 0, (
        "weeks list is empty — did sync-data.yml push the seed plan.md to Azure Files?"
    )
    first = payload["weeks"][0]
    assert "folder" in first and isinstance(first["folder"], str), first
```

- [ ] **Step 2: Verify collection grew to 5 cases**

Run: `pytest tests/e2e/test_smoke.py --collect-only -m e2e -q`

Expected: 5 items collected.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/test_smoke.py
git commit -m "test(e2e): case 5 — /api/{user}/weeks non-empty (Azure Files mount)"
```

---

## Task 9: Smoke case 6 — `/api/{user}/activities` + Shanghai `+08:00` offset

**Files:**
- Modify: `tests/e2e/test_smoke.py`

**Context:** This is the only case that catches the timezone-regression class. The route calls `utc_iso_to_shanghai_iso(d["date"])` before returning rows (see `routes/activities.py:115`). That helper produces ISO strings ending in `+08:00`. If a future refactor accidentally drops the conversion, the offset would be `+00:00` and this test would fail.

- [ ] **Step 1: Append case 6 to `test_smoke.py`**

Append to `tests/e2e/test_smoke.py`:

```python
from datetime import datetime, timedelta  # noqa: E402  (top of file already imports pytest)


SHANGHAI_UTCOFFSET = timedelta(hours=8)


@pytest.mark.e2e
def test_activities_list_and_timezone(prod_client, e2e_user_id) -> None:
    """Case 6: /api/{user}/activities returns rows with Shanghai-offset dates.

    Proves: SQLite read works, the route applied utc_iso_to_shanghai_iso
    (so every `date` ends in `+08:00`), and the seed activity was synced.
    """
    resp = prod_client.get(f"/api/{e2e_user_id}/activities", params={"limit": 5})
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert "activities" in payload and isinstance(payload["activities"], list), payload
    assert len(payload["activities"]) > 0, (
        "activities list is empty — did the e2e user sync at least one activity?"
    )
    for row in payload["activities"]:
        date_str = row.get("date")
        assert isinstance(date_str, str) and date_str, f"row missing `date`: {row}"
        try:
            dt = datetime.fromisoformat(date_str)
        except ValueError as e:
            pytest.fail(f"row `date` not ISO-parseable: {date_str!r} ({e})")
        assert dt.utcoffset() == SHANGHAI_UTCOFFSET, (
            f"row `date` offset is {dt.utcoffset()}, expected +08:00 — "
            f"the route may have dropped utc_iso_to_shanghai_iso. Row: {row}"
        )
```

Note: the `from datetime import ...` line is added at module top during this step, not inline. Move it to join the existing imports at the top of `test_smoke.py`.

- [ ] **Step 2: Reorder imports cleanly**

After Step 1, the import block at the top of `test_smoke.py` should look like:

```python
"""Read-only prod smoke suite. Opt-in via `pytest -m e2e`."""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest
```

(Remove the `# noqa` comment introduced in Step 1.)

- [ ] **Step 3: Verify collection grew to 6 cases**

Run: `pytest tests/e2e/test_smoke.py --collect-only -m e2e -q`

Expected: 6 items collected.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/test_smoke.py
git commit -m "test(e2e): case 6 — activities list + Shanghai +08:00 offset"
```

---

## Task 10: Smoke case 7 — SPA bundle served at `/`

**Files:**
- Modify: `tests/e2e/test_smoke.py`

**Context:** The Vite-built React SPA is baked into the Docker image (stage 1) and mounted as a `StaticFiles` catch-all in `src/stride_server/static.py`. A deploy where stage 1 silently failed would still pass `/api/health` (FastAPI boots fine) but `/` would 404. The smoke catches this by asserting the response is HTML containing `id="root"` (the standard Vite mount point).

- [ ] **Step 1: Append case 7 to `test_smoke.py`**

Append to `tests/e2e/test_smoke.py`:

```python
@pytest.mark.e2e
def test_spa_bundle_served(prod_client_anon) -> None:
    """Case 7: GET / returns the Vite-built SPA shell.

    Catches the deploy class of bug where Docker stage 1 (npm run build)
    failed silently and the image shipped without the frontend bundle.
    """
    resp = prod_client_anon.get("/")
    assert resp.status_code == 200, resp.text[:300]
    ctype = resp.headers.get("content-type", "")
    assert ctype.startswith("text/html"), f"expected text/html, got {ctype!r}"
    assert 'id="root"' in resp.text, (
        "SPA mount point `id=\"root\"` not in response — Vite bundle may not be in the image"
    )
```

- [ ] **Step 2: Verify collection is at 7 cases**

Run: `pytest tests/e2e/test_smoke.py --collect-only -m e2e -q`

Expected: 7 items collected — exactly matching the spec.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/test_smoke.py
git commit -m "test(e2e): case 7 — SPA bundle present at /"
```

---

## Task 11: Runner script, README, optional HTML report

**Files:**
- Create: `scripts/smoke-prod.sh`
- Create: `tests/e2e/README.md`
- Modify: `pyproject.toml` (add `pytest-html` to `dev` extras)

- [ ] **Step 1: Add `pytest-html` to dev extras**

In `pyproject.toml`, find the `dev` extras block:

```toml
dev = [
    "pytest>=8.0",
    "pytest-httpx>=0.30",
    "import-linter>=2.0",
]
```

Add `"pytest-html>=4.1",` at the end:

```toml
dev = [
    "pytest>=8.0",
    "pytest-httpx>=0.30",
    "import-linter>=2.0",
    "pytest-html>=4.1",
]
```

- [ ] **Step 2: Write the runner script**

Write `scripts/smoke-prod.sh`:

```bash
#!/usr/bin/env bash
# Prod smoke runner — read-only checks against the live stride-app deploy.
# Usage:
#   ./scripts/smoke-prod.sh                # run all 7 cases, terminal output
#   ./scripts/smoke-prod.sh -k weeks       # filter by name
#   ./scripts/smoke-prod.sh --e2e-config=tests/e2e/e2e.config.staging.json
set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR="out"
mkdir -p "$OUT_DIR"
HTML_REPORT="$OUT_DIR/e2e-report.html"

# pytest-html is optional. If installed we also emit an HTML report; if not
# we still run the suite and print to stdout only.
HTML_ARGS=()
if python -c "import pytest_html" 2>/dev/null; then
    HTML_ARGS=(--html="$HTML_REPORT" --self-contained-html)
else
    echo "(pytest-html not installed — terminal-only output. Install with: pip install pytest-html)"
fi

exec pytest tests/e2e -m e2e -v "${HTML_ARGS[@]}" "$@"
```

Make it executable:

```bash
chmod +x scripts/smoke-prod.sh
```

- [ ] **Step 3: Write the README**

Write `tests/e2e/README.md`:

````markdown
# E2E Prod Smoke Suite

Read-only smoke test against the live `stride-app` deploy. Manually triggered after a prod deploy to confirm auth, DB mount, Azure Files mount, and the SPA bundle are all healthy.

## One-time setup

### 1. Seed the e2e test user

The seven test cases assume a dedicated user exists in prod with at least one synced activity and one weekly plan folder. If you have not done this yet:

1. **Register `stride-e2e@<your-domain>` via the auth-service signup flow.** Keep the password handy.
2. **Note the resulting UUID** — visible in the JWT `sub` claim after first login, or via auth-service admin.
3. **Seed at least one activity:** either link a real COROS account to that user and run `coros-sync -P <uuid> sync`, or insert one synthetic row directly into `data/<uuid>/coros.db` via SQL. The real-data path also validates COROS sync, so prefer it.
4. **Seed at least one weekly plan folder:** create `data/<uuid>/logs/2026-05-22_05-22(e2e)/plan.md` plus a valid `plan.json` (per `docs/plan-json-schema.md`). Commit and push so `sync-data.yml` uploads them to Azure Files.

### 2. Fill in the local config

```bash
cp tests/e2e/e2e.config.example.json tests/e2e/e2e.config.local.json
# edit tests/e2e/e2e.config.local.json — fill in e2e_email + e2e_password
```

`tests/e2e/e2e.config.local.json` is git-ignored. Do not commit it.

## Running the smoke

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

## What each case proves

| # | Test | If it fails, suspect |
|---|------|----------------------|
| 1 | `test_liveness` | Container not running, or `/api/health` route removed |
| 2 | `test_unauthenticated_is_401` | `require_bearer` dependency dropped — public key env var missing or `allow_insecure_without_key=true` enabled in prod |
| 3 | `test_users_returns_current_user` | Auth verification failing OR Azure Files share not mounted (no `data/<uuid>/` dirs visible) |
| 4 | `test_home_dashboard` | `HomeResponse` schema regressed |
| 5 | `test_weeks_list` | `sync-data.yml` failed; seed plan.md never reached Azure Files |
| 6 | `test_activities_list_and_timezone` | SQLite mount broken OR a route forgot to call `utc_iso_to_shanghai_iso` |
| 7 | `test_spa_bundle_served` | Docker stage-1 (Vite build) silently failed; image shipped without `frontend/dist` |

## Why this suite is excluded from default `pytest`

Every case has `@pytest.mark.e2e`. `pyproject.toml` sets `addopts = "-m 'not e2e'"`, so the bare `pytest` invocation used by `ci.yml` skips them automatically. `scripts/smoke-prod.sh` adds `-m e2e` to flip the filter on.

## Manual validation checklist for first merge

After merging this suite, before declaring v1 done:

- [ ] Run `./scripts/smoke-prod.sh` → all 7 cases pass.
- [ ] Edit `e2e.config.local.json` to flip one byte of `e2e_password` → run; expect cases 3-6 to fail with a clear auth error, cases 1, 2, 7 still pass.
- [ ] Edit `e2e.config.local.json` to set `prod_url` to a bogus host → run; expect a clean connection-error failure mode, not a misleading assertion.
- [ ] Run plain `pytest` (no args) → confirm e2e cases are skipped and the existing unit suite passes unchanged.
````

- [ ] **Step 4: Verify the runner script's pytest-html branch detects correctly**

Run: `python -c "import pytest_html; print('present')" 2>&1 || echo "absent"`

Expected output: either `present` (if dev extras installed) or `absent`. Either way, the runner will behave correctly — this just confirms which branch will execute.

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-prod.sh tests/e2e/README.md pyproject.toml
git commit -m "test(e2e): runner script + README + optional pytest-html report"
```

---

## Task 12: Final validation pass

**Files:** none (verification only)

**Context:** No code changes here. This task confirms the suite works end-to-end against prod, which requires the human-only test-user seed from `tests/e2e/README.md` to be complete. If the seed is incomplete, document that and stop — do not retrofit synthetic data into the plan.

- [ ] **Step 1: Confirm default `pytest` is unaffected**

Run: `pytest -q 2>&1 | tail -3`

Expected: existing unit suite runs as before. No collection errors. The new `tests/unit_e2e_helpers/` cases (10 total: 6 config + 4 jwt) are included in the pass count; the `tests/e2e/test_smoke.py` cases are deselected by the marker filter.

- [ ] **Step 2: Confirm `lint-imports` still passes**

Run: `PYTHONPATH=src lint-imports`

Expected: PASS. The new files do not touch `src/` so no import-linter contracts should fire, but verify to be safe.

- [ ] **Step 3: Confirm the test user is seeded**

Manual: ask the human operator whether they have completed all four steps in the "Seed the e2e test user" section of `tests/e2e/README.md`. If NO → stop here and surface the blocker; do not attempt to bypass.

- [ ] **Step 4: Run the smoke against prod**

Run: `./scripts/smoke-prod.sh`

Expected: 7 passed in under ~30s. If anything fails, the README's "What each case proves" table maps the failure to the likely cause.

- [ ] **Step 5: Run the deliberate-failure sanity checks listed in the README**

Follow the three-item "Manual validation checklist" in `tests/e2e/README.md`. Confirm each behaves as documented.

- [ ] **Step 6: Final commit (if anything was tweaked during validation)**

Only if Steps 1-5 surfaced a real bug requiring a fix:

```bash
git add <touched files>
git commit -m "fix(e2e): <one-line description>"
```

Otherwise no commit. The suite is done.

---

## Self-Review

**Spec coverage** — every section of the spec maps to a task:

| Spec section | Implementing task(s) |
|---|---|
| Goal / Non-Goals | All tasks; explicit failure semantics in Task 4 (login → `pytest.fail`) and Task 11 (no rollback automation) |
| Directory layout | Task 1 |
| Pytest marker / discovery | Task 1 (Steps 3, 5), Task 5 (Steps 2-3 verify default-skip behavior) |
| Configuration file | Tasks 1 (example), 2 (loader + tests), 4 (fixtures consume it) |
| Auth bootstrap | Tasks 3 (JWT decode + tests), 4 (login fixture) |
| Test cases 1-7 | Tasks 5-10, one per case-group |
| Test user seed | Task 11 (README), Task 12 (Step 3 verification gate) |
| Runner script | Task 11 |
| Reporting | Task 11 (`pytest-html` optional path) |
| Failure semantics | Task 4 (Steps using `pytest.fail` vs `pytest.skip`) |
| Files Added / Modified | File Map at top of this plan, cross-referenced in each task |

**Placeholder scan** — searched for "TBD", "TODO", "implement later", "appropriate ... handling": none in this plan. The only string `<fill in real password here, then rename file to e2e.config.local.json>` is the intended placeholder inside the committed example config — not a plan placeholder.

**Type consistency** — `E2EConfig` (Task 2) field names match keys used in Task 4 (`prod_url`, `auth_url`, `client_id`, `e2e_email`, `e2e_password`). `extract_sub` (Task 3) signature matches usage in Task 4. `prod_client` / `prod_client_anon` fixture names match usage in Tasks 5-10. `HOME_REQUIRED_KEYS` constant in Task 7 lists exactly the six fields from `HomeResponse` (verified by reading `src/stride_server/routes/home.py:369-376`). `SHANGHAI_UTCOFFSET = timedelta(hours=8)` in Task 9 matches the offset produced by `utc_iso_to_shanghai_iso` (verified via `src/stride_core/timefmt.py:25`).
