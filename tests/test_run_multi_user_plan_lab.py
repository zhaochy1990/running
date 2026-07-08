from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest


SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import run_multi_user_plan_lab as lab  # noqa: E402


def test_resolve_users_uses_slug_aliases(tmp_path: Path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (data_dir / ".slug_aliases.json").write_text(
        json.dumps({"zhaochaoyi": "f10bc353-01ab-4db1-af9f-d9305ea9a532"}),
        encoding="utf-8",
    )

    users = lab.resolve_users(["zhaochaoyi"], data_dir=data_dir)

    assert users == [
        lab.LabUser(slug="zhaochaoyi", user_id="f10bc353-01ab-4db1-af9f-d9305ea9a532")
    ]


def test_build_goal_freezes_may_replay_dates():
    goal = lab.build_goal("zhaochaoyi", season_start="2026-05-04")

    assert goal["season_start"] == "2026-05-04"
    assert goal["as_of_date"] == "2026-05-04"
    assert goal["race_date"] == "2026-10-18"
    assert goal["race_distance"] == "FM"
    assert goal["target_finish_time"] == "2:50:00"


def test_build_rule_filter_kwargs_includes_season_window():
    goal = lab.build_goal("lvge", season_start="2026-05-04")

    kwargs = lab.build_rule_filter_kwargs(goal)

    assert kwargs["season_window"] == {
        "start_date": "2026-05-04",
        "end_date": "2026-10-18",
    }
    assert kwargs["target_race"]["distance"] == "fm"
    assert kwargs["target_race"]["race_date"] == "2026-10-18"
    assert kwargs["weekly_run_days_max"] == 5


def test_write_user_artifacts_saves_expected_files(tmp_path: Path):
    user = lab.LabUser(slug="zhaochaoyi", user_id="u1")
    result = lab.UserLabResult(
        slug="zhaochaoyi",
        user_id="u1",
        ok=True,
        master_plan={"plan_id": "mp1"},
        master_weekly_quality={"ok": True, "issues": []},
        season_bundle={"master_plan_id": "mp1", "phases": []},
        weekly_quality={"ok": True, "issues": []},
        metadata={"elapsed_s": 1.2},
        error=None,
    )

    lab.write_user_artifacts(tmp_path, user, result)

    user_dir = tmp_path / "zhaochaoyi"
    assert json.loads((user_dir / "master_plan.json").read_text(encoding="utf-8")) == {"plan_id": "mp1"}
    assert json.loads((user_dir / "master_weekly_quality.json").read_text(encoding="utf-8"))["ok"] is True
    assert json.loads((user_dir / "season_bundle.json").read_text(encoding="utf-8"))["master_plan_id"] == "mp1"
    assert json.loads((user_dir / "weekly_quality.json").read_text(encoding="utf-8"))["ok"] is True
    assert json.loads((user_dir / "summary.json").read_text(encoding="utf-8"))["ok"] is True


def test_blocked_master_verdict_is_not_usable_for_weekly_generation():
    assert lab.should_generate_weekly({"final_verdict": "block", "final_artifact": {}}) is False
    assert lab.should_generate_weekly({"final_verdict": "pass", "final_artifact": {}}) is True


def test_load_existing_result_reads_summary_and_artifacts(tmp_path: Path):
    user_dir = tmp_path / "zhaochaoyi"
    user_dir.mkdir()
    (user_dir / "summary.json").write_text(
        json.dumps({"slug": "zhaochaoyi", "user_id": "u1", "ok": True, "metadata": {"elapsed_s": 3.0}}),
        encoding="utf-8",
    )
    (user_dir / "master_plan.json").write_text(json.dumps({"plan_id": "mp1"}), encoding="utf-8")
    (user_dir / "master_weekly_quality.json").write_text(json.dumps({"ok": True, "issues": []}), encoding="utf-8")
    (user_dir / "season_bundle.json").write_text(json.dumps({"master_plan_id": "mp1"}), encoding="utf-8")
    (user_dir / "weekly_quality.json").write_text(json.dumps({"ok": True, "issues": []}), encoding="utf-8")

    result = lab.load_existing_result(tmp_path, lab.LabUser(slug="zhaochaoyi", user_id="u1"))

    assert result is not None
    assert result.ok is True
    assert result.master_plan == {"plan_id": "mp1"}
    assert result.weekly_quality == {"ok": True, "issues": []}


def test_unknown_slug_requires_explicit_goal():
    with pytest.raises(KeyError):
        lab.build_goal("unknown", season_start="2026-05-04")
