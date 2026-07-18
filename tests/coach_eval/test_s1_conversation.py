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
    "s1c-focus-exact-text-reasonable": "0ec123355b3e44219945171168255203a6d2051dab4ff7f5f3de9a2154d02628",
    "s1c-focus-missing-phase-clarify": "622136741decfb9537fed00397d2026982c6c95c5f49909aac8a8d0d30ca1fb2",
    "s1c-focus-phase-followup-reasonable": "9bed8e3c399e0d0cdfb653a9f9c529b99d7f891d7afb2317f8d91fb614440e51",
    "s1c-increase-details-followup-reasonable": "d0ad8f40d3801fa119d688e8f834eebf9634b64b0dbdb066f129c013554bc90b",
    "s1c-increase-missing-details-clarify": "7f2864ebd73f9eed21177d26bdd7c0c959a9127d1e1807e8efe8e3e87292650e",
    "s1c-increase-percentage-missing-phase-clarify": "d8dab5b18209ee27fa0badcf76af6b5f4d8c5ac2f2480a6342e4df15fb393b69",
    "s1c-increase-percentage-phase-followup-reasonable": "dd6dc25b301716cb3721e8e2c0caf64c59f7cd5a6dc8290905521909feaa835f",
    "s1c-phase-compress-reasonable": "7da6a6783da20fc966cb9fc06ccd6a20adb66f61765861ba7593b50a396d1b93",
    "s1c-phase-extend-missing-weeks-clarify": "2d975ae386848310c2bdb4debedc43c3fa0d850114be69d87c38c595109afbbe",
    "s1c-phase-extend-reasonable": "7d230e696cad495a6e0c5a1f25f80f3fb20d8a7c1ad9d08728f111d64820c59c",
    "s1c-race-postponed-atomic": "ae2c9d7a12347e44fd15e7a684b827627a55db1263759ce572c78e229d305303",
    "s1c-target-time-reasonable-atomic": "6e016c9222f18450e9d7eda42fbc8a94939c8168339aabd6c69c1f1fc542939e",
    "s1c-vague-adjustment-clarify": "a9c4467eb8c4ce6458ab418a8870f99e8ae7d851cdfc0773909ddb137fd05d9d",
}


class _NeverCalledLLM:
    def bind_tools(self, _tools, **_kwargs):
        return self

    def invoke(self, _messages):
        raise AssertionError("clarification fixture must not invoke the LLM")


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


def test_missing_phase_fixture_clarifies_without_llm_or_tools() -> None:
    report = run_s1_conversation_evaluation(
        fixture_ids=["s1c-focus-missing-phase-clarify"], llm=_NeverCalledLLM()
    )

    assert report.fixtures_passed == 1
    outcome = report.per_fixture[0]
    assert outcome.generated_artifact["tool_trace"] == []
    result = outcome.generated_artifact["result"]
    assert result["status"] == "needs_clarification"
    assert "哪个阶段" in result["clarification"]
    assert result["proposals"] == []


def test_increase_missing_details_fixture_clarifies_without_llm_or_tools() -> None:
    report = run_s1_conversation_evaluation(
        fixture_ids=["s1c-increase-missing-details-clarify"],
        llm=_NeverCalledLLM(),
    )

    assert report.fixtures_passed == 1
    outcome = report.per_fixture[0]
    assert outcome.generated_artifact["tool_trace"] == []
    result = outcome.generated_artifact["result"]
    assert result["status"] == "needs_clarification"
    assert "调整哪个阶段" in result["clarification"]
    assert result["proposals"] == []


def test_percentage_increase_missing_phase_fixture_clarifies_without_llm_or_tools() -> None:
    report = run_s1_conversation_evaluation(
        fixture_ids=["s1c-increase-percentage-missing-phase-clarify"],
        llm=_NeverCalledLLM(),
    )

    assert report.fixtures_passed == 1
    outcome = report.per_fixture[0]
    assert outcome.generated_artifact["tool_trace"] == []
    result = outcome.generated_artifact["result"]
    assert result["status"] == "needs_clarification"
    assert "哪个阶段" in result["clarification"]
    assert result["proposals"] == []


def test_phase_extend_missing_weeks_clarifies_without_llm_or_tools() -> None:
    report = run_s1_conversation_evaluation(
        fixture_ids=["s1c-phase-extend-missing-weeks-clarify"],
        llm=_NeverCalledLLM(),
    )

    assert report.fixtures_passed == 1
    outcome = report.per_fixture[0]
    assert outcome.generated_artifact["tool_trace"] == []
    result = outcome.generated_artifact["result"]
    assert result["status"] == "needs_clarification"
    assert "几周" in result["clarification"]
    assert result["proposals"] == []


