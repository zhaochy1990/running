from __future__ import annotations

import json
import pytest

from scripts.repair_eval_report_judges import RepairError, repair_report


def _judge_score(fixture_id: str, verdict: str = "pass") -> dict:
    return {
        "fixture_id": fixture_id,
        "scope": "s1",
        "axes": [
            {
                "axis": "schema_validity",
                "score": 5,
                "rationale": "ok",
                "matches_expected": True,
            }
        ],
        "overall_verdict": verdict,
        "overall_rationale": "ok",
        "judge_model": "fake",
        "judge_prompt_version": "s1-vtest",
    }


def _write(path, payload: dict):
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def _report(per_fixture: list[dict]) -> dict:
    passed = sum(
        1
        for outcome in per_fixture
        if outcome.get("l1_passed")
        and (outcome.get("judge_score") or {}).get("overall_verdict") == "pass"
    )
    failed = len(per_fixture) - passed
    return {
        "run_id": "base-run",
        "git_sha": "abc123",
        "scope": "s1",
        "mode": "frozen_fixture",
        "judge_prompt_version": "s1-vtest",
        "fixtures_total": len(per_fixture),
        "fixtures_passed": passed,
        "fixtures_marginal": 0,
        "fixtures_failed": failed,
        "per_axis_avg": {},
        "per_fixture": per_fixture,
    }


def test_repair_report_replaces_only_judge_fields(tmp_path):
    base = _write(
        tmp_path / "base.json",
        _report(
            [
                {
                    "fixture_id": "s1-a",
                    "scope": "s1",
                    "l1_passed": True,
                    "generated_artifact": {"plan_id": "a"},
                    "generation_iterations": 1,
                    "timings": {"generator_total_s": 10.0, "generation_total_s": 11.0},
                    "error": "judge_failed: RateLimitError: no_capacity",
                },
                {
                    "fixture_id": "s1-b",
                    "scope": "s1",
                    "l1_passed": True,
                    "generated_artifact": {"plan_id": "b"},
                    "generation_iterations": 1,
                    "timings": {
                        "generator_total_s": 20.0,
                        "generation_total_s": 21.0,
                        "judge_s": 2.0,
                        "total_s": 23.0,
                    },
                    "judge_score": _judge_score("s1-b"),
                },
            ]
        ),
    )
    judge_report = _write(
        tmp_path / "judge-a.json",
        _report(
            [
                {
                    "fixture_id": "s1-a",
                    "scope": "s1",
                    "l1_passed": True,
                    "generated_artifact": {"plan_id": "a"},
                    "timings": {
                        "rule_filter_s": [0.01],
                        "judge_s": 3.0,
                        "judge_attempt_s": [1.0, 2.0],
                        "judge_retries": 1,
                    },
                    "judge_score": _judge_score("s1-a"),
                }
            ]
        ),
    )

    repaired = repair_report(base, [judge_report])

    assert repaired.fixtures_passed == 2
    assert repaired.fixtures_failed == 0
    outcome = repaired.per_fixture[0]
    assert outcome.fixture_id == "s1-a"
    assert outcome.generated_artifact == {"plan_id": "a"}
    assert outcome.generation_iterations == 1
    assert outcome.error is None
    assert outcome.judge_score is not None
    assert outcome.timings["generator_total_s"] == 10.0
    assert outcome.timings["generation_total_s"] == 11.0
    assert outcome.timings["judge_s"] == 3.0
    assert outcome.timings["judge_retries"] == 1
    assert outcome.timings["total_s"] == 14.0
    assert repaired.per_axis_avg == {"schema_validity": 5.0}


def test_repair_report_replaces_full_fixture_outcome(tmp_path):
    base = _write(
        tmp_path / "base.json",
        _report(
            [
                {
                    "fixture_id": "s1-a",
                    "scope": "s1",
                    "l1_passed": True,
                    "generated_artifact": {"plan_id": "old"},
                    "generation_iterations": 1,
                    "timings": {"generator_total_s": 10.0},
                    "judge_score": _judge_score("s1-a", verdict="fail"),
                },
                {
                    "fixture_id": "s1-b",
                    "scope": "s1",
                    "l1_passed": True,
                    "generated_artifact": {"plan_id": "b"},
                    "generation_iterations": 1,
                    "timings": {"generator_total_s": 20.0},
                    "judge_score": _judge_score("s1-b"),
                },
            ]
        ),
    )
    replacement = _write(
        tmp_path / "replacement-a.json",
        _report(
            [
                {
                    "fixture_id": "s1-a",
                    "scope": "s1",
                    "l1_passed": True,
                    "generated_artifact": {"plan_id": "new"},
                    "generation_iterations": 2,
                    "timings": {
                        "generator_total_s": 30.0,
                        "generation_total_s": 31.0,
                        "judge_s": 4.0,
                        "total_s": 35.0,
                    },
                    "judge_score": _judge_score("s1-a"),
                }
            ]
        ),
    )

    repaired = repair_report(base, [], replacement_reports=[replacement])

    assert repaired.fixtures_passed == 2
    assert repaired.fixtures_failed == 0
    outcome = repaired.per_fixture[0]
    assert outcome.fixture_id == "s1-a"
    assert outcome.generated_artifact == {"plan_id": "new"}
    assert outcome.generation_iterations == 2
    assert outcome.timings["total_s"] == 35.0
    assert outcome.judge_score is not None
    assert outcome.judge_score.overall_verdict == "pass"


def test_repair_report_rejects_replay_as_full_replacement(tmp_path):
    base = _write(
        tmp_path / "base.json",
        _report(
            [
                {
                    "fixture_id": "s1-a",
                    "scope": "s1",
                    "l1_passed": True,
                    "generated_artifact": {"plan_id": "old"},
                    "generation_iterations": 1,
                    "timings": {"generator_total_s": 10.0},
                    "judge_score": _judge_score("s1-a", verdict="fail"),
                }
            ]
        ),
    )
    replay = _write(
        tmp_path / "replay-a.json",
        _report(
            [
                {
                    "fixture_id": "s1-a",
                    "scope": "s1",
                    "l1_passed": True,
                    "generated_artifact": {"plan_id": "old"},
                    "generation_iterations": 1,
                    "timings": {
                        "generator_total_s": 10.0,
                        "artifact_source_report": ".omc/eval/reports/source.json",
                    },
                    "judge_score": _judge_score("s1-a"),
                }
            ]
        ),
    )

    with pytest.raises(RepairError, match="not a full generation result"):
        repair_report(base, [], replacement_reports=[replay])
