"""S1 master_chat eval harness and frozen-fixture contracts."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from langchain_core.messages import AIMessage

from coach_eval.runner import load_fixtures, run_s1_conversation_evaluation
from coach_eval.s1_conversation import _contract_violations


FIXTURE_DIR = (
    Path(__file__).resolve().parents[1]
    / "fixtures"
    / "coach_eval"
    / "s1_conversation"
)

S1_CONVERSATION_INPUT_SHA256 = {
    "s1c-aggressive-range-unreasonable": "9d54fc2cb89baa5263b3e8e0bf08f792807ebb3fb6f602b16266c7376d0aebcc",
    "s1c-exact-range-reasonable": "638adf9fdc4fa4af9884583fb04d97739707ae31bb90ec5e287cb3a4ac092215",
    "s1c-focus-change-reasonable": "5c05ba87262e5e03c38de4f79bfb802cc1086f7af4801168b97fe277f4ea78a7",
    "s1c-race-postponed-atomic": "ae2c9d7a12347e44fd15e7a684b827627a55db1263759ce572c78e229d305303",
    "s1c-target-time-reasonable-atomic": "6e016c9222f18450e9d7eda42fbc8a94939c8168339aabd6c69c1f1fc542939e",
    "s1c-vague-adjustment-clarify": "a9c4467eb8c4ce6458ab418a8870f99e8ae7d851cdfc0773909ddb137fd05d9d",
}


class _NeverCalledLLM:
    def bind_tools(self, _tools, **_kwargs):
        return self

    def invoke(self, _messages):
        raise AssertionError("vague fixture must clarify before invoking the LLM")


class _ScriptedLLM:
    def __init__(self, responses: list[AIMessage]) -> None:
        self._responses = list(responses)

    def bind_tools(self, _tools, **_kwargs):
        return self

    def invoke(self, _messages):
        if not self._responses:
            raise AssertionError("scripted LLM ran out of responses")
        return self._responses.pop(0)


def _tool_calls(sequence: int, *calls: tuple[str, dict]) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[
            {
                "name": name,
                "args": args,
                "id": f"call-{sequence}-{index}",
                "type": "tool_call",
            }
            for index, (name, args) in enumerate(calls)
        ],
    )


def _required_read_calls() -> AIMessage:
    return _tool_calls(
        1,
        ("get_master_plan_current", {}),
        ("get_health_snapshot", {}),
        ("get_pmc_series", {"days": 42}),
        ("estimate_master_plan_load", {}),
    )


def _target_time_read_calls() -> AIMessage:
    return _tool_calls(
        1,
        ("get_master_plan_current", {}),
        ("get_health_snapshot", {}),
        ("get_pmc_series", {"days": 42}),
        ("estimate_master_plan_load", {}),
        ("get_race_predictions", {}),
        ("get_pbs", {}),
    )


def _input_hash(fixture: dict) -> str:
    canonical = json.dumps(
        fixture["input"],
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def test_s1_conversation_fixture_inputs_are_frozen() -> None:
    fixtures = load_fixtures("s1_conversation")
    assert [fixture["fixture_id"] for fixture in fixtures] == sorted(
        S1_CONVERSATION_INPUT_SHA256
    )
    for fixture in fixtures:
        fixture_id = fixture["fixture_id"]
        assert fixture["evaluation_path"] == "master_chat"
        assert _input_hash(fixture) == S1_CONVERSATION_INPUT_SHA256[fixture_id]


def test_vague_adjustment_fixture_passes_without_llm_or_tools() -> None:
    report = run_s1_conversation_evaluation(
        fixture_ids=["s1c-vague-adjustment-clarify"], llm=_NeverCalledLLM()
    )

    assert report.fixtures_passed == 1
    outcome = report.per_fixture[0]
    assert outcome.generated_artifact["tool_trace"] == []
    result = outcome.generated_artifact["result"]
    assert result["status"] == "needs_clarification"
    assert result["proposals"] == []


def test_contract_reports_wrong_exact_range() -> None:
    artifact = {
        "result": {"status": "completed", "clarification": None, "proposals": [{"ops": [{"op": "replace_weekly_range", "phase_id": "phase-base", "new_value": {"weekly_distance_km_low": 60.0, "weekly_distance_km_high": 70.0}}]}]},
        "tool_trace": [],
        "assessment": {},
    }
    expected = {
        "status": "completed",
        "clarification_required": False,
        "proposal_count": 1,
        "proposal": {
            "op": "replace_weekly_range",
            "phase_id": "phase-base",
            "new_value": {
                "weekly_distance_km_low": 65.0,
                "weekly_distance_km_high": 75.0,
            },
        },
    }

    violations = _contract_violations(artifact, expected)

    assert any("weekly_distance_km_low" in item for item in violations)
    assert any("weekly_distance_km_high" in item for item in violations)


def test_exact_range_fixture_passes_scripted_production_graph() -> None:
    request = "把基础期周跑量从 70–80 公里调整到 65–75 公里"
    llm = _ScriptedLLM(
        [
            _required_read_calls(),
            _tool_calls(
                2,
                (
                    "assess_master_adjustment",
                    {
                        "adjustment_request": request,
                        "verdict": "reasonable",
                        "rationale": "frozen evidence supports a modest reduction",
                    },
                ),
            ),
            _tool_calls(
                3,
                (
                    "set_phase_weekly_range",
                    {
                        "plan_id": "s1c-plan-001",
                        "phase_id": "phase-base",
                        "weekly_distance_km_low": 65,
                        "weekly_distance_km_high": 75,
                        "reason": "modest supported reduction",
                    },
                ),
            ),
        ]
    )

    report = run_s1_conversation_evaluation(
        fixture_ids=["s1c-exact-range-reasonable"], llm=llm
    )

    assert report.fixtures_passed == 1
    outcome = report.per_fixture[0]
    assert outcome.debug["contract_violations"] == []
    assert [item["name"] for item in outcome.generated_artifact["tool_trace"]] == [
        "get_master_plan_current",
        "get_health_snapshot",
        "get_pmc_series",
        "estimate_master_plan_load",
        "assess_master_adjustment",
        "set_phase_weekly_range",
    ]


def test_postponed_race_fixture_passes_as_one_atomic_diff() -> None:
    request = "目标马拉松官方延期到 2026-11-08，请把 Master Plan 一起顺延"
    llm = _ScriptedLLM(
        [
            _required_read_calls(),
            _tool_calls(
                2,
                (
                    "assess_master_adjustment",
                    {
                        "adjustment_request": request,
                        "verdict": "reasonable",
                        "rationale": "official postponement is consistent with a two-week season shift",
                    },
                ),
            ),
            _tool_calls(
                3,
                (
                    "reschedule_target_race",
                    {
                        "plan_id": "s1c-plan-001",
                        "milestone_id": "race-001",
                        "new_date": "2026-11-08",
                        "reason": "比赛官方延期两周",
                    },
                ),
            ),
        ]
    )

    report = run_s1_conversation_evaluation(
        fixture_ids=["s1c-race-postponed-atomic"], llm=llm
    )

    assert report.fixtures_passed == 1
    outcome = report.per_fixture[0]
    assert outcome.debug["contract_violations"] == []
    proposal = outcome.generated_artifact["result"]["proposals"][0]
    assert len(proposal["ops"]) == 1
    assert proposal["ops"][0]["op"] == "reschedule_target_race"
    assert [item["name"] for item in outcome.generated_artifact["tool_trace"]] == [
        "get_master_plan_current",
        "get_health_snapshot",
        "get_pmc_series",
        "estimate_master_plan_load",
        "assess_master_adjustment",
        "reschedule_target_race",
    ]


def test_phase_focus_fixture_preserves_exact_user_direction() -> None:
    request = "专项期更侧重马拉松配速耐力与补给演练"
    llm = _ScriptedLLM(
        [
            _required_read_calls(),
            _tool_calls(
                2,
                (
                    "assess_master_adjustment",
                    {
                        "adjustment_request": request,
                        "verdict": "reasonable",
                        "rationale": "stable load supports a more race-specific build focus",
                    },
                ),
            ),
            _tool_calls(
                3,
                (
                    "set_phase_focus",
                    {
                        "plan_id": "s1c-plan-001",
                        "phase_id": "phase-build",
                        "focus": "马拉松配速耐力与补给演练",
                        "reason": "用户明确要求，当前负荷与恢复支持",
                    },
                ),
            ),
        ]
    )

    report = run_s1_conversation_evaluation(
        fixture_ids=["s1c-focus-change-reasonable"], llm=llm
    )

    assert report.fixtures_passed == 1
    outcome = report.per_fixture[0]
    assert outcome.debug["contract_violations"] == []
    proposal = outcome.generated_artifact["result"]["proposals"][0]
    assert proposal["ops"][0]["op"] == "replace_phase_focus"
    assert proposal["ops"][0]["spec_patch"] == {
        "focus": "马拉松配速耐力与补给演练"
    }


def test_target_time_fixture_reads_realism_evidence_and_emits_atomic_diff() -> None:
    request = "把目标马拉松完赛成绩从 3:15:00 调整到 3:10:00"
    llm = _ScriptedLLM(
        [
            _target_time_read_calls(),
            _tool_calls(
                2,
                (
                    "assess_master_adjustment",
                    {
                        "adjustment_request": request,
                        "verdict": "reasonable",
                        "rationale": "3:09:30 prediction and 3:13 PB support 3:10",
                    },
                ),
            ),
            _tool_calls(
                3,
                (
                    "update_target_race_time",
                    {
                        "plan_id": "s1c-plan-001",
                        "milestone_id": "race-001",
                        "new_target_time": "3:10:00",
                        "reason": "prediction and PB support the modest improvement",
                    },
                ),
            ),
        ]
    )

    report = run_s1_conversation_evaluation(
        fixture_ids=["s1c-target-time-reasonable-atomic"], llm=llm
    )

    assert report.fixtures_passed == 1
    outcome = report.per_fixture[0]
    assert outcome.debug["contract_violations"] == []
    proposal = outcome.generated_artifact["result"]["proposals"][0]
    assert proposal["ops"][0]["op"] == "update_target_race_time"
    assert [item["name"] for item in outcome.generated_artifact["tool_trace"]] == [
        "get_master_plan_current",
        "get_health_snapshot",
        "get_pmc_series",
        "estimate_master_plan_load",
        "get_race_predictions",
        "get_pbs",
        "assess_master_adjustment",
        "update_target_race_time",
    ]


def test_contract_fails_even_when_runtime_gate_blocks_premature_draft() -> None:
    artifact = {
        "result": {
            "status": "completed",
            "clarification": None,
            "proposals": [],
        },
        "tool_trace": [
            {
                "name": "set_phase_weekly_range",
                "outcome": "blocked",
                "reason": "proposal_gate",
            }
        ],
        "assessment": {},
    }

    violations = _contract_violations(
        artifact,
        {
            "status": "completed",
            "clarification_required": False,
            "proposal_count": 0,
        },
    )

    assert any("blocked tool attempt" in item for item in violations)