def test_conversation_atomic_fixtures_declare_expected_op_count() -> None:
    fixtures = load_fixtures("s1_conversation")

    missing = [
        fixture["fixture_id"]
        for fixture in fixtures
        if (fixture.get("expected") or {}).get("proposal")
        and not isinstance(
            ((fixture.get("expected") or {}).get("proposal") or {}).get("op_count"),
            int,
        )
    ]

    assert missing == []


def test_contract_reports_missing_expected_proposal() -> None:
    artifact = {
        "result": {"status": "completed", "clarification": None, "proposals": []},
        "tool_trace": [],
        "assessment": {},
    }
    expected = {
        "status": "completed",
        "clarification_required": False,
        "proposal": {
            "op": "replace_weekly_range",
            "phase_id": "phase-base",
        },
    }

    violations = _contract_violations(artifact, expected)

    assert any("expected proposal" in item for item in violations)


def test_contract_reports_extra_atomic_operations() -> None:
    artifact = {
        "result": {
            "status": "completed",
            "clarification": None,
            "proposals": [
                {
                    "ops": [
                        {"op": "reschedule_target_race", "milestone_id": "race-001"},
                        {"op": "shift_milestone", "milestone_id": "race-001"},
                    ]
                }
            ],
        },
        "tool_trace": [],
        "assessment": {},
    }
    expected = {
        "status": "completed",
        "clarification_required": False,
        "proposal": {
            "op_count": 1,
            "op": "reschedule_target_race",
            "milestone_id": "race-001",
        },
    }

    violations = _contract_violations(artifact, expected)

    assert any("proposal op_count expected 1, got 2" in item for item in violations)


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


def test_contract_reports_missing_assessment_and_explanation_evidence() -> None:
    artifact = {
        "result": {
            "status": "completed",
            "clarification": None,
            "proposals": [
                {
                    "ai_explanation": "修改训练重点",
                    "ops": [
                        {
                            "op": "replace_phase_focus",
                            "phase_id": "phase-base",
                            "old_value": {"focus": "错误旧值"},
                            "spec_patch": {"focus": "上坡力量"},
                        }
                    ],
                }
            ],
        },
        "tool_trace": [],
        "assessment": {"rationale": "负荷稳定"},
    }
    expected = {
        "assessment_rationale_contains": ["比赛爬升"],
        "proposal": {
            "old_value": {"focus": "有氧基础"},
            "ai_explanation_contains": ["比赛爬升"],
        },
    }

    violations = _contract_violations(artifact, expected)

    assert any("assessment rationale" in item for item in violations)
    assert any("old_value.focus" in item for item in violations)
    assert any("ai_explanation" in item for item in violations)


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
                        "adjustment_request": request,
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


def test_phase_extend_fixture_emits_one_atomic_boundary_shift() -> None:
    request = "把基础期延长两周"
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
                        "rationale": "当前恢复稳定，赛季内部可把基础期与专项期共享边界后移两周",
                    },
                ),
            ),
            _tool_calls(
                3,
                (
                    "extend_phase",
                    {
                        "plan_id": "s1c-plan-001",
                        "phase_id": "phase-base",
                        "weeks": 2,
                        "adjustment_request": request,
                    },
                ),
            ),
        ]
    )

    report = run_s1_conversation_evaluation(
        fixture_ids=["s1c-phase-extend-reasonable"], llm=llm
    )

    assert report.fixtures_passed == 1
    outcome = report.per_fixture[0]
    assert outcome.debug["contract_violations"] == []
    proposal = outcome.generated_artifact["result"]["proposals"][0]
    assert len(proposal["ops"]) == 1
    op = proposal["ops"][0]
    assert op["op"] == "shift_phase_boundary"
    assert op["spec_patch"] == {
        "end_date": "2026-08-29",
        "following_phase_id": "phase-build",
        "following_start_date": "2026-08-30",
    }


def test_phase_compress_fixture_emits_one_atomic_boundary_shift() -> None:
    request = "把基础期缩短一周"
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
                        "rationale": "当前基础能力与恢复稳定，可把专项期起点提前一周",
                    },
                ),
            ),
            _tool_calls(
                3,
                (
                    "compress_phase",
                    {
                        "plan_id": "s1c-plan-001",
                        "phase_id": "phase-base",
                        "weeks": 1,
                        "adjustment_request": request,
                    },
                ),
            ),
        ]
    )

    report = run_s1_conversation_evaluation(
        fixture_ids=["s1c-phase-compress-reasonable"], llm=llm
    )

    assert report.fixtures_passed == 1
    outcome = report.per_fixture[0]
    assert outcome.debug["contract_violations"] == []
    op = outcome.generated_artifact["result"]["proposals"][0]["ops"][0]
    assert op["op"] == "shift_phase_boundary"
    assert op["spec_patch"] == {
        "end_date": "2026-08-08",
        "following_phase_id": "phase-build",
        "following_start_date": "2026-08-09",
    }


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
                        "adjustment_request": request,
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


