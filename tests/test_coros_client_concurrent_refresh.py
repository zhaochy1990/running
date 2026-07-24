"""Concurrency: expired-token refresh is single-flighted across worker threads.

COROS issues one valid access token per account. When many detail-fetch threads
(jobs>1) hit an expired token at once, exactly ONE must re-login while the rest
wait on the `_token_ready` barrier and reuse the fresh token — otherwise each
thread re-logs in and overwrites the others' token, a re-login storm that wedges
onboarding full_sync. This locks in that invariant so the API-side onboarding
sync can run with parallel fetches instead of jobs=1.
"""

from __future__ import annotations

import threading
import time

from coros_sync.client import (
    CorosClient,
    RESULT_SUCCESS,
    RESULT_TOKEN_EXPIRED,
)
from coros_sync.auth import Credentials


class _FakeResp:
    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:  # pragma: no cover - trivial
        pass

    def json(self) -> dict:
        return self._payload


def _make_client() -> CorosClient:
    # Bypass __init__ (no real httpx client), but wire the coordination
    # primitives __init__ would normally set up.
    c = CorosClient.__new__(CorosClient)
    c._creds = Credentials(
        email="r@e.com", pwd_hash="hash", access_token="old", region="cn", user_id="u1"
    )
    c._user = "u1"
    c._delay = 0.0
    c._relogin_lock = threading.Lock()
    c._token_ready = threading.Event()
    c._token_ready.set()
    return c


class _ExpireOnceHttpx:
    """Return TOKEN_EXPIRED for the stale token, SUCCESS for the refreshed one."""

    def request(self, method, url, params=None, headers=None):
        token = (headers or {}).get("accesstoken")
        if token == "old":
            return _FakeResp({"result": RESULT_TOKEN_EXPIRED})
        return _FakeResp({"result": RESULT_SUCCESS, "data": {"ok": True}})

    def post(self, url, json=None, headers=None):
        token = (headers or {}).get("accesstoken")
        if token == "old":
            return _FakeResp({"result": RESULT_TOKEN_EXPIRED})
        return _FakeResp({"result": RESULT_SUCCESS, "data": {"ok": True}})


def _wire_single_relogin(c: CorosClient, calls: dict) -> None:
    def fake_relogin() -> str:
        calls["n"] += 1
        # Widen the window so all peers pile onto _relogin_lock before the
        # token flips — proves the double-check + barrier truly single-flights.
        time.sleep(0.05)
        c._creds.access_token = "new-token"
        return "new-token"

    c._relogin = fake_relogin  # type: ignore[method-assign]


def _run_concurrently(fn, n: int = 8) -> list:
    barrier = threading.Barrier(n)
    results: list = []
    lock = threading.Lock()

    def worker() -> None:
        barrier.wait()  # release all threads at once
        out = fn()
        with lock:
            results.append(out)

    threads = [threading.Thread(target=worker) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)
    assert all(not t.is_alive() for t in threads), "a worker deadlocked on the barrier"
    return results


def test_request_expiry_single_relogin_across_threads():
    c = _make_client()
    c._client = _ExpireOnceHttpx()
    calls = {"n": 0}
    _wire_single_relogin(c, calls)

    results = _run_concurrently(lambda: c._request("GET", "/activity/query"), n=8)

    assert calls["n"] == 1, "exactly one thread must re-login"
    assert len(results) == 8
    assert all(r.get("result") == RESULT_SUCCESS for r in results)
    assert c._creds.access_token == "new-token"


def test_request_json_expiry_single_relogin_across_threads():
    c = _make_client()
    c._client = _ExpireOnceHttpx()
    calls = {"n": 0}
    _wire_single_relogin(c, calls)

    results = _run_concurrently(
        lambda: c._request_json("/training/exercise/add", {"x": 1}), n=8
    )

    assert calls["n"] == 1
    assert len(results) == 8
    assert all(r.get("result") == RESULT_SUCCESS for r in results)
    assert c._creds.access_token == "new-token"
