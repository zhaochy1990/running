from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

from coach.graphs.generation.rule_filter import RuleFilterReport, RuleViolation
from coach_eval.judge_s1 import (
    _build_user_message,
    _compact_generated_plan,
    build_s1_judge_prompt_metadata,
)
from coach_eval.runner import (
    RunMode,
    run_s1_judge_artifact_evaluation,
    run_s2_judge_artifact_evaluation,
)
from coach_eval.schemas import EvalReport, FixtureRunOutcome, JudgeScore


def _fixture() -> dict:
    return {
        "fixture_id": "s1-artifact-fixture",
        "scope": "s1",
        "input": {
            "user_profile": {
                "target_race": {
                    "distance": "fm",
                    "goal_time_s": 10800,
                    "race_date": "2026-10-18",
                },
                "prs": {"fm_s": 11400},
                "weekly_run_days_max": 5,
            },
            "season_window": {"start_date": "2026-05-25", "end_date": "2026-10-18"},
        },
        "expected": {"soft_rubric": {"schema_validity": {"min_score": 5}}},
    }


def _s2_fixture() -> dict:
    return {
        "fixture_id": "s2-artifact-fixture",
        "scope": "s2",
        "description": "bad recovery signals with user pushback",
        "input": {
            "user_profile": {
                "phase": "build",
                "threshold_pace_s_km": 240,
                "injuries": [],
            },
            "target_week_start": "2026-05-18",
            "week_folder": "2026-05-18_05-24(S2)",
            "target_weekly_km": 50,
            "recent_signals": {
                "hrv_7d": [62, 60, 58, 56, 55, 54, 53],
                "rhr_7d": [48, 50, 51, 52, 53, 54, 54],
                "sleep_score_7d": [78, 73, 70, 66, 62, 60, 58],
                "ctl": 50,
                "atl": 64,
                "prev_week_km": 52,
            },
            "user_request_md": "keep quality",
        },
        "expected": {
            "hard_constraints": {
                "target_week_start": "2026-05-18",
                "week_folder": "2026-05-18_05-24(S2)",
                "target_weekly_km": 50,
                "weekly_km_tolerance_pct": 0.1,
                "prev_week_km": 52,
                "prev_ctl": 50,
                "z45_pace_threshold_s_km": 240,
                "bad_recovery_signal": True,
                "max_hard_sessions": 1,
                "max_hard_sessions_when_bad_signals": 1,
                "nutrition_daily": True,
                "required_note_tokens": ["HRV"],
            },
            "soft_rubric": {"schema_validity": {"min_score": 5}},
        },
    }


def _nutrition(start_day: int = 18) -> list[dict]:
    return [
        {
            "schema": "plan-nutrition/v1",
            "date": f"2026-05-{day:02d}",
            "kcal_target": 2400,
            "carbs_g": 300,
            "protein_g": 130,
            "fat_g": 70,
            "water_ml": 2500,
            "meals": [],
            "notes_md": "基础补给",
        }
        for day in range(start_day, start_day + 7)
    ]


def _s2_weekly_plan(*, notes: str = "HRV/RHR downshift") -> dict:
    sessions = [
        ("2026-05-18", "run", "easy 8km", 8000),
        ("2026-05-19", "run", "threshold intervals 10km", 10000),
        ("2026-05-20", "rest", "rest", None),
        ("2026-05-21", "run", "VO2 intervals 8km", 8000),
        ("2026-05-22", "run", "easy 9km", 9000),
        ("2026-05-23", "strength", "core stability", None),
        ("2026-05-24", "run", "long run 15km", 15000),
    ]
    return {
        "schema": "weekly-plan/v1",
        "week_folder": "2026-05-18_05-24(S2)",
        "sessions": [
            {
                "schema": "plan-session/v1",
                "date": date,
                "session_index": 0,
                "kind": kind,
                "summary": summary,
                "spec": None,
                "notes_md": notes,
                "total_distance_m": distance,
                "total_duration_s": None,
                "scheduled_workout_id": None,
            }
            for date, kind, summary, distance in sessions
        ],
        "nutrition": _nutrition(),
        "notes_md": notes,
    }


def test_s1_judge_compact_plan_drops_aliases_and_keeps_content():
    plan = {
        "plan_id": "p1",
        "goal": {"distance": "FM", "target_time": "2:50:00"},
        "training_principles": ["A通道需31km专项全过"],
        "phases": [
            {
                "id": "ph1",
                "name": "峰值期",
                "phase_type": "peak",
                "start_date": "2026-09-01",
                "end_date": "2026-10-04",
                "focus": "31km专项",
                "weekly_distance_km_low": 80,
                "weekly_distance_km_high": 90,
                "key_session_types": ["long_run", "race_pace"],
                "milestone_ids": ["m1"],
                "rhythm": "3周负荷+恢复",
                "key_workouts": "31km含22km MP",
                "monitoring_triggers": ["跟腱痛>2降级"],
                "coach_note": "保守执行",
                "is_completed": False,
                "summary": None,
            }
        ],
        "milestones": [
            {
                "id": "m1",
                "phase_id": "ph1",
                "type": "long_run",
                "date": "2026-09-27",
                "target": "31km含22km MP",
                "completed_actual": None,
                "metric": "long_run_distance_km",
                "target_value": 31,
                "comparator": ">=",
            }
        ],
        "weeks": [
            {
                "week_index": 1,
                "week_start": "2026-09-21",
                "phase_id": "ph1",
                "target_weekly_km_low": 84,
                "target_weekly_km_high": 90,
                "is_recovery_week": False,
                "is_taper_week": False,
                "key_sessions": [
                    {
                        "type": "long_run",
                        "distance_km": 31,
                        "duration_min": None,
                        "intensity": "z2",
                        "purpose": "最大专项",
                    },
                    {
                        "type": "race_pace",
                        "distance_km": 22,
                        "duration_min": None,
                        "intensity": "mp",
                        "purpose": "同次长跑内MP段",
                    },
                ],
            }
        ],
    }
    plan["weekly_key_sessions"] = list(plan["weeks"])

    compact = _compact_generated_plan(plan)

    assert "plan_id" not in compact
    assert "weekly_key_sessions" not in compact
    assert "id" not in compact["phases"][0]
    assert "milestone_ids" not in compact["phases"][0]
    assert compact["milestones"][0]["phase_name"] == "峰值期"
    assert "phase_id" not in compact["milestones"][0]
    assert compact["weeks"][0]["phase_name"] == "峰值期"
    assert "phase_id" not in compact["weeks"][0]
    assert "is_completed" not in compact["phases"][0]
    assert "is_recovery_week" not in compact["weeks"][0]
    assert "is_taper_week" not in compact["weeks"][0]
    assert compact["weeks"][0]["key_sessions"][0] == {
        "type": "long_run",
        "distance_km": 31,
        "intensity": "z2",
        "purpose": "最大专项",
    }


def test_s1_judge_compact_plan_keeps_true_boolean_flags():
    plan = {
        "phases": [
            {"id": "ph1", "name": "已完成基础期", "phase_type": "base", "is_completed": True},
            {"id": "ph2", "name": "恢复周", "phase_type": "recovery", "is_completed": False},
        ],
        "weeks": [
            {
                "week_index": 1,
                "phase_id": "ph2",
                "is_recovery_week": True,
                "is_taper_week": False,
                "key_sessions": [],
            },
            {
                "week_index": 2,
                "phase_id": "ph2",
                "is_recovery_week": False,
                "is_taper_week": True,
                "key_sessions": [],
            },
        ],
    }

    compact = _compact_generated_plan(plan)

    assert compact["phases"][0]["is_completed"] is True
    assert "is_completed" not in compact["phases"][1]
    assert compact["weeks"][0]["is_recovery_week"] is True
    assert "is_taper_week" not in compact["weeks"][0]
    assert "is_recovery_week" not in compact["weeks"][1]
    assert compact["weeks"][1]["is_taper_week"] is True


def test_s1_judge_user_message_uses_compact_plan_view():
    plan = {
        "plan_id": "p1",
        "goal": {"distance": "FM"},
        "phases": [{"id": "ph1", "name": "峰值期", "phase_type": "peak"}],
        "weeks": [{"week_index": 1, "phase_id": "ph1", "key_sessions": []}],
    }
    plan["weekly_key_sessions"] = plan["weeks"]

    message = _build_user_message(plan, _fixture())

    assert "<draft_master_plan_compact" in message
    assert "duplicate weekly_key_sessions" in message
    assert '"weekly_key_sessions"' not in message
    assert '"plan_id"' not in message
    assert '"phase_name":"峰值期"' in message
    assert "\n  \"" not in message  # compact JSON, no pretty indentation


def test_s1_judge_prompt_metadata_matches_compact_prompt_view():
    plan = {
        "plan_id": "p1",
        "goal": {"distance": "FM"},
        "phases": [{"id": "ph1", "name": "峰值期", "phase_type": "peak"}],
        "weeks": [{"week_index": 1, "phase_id": "ph1", "key_sessions": []}],
    }
    plan["weekly_key_sessions"] = plan["weeks"]

    metadata = build_s1_judge_prompt_metadata(plan, _fixture())

    assert metadata["judge_system_prompt_chars"] > 0
    assert metadata["judge_user_prompt_chars"] == len(
        _build_user_message(plan, _fixture())
    )
    assert metadata["judge_compact_plan_chars"] == len(
        json.dumps(
            _compact_generated_plan(plan),
            ensure_ascii=False,
            separators=(",", ":"),
        )
    )
    assert metadata["judge_original_plan_chars"] == len(
        json.dumps(plan, ensure_ascii=False, separators=(",", ":"))
    )
    assert metadata["judge_compact_plan_chars"] < metadata["judge_original_plan_chars"]


