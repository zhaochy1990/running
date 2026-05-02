"""Tests for `coros-sync plan reparse` backfill CLI."""

from __future__ import annotations

from click.testing import CliRunner

from coros_sync.cli import cli
from stride_core.db import Database
from stride_core.plan_spec import PlannedSession, SessionKind, WeeklyPlan
from stride_server.coach_agent.agent import AgentResult


USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"


def _patch_data_dirs(tmp_path, monkeypatch):
    """Point both the CLI USER_DATA_DIR and Database USER_DATA_DIR at tmp."""
    import coros_sync.auth as auth_mod
    import coros_sync.cli as cli_mod
    import stride_core.db as core_db
    monkeypatch.setattr(auth_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(cli_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)


def _seed_plan_md(tmp_path, folder: str, body: str = "# Plan body") -> None:
    week_dir = tmp_path / USER_UUID / "logs" / folder
    week_dir.mkdir(parents=True, exist_ok=True)
    (week_dir / "plan.md").write_text(body, encoding="utf-8")


def _stub_run_agent(monkeypatch, *, structured: bool, parse_error: str | None = None,
                    folder: str = "2026-04-20_04-26(W0)") -> None:
    import coros_sync.cli as cli_mod
    wp = None
    if structured:
        wp = WeeklyPlan(
            week_folder=folder,
            sessions=(
                PlannedSession(date="2026-04-22", session_index=0,
                               kind=SessionKind.REST, summary="rest"),
            ),
            nutrition=(),
        )

    # The CLI imports run_agent and apply_weekly_plan inside the function body,
    # so patch them at the source module so the local import picks the stub up.
    import stride_server.coach_agent.agent as agent_mod
    monkeypatch.setattr(
        agent_mod, "run_agent",
        lambda *a, **kw: AgentResult(
            content="", model="stub", context_summary={}, sync={},
            structured=wp, parse_error=parse_error,
        ),
    )


def test_plan_reparse_dry_run_lists_candidates(tmp_path, monkeypatch):
    _patch_data_dirs(tmp_path, monkeypatch)
    _seed_plan_md(tmp_path, "2026-04-20_04-26(W0)")
    _seed_plan_md(tmp_path, "2026-04-27_05-03(W1)")

    runner = CliRunner()
    res = runner.invoke(
        cli, ["-P", USER_UUID, "plan", "reparse", "--all", "--dry-run"],
    )
    assert res.exit_code == 0, res.output
    assert "2026-04-20_04-26(W0)" in res.output
    assert "2026-04-27_05-03(W1)" in res.output
    assert "Dry-run: 2 candidates" in res.output


def test_plan_reparse_single_folder_writes_backfilled(tmp_path, monkeypatch):
    _patch_data_dirs(tmp_path, monkeypatch)
    _seed_plan_md(tmp_path, "2026-04-20_04-26(W0)")
    _stub_run_agent(monkeypatch, structured=True)

    runner = CliRunner()
    res = runner.invoke(
        cli, ["-P", USER_UUID, "plan", "reparse",
              "--folder", "2026-04-20_04-26(W0)"],
    )
    assert res.exit_code == 0, res.output
    assert "backfilled" in res.output

    # DB row should carry status='backfilled' (NOT 'fresh').
    db = Database(tmp_path / USER_UUID / "coros.db")
    try:
        row = dict(db._conn.execute(
            "SELECT structured_status FROM weekly_plan WHERE week=?",
            ("2026-04-20_04-26(W0)",),
        ).fetchone())
        assert row["structured_status"] == "backfilled"
        sessions = db.get_planned_sessions(week_folder="2026-04-20_04-26(W0)")
        assert len(sessions) == 1
        assert sessions[0]["kind"] == "rest"
    finally:
        db.close()


def test_plan_reparse_parse_failure_marks_failed(tmp_path, monkeypatch):
    _patch_data_dirs(tmp_path, monkeypatch)
    _seed_plan_md(tmp_path, "2026-04-20_04-26(W0)")
    _stub_run_agent(monkeypatch, structured=False, parse_error="malformed")

    runner = CliRunner()
    res = runner.invoke(
        cli, ["-P", USER_UUID, "plan", "reparse",
              "--folder", "2026-04-20_04-26(W0)"],
    )
    assert res.exit_code == 0, res.output
    assert "parse_failed" in res.output
    assert "0/1 weeks backfilled" in res.output

    db = Database(tmp_path / USER_UUID / "coros.db")
    try:
        row = dict(db._conn.execute(
            "SELECT structured_status FROM weekly_plan WHERE week=?",
            ("2026-04-20_04-26(W0)",),
        ).fetchone())
        # apply_weekly_plan(structured=None) marks parse_failed regardless of source
        assert row["structured_status"] == "parse_failed"
    finally:
        db.close()


def test_plan_reparse_requires_all_or_folder(tmp_path, monkeypatch):
    _patch_data_dirs(tmp_path, monkeypatch)
    runner = CliRunner()
    res = runner.invoke(cli, ["-P", USER_UUID, "plan", "reparse"])
    assert res.exit_code != 0
    assert "exactly one of --all or --folder" in res.output


def test_plan_reparse_skips_missing_plan_md(tmp_path, monkeypatch):
    """A folder that exists but has no plan.md is logged as a skip and
    contributes 0 to the row count."""
    _patch_data_dirs(tmp_path, monkeypatch)
    # Create a folder without plan.md
    (tmp_path / USER_UUID / "logs" / "2026-04-20_04-26(W0)").mkdir(parents=True)
    _stub_run_agent(monkeypatch, structured=True)

    runner = CliRunner()
    res = runner.invoke(
        cli, ["-P", USER_UUID, "plan", "reparse", "--all"],
    )
    assert res.exit_code == 0, res.output
    assert "no plan.md" in res.output
    assert "0/0 weeks backfilled" in res.output


def test_plan_reparse_all_processes_multiple_weeks(tmp_path, monkeypatch):
    _patch_data_dirs(tmp_path, monkeypatch)
    _seed_plan_md(tmp_path, "2026-04-20_04-26(W0)")
    _seed_plan_md(tmp_path, "2026-04-27_05-03(W1)")

    # Make the stub return a distinct date per week_folder so we don't trip
    # the planned_session.UNIQUE(date, session_index) constraint with shared
    # dates across folders. (The real LLM produces dates that fall inside
    # each week's range; only the test stub needed to be fixed.)
    _date_by_folder = {
        "2026-04-20_04-26(W0)": "2026-04-22",
        "2026-04-27_05-03(W1)": "2026-04-29",
    }

    def _make_result(*args, **kwargs):
        folder = kwargs.get("folder")
        date = _date_by_folder[folder]
        wp = WeeklyPlan(
            week_folder=folder,
            sessions=(PlannedSession(
                date=date, session_index=0,
                kind=SessionKind.REST, summary="rest",
            ),),
            nutrition=(),
        )
        return AgentResult(
            content="", model="stub", context_summary={}, sync={},
            structured=wp, parse_error=None,
        )

    import stride_server.coach_agent.agent as agent_mod
    monkeypatch.setattr(agent_mod, "run_agent", _make_result)

    runner = CliRunner()
    res = runner.invoke(
        cli, ["-P", USER_UUID, "plan", "reparse", "--all"],
    )
    assert res.exit_code == 0, res.output
    assert "2/2 weeks backfilled" in res.output

    db = Database(tmp_path / USER_UUID / "coros.db")
    try:
        for wf in ("2026-04-20_04-26(W0)", "2026-04-27_05-03(W1)"):
            row = dict(db._conn.execute(
                "SELECT structured_status FROM weekly_plan WHERE week=?",
                (wf,),
            ).fetchone())
            assert row["structured_status"] == "backfilled"
    finally:
        db.close()
