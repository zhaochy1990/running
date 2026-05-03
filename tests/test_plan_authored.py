"""Phase 1 plan.json-priority reparse path tests.

Covers ``_try_authored_reparse`` short-circuit in ``stride_server.routes.plan``:
- valid plan.json → bypass LLM, stamp ``structured_source='authored'``
- missing plan.json → fall through to LLM
- corrupt plan.json → fall through to LLM
- plan.md missing entirely → 404 (existing strict behavior preserved)
- ``STRIDE_PLAN_JSON_PRIORITY=false`` → force LLM path even when plan.json valid
- schema_version > SUPPORTED → fall through to LLM
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

# Re-use fixtures + helpers from the existing plan-routes test file. ``app_client``
# and ``rsa_keypair`` are pytest fixtures that work via re-export under pytest's
# fixture lookup (importing the function does NOT import the fixture; we need to
# re-declare them as local fixtures or use ``pytest_plugins``). Simpler path:
# import the fixtures directly and re-export as module-level fixtures.
from tests.test_plan_routes import (
    INTERNAL_TOKEN,
    USER_UUID,
    _auth,
    _db,
    app_client,  # noqa: F401 — re-export pytest fixture
    rsa_keypair,  # noqa: F401 — re-export pytest fixture
)


# Fixtures use a different week folder than test_plan_routes.WEEK; pin to the
# real fixture week so plan.json's ``week_folder`` field matches.
FIXTURE_WEEK = "2026-05-04_05-10(W2基础重建)"


def _copy_fixture(src_name: str, dst_dir: Path) -> None:
    """Copy all files from tests/fixtures/plan_json/<src_name>/ → dst_dir/."""
    src = Path(__file__).parent / "fixtures" / "plan_json" / src_name
    dst_dir.mkdir(parents=True, exist_ok=True)
    for f in src.iterdir():
        if f.is_file():
            shutil.copy(f, dst_dir / f.name)


def _week_dir(tmp_path: Path, week: str = FIXTURE_WEEK) -> Path:
    return tmp_path / USER_UUID / "logs" / week


def _mock_run_agent(monkeypatch, *, structured: bool = True):
    """Install a fake run_agent on plan_mod that bumps a sentinel counter.

    Returns the sentinel dict so tests can assert call counts.
    """
    import stride_server.routes.plan as plan_mod
    from stride_core.plan_spec import PlannedSession, SessionKind, WeeklyPlan
    from stride_server.coach_agent.agent import AgentResult

    wp = (
        WeeklyPlan(
            week_folder=FIXTURE_WEEK,
            sessions=(
                PlannedSession(
                    date="2026-05-05", session_index=0,
                    kind=SessionKind.REST, summary="mock fallthrough",
                ),
            ),
            nutrition=(),
        )
        if structured else None
    )
    sentinel = {"called": 0}

    def _fake(*a, **kw):
        sentinel["called"] += 1
        return AgentResult(
            content="mocked", model="mock", context_summary={}, sync={},
            structured=wp, parse_error=None if structured else "fail",
        )

    monkeypatch.setattr(plan_mod, "run_agent", _fake)
    return sentinel


def _boom_run_agent(monkeypatch):
    """Install a run_agent that fails loudly if invoked. Returns sentinel."""
    import stride_server.routes.plan as plan_mod
    sentinel = {"called": 0}

    def _boom(*a, **kw):
        sentinel["called"] += 1
        raise AssertionError("run_agent should NOT be called")

    monkeypatch.setattr(plan_mod, "run_agent", _boom)
    return sentinel


def _seed_db_md(tmp_path: Path, *, week: str = FIXTURE_WEEK,
                content: str = "# md placeholder") -> None:
    """Insert a weekly_plan row so the reparse precondition is met."""
    db = _db(tmp_path)
    try:
        db.upsert_weekly_plan(week, content, generated_by="test-author")
    finally:
        db.close()


# ─────────────────────────────────────────────────────────────────────────────
# Tests
# ─────────────────────────────────────────────────────────────────────────────


class TestAuthoredReparse:
    def test_reparse_with_authored_plan_json_skips_llm(self, app_client, monkeypatch):
        """Valid plan.json + plan.md → authored short-circuit (no LLM call)."""
        client, _, tmp_path, _, _ = app_client
        _copy_fixture("w2_authored", _week_dir(tmp_path))
        _seed_db_md(tmp_path, content="old md content")
        sentinel = _boom_run_agent(monkeypatch)

        resp = client.post(
            f"/internal/plan/reparse?user={USER_UUID}&folder={FIXTURE_WEEK}",
            headers={"X-Internal-Token": INTERNAL_TOKEN},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["source"] == "authored"
        assert body["llm_calls"] == 0
        assert body["schema_version"] == 1
        assert body["structured_status"] == "authored"
        assert sentinel["called"] == 0

        # Validate that the structured layer landed: w2_authored has 7 sessions.
        db = _db(tmp_path)
        try:
            sessions = db.get_planned_sessions(
                date_from="2026-05-04", date_to="2026-05-10",
            )
        finally:
            db.close()
        assert len(sessions) == 7

    def test_reparse_without_plan_json_falls_through_to_llm(
        self, app_client, monkeypatch,
    ):
        """plan.md only → no authored path → LLM runs."""
        client, _, tmp_path, _, _ = app_client
        _copy_fixture("w1_no_json", _week_dir(tmp_path))
        _seed_db_md(tmp_path)
        sentinel = _mock_run_agent(monkeypatch, structured=True)

        resp = client.post(
            f"/internal/plan/reparse?user={USER_UUID}&folder={FIXTURE_WEEK}",
            headers={"X-Internal-Token": INTERNAL_TOKEN},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["source"] == "fresh"
        assert body["llm_calls"] == 1
        assert body["schema_version"] is None
        assert body["structured_status"] == "fresh"
        assert sentinel["called"] == 1

    def test_reparse_with_corrupt_plan_json_falls_through(
        self, app_client, monkeypatch,
    ):
        """plan.json with schema-invalid content → fall through, LLM runs."""
        client, _, tmp_path, _, _ = app_client
        _copy_fixture("w_corrupt_json", _week_dir(tmp_path))
        _seed_db_md(tmp_path)
        sentinel = _mock_run_agent(monkeypatch, structured=True)

        resp = client.post(
            f"/internal/plan/reparse?user={USER_UUID}&folder={FIXTURE_WEEK}",
            headers={"X-Internal-Token": INTERNAL_TOKEN},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["source"] == "fresh"
        assert body["llm_calls"] == 1
        assert sentinel["called"] == 1

    def test_reparse_with_missing_plan_md_returns_404(
        self, app_client, monkeypatch,
    ):
        """plan.json present but plan.md + DB row both missing → 404.

        Mirrors existing strict behavior in ``test_reparse_404_when_no_plan``:
        the authored path never short-circuits when there's no markdown row at
        all, since the read-md-or-fall-back-to-disk precondition runs first.
        """
        client, _, tmp_path, _, _ = app_client
        # Only plan.json — no plan.md, no DB row.
        _week_dir(tmp_path).mkdir(parents=True, exist_ok=True)
        src = Path(__file__).parent / "fixtures" / "plan_json" / "w_md_missing" / "plan.json"
        shutil.copy(src, _week_dir(tmp_path) / "plan.json")

        sentinel = _boom_run_agent(monkeypatch)

        resp = client.post(
            f"/internal/plan/reparse?user={USER_UUID}&folder={FIXTURE_WEEK}",
            headers={"X-Internal-Token": INTERNAL_TOKEN},
        )
        assert resp.status_code == 404
        assert sentinel["called"] == 0

    def test_reparse_with_feature_flag_off_skips_plan_json(
        self, app_client, monkeypatch,
    ):
        """STRIDE_PLAN_JSON_PRIORITY=false → bypass authored path entirely."""
        client, _, tmp_path, _, _ = app_client
        _copy_fixture("w2_authored", _week_dir(tmp_path))
        _seed_db_md(tmp_path)
        monkeypatch.setenv("STRIDE_PLAN_JSON_PRIORITY", "false")
        sentinel = _mock_run_agent(monkeypatch, structured=True)

        resp = client.post(
            f"/internal/plan/reparse?user={USER_UUID}&folder={FIXTURE_WEEK}",
            headers={"X-Internal-Token": INTERNAL_TOKEN},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["source"] == "fresh"
        assert body["llm_calls"] == 1
        assert sentinel["called"] == 1

    def test_reparse_disk_fallback_when_db_row_missing(
        self, app_client, monkeypatch,
    ):
        """plan.md on disk, no DB row → disk-fallback path must hand a *string*
        (not a ContentItem) to downstream code. Regression for prod 500 caught
        when the public reparse route was first hit on a disk-only week.

        Uses ``raise_server_exceptions=True`` so any AttributeError propagates
        to the test instead of being swallowed as a generic 500.
        """
        from fastapi.testclient import TestClient
        client_default, _, tmp_path, _, _ = app_client
        # Re-wrap the app to surface server exceptions.
        client = TestClient(client_default.app, raise_server_exceptions=True)

        _copy_fixture("w1_no_json", _week_dir(tmp_path))
        # NOTE: deliberately NOT calling _seed_db_md — DB row absent forces
        # the ``content_md = disk_md.content`` fallback to run.
        sentinel = _mock_run_agent(monkeypatch, structured=True)
        # Stub get_generated_by because no DB row → no existing_generated_by →
        # apply_weekly_plan falls through to live AOAI lookup which is unset
        # in the test env. Unrelated to the bug under test.
        import stride_server.coach_agent.agent as agent_mod
        monkeypatch.setattr(agent_mod, "get_generated_by", lambda: "test-author")

        resp = client.post(
            f"/internal/plan/reparse?user={USER_UUID}&folder={FIXTURE_WEEK}",
            headers={"X-Internal-Token": INTERNAL_TOKEN},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["source"] == "fresh"
        assert body["llm_calls"] == 1
        assert sentinel["called"] == 1

    def test_reparse_with_schema_v2_skew_falls_through(
        self, app_client, monkeypatch,
    ):
        """plan.json with schema_version > SUPPORTED → fall through to LLM."""
        client, _, tmp_path, _, _ = app_client
        # Copy the markdown from w2_authored, then write a v2-stamped plan.json.
        wd = _week_dir(tmp_path)
        wd.mkdir(parents=True, exist_ok=True)
        md_src = (
            Path(__file__).parent / "fixtures" / "plan_json"
            / "w2_authored" / "plan.md"
        )
        shutil.copy(md_src, wd / "plan.md")
        v2_payload = {
            "schema": "weekly-plan/v2",
            "week_folder": FIXTURE_WEEK,
            "sessions": [],
            "nutrition": [],
        }
        (wd / "plan.json").write_text(
            json.dumps(v2_payload), encoding="utf-8",
        )

        _seed_db_md(tmp_path)
        sentinel = _mock_run_agent(monkeypatch, structured=True)

        resp = client.post(
            f"/internal/plan/reparse?user={USER_UUID}&folder={FIXTURE_WEEK}",
            headers={"X-Internal-Token": INTERNAL_TOKEN},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["source"] == "fresh"
        assert body["llm_calls"] == 1
        assert sentinel["called"] == 1