def test_run_s1_judge_artifact_evaluation_reuses_saved_plan(monkeypatch, tmp_path):
    artifact = {"plan_id": "p1", "phases": []}
    artifact_path = tmp_path / "plan.json"
    artifact_path.write_text(json.dumps(artifact), encoding="utf-8")

    captured: dict = {}
    monkeypatch.setattr("coach_eval.runner.load_fixtures", lambda scope, ids: [_fixture()])

    def fake_rule_filter(plan, **kwargs):
        captured["rule_filter"] = {"plan": plan, "kwargs": kwargs}
        return RuleFilterReport([])

    monkeypatch.setattr("coach_eval.runner.run_master_rule_filter", fake_rule_filter)

    def fake_make_judge(_llm):
        def judge(plan, fixture):
            captured["judge"] = {"plan": plan, "fixture_id": fixture["fixture_id"]}
            return JudgeScore(
                fixture_id=fixture["fixture_id"],
                scope="s1",
                axes=[],
                overall_verdict="pass",
                overall_rationale="ok",
                judge_model="fake",
                judge_prompt_version="s1-vtest",
            )

        return judge

    monkeypatch.setattr("coach_eval.runner.make_s1_judge", fake_make_judge)

    report = run_s1_judge_artifact_evaluation(
        mode=RunMode.FROZEN_FIXTURE,
        fixture_id="s1-artifact-fixture",
        artifact_path=artifact_path,
        judge_llm=SimpleNamespace(model="fake"),
    )

    assert report.fixtures_passed == 1
    outcome = report.per_fixture[0]
    assert outcome.generated_artifact == artifact
    assert outcome.l1_passed is True
    assert outcome.judge_score is not None
    assert captured["rule_filter"]["plan"] == artifact
    assert captured["rule_filter"]["kwargs"]["season_window"]["start_date"] == "2026-05-25"
    assert captured["judge"] == {"plan": artifact, "fixture_id": "s1-artifact-fixture"}
    assert "judge_s" in outcome.timings
    assert outcome.timings["judge_system_prompt_chars"] > 0
    assert outcome.timings["judge_user_prompt_chars"] > 0
    assert outcome.timings["judge_compact_plan_chars"] > 0
    assert outcome.timings["judge_original_plan_chars"] > 0


def test_run_s2_judge_artifact_l1_blocks_bad_signal_double_hard(
    monkeypatch, tmp_path
):
    artifact = _s2_weekly_plan()
    artifact_path = tmp_path / "weekly-plan.json"
    artifact_path.write_text(json.dumps(artifact), encoding="utf-8")

    monkeypatch.setattr("coach_eval.runner.load_fixtures", lambda scope, ids: [_s2_fixture()])

    report = run_s2_judge_artifact_evaluation(
        mode=RunMode.FROZEN_FIXTURE,
        fixture_id="s2-artifact-fixture",
        artifact_path=artifact_path,
        judge_llm=SimpleNamespace(model="fake"),
        run_judge=False,
    )

    assert report.scope == "s2"
    assert report.fixtures_failed == 1
    outcome = report.per_fixture[0]
    assert outcome.l1_passed is False
    assert {v["rule"] for v in outcome.l1_violations} >= {
        "hard_session_count",
        "signal_response_hard_sessions",
    }


def test_run_s2_judge_artifact_evaluation_reuses_saved_weekly_plan(
    monkeypatch, tmp_path
):
    artifact = _s2_weekly_plan()
    artifact["sessions"][3]["summary"] = "easy 8km"
    artifact_path = tmp_path / "weekly-plan.json"
    artifact_path.write_text(json.dumps(artifact), encoding="utf-8")

    captured: dict = {}
    monkeypatch.setattr("coach_eval.runner.load_fixtures", lambda scope, ids: [_s2_fixture()])

    def fake_make_judge(_llm):
        def judge(plan, fixture):
            captured["judge"] = {"plan": plan, "fixture_id": fixture["fixture_id"]}
            return JudgeScore(
                fixture_id=fixture["fixture_id"],
                scope="s2",
                axes=[],
                overall_verdict="pass",
                overall_rationale="ok",
                judge_model="fake",
                judge_prompt_version="s2-vtest",
            )

        return judge

    monkeypatch.setattr("coach_eval.runner.make_s2_judge", fake_make_judge)

    report = run_s2_judge_artifact_evaluation(
        mode=RunMode.FROZEN_FIXTURE,
        fixture_id="s2-artifact-fixture",
        artifact_path=artifact_path,
        judge_llm=SimpleNamespace(model="fake"),
    )

    assert report.scope == "s2"
    assert report.fixtures_passed == 1
    outcome = report.per_fixture[0]
    assert outcome.generated_artifact == artifact
    assert outcome.l1_passed is True
    assert outcome.judge_score is not None
    assert captured["judge"] == {"plan": artifact, "fixture_id": "s2-artifact-fixture"}
    assert outcome.timings["judge_system_prompt_chars"] > 0
    assert outcome.timings["judge_user_prompt_chars"] > 0


def test_run_s2_judge_artifact_l1_only_pass_counts_as_pass(monkeypatch, tmp_path):
    artifact = _s2_weekly_plan()
    artifact["sessions"][3]["summary"] = "easy 8km"
    artifact_path = tmp_path / "weekly-plan.json"
    artifact_path.write_text(json.dumps(artifact), encoding="utf-8")

    monkeypatch.setattr("coach_eval.runner.load_fixtures", lambda scope, ids: [_s2_fixture()])

    report = run_s2_judge_artifact_evaluation(
        mode=RunMode.FROZEN_FIXTURE,
        fixture_id="s2-artifact-fixture",
        artifact_path=artifact_path,
        judge_llm=SimpleNamespace(model="fake"),
        run_judge=False,
    )

    assert report.fixtures_passed == 1
    outcome = report.per_fixture[0]
    assert outcome.l1_passed is True
    assert outcome.judge_score is not None
    assert outcome.judge_score.judge_model == "none"


def test_run_s1_judge_artifact_backfills_source_generation_metadata(
    monkeypatch, tmp_path
):
    artifact = {"plan_id": "p1", "phases": []}
    reports_dir = tmp_path / "reports"
    artifact_dir = reports_dir / "run-source" / "artifacts"
    artifact_dir.mkdir(parents=True)
    artifact_path = artifact_dir / "s1-artifact-fixture.generated-plan.json"
    artifact_path.write_text(json.dumps(artifact), encoding="utf-8")
    source_report = {
        "run_id": "run-source",
        "git_sha": "abc123",
        "scope": "s1",
        "mode": "frozen_fixture",
        "judge_prompt_version": "s1-vtest",
        "fixtures_total": 1,
        "fixtures_passed": 0,
        "fixtures_marginal": 0,
        "fixtures_failed": 1,
        "per_axis_avg": {},
        "per_fixture": [
            {
                "fixture_id": "s1-artifact-fixture",
                "scope": "s1",
                "l1_passed": True,
                "l1_violations": [],
                "generated_artifact": artifact,
                "generation_iterations": 2,
                "timings": {
                    "generator_total_s": 321.0,
                    "generation_total_s": 322.0,
                    "generator_system_prompt_chars": 30000,
                    "generator_user_prompt_chars": 2000,
                    "generator_raw_response_chars": 9000,
                    "judge_s": 777.0,
                    "rule_filter_history": [
                        {
                            "iteration": 1,
                            "violations": [
                                {"rule": "weekly_volume_ramp", "severity": "error"}
                            ],
                        },
                        {"iteration": 2, "violations": []},
                    ],
                },
            }
        ],
    }
    (reports_dir / "run-source.json").write_text(
        json.dumps(source_report), encoding="utf-8"
    )

    monkeypatch.setattr("coach_eval.runner.REPORT_DIR", reports_dir)
    monkeypatch.setattr("coach_eval.runner.load_fixtures", lambda scope, ids: [_fixture()])
    monkeypatch.setattr(
        "coach_eval.runner.run_master_rule_filter",
        lambda plan, **kwargs: RuleFilterReport([]),
    )

    def fake_make_judge(_llm):
        def judge(plan, fixture):
            return JudgeScore(
                fixture_id=fixture["fixture_id"],
                scope="s1",
                axes=[],
                overall_verdict="pass",
                overall_rationale="ok",
                judge_model="fake",
                judge_prompt_version="s1-vtest",
            )

        return judge

    monkeypatch.setattr("coach_eval.runner.make_s1_judge", fake_make_judge)

    report = run_s1_judge_artifact_evaluation(
        mode=RunMode.FROZEN_FIXTURE,
        fixture_id="s1-artifact-fixture",
        artifact_path=artifact_path,
        judge_llm=SimpleNamespace(model="fake"),
    )

    outcome = report.per_fixture[0]
    assert outcome.generation_iterations == 2
    assert outcome.timings["generator_total_s"] == 321.0
    assert outcome.timings["generation_total_s"] == 322.0
    assert outcome.timings["generator_system_prompt_chars"] == 30000
    assert outcome.timings["generator_user_prompt_chars"] == 2000
    assert outcome.timings["generator_raw_response_chars"] == 9000
    assert outcome.timings["rule_filter_history"][0]["violations"][0]["rule"] == "weekly_volume_ramp"
    assert outcome.timings["artifact_source_report"].endswith("run-source.json")
    assert outcome.timings["judge_s"] != 777.0


