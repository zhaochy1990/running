"""Regression: _relogin reuses the stored region instead of re-detecting it.

Region is a stable property of the account. Detecting it on every token
refresh fired an extra /account/query probe against each base per re-login,
which under concurrent sync produced a WRONG_REGION churn (global<->cn flapping)
that stalled onboarding full_sync.
"""

from __future__ import annotations

from coros_sync.client import CorosClient, RESULT_SUCCESS
from coros_sync.auth import Credentials


def _client_with_region(region: str | None) -> tuple[CorosClient, dict]:
    c = CorosClient.__new__(CorosClient)  # bypass __init__ (no httpx client needed)
    c._creds = Credentials(
        email="r@e.com", pwd_hash="hash", access_token="old", region=region, user_id="u1"
    )
    c._user = "u1"

    calls = {"detect": 0, "saved": 0}

    def fake_post_raw(url, **kwargs):
        return {"result": RESULT_SUCCESS, "data": {"accessToken": "new-token"}}

    def fake_detect(token):
        calls["detect"] += 1
        return "cn"

    def fake_save(user=None):
        calls["saved"] += 1

    c._post_raw = fake_post_raw  # type: ignore[method-assign]
    c._detect_region = fake_detect  # type: ignore[method-assign]
    c._creds.save = fake_save  # type: ignore[method-assign]
    return c, calls


def test_relogin_reuses_stored_region_without_detecting():
    c, calls = _client_with_region("cn")
    token = c._relogin()
    assert token == "new-token"
    assert c._creds.access_token == "new-token"
    assert c._creds.region == "cn"
    assert calls["detect"] == 0  # region reused, NOT re-detected
    assert calls["saved"] == 1


def test_relogin_detects_region_only_when_missing():
    c, calls = _client_with_region(None)
    c._relogin()
    assert calls["detect"] == 1  # no stored region → detect once
    assert c._creds.region == "cn"