def test_phase_focus_fixture_preserves_exact_text_and_grounded_reason() -> None:
    request = "基础期训练重点改为上坡力量，因为秋季比赛有爬升，但保持周跑量不变"
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
                        "rationale": "秋季比赛有爬升；当前恢复与负荷稳定，适合在基础期加入上坡力量且不改周跑量",
                    },
                ),
            ),
            _tool_calls(
                3,
                (
                    "set_phase_focus",
                    {
                        "plan_id": "s1c-plan-001",
                        "phase_id": "phase-base",
                        "focus": "上坡力量",
                        "adjustment_request": request,
                        "reason": "秋季比赛有爬升，当前恢复与负荷支持",
                    },
                ),
            ),
        ]
    )

    report = run_s1_conversation_evaluation(
        fixture_ids=["s1c-focus-exact-text-reasonable"], llm=llm
    )

    assert report.fixtures_passed == 1
    outcome = report.per_fixture[0]
    assert outcome.debug["contract_violations"] == []
    proposal = outcome.generated_artifact["result"]["proposals"][0]
    op = proposal["ops"][0]
    assert op["phase_id"] == "phase-base"
    assert op["spec_patch"] == {"focus": "上坡力量"}
    assert op["old_value"] == {"focus": "有氧基础"}


def test_phase_focus_followup_fixture_resumes_original_request() -> None:
    request = "专项期：训练重点改成上坡力量与跑姿经济性"
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
                        "rationale": "the clarified build phase can safely emphasize hills and economy",
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
                        "focus": "上坡力量与跑姿经济性",
                        "adjustment_request": request,
                        "reason": "用户补充指定专项期，当前负荷与恢复支持",
                    },
                ),
            ),
        ]
    )

    report = run_s1_conversation_evaluation(
        fixture_ids=["s1c-focus-phase-followup-reasonable"], llm=llm
    )

    assert report.fixtures_passed == 1
    outcome = report.per_fixture[0]
    assert outcome.debug["contract_violations"] == []
    proposal = outcome.generated_artifact["result"]["proposals"][0]
    assert proposal["ops"][0]["phase_id"] == "phase-build"
    assert proposal["ops"][0]["spec_patch"] == {
        "focus": "上坡力量与跑姿经济性"
    }


def test_increase_details_followup_preserves_direction_and_exact_range() -> None:
    request = "专项期，增加到 82–96 公里：我想要加量"
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
                        "rationale": "历史峰值、当前恢复与负荷支持该增量区间",
                    },
                ),
            ),
            _tool_calls(
                3,
                (
                    "set_phase_weekly_range",
                    {
                        "plan_id": "s1c-plan-001",
                        "phase_id": "phase-build",
                        "weekly_distance_km_low": 82,
                        "weekly_distance_km_high": 96,
                        "adjustment_request": request,
                        "reason": "用户明确要求加量且冻结证据支持",
                    },
                ),
            ),
        ]
    )

    report = run_s1_conversation_evaluation(
        fixture_ids=["s1c-increase-details-followup-reasonable"], llm=llm
    )

    assert report.fixtures_passed == 1
    outcome = report.per_fixture[0]
    assert outcome.debug["contract_violations"] == []
    proposal = outcome.generated_artifact["result"]["proposals"][0]
    op = proposal["ops"][0]
    assert op["new_value"]["weekly_distance_km_low"] > op["old_value"][
        "weekly_distance_km_low"
    ]
    assert op["new_value"]["weekly_distance_km_high"] > op["old_value"][
        "weekly_distance_km_high"
    ]
    assert "propose_reduction_alternatives" not in [
        item["name"] for item in outcome.generated_artifact["tool_trace"]
    ]


def test_percentage_increase_followup_preserves_exact_magnitude() -> None:
    request = "专项期：把跑量提高 10%"
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
                        "rationale": "专项期 75–88 公里提高 10% 后为 82.5–96.8 公里，冻结证据支持",
                    },
                ),
            ),
            _tool_calls(
                3,
                (
                    "set_phase_weekly_range",
                    {
                        "plan_id": "s1c-plan-001",
                        "phase_id": "phase-build",
                        "weekly_distance_km_low": 82.5,
                        "weekly_distance_km_high": 96.8,
                        "adjustment_request": request,
                        "reason": "75–88 公里分别提高 10%",
                    },
                ),
            ),
        ]
    )

    report = run_s1_conversation_evaluation(
        fixture_ids=["s1c-increase-percentage-phase-followup-reasonable"],
        llm=llm,
    )

    assert report.fixtures_passed == 1
    outcome = report.per_fixture[0]
    assert outcome.debug["contract_violations"] == []
    proposal = outcome.generated_artifact["result"]["proposals"][0]
    assert proposal["ops"][0]["old_value"] == {
        "weekly_distance_km_low": 75.0,
        "weekly_distance_km_high": 88.0,
    }
    assert proposal["ops"][0]["new_value"] == {
        "weekly_distance_km_low": 82.5,
        "weekly_distance_km_high": 96.8,
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