def test_run_evaluation_for_fixture_records_judge_prompt_metadata():
    from coach_eval.graph import run_evaluation_for_fixture

    artifact = {"plan_id": "p1", "goal": {"distance": "FM"}, "phases": []}

    class FakeGraph:
        def invoke(self, _state):
            return {
                "final_verdict": "pass",
                "rule_violations": [],
                "final_artifact": artifact,
                "iteration": 1,
                "timings": {"generator_total_s": 1.0},
            }

    def judge(plan, fixture):
        return JudgeScore(
            fixture_id=fixture["fixture_id"],
            scope="s1",
            axes=[],
            overall_verdict="pass",
            overall_rationale="ok",
            judge_model="fake",
            judge_prompt_version="s1-vtest",
        )

    outcome = run_evaluation_for_fixture(
        fixture=_fixture(),
        gen_graph=FakeGraph(),
        judge=judge,
        initial_state_builder=lambda _fixture: {},
        judge_prompt_metadata_builder=build_s1_judge_prompt_metadata,
    )

    assert outcome.l1_passed is True
    assert outcome.judge_score is not None
    assert outcome.timings["judge_user_prompt_chars"] == len(
        _build_user_message(artifact, _fixture())
    )
    assert outcome.timings["judge_compact_plan_chars"] > 0


def test_run_s1_evaluation_writes_partial_checkpoints(monkeypatch, tmp_path):
    from coach_eval import runner

    reports_dir = tmp_path / "reports"
    monkeypatch.setattr(runner, "REPORT_DIR", reports_dir)
    monkeypatch.setattr(runner, "_new_run_id", lambda: "run-checkpoint")
    fixtures = [
        {**_fixture(), "fixture_id": "s1-checkpoint-a"},
        {**_fixture(), "fixture_id": "s1-checkpoint-b"},
    ]
    monkeypatch.setattr(runner, "load_fixtures", lambda scope, ids: fixtures)
    monkeypatch.setattr(runner, "_make_frozen_load_context", lambda fixture: (lambda state: {}))

    class FakeGraph:
        calls = 0

        def invoke(self, _state):
            self.calls += 1
            return {
                "final_verdict": "pass",
                "rule_violations": [],
                "final_artifact": {"plan_id": f"p{self.calls}"},
                "iteration": 1,
                "timings": {"generator_total_s": 1.0},
            }

    fake_graph = FakeGraph()
    monkeypatch.setattr(runner, "build_generation_graph", lambda **kwargs: fake_graph)
    monkeypatch.setattr(runner, "make_s1_judge", lambda llm: (lambda plan, fixture: JudgeScore(
        fixture_id=fixture["fixture_id"],
        scope="s1",
        axes=[],
        overall_verdict="pass",
        overall_rationale="ok",
        judge_model="fake",
        judge_prompt_version="s1-vtest",
    )))
    monkeypatch.setattr(runner, "build_s1_judge_prompt_metadata", lambda plan, fixture: {})

    report = runner.run_s1_evaluation(
        mode=RunMode.FROZEN_FIXTURE,
        judge_llm=SimpleNamespace(model="fake"),
    )

    assert report.run_id == "run-checkpoint"
    assert [outcome.fixture_id for outcome in report.per_fixture] == [
        "s1-checkpoint-a",
        "s1-checkpoint-b",
    ]
    partial_json = reports_dir / "run-checkpoint.partial.json"
    partial_md = reports_dir / "run-checkpoint.partial.md"
    assert partial_json.exists()
    assert partial_md.exists()
    partial_payload = json.loads(partial_json.read_text(encoding="utf-8"))
    assert partial_payload["run_id"] == "run-checkpoint.partial"
    assert partial_payload["fixtures_total"] == 2
    assert [outcome["fixture_id"] for outcome in partial_payload["per_fixture"]] == [
        "s1-checkpoint-a",
        "s1-checkpoint-b",
    ]
    assert (
        reports_dir
        / "run-checkpoint.partial"
        / "artifacts"
        / "s1-checkpoint-b.generated-plan.json"
    ).exists()


def test_run_s1_evaluation_resumes_from_partial_report(monkeypatch, tmp_path):
    from coach_eval import runner

    reports_dir = tmp_path / "reports"
    monkeypatch.setattr(runner, "REPORT_DIR", reports_dir)
    fixtures = [
        {**_fixture(), "fixture_id": "s1-resume-a"},
        {**_fixture(), "fixture_id": "s1-resume-b"},
    ]
    monkeypatch.setattr(runner, "load_fixtures", lambda scope, ids: fixtures)
    monkeypatch.setattr(runner, "_make_frozen_load_context", lambda fixture: (lambda state: {}))

    resume_report = EvalReport(
        run_id="run-resume.partial",
        git_sha="abc123",
        scope="s1",
        mode="frozen_fixture",
        judge_prompt_version=runner.S1_JUDGE_VERSION,
        fixtures_total=1,
        fixtures_passed=1,
        fixtures_marginal=0,
        fixtures_failed=0,
        per_fixture=[
            FixtureRunOutcome(
                fixture_id="s1-resume-a",
                scope="s1",
                l1_passed=True,
                generated_artifact={"plan_id": "resumed"},
                judge_score=JudgeScore(
                    fixture_id="s1-resume-a",
                    scope="s1",
                    axes=[],
                    overall_verdict="pass",
                    overall_rationale="ok",
                    judge_model="fake",
                    judge_prompt_version=runner.S1_JUDGE_VERSION,
                ),
            )
        ],
    )
    resume_path = tmp_path / "resume.partial.json"
    resume_path.write_text(resume_report.model_dump_json(), encoding="utf-8")

    class FakeGraph:
        calls = 0

        def invoke(self, _state):
            self.calls += 1
            return {
                "final_verdict": "pass",
                "rule_violations": [],
                "final_artifact": {"plan_id": "new"},
                "iteration": 1,
                "timings": {"generator_total_s": 1.0},
            }

    fake_graph = FakeGraph()
    monkeypatch.setattr(runner, "build_generation_graph", lambda **kwargs: fake_graph)
    monkeypatch.setattr(runner, "make_s1_judge", lambda llm: (lambda plan, fixture: JudgeScore(
        fixture_id=fixture["fixture_id"],
        scope="s1",
        axes=[],
        overall_verdict="pass",
        overall_rationale="ok",
        judge_model="fake",
        judge_prompt_version=runner.S1_JUDGE_VERSION,
    )))
    monkeypatch.setattr(runner, "build_s1_judge_prompt_metadata", lambda plan, fixture: {})

    report = runner.run_s1_evaluation(
        mode=RunMode.FROZEN_FIXTURE,
        judge_llm=SimpleNamespace(model="fake"),
        resume_report_path=resume_path,
    )

    assert report.run_id == "run-resume"
    assert fake_graph.calls == 1
    assert [outcome.fixture_id for outcome in report.per_fixture] == [
        "s1-resume-a",
        "s1-resume-b",
    ]
    assert report.per_fixture[0].generated_artifact == {"plan_id": "resumed"}
    assert report.per_fixture[1].generated_artifact == {"plan_id": "new"}
    partial_payload = json.loads(
        (reports_dir / "run-resume.partial.json").read_text(encoding="utf-8")
    )
    assert [outcome["fixture_id"] for outcome in partial_payload["per_fixture"]] == [
        "s1-resume-a",
        "s1-resume-b",
    ]


def test_write_report_removes_matching_partial_checkpoint(monkeypatch, tmp_path):
    from coach_eval import runner
    from coach_eval.runner import write_report

    reports_dir = tmp_path / "reports"
    monkeypatch.setattr(runner, "REPORT_DIR", reports_dir)
    partial_dir = reports_dir / "run-final.partial" / "artifacts"
    partial_dir.mkdir(parents=True)
    (reports_dir / "run-final.partial.json").write_text("{}", encoding="utf-8")
    (reports_dir / "run-final.partial.md").write_text("partial", encoding="utf-8")
    (partial_dir / "old.generated-plan.json").write_text("{}", encoding="utf-8")

    report = EvalReport(
        run_id="run-final",
        git_sha="abc123",
        scope="s1",
        mode="frozen_fixture",
        judge_prompt_version="s1-vtest",
        fixtures_total=1,
        fixtures_passed=1,
        fixtures_marginal=0,
        fixtures_failed=0,
        per_fixture=[
            FixtureRunOutcome(
                fixture_id="s1-final",
                scope="s1",
                l1_passed=True,
                generated_artifact={"plan_id": "final"},
                judge_score=JudgeScore(
                    fixture_id="s1-final",
                    scope="s1",
                    axes=[],
                    overall_verdict="pass",
                    overall_rationale="ok",
                    judge_model="fake",
                    judge_prompt_version="s1-vtest",
                ),
            )
        ],
    )

    json_path, md_path = write_report(report)

    assert json_path.exists()
    assert md_path.exists()
    assert not (reports_dir / "run-final.partial.json").exists()
    assert not (reports_dir / "run-final.partial.md").exists()
    assert not (reports_dir / "run-final.partial").exists()


def test_run_s1_judge_artifact_evaluation_can_repeat_judge(monkeypatch, tmp_path):
    artifact = {"plan_id": "p1", "phases": []}
    artifact_path = tmp_path / "plan.json"
    artifact_path.write_text(json.dumps(artifact), encoding="utf-8")

    monkeypatch.setattr("coach_eval.runner.load_fixtures", lambda scope, ids: [_fixture()])
    monkeypatch.setattr(
        "coach_eval.runner.run_master_rule_filter",
        lambda plan, **kwargs: RuleFilterReport([]),
    )

    calls = {"n": 0}

    def fake_make_judge(_llm):
        def judge(plan, fixture):
            calls["n"] += 1
            score = 5 if calls["n"] == 1 else 4
            return JudgeScore(
                fixture_id=fixture["fixture_id"],
                scope="s1",
                axes=[
                    {
                        "axis": "goal_realism",
                        "score": score,
                        "rationale": f"sample {calls['n']}",
                        "matches_expected": True,
                    }
                ],
                overall_verdict="pass",
                overall_rationale="ok",
                judge_model="fake",
                judge_prompt_version="s1-vtest",
            )

        return judge

    monkeypatch.setattr("coach_eval.runner.make_s1_judge", fake_make_judge)

    report = run_s1_judge_artifact_evaluation(
        mode=RunMode.FROZEN_FIXTURE,
        fixture_id="s1-artifact-fixture",
        artifact_path=artifact_path,
        judge_llm=SimpleNamespace(model="fake"),
        judge_repeat=2,
    )

    outcome = report.per_fixture[0]
    assert calls["n"] == 2
    assert len(outcome.judge_samples) == 2
    assert outcome.judge_score is not None
    assert outcome.judge_score.axes[0].score == 4
    assert outcome.judge_summary["repeat"] == 2
    assert outcome.judge_summary["unstable_axes"] == ["goal_realism"]
    assert outcome.judge_summary["axis_scores"] == {"goal_realism": [5, 4]}


def test_run_s1_judge_artifact_retries_capacity_error(monkeypatch, tmp_path):
    from coach_eval import graph

    artifact = {"plan_id": "p1", "phases": []}
    artifact_path = tmp_path / "plan.json"
    artifact_path.write_text(json.dumps(artifact), encoding="utf-8")

    monkeypatch.setattr("coach_eval.runner.load_fixtures", lambda scope, ids: [_fixture()])
    monkeypatch.setattr(
        "coach_eval.runner.run_master_rule_filter",
        lambda plan, **kwargs: RuleFilterReport([]),
    )
    monkeypatch.setattr(graph, "_JUDGE_RETRY_DELAYS_S", (0.0,))
    monkeypatch.setattr(graph.time, "sleep", lambda _seconds: None)
    calls = {"n": 0}

    def fake_make_judge(_llm):
        def judge(plan, fixture):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("Error code: 429 - no_capacity")
            return JudgeScore(
                fixture_id=fixture["fixture_id"],
                scope="s1",
                axes=[],
                overall_verdict="pass",
                overall_rationale="ok",
                judge_model="fake",
                judge_prompt_version="s1-vtest",
            )

        return judge

    monkeypatch.setattr("coach_eval.runner.make_s1_judge", fake_make_judge)

    report = run_s1_judge_artifact_evaluation(
        mode=RunMode.FROZEN_FIXTURE,
        fixture_id="s1-artifact-fixture",
        artifact_path=artifact_path,
        judge_llm=SimpleNamespace(model="fake"),
    )

    outcome = report.per_fixture[0]
    assert report.fixtures_passed == 1
    assert calls["n"] == 2
    assert outcome.timings["judge_retries"] == 1
    assert len(outcome.timings["judge_attempt_s"]) == 2


def test_run_s1_judge_artifact_records_exhausted_transient_judge_failure(
    monkeypatch, tmp_path
):
    from coach_eval import graph
    from scripts.eval_coach import EXIT_LLM_UNAVAILABLE, _exit_code

    artifact = {"plan_id": "p1", "phases": []}
    artifact_path = tmp_path / "plan.json"
    artifact_path.write_text(json.dumps(artifact), encoding="utf-8")

    monkeypatch.setattr("coach_eval.runner.load_fixtures", lambda scope, ids: [_fixture()])
    monkeypatch.setattr(
        "coach_eval.runner.run_master_rule_filter",
        lambda plan, **kwargs: RuleFilterReport([]),
    )
    monkeypatch.setattr(graph, "_JUDGE_RETRY_DELAYS_S", (0.0,))
    monkeypatch.setattr(graph.time, "sleep", lambda _seconds: None)
    calls = {"n": 0}

    def fake_make_judge(_llm):
        def judge(plan, fixture):
            calls["n"] += 1
            raise RuntimeError("Error code: 429 - no_capacity")

        return judge

    monkeypatch.setattr("coach_eval.runner.make_s1_judge", fake_make_judge)

    report = run_s1_judge_artifact_evaluation(
        mode=RunMode.FROZEN_FIXTURE,
        fixture_id="s1-artifact-fixture",
        artifact_path=artifact_path,
        judge_llm=SimpleNamespace(model="fake"),
    )

    outcome = report.per_fixture[0]
    assert calls["n"] == 2
    assert report.fixtures_failed == 1
    assert outcome.l1_passed is True
    assert outcome.generated_artifact == artifact
    assert outcome.judge_score is None
    assert outcome.error is not None
    assert outcome.error.startswith("judge_failed: RuntimeError")
    assert "no_capacity" in outcome.error
    assert outcome.debug == {"exception_type": "RuntimeError"}
    assert outcome.timings["judge_user_prompt_chars"] > 0
    assert _exit_code(report) == EXIT_LLM_UNAVAILABLE


def test_fixture_run_outcome_accepts_structured_timing_history():
    outcome = FixtureRunOutcome(
        fixture_id="s1-structured-timing",
        scope="s1",
        l1_passed=True,
        timings={
            "generator_total_s": 12.3,
            "rule_filter_history": [
                {
                    "iteration": 1,
                    "violations": [
                        {"rule": "weekly_volume_ramp", "severity": "error"}
                    ],
                },
                {"iteration": 2, "violations": []},
            ],
        },
    )

    assert outcome.timings["rule_filter_history"][0]["iteration"] == 1
    assert outcome.timings["rule_filter_history"][1]["violations"] == []


def test_judge_capacity_error_retries_once(monkeypatch):
    from coach_eval import graph

    monkeypatch.setattr(graph, "_JUDGE_RETRY_DELAYS_S", (0.0,))
    monkeypatch.setattr(graph.time, "sleep", lambda _seconds: None)
    calls = {"n": 0}

    def flaky_judge(_plan, fixture):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("Error code: 429 - no_capacity")
        return JudgeScore(
            fixture_id=fixture["fixture_id"],
            scope="s1",
            axes=[],
            overall_verdict="pass",
            overall_rationale="ok",
            judge_model="fake",
            judge_prompt_version="s1-vtest",
        )

    score, timings = graph.call_judge_with_retries(
        flaky_judge,
        {"plan_id": "p1"},
        _fixture(),
    )

    assert score.overall_verdict == "pass"
    assert calls["n"] == 2
    assert timings["judge_retries"] == 1
    assert len(timings["judge_attempt_s"]) == 2


def test_judge_non_capacity_error_does_not_retry(monkeypatch):
    from coach_eval import graph

    monkeypatch.setattr(graph, "_JUDGE_RETRY_DELAYS_S", (0.0,))
    calls = {"n": 0}

    def bad_judge(_plan, _fixture):
        calls["n"] += 1
        raise ValueError("judge JSON parse failed")

    try:
        graph.call_judge_with_retries(bad_judge, {"plan_id": "p1"}, _fixture())
    except ValueError as exc:
        assert "parse failed" in str(exc)
    else:  # pragma: no cover - assertion path
        raise AssertionError("expected judge parse failure")

    assert calls["n"] == 1


def test_run_s1_judge_artifact_evaluation_skips_judge_when_l1_blocks(
    monkeypatch, tmp_path
):
    artifact_path = tmp_path / "plan.json"
    artifact_path.write_text(json.dumps({"plan_id": "bad"}), encoding="utf-8")

    monkeypatch.setattr("coach_eval.runner.load_fixtures", lambda scope, ids: [_fixture()])
    monkeypatch.setattr(
        "coach_eval.runner.run_master_rule_filter",
        lambda plan, **kwargs: RuleFilterReport(
            [
                RuleViolation(
                    rule="season_window_fits",
                    severity="error",
                    message="late start",
                )
            ]
        ),
    )

    def fail_make_judge(_llm):  # pragma: no cover - assertion path
        raise AssertionError("judge should not be built after L1 block")

    monkeypatch.setattr("coach_eval.runner.make_s1_judge", fail_make_judge)

    report = run_s1_judge_artifact_evaluation(
        mode=RunMode.FROZEN_FIXTURE,
        fixture_id="s1-artifact-fixture",
        artifact_path=artifact_path,
        judge_llm=SimpleNamespace(model="fake"),
    )

    assert report.fixtures_failed == 1
    outcome = report.per_fixture[0]
    assert outcome.l1_passed is False
    assert outcome.judge_score is None
    assert outcome.l1_violations[0]["rule"] == "season_window_fits"


def test_frozen_load_context_passes_structured_fixture_context():
    from coach_eval.runner import _make_frozen_load_context

    fixture = _fixture()
    fixture["input"]["training_history_summary"] = {
        "monthly_mileage_km": [100],
        "weekly_profile": [
            {
                "week_start": "2026-06-22",
                "distance_km": 62.0,
                "hours": 5.0,
                "n_runs": 6,
            }
        ],
        "peak_weekly_km_in_window": 88,
    }
    fixture["input"]["fitness_state"] = {"summary": "RHR 53 yellow at altitude"}
    fixture["input"]["continuity"] = {"macro_cycle": "summer", "recent_aerobic_weeks": 8}
    fixture["input"]["current_phase"] = {
        "source": "existing_plan",
        "current_phase_type": "build",
        "weeks_in_phase": 2,
        "completed_aerobic_weeks": 8,
        "recommended_entry_phase": "build",
        "confidence": "high",
        "rationale": "existing P2W2 plan",
    }
    fixture["input"]["body_composition"] = {"weight_kg": 70.0, "body_fat_pct": 21.0}
    fixture["input"]["body_composition_summary"] = "最新体测：70kg"

    ctx = _make_frozen_load_context(fixture)({})

    assert ctx["fitness_state"]["summary"] == "RHR 53 yellow at altitude"
    assert ctx["history"]["weekly_profile"][0]["distance_km"] == 62.0
    assert ctx["continuity"]["macro_cycle"] == "summer"
    assert ctx["current_phase"]["recommended_entry_phase"] == "build"
    assert ctx["body_composition_summary"] == "最新体测：70kg"


def test_s1_initial_state_can_carry_master_max_tokens_override():
    from coach_eval.runner import _build_s1_initial_state

    state = _build_s1_initial_state(_fixture(), master_max_tokens=20000)

    assert state["runtime_options"] == {"master_max_tokens": 20000}


def test_s1_rule_filter_kwargs_passes_injury_and_history_context():
    from coach_eval.runner import _s1_rule_filter_kwargs

    fixture = _fixture()
    fixture["input"]["user_profile"]["injuries"] = ["knee"]
    fixture["input"]["training_history_summary"] = {
        "peak_weekly_km_in_window": 58,
        "training_gaps": [{"reason": "knee injury + PT rehab"}],
    }

    kwargs = _s1_rule_filter_kwargs(fixture)

    assert kwargs["injuries"] == ["knee"]
    assert kwargs["training_history_summary"]["peak_weekly_km_in_window"] == 58


def test_s1_judge_prompt_allows_no_recovery_phase_when_window_ends_at_race():
    from coach_eval.judge_s1 import JUDGE_PROMPT_VERSION, S1_JUDGE_SYSTEM_PROMPT

    assert JUDGE_PROMPT_VERSION == "s1-v8"
    assert "season_window.end_date" in S1_JUDGE_SYSTEM_PROMPT
    assert "target_race.race_date" in S1_JUDGE_SYSTEM_PROMPT
    assert "不要因为缺少赛后 recovery phase 扣 season_structure 分" in S1_JUDGE_SYSTEM_PROMPT
    assert "is_completed:true" in S1_JUDGE_SYSTEM_PROMPT
    assert "不要因为 weeks 从当前 active phase" in S1_JUDGE_SYSTEM_PROMPT
    assert "weeks" in S1_JUDGE_SYSTEM_PROMPT
    assert "weekly_key_sessions" in S1_JUDGE_SYSTEM_PROMPT
    assert "正常冗余" in S1_JUDGE_SYSTEM_PROMPT
    assert "跨过 recovery/taper 周" in S1_JUDGE_SYSTEM_PROMPT
    assert "不能按 44 到 81 误判为大跳" in S1_JUDGE_SYSTEM_PROMPT
    assert "weekly_distance_km_low" in S1_JUDGE_SYSTEM_PROMPT
    assert "build low=55, recovery high=44" in S1_JUDGE_SYSTEM_PROMPT
    assert "春节/holiday race fixture" in S1_JUDGE_SYSTEM_PROMPT
    assert "65-72km" in S1_JUDGE_SYSTEM_PROMPT
    assert "protected `28km / 72km`" in S1_JUDGE_SYSTEM_PROMPT
    assert "holiday volume exception" in S1_JUDGE_SYSTEM_PROMPT
    assert "data-gap/no-recent-race FM 例外" in S1_JUDGE_SYSTEM_PROMPT
    assert "history peak around 52km" in S1_JUDGE_SYSTEM_PROMPT
    assert "protected `28km / 58-65km`" in S1_JUDGE_SYSTEM_PROMPT
    assert "不要仅因 `28/60` 略高于 35%" in S1_JUDGE_SYSTEM_PROMPT
    assert "完整 gate 组合" in S1_JUDGE_SYSTEM_PROMPT
    assert "HM/10K gate + 30-32km MP rehearsal" in S1_JUDGE_SYSTEM_PROMPT
    assert "zhaochaoyi fixture" in S1_JUDGE_SYSTEM_PROMPT
    assert "观察/B+" in S1_JUDGE_SYSTEM_PROMPT
    assert "31km/22km MP + VO2max + HR/RPE + 跟腱" in S1_JUDGE_SYSTEM_PROMPT
    assert "aggressive HM fixture 口径" in S1_JUDGE_SYSTEM_PROMPT
    assert "PB `1:27:42` -> `1:20`" in S1_JUDGE_SYSTEM_PROMPT
    assert "aggressive but possible for advanced" in S1_JUDGE_SYSTEM_PROMPT
    assert "默认日常按 `1:21-1:22`" in S1_JUDGE_SYSTEM_PROMPT
    assert "`10K<=37:00`" in S1_JUDGE_SYSTEM_PROMPT
    assert "不要仅因当前/近期 10K 约 40 分" in S1_JUDGE_SYSTEM_PROMPT
    assert "goal.target_time" in S1_JUDGE_SYSTEM_PROMPT
    assert "不要因为 `goal.target_time` 仍是 A 目标" in S1_JUDGE_SYSTEM_PROMPT
    assert "目标等价 HM/10K gate" in S1_JUDGE_SYSTEM_PROMPT
    assert "不要求每个信号都出现在 race milestone" in S1_JUDGE_SYSTEM_PROMPT
    assert "不要仅因 recovery→load 的视觉回弹扣到 4" in S1_JUDGE_SYSTEM_PROMPT
    assert "伤后 FM 回归" in S1_JUDGE_SYSTEM_PROMPT
    assert "唯一 64-65km 周绑定 28km 彩排" in S1_JUDGE_SYSTEM_PROMPT
    assert "不要因高50/低60km 平台期" in S1_JUDGE_SYSTEM_PROMPT
    assert "lighter long-run buffer" in S1_JUDGE_SYSTEM_PROMPT
    assert "5K 计划受自然周 schema 约束" in S1_JUDGE_SYSTEM_PROMPT
    assert "不要把“整周 phase”当作 7 天 taper 缺陷" in S1_JUDGE_SYSTEM_PROMPT
    assert "只有 `race` 一个结构化 key session" in S1_JUDGE_SYSTEM_PROMPT


def test_cli_summary_prints_speed_metadata(capsys, tmp_path):
    from scripts.eval_coach import _print_summary

    report = EvalReport(
        run_id="run-speed",
        git_sha="abc123",
        scope="s1",
        mode="frozen_fixture",
        judge_prompt_version="s1-vtest",
        fixtures_total=1,
        fixtures_passed=1,
        fixtures_marginal=0,
        fixtures_failed=0,
        per_axis_avg={},
        per_fixture=[
            FixtureRunOutcome(
                fixture_id="s1-speed-fixture",
                scope="s1",
                l1_passed=True,
                generation_iterations=2,
                timings={
                    "generator_total_s": 12.34,
                    "judge_s": 5.67,
                    "total_s": 18.01,
                    "generator_system_prompt_chars": 39931,
                    "generator_user_prompt_chars": 6579,
                    "generator_raw_response_chars": 12345,
                    "generator_max_tokens": 20000,
                    "judge_user_prompt_chars": 19075,
                    "judge_compact_plan_chars": 11064,
                },
                judge_score=JudgeScore(
                    fixture_id="s1-speed-fixture",
                    scope="s1",
                    axes=[],
                    overall_verdict="pass",
                    overall_rationale="ok",
                    judge_model="fake",
                    judge_prompt_version="s1-vtest",
                ),
                judge_summary={
                    "repeat": 2,
                    "unstable_axes": ["goal_realism"],
                    "axis_scores": {"goal_realism": [5, 4]},
                },
            )
        ],
    )

    _print_summary(report, tmp_path / "report.json", tmp_path / "report.md")

    out = capsys.readouterr().out
    assert "gen=12.3s" in out
    assert "judge=5.7s" in out
    assert "gsys=39931ch" in out
    assert "guser=6579ch" in out
    assert "raw=12345ch" in out
    assert "max=20000" in out
    assert "juser=19075ch" in out
    assert "jplan=11064ch" in out
    assert "judge_n=2" in out
    assert "unstable=goal_realism" in out


def test_exit_code_treats_transient_llm_failures_as_unavailable(capsys):
    from scripts.eval_coach import EXIT_LLM_UNAVAILABLE, _exit_code, _print_summary

    report = EvalReport(
        run_id="run-capacity",
        git_sha="abc123",
        scope="s1",
        mode="frozen_fixture",
        judge_prompt_version="s1-vtest",
        fixtures_total=1,
        fixtures_passed=0,
        fixtures_marginal=0,
        fixtures_failed=1,
        per_fixture=[
            FixtureRunOutcome(
                fixture_id="s1-capacity",
                scope="s1",
                l1_passed=False,
                error="generation_failed: LLMError: Error code: 429 - no_capacity",
            )
        ],
    )

    assert _exit_code(report) == EXIT_LLM_UNAVAILABLE

    # Summary should make infra failure visually distinct from plan-quality fail.
    _print_summary(report, Path("report.json"), Path("report.md"))
    assert "infra=llm_transient" in capsys.readouterr().out


def test_exit_code_treats_judge_server_error_as_unavailable():
    from scripts.eval_coach import EXIT_LLM_UNAVAILABLE, _exit_code

    report = EvalReport(
        run_id="run-judge-server-error",
        git_sha="abc123",
        scope="s1",
        mode="frozen_fixture",
        judge_prompt_version="s1-vtest",
        fixtures_total=1,
        fixtures_passed=0,
        fixtures_marginal=0,
        fixtures_failed=1,
        per_fixture=[
            FixtureRunOutcome(
                fixture_id="s1-judge-server-error",
                scope="s1",
                l1_passed=True,
                generation_iterations=2,
                error="judge_failed: InternalServerError: Error code: 500 - {'error': {'code': 'server_error', 'message': 'The server had an error processing your request.'}}",
            )
        ],
    )

    assert _exit_code(report) == EXIT_LLM_UNAVAILABLE


def test_exit_code_allows_passes_plus_transient_llm_failures():
    from scripts.eval_coach import EXIT_LLM_UNAVAILABLE, _exit_code

    report = EvalReport(
        run_id="run-partial-capacity",
        git_sha="abc123",
        scope="s1",
        mode="frozen_fixture",
        judge_prompt_version="s1-vtest",
        fixtures_total=2,
        fixtures_passed=1,
        fixtures_marginal=0,
        fixtures_failed=1,
        per_fixture=[
            FixtureRunOutcome(
                fixture_id="s1-pass",
                scope="s1",
                l1_passed=True,
                judge_score=JudgeScore(
                    fixture_id="s1-pass",
                    scope="s1",
                    axes=[],
                    overall_verdict="pass",
                    overall_rationale="ok",
                    judge_model="fake",
                    judge_prompt_version="s1-vtest",
                ),
            ),
            FixtureRunOutcome(
                fixture_id="s1-capacity",
                scope="s1",
                l1_passed=False,
                error="generation_failed: LLMError: too many requests no_capacity",
            ),
        ],
    )

    assert _exit_code(report) == EXIT_LLM_UNAVAILABLE


def test_exit_code_keeps_real_eval_failures_as_failures():
    from scripts.eval_coach import EXIT_FAIL, _exit_code

    report = EvalReport(
        run_id="run-real-fail",
        git_sha="abc123",
        scope="s1",
        mode="frozen_fixture",
        judge_prompt_version="s1-vtest",
        fixtures_total=1,
        fixtures_passed=0,
        fixtures_marginal=0,
        fixtures_failed=1,
        per_fixture=[
            FixtureRunOutcome(
                fixture_id="s1-l1-fail",
                scope="s1",
                l1_passed=False,
                error="generation_failed: SchemaError: weekly_volume_ramp",
            )
        ],
    )

    assert _exit_code(report) == EXIT_FAIL


def test_llm_health_check_success(capsys):
    from scripts.eval_coach import EXIT_OK, _run_llm_health_check

    class FakeLLM:
        def invoke(self, _messages):
            return "OK"

    assert _run_llm_health_check(FakeLLM()) == EXIT_OK

    out = capsys.readouterr().out
    assert "Eval LLM health check" in out
    assert "Status: OK" in out
    assert "Response: OK" in out


def test_llm_health_check_transient_failure(capsys):
    from scripts.eval_coach import EXIT_LLM_UNAVAILABLE, _run_llm_health_check

    class FakeLLM:
        def invoke(self, _messages):
            raise RuntimeError("Error code: 429 - no_capacity")

    assert _run_llm_health_check(FakeLLM()) == EXIT_LLM_UNAVAILABLE

    out = capsys.readouterr().out
    assert "Eval LLM health check" in out
    assert "Status: llm_transient" in out
    assert "Latency:" in out
    assert "no_capacity" in out


def test_llm_health_check_must_run_by_itself(capsys, tmp_path):
    from scripts.eval_coach import EXIT_FAIL, main

    report = tmp_path / "report.json"
    report.write_text("{}", encoding="utf-8")

    assert main(["--llm-health-check", "--compare-reports", str(report)]) == EXIT_FAIL

    err = capsys.readouterr().err
    assert "Use --llm-health-check by itself" in err


def test_resume_report_rejects_incompatible_cli_modes(capsys, tmp_path):
    from scripts.eval_coach import EXIT_FAIL, main

    report = tmp_path / "resume.json"
    artifact = tmp_path / "artifact.json"
    report.write_text("{}", encoding="utf-8")
    artifact.write_text("{}", encoding="utf-8")

    assert main([
        "--scope", "s1",
        "--fixture", "s1-artifact-fixture",
        "--resume-report", str(report),
        "--judge-artifact", str(artifact),
    ]) == EXIT_FAIL
    assert "--resume-report cannot be combined with --judge-artifact" in capsys.readouterr().err

    assert main([
        "--scope", "s1",
        "--resume-report", str(report),
        "--layer", "L1",
    ]) == EXIT_FAIL
    assert "--resume-report cannot be combined with --layer L1" in capsys.readouterr().err


def test_compare_reports_prints_speed_and_axis_rows(capsys, tmp_path):
    from scripts.eval_coach import _run_compare_reports

    report = EvalReport(
        run_id="run-compare",
        git_sha="abc123",
        scope="s1",
        mode="frozen_fixture",
        judge_prompt_version="s1-vtest",
        fixtures_total=1,
        fixtures_passed=1,
        fixtures_marginal=0,
        fixtures_failed=0,
        per_fixture=[
            FixtureRunOutcome(
                fixture_id="s1-compare-fixture",
                scope="s1",
                l1_passed=True,
                l1_violations=[
                    {"rule": "long_run_distance_share", "severity": "warning"},
                    {"rule": "long_run_distance_share", "severity": "warning"},
                    {"rule": "milestone_week_consistency", "severity": "warning"},
                ],
                generation_iterations=2,
                timings={
                    "generator_total_s": 99.9,
                    "judge_s": 11.1,
                    "total_s": 111.0,
                    "rule_filter_history": [
                        {
                            "iteration": 1,
                            "violations": [
                                {"rule": "weekly_volume_ramp", "severity": "error"},
                                {"rule": "milestone_week_consistency", "severity": "warning"},
                            ],
                        },
                        {"iteration": 2, "violations": []},
                    ],
                    "generator_system_prompt_chars": 39931,
                    "generator_user_prompt_chars": 6579,
                    "generator_max_tokens": 22000,
                    "generator_raw_response_chars": 13579,
                    "judge_system_prompt_chars": 12000,
                    "judge_user_prompt_chars": 21000,
                    "judge_compact_plan_chars": 11000,
                    "judge_original_plan_chars": 31000,
                    "judge_retries": 2,
                },
                judge_score=JudgeScore(
                    fixture_id="s1-compare-fixture",
                    scope="s1",
                    axes=[
                        {
                            "axis": "schema_validity",
                            "score": 5,
                            "rationale": "ok",
                            "matches_expected": True,
                        }
                    ],
                    overall_verdict="pass",
                    overall_rationale="ok",
                    judge_model="fake",
                    judge_prompt_version="s1-vtest",
                ),
                judge_summary={
                    "repeat": 3,
                    "unstable_axes": ["goal_realism", "volume_progression"],
                    "axis_scores": {
                        "goal_realism": [5, 4, 5],
                        "volume_progression": [5, 5, 4],
                    },
                },
            )
        ],
    )
    path = tmp_path / "report.json"
    path.write_text(report.model_dump_json(), encoding="utf-8")

    assert _run_compare_reports([path]) == 0

    out = capsys.readouterr().out
    assert "Eval report comparison" in out
    assert "s1-compare-fixture" in out
    assert "99.9" in out
    assert "gen_cps" in out
    assert "135.9" in out
    assert "gsys" in out
    assert "guser" in out
    assert "39931" in out
    assert "6579" in out
    assert "22000" in out
    assert "13579" in out
    assert "jsys" in out
    assert "juser" in out
    assert "jplan" in out
    assert "jorig" in out
    assert "21000" in out
    assert "11000" in out
    assert "judge_ver" in out
    assert "judge_n" in out
    assert "unstable" in out
    assert "warn_rules" in out
    assert "warn_counts" in out
    assert "long_run_distance_share" in out
    assert "long_run_distance_share=2,milestone_week_consistency=1" in out
    assert "retry_rules" in out
    assert "i1:weekly_volume_ramp(error),milestone_week_consistency(warning)" in out
    assert "judge_retry" in out
    assert "2" in out
    assert "s1-vtest" in out
    assert "goal_realism,volume_progression" in out
    assert "schema_validity" in out


def test_compare_reports_prints_infra_error_rows(capsys, tmp_path):
    from scripts.eval_coach import _run_compare_reports

    report = EvalReport(
        run_id="run-infra-compare",
        git_sha="abc123",
        scope="s1",
        mode="frozen_fixture",
        judge_prompt_version="s1-vtest",
        fixtures_total=1,
        fixtures_passed=0,
        fixtures_marginal=0,
        fixtures_failed=1,
        per_fixture=[
            FixtureRunOutcome(
                fixture_id="s1-capacity-fixture",
                scope="s1",
                l1_passed=False,
                error="generation_failed: LLMError: Error code: 429 - no_capacity",
            )
        ],
    )
    path = tmp_path / "infra.json"
    path.write_text(report.model_dump_json(), encoding="utf-8")

    assert _run_compare_reports([path]) == 0

    out = capsys.readouterr().out
    assert "infra" in out
    assert "error" in out
    assert "llm_transient" in out
    assert "generation_failed: LLMError" in out


def test_compare_reports_warns_when_judge_versions_are_mixed(capsys, tmp_path):
    from scripts.eval_coach import _run_compare_reports

    def write_report(name: str, judge_version: str) -> object:
        path = tmp_path / f"{name}.json"
        path.write_text(
            json.dumps(
                {
                    "run_id": name,
                    "git_sha": "abc123",
                    "scope": "s1",
                    "mode": "frozen_fixture",
                    "judge_prompt_version": judge_version,
                    "fixtures_total": 1,
                    "fixtures_passed": 1,
                    "fixtures_marginal": 0,
                    "fixtures_failed": 0,
                    "per_fixture": [
                        {
                            "fixture_id": "s1-compare-fixture",
                            "scope": "s1",
                            "l1_passed": True,
                            "timings": {"generator_total_s": 1.0},
                            "judge_score": {
                                "fixture_id": "s1-compare-fixture",
                                "scope": "s1",
                                "axes": [
                                    {
                                        "axis": "schema_validity",
                                        "score": 5,
                                        "rationale": "ok",
                                        "matches_expected": True,
                                    }
                                ],
                                "overall_verdict": "pass",
                                "overall_rationale": "ok",
                                "judge_model": "fake",
                                "judge_prompt_version": judge_version,
                            },
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        return path

    assert _run_compare_reports([
        write_report("run-v1", "s1-v1"),
        write_report("run-v2", "s1-v2"),
    ]) == 0

    out = capsys.readouterr().out
    assert "Warning: mixed judge_prompt_version values" in out
    assert "s1-v1" in out
    assert "s1-v2" in out
    assert "not directly comparable" in out


def test_summarize_speed_groups_fresh_runs_and_replays(capsys, tmp_path):
    from scripts.eval_coach import _run_summarize_speed

    def payload(name: str, *, gen_s: float, raw: int, score: int = 5, replay: bool = False) -> dict:
        timings = {
            "generator_total_s": gen_s,
            "generator_system_prompt_chars": 30000,
            "generator_user_prompt_chars": 5000,
            "generator_raw_response_chars": raw,
            "judge_retries": 1 if replay else 0,
        }
        if replay:
            timings["artifact_source_report"] = ".omc/eval/reports/source.json"
        return {
            "run_id": name,
            "git_sha": "abc123",
            "scope": "s1",
            "mode": "frozen_fixture",
            "judge_prompt_version": "s1-vtest",
            "fixtures_total": 1,
            "fixtures_passed": 1,
            "fixtures_marginal": 0,
            "fixtures_failed": 0,
            "per_axis_avg": {"schema_validity": float(score)},
            "per_fixture": [
                {
                    "fixture_id": "s1-speed-fixture",
                    "scope": "s1",
                    "l1_passed": True,
                    "generation_iterations": 1,
                    "timings": timings,
                    "judge_score": {
                        "fixture_id": "s1-speed-fixture",
                        "scope": "s1",
                        "axes": [
                            {
                                "axis": "schema_validity",
                                "score": score,
                                "rationale": "ok",
                                "matches_expected": True,
                            }
                        ],
                        "overall_verdict": "pass",
                        "overall_rationale": "ok",
                        "judge_model": "fake",
                        "judge_prompt_version": "s1-vtest",
                    },
                }
            ],
        }

    baseline = tmp_path / "baseline.json"
    baseline.write_text(
        json.dumps(payload("baseline", gen_s=80.0, raw=9600, score=5)),
        encoding="utf-8",
    )

    paths = []
    for name, report in [
        ("fast", payload("fast", gen_s=100.0, raw=10000, score=5)),
        ("slow", payload("slow", gen_s=260.0, raw=11000, score=4)),
        ("replay", payload("replay", gen_s=260.0, raw=11000, score=5, replay=True)),
    ]:
        path = tmp_path / f"{name}.json"
        path.write_text(json.dumps(report), encoding="utf-8")
        paths.append(path)

    assert _run_summarize_speed(paths, baseline_path=baseline) == 0

    out = capsys.readouterr().out
    assert "Eval speed summary" in out
    assert "s1-speed-fixture" in out
    assert "reports" in out
    assert "fresh" in out
    assert "replay" in out
    assert "pass:3" in out
    assert "4-5" in out
    assert "100.0-260.0s med=180.0s" in out
    assert "160.0" in out
    assert "42.3-100.0ch/s med=71.2ch/s" in out
    assert "10000.0-11000.0ch med=10500.0ch" in out
    assert "base_gen" in out
    assert "80.0" in out
    assert "260.0s (+180.0s/+225.0%)" in out
    assert "120.0ch/s" in out
    assert "42.3ch/s (-77.7ch/s/-64.7%)" in out
    assert "speed_cause" in out
    assert "throughput_drop" in out
    assert "fast:s1-speed-fixture" in out
    assert "slow:s1-speed-fixture" in out


def _gate_report_payload(
    *,
    fixture_id: str = "s1-gate-fixture",
    verdict: str = "pass",
    score: int = 5,
    generator_total_s: float = 100.0,
    generator_system_prompt_chars: int | None = None,
    generator_user_prompt_chars: int | None = None,
    generator_raw_response_chars: int | None = None,
    judge_retries: int | None = None,
    generation_iterations: int = 1,
    rule_filter_history: list[dict] | None = None,
    l1_warning_rules: list[str] | None = None,
    fixtures_failed: int = 0,
    judge_prompt_version: str = "s1-vtest",
) -> dict:
    timings = {"generator_total_s": generator_total_s}
    if rule_filter_history is not None:
        timings["rule_filter_history"] = rule_filter_history
    if generator_system_prompt_chars is not None:
        timings["generator_system_prompt_chars"] = generator_system_prompt_chars
    if generator_user_prompt_chars is not None:
        timings["generator_user_prompt_chars"] = generator_user_prompt_chars
    if generator_raw_response_chars is not None:
        timings["generator_raw_response_chars"] = generator_raw_response_chars
    if judge_retries is not None:
        timings["judge_retries"] = judge_retries
    return {
        "run_id": "run-gate",
        "git_sha": "abc123",
        "scope": "s1",
        "mode": "frozen_fixture",
        "judge_prompt_version": judge_prompt_version,
        "fixtures_total": 1,
        "fixtures_passed": 1 if verdict == "pass" and fixtures_failed == 0 else 0,
        "fixtures_marginal": 0,
        "fixtures_failed": fixtures_failed,
        "per_axis_avg": {"schema_validity": float(score)},
        "per_fixture": [
            {
                "fixture_id": fixture_id,
                "scope": "s1",
                "l1_passed": verdict == "pass",
                "l1_violations": [
                    {"rule": rule, "severity": "warning", "message": rule}
                    for rule in (l1_warning_rules or [])
                ],
                "generation_iterations": generation_iterations,
                "timings": timings,
                "judge_score": {
                    "fixture_id": fixture_id,
                    "scope": "s1",
                    "axes": [
                        {
                            "axis": "schema_validity",
                            "score": score,
                            "rationale": "ok",
                            "matches_expected": score >= 5,
                        }
                    ],
                    "overall_verdict": verdict,
                    "overall_rationale": "ok",
                    "judge_model": "fake",
                    "judge_prompt_version": judge_prompt_version,
                },
            }
        ],
    }


def _write_gate_report(tmp_path, name: str, payload: dict) -> object:
    path = tmp_path / f"{name}.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def test_gate_report_passes_identical_report(capsys, tmp_path):
    from scripts.eval_coach import _run_gate_report

    baseline = _write_gate_report(tmp_path, "baseline", _gate_report_payload())
    candidate = _write_gate_report(tmp_path, "candidate", _gate_report_payload())

    assert _run_gate_report(candidate_path=candidate, baseline_path=baseline) == 0

    out = capsys.readouterr().out
    assert "Eval baseline gate" in out
    assert "Gate: PASS" in out


def test_gate_report_fails_axis_drop(capsys, tmp_path):
    from scripts.eval_coach import _run_gate_report

    baseline = _write_gate_report(tmp_path, "baseline", _gate_report_payload(score=5))
    candidate = _write_gate_report(tmp_path, "candidate", _gate_report_payload(score=4))

    assert _run_gate_report(candidate_path=candidate, baseline_path=baseline) == 1

    out = capsys.readouterr().out
    assert "axis average drop schema_validity" in out
    assert "axis schema_validity dropped" in out
    assert "Gate: FAIL" in out


def test_gate_report_allows_partial_targeted_diagnostics(capsys, tmp_path):
    from scripts.eval_coach import _run_gate_report

    baseline_payload = _gate_report_payload()
    extra = _gate_report_payload(fixture_id="s1-extra-fixture")["per_fixture"][0]
    baseline_payload["per_fixture"].append(extra)
    baseline_payload["fixtures_total"] = 2
    baseline_payload["fixtures_passed"] = 2
    baseline = _write_gate_report(tmp_path, "baseline", baseline_payload)
    candidate = _write_gate_report(tmp_path, "candidate", _gate_report_payload())

    assert _run_gate_report(candidate_path=candidate, baseline_path=baseline) == 1
    default_out = capsys.readouterr().out
    assert "candidate missing baseline fixture(s): s1-extra-fixture" in default_out
    assert "Gate: FAIL" in default_out

    assert _run_gate_report(
        candidate_path=candidate,
        baseline_path=baseline,
        allow_partial_gate=True,
    ) == 0
    partial_out = capsys.readouterr().out
    assert "candidate missing baseline fixture(s): s1-extra-fixture" in partial_out
    assert "partial gate: suite-level per_axis_avg gate skipped" in partial_out
    assert "partial gate: suite-level generator_total_s gate skipped" in partial_out
    assert "Gate: PASS" in partial_out


def test_gate_report_fails_generation_speed_regression(capsys, tmp_path):
    from scripts.eval_coach import _run_gate_report

    baseline = _write_gate_report(
        tmp_path,
        "baseline",
        _gate_report_payload(
            generator_total_s=100.0,
            generator_system_prompt_chars=30000,
            generator_user_prompt_chars=5000,
            generator_raw_response_chars=10000,
            generation_iterations=1,
        ),
    )
    candidate = _write_gate_report(
        tmp_path,
        "candidate",
        _gate_report_payload(
            generator_total_s=260.0,
            generator_system_prompt_chars=31000,
            generator_user_prompt_chars=5200,
            generator_raw_response_chars=11000,
            judge_retries=2,
            generation_iterations=1,
        ),
    )

    assert _run_gate_report(
        candidate_path=candidate,
        baseline_path=baseline,
        max_suite_gen_slowdown_pct=25.0,
        min_suite_gen_slowdown_s=60.0,
        max_fixture_gen_slowdown_pct=50.0,
        min_fixture_gen_slowdown_s=120.0,
    ) == 1

    out = capsys.readouterr().out
    assert "generator_total_s slowed 160.0s" in out
    assert "speed_context=" in out
    assert "iter=1->1" in out
    assert "judge_retries=2" in out
    assert "prompt=35000->36200ch" in out
    assert "raw=10000->11000ch" in out
    assert "gen_cps=100.0->42.3ch/s" in out
    assert "speed_cause=throughput_drop" in out
    assert "suite generator_total_s slowed 160.0s" in out
    assert "top_contributors=s1-gate-fixture+160.0s" in out


def test_gate_report_speed_context_classifies_throughput_drop(capsys, tmp_path):
    from scripts.eval_coach import _run_gate_report

    baseline = _write_gate_report(
        tmp_path,
        "baseline",
        _gate_report_payload(
            generator_total_s=100.0,
            generator_system_prompt_chars=30000,
            generator_user_prompt_chars=5000,
            generator_raw_response_chars=10000,
            generation_iterations=1,
        ),
    )
    candidate = _write_gate_report(
        tmp_path,
        "candidate",
        _gate_report_payload(
            generator_total_s=260.0,
            generator_system_prompt_chars=30200,
            generator_user_prompt_chars=5100,
            generator_raw_response_chars=9800,
            generation_iterations=1,
        ),
    )

    assert _run_gate_report(
        candidate_path=candidate,
        baseline_path=baseline,
        max_fixture_gen_slowdown_pct=50.0,
        min_fixture_gen_slowdown_s=120.0,
        max_suite_gen_slowdown_pct=25.0,
        min_suite_gen_slowdown_s=60.0,
    ) == 1

    out = capsys.readouterr().out
    assert "speed_context=" in out
    assert "gen_cps=100.0->37.7ch/s" in out
    assert "speed_cause=throughput_drop" in out


def test_gate_report_final_l1_warning_is_not_retry_cause(capsys, tmp_path):
    from scripts.eval_coach import _run_gate_report

    baseline = _write_gate_report(
        tmp_path,
        "baseline",
        _gate_report_payload(
            generator_total_s=100.0,
            generator_raw_response_chars=10000,
            generation_iterations=1,
        ),
    )
    candidate = _write_gate_report(
        tmp_path,
        "candidate",
        _gate_report_payload(
            generator_total_s=260.0,
            generator_raw_response_chars=9800,
            generation_iterations=1,
            rule_filter_history=[
                {
                    "iteration": 1,
                    "violations": [
                        {"rule": "long_run_distance_share", "severity": "warning"},
                    ],
                },
            ],
        ),
    )

    assert _run_gate_report(
        candidate_path=candidate,
        baseline_path=baseline,
        max_fixture_gen_slowdown_pct=50.0,
        min_fixture_gen_slowdown_s=120.0,
        max_suite_gen_slowdown_pct=25.0,
        min_suite_gen_slowdown_s=60.0,
    ) == 1

    out = capsys.readouterr().out
    assert "speed_cause=throughput_drop" in out
    assert "rule_retry" not in out


def test_gate_report_returns_unavailable_for_transient_llm_candidate(capsys, tmp_path):
    from scripts.eval_coach import EXIT_LLM_UNAVAILABLE, _run_gate_report

    baseline = _write_gate_report(tmp_path, "baseline", _gate_report_payload())
    candidate_payload = _gate_report_payload(
        verdict="pass",
        fixtures_failed=1,
    )
    candidate_payload["fixtures_passed"] = 0
    candidate_payload["per_axis_avg"] = {}
    candidate_payload["per_fixture"][0]["l1_passed"] = False
    candidate_payload["per_fixture"][0]["judge_score"] = None
    candidate_payload["per_fixture"][0]["error"] = (
        "generation_failed: LLMError: Error code: 429 - no_capacity"
    )
    candidate = _write_gate_report(tmp_path, "candidate", candidate_payload)

    assert _run_gate_report(candidate_path=candidate, baseline_path=baseline) == EXIT_LLM_UNAVAILABLE

    out = capsys.readouterr().out
    assert "INFRA FAILURE" in out
    assert "s1-gate-fixture" in out
    assert "Gate: INFRA_UNAVAILABLE" in out


def test_gate_report_speed_context_includes_retry_rules(capsys, tmp_path):
    from scripts.eval_coach import _run_gate_report

    baseline = _write_gate_report(
        tmp_path,
        "baseline",
        _gate_report_payload(generator_total_s=100.0, generation_iterations=1),
    )
    candidate = _write_gate_report(
        tmp_path,
        "candidate",
        _gate_report_payload(
            generator_total_s=260.0,
            generation_iterations=2,
            rule_filter_history=[
                {
                    "iteration": 1,
                    "violations": [
                        {"rule": "hard_session_spacing", "severity": "error"},
                    ],
                },
                {"iteration": 2, "violations": []},
            ],
        ),
    )

    assert _run_gate_report(
        candidate_path=candidate,
        baseline_path=baseline,
        max_fixture_gen_slowdown_pct=50.0,
        min_fixture_gen_slowdown_s=120.0,
        max_suite_gen_slowdown_pct=25.0,
        min_suite_gen_slowdown_s=60.0,
    ) == 1

    out = capsys.readouterr().out
    assert "speed_context=" in out
    assert "iter=1->2" in out
    assert "retry_rules=i1:hard_session_spacing(error)" in out


def test_gate_report_fails_generator_prompt_growth(capsys, tmp_path):
    from scripts.eval_coach import _run_gate_report

    baseline = _write_gate_report(
        tmp_path,
        "baseline",
        _gate_report_payload(
            generator_system_prompt_chars=30000,
            generator_user_prompt_chars=5000,
        ),
    )
    candidate = _write_gate_report(
        tmp_path,
        "candidate",
        _gate_report_payload(
            generator_system_prompt_chars=45000,
            generator_user_prompt_chars=7000,
        ),
    )

    assert _run_gate_report(
        candidate_path=candidate,
        baseline_path=baseline,
        max_fixture_gen_prompt_growth_pct=30.0,
        min_fixture_gen_prompt_growth_chars=12000.0,
    ) == 1

    out = capsys.readouterr().out
    assert "generator prompt chars grew 17000ch" in out
    assert "48.6%" in out
    assert "baseline=35000ch" in out
    assert "candidate=52000ch" in out
    assert "Gate: FAIL" in out


def test_gate_report_fails_new_l1_warning_rule(capsys, tmp_path):
    from scripts.eval_coach import _run_gate_report

    baseline = _write_gate_report(
        tmp_path,
        "baseline",
        _gate_report_payload(l1_warning_rules=["long_run_distance_share"]),
    )
    candidate = _write_gate_report(
        tmp_path,
        "candidate",
        _gate_report_payload(
            l1_warning_rules=["long_run_distance_share", "milestone_week_consistency"]
        ),
    )

    assert _run_gate_report(candidate_path=candidate, baseline_path=baseline) == 1

    out = capsys.readouterr().out
    assert "new final L1 warning rule(s): milestone_week_consistency" in out
    assert "Gate: FAIL" in out


def test_gate_report_fails_l1_warning_count_growth(capsys, tmp_path):
    from scripts.eval_coach import _run_gate_report

    baseline = _write_gate_report(
        tmp_path,
        "baseline",
        _gate_report_payload(l1_warning_rules=["long_run_distance_share"]),
    )
    candidate = _write_gate_report(
        tmp_path,
        "candidate",
        _gate_report_payload(
            l1_warning_rules=["long_run_distance_share", "long_run_distance_share"]
        ),
    )

    assert _run_gate_report(
        candidate_path=candidate,
        baseline_path=baseline,
        max_fixture_l1_warning_increase=0,
    ) == 1

    out = capsys.readouterr().out
    assert "final L1 warnings increased from 1 to 2" in out
    assert "rules=long_run_distance_share" in out
    assert "new final L1 warning rule" not in out
    assert "Gate: FAIL" in out


def test_gate_report_allows_warning_count_growth_by_default(capsys, tmp_path):
    from scripts.eval_coach import _run_gate_report

    baseline = _write_gate_report(
        tmp_path,
        "baseline",
        _gate_report_payload(l1_warning_rules=["long_run_distance_share"]),
    )
    candidate = _write_gate_report(
        tmp_path,
        "candidate",
        _gate_report_payload(
            l1_warning_rules=["long_run_distance_share", "long_run_distance_share"]
        ),
    )

    assert _run_gate_report(candidate_path=candidate, baseline_path=baseline) == 0

    out = capsys.readouterr().out
    assert "final L1 warnings increased" not in out
    assert "Gate: PASS" in out


def test_gate_report_fails_iteration_increase(capsys, tmp_path):
    from scripts.eval_coach import _run_gate_report

    baseline = _write_gate_report(
        tmp_path,
        "baseline",
        _gate_report_payload(generation_iterations=1),
    )
    candidate = _write_gate_report(
        tmp_path,
        "candidate",
        _gate_report_payload(
            generation_iterations=2,
            rule_filter_history=[
                {
                    "iteration": 1,
                    "violations": [
                        {"rule": "weekly_volume_ramp", "severity": "error"},
                        {"rule": "milestone_week_consistency", "severity": "warning"},
                    ],
                },
                {"iteration": 2, "violations": []},
            ],
        ),
    )

    assert _run_gate_report(candidate_path=candidate, baseline_path=baseline) == 1

    out = capsys.readouterr().out
    assert "generation_iterations increased from 1 to 2" in out
    assert "retry_rules=i1:weekly_volume_ramp(error),milestone_week_consistency(warning)" in out
