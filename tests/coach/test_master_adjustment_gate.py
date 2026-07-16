"""Hard gates for evidence-based master-plan adjustment proposals."""

from __future__ import annotations

from typing import Any

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from coach.graphs.conversation.graph import build_conversation_graph
from coach.graphs.conversation.master_adjustment_direction import (
    master_diff_matches_phase_resize_request,
    master_diff_matches_focus_request,
    master_diff_matches_volume_request,
    requested_phase_focus,
    requested_phase_resize_direction,
    requested_phase_resize_weeks,
    requested_phase_type_for_focus,
    requested_weekly_volume_direction,
)
from coach.schemas import ToolResult
from stride_core.master_plan_diff import MasterPlanDiff
from .stubs.fake_toolkit import FakeToolkit


@pytest.mark.parametrize(
    ("user_text", "expected"),
    [
        ("我想要加量", "increase"),
        ("专项期增加到 82–96 公里", "increase"),
        ("我想把跑量提高 10%", "increase"),
        ("接下来里程降低一些", "decrease"),
        ("把基础期周跑量降到 45 公里", "decrease"),
        ("把基础期周跑量从 70–80 公里调整到 65–75 公里", "decrease"),
    ],
)
def test_requested_weekly_volume_direction_covers_natural_phrasing(
    user_text: str, expected: str
) -> None:
    assert requested_weekly_volume_direction(user_text) == expected


def test_exact_range_request_rejects_a_different_same_direction_range() -> None:
    diff = MasterPlanDiff.model_validate({
        "diff_id": "wrong-exact-range",
        "plan_id": "plan-1",
        "ops": [{
            "id": "op-1",
            "op": "replace_weekly_range",
            "phase_id": "phase-build",
            "old_value": {
                "weekly_distance_km_low": 75,
                "weekly_distance_km_high": 88,
            },
            "new_value": {
                "weekly_distance_km_low": 80,
                "weekly_distance_km_high": 95,
            },
            "spec_patch": {
                "weekly_distance_km_low": 80,
                "weekly_distance_km_high": 95,
            },
        }],
        "ai_explanation": "方向正确但不是用户指定区间",
        "created_at": "2026-07-16T00:00:00Z",
    })

    assert not master_diff_matches_volume_request(
        diff, "专项期增加到 82–96 公里"
    )


def test_percentage_request_uses_half_up_rounding_at_one_decimal() -> None:
    diff = MasterPlanDiff.model_validate({
        "diff_id": "half-up",
        "plan_id": "plan-1",
        "ops": [{
            "id": "op-1",
            "op": "replace_weekly_range",
            "phase_id": "phase-build",
            "old_value": {
                "weekly_distance_km_low": 65,
                "weekly_distance_km_high": 75,
            },
            "new_value": {
                "weekly_distance_km_low": 68.3,
                "weekly_distance_km_high": 78.8,
            },
            "spec_patch": {
                "weekly_distance_km_low": 68.3,
                "weekly_distance_km_high": 78.8,
            },
        }],
        "ai_explanation": "分别提高 5% 并按 0.1 km 四舍五入",
        "created_at": "2026-07-16T00:00:00Z",
    })

    assert master_diff_matches_volume_request(diff, "专项期跑量提高 5%")


def test_conflicting_percentages_fail_closed() -> None:
    diff = MasterPlanDiff.model_validate({
        "diff_id": "ambiguous-percentage",
        "plan_id": "plan-1",
        "ops": [{
            "id": "op-1",
            "op": "replace_weekly_range",
            "phase_id": "phase-build",
            "old_value": {
                "weekly_distance_km_low": 75,
                "weekly_distance_km_high": 88,
            },
            "new_value": {
                "weekly_distance_km_low": 82.5,
                "weekly_distance_km_high": 96.8,
            },
            "spec_patch": {
                "weekly_distance_km_low": 82.5,
                "weekly_distance_km_high": 96.8,
            },
        }],
        "ai_explanation": "不应猜测冲突的百分比",
        "created_at": "2026-07-16T00:00:00Z",
    })

    assert not master_diff_matches_volume_request(
        diff, "专项期跑量提高 5% 或 10%"
    )


@pytest.mark.parametrize(
    ("user_text", "focus", "phase_type"),
    [
        ("专项期更侧重马拉松配速耐力与补给演练", "马拉松配速耐力与补给演练", "build"),
        ("基础期训练重点改成『有氧耐力与上坡力量』", "有氧耐力与上坡力量", "base"),
        ("把 peak phase focus on race pace economy", "race pace economy", "peak"),
        ("Change the build phase focus to marathon pace endurance", "marathon pace endurance", "build"),
        ("调整期聚焦配速唤醒，不改变周跑量", "配速唤醒", "taper"),
    ],
)
def test_requested_phase_focus_extracts_exact_text_and_phase(
    user_text: str, focus: str, phase_type: str
) -> None:
    assert requested_phase_focus(user_text) == focus
    assert requested_phase_type_for_focus(user_text) == phase_type


def test_focus_request_rejects_expanded_or_wrong_phase_diff() -> None:
    from stride_core.master_plan import MasterPlan

    plan = MasterPlan.model_validate(
        {
            "plan_id": "plan-1",
            "user_id": "u1",
            "status": "active",
            "goal": {
                "goal_id": "goal-1", "race_date": "2026-10-25",
                "target_time": "3:15:00", "timezone": "Asia/Shanghai",
            },
            "start_date": "2026-07-01",
            "end_date": "2026-10-25",
            "phases": [
                {
                    "id": "phase-base", "name": "基础期", "phase_type": "base",
                    "start_date": "2026-07-01", "end_date": "2026-08-15",
                    "focus": "有氧基础", "weekly_distance_km_low": 60,
                    "weekly_distance_km_high": 70, "key_session_types": [],
                    "milestone_ids": [],
                },
                {
                    "id": "phase-build", "name": "专项期", "phase_type": "build",
                    "start_date": "2026-08-16", "end_date": "2026-10-10",
                    "focus": "马拉松专项", "weekly_distance_km_low": 70,
                    "weekly_distance_km_high": 80, "key_session_types": [],
                    "milestone_ids": [],
                },
            ],
            "milestones": [], "training_principles": [], "generated_by": "test",
            "version": 1, "created_at": "2026-07-01T00:00:00Z",
            "updated_at": "2026-07-01T00:00:00Z",
        }
    )

    def _diff(phase_id: str, focus: str) -> MasterPlanDiff:
        return MasterPlanDiff.model_validate(
            {
                "diff_id": phase_id + focus, "plan_id": "plan-1",
                "ops": [{
                    "id": "op-1", "op": "replace_phase_focus",
                    "phase_id": phase_id, "old_value": {"focus": "old"},
                    "new_value": {"focus": focus}, "spec_patch": {"focus": focus},
                }],
                "ai_explanation": "test", "created_at": "2026-07-16T00:00:00Z",
            }
        )

    request = "专项期更侧重马拉松配速耐力与补给演练"
    assert master_diff_matches_focus_request(
        _diff("phase-build", "马拉松配速耐力与补给演练"), request, plan=plan
    )
    assert not master_diff_matches_focus_request(
        _diff("phase-build", "马拉松配速耐力、补给演练与上坡力量"), request, plan=plan
    )
    assert not master_diff_matches_focus_request(
        _diff("phase-base", "马拉松配速耐力与补给演练"), request, plan=plan
    )


@pytest.mark.parametrize(
    ("user_text", "direction", "weeks"),
    [
        ("把基础期延长两周", "extend", 2),
        ("专项期缩短 1 周", "compress", 1),
        ("extend the base phase by 3 weeks", "extend", 3),
        ("把基础期从 6 周改为 8 周", "extend", 2),
        ("把专项期从八周压缩到六周", "compress", 2),
        ("基础期延长 14 天", "extend", 2),
    ],
)
def test_phase_resize_request_parses_exact_direction_and_whole_weeks(
    user_text: str, direction: str, weeks: int
) -> None:
    assert requested_phase_resize_direction(user_text) == direction
    assert requested_phase_resize_weeks(user_text) == weeks


@pytest.mark.parametrize(
    "user_text",
    [
        "把基础期延长一些",
        "把基础期延长 10 天",
        "把基础期延长 1 周或 2 周",
    ],
)
def test_phase_resize_request_fails_closed_without_one_whole_week_delta(
    user_text: str,
) -> None:
    assert requested_phase_resize_weeks(user_text) is None


def test_phase_resize_diff_requires_atomic_contiguous_exact_boundary_move() -> None:
    from stride_core.master_plan import MasterPlan

    plan = MasterPlan.model_validate(
        {
            "plan_id": "resize-plan", "user_id": "u1", "status": "active",
            "goal": {"goal_id": "g1", "race_date": "2026-10-25", "target_time": "3:15:00"},
            "start_date": "2026-07-01", "end_date": "2026-10-25",
            "phases": [
                {"id": "base", "name": "基础期", "phase_type": "base", "start_date": "2026-07-01", "end_date": "2026-08-15", "focus": "有氧", "weekly_distance_km_low": 50, "weekly_distance_km_high": 60, "key_session_types": [], "milestone_ids": []},
                {"id": "build", "name": "专项期", "phase_type": "build", "start_date": "2026-08-16", "end_date": "2026-10-25", "focus": "专项", "weekly_distance_km_low": 60, "weekly_distance_km_high": 70, "key_session_types": [], "milestone_ids": []},
            ],
            "milestones": [], "training_principles": [], "generated_by": "test",
            "version": 1, "created_at": "2026-07-01T00:00:00Z", "updated_at": "2026-07-01T00:00:00Z",
        }
    )

    def _boundary(new_end: str, new_start: str, phase_id: str = "base") -> MasterPlanDiff:
        return MasterPlanDiff.model_validate(
            {
                "diff_id": new_end, "plan_id": "resize-plan",
                "ops": [{
                    "id": "op", "op": "shift_phase_boundary", "phase_id": phase_id,
                    "old_value": {"end_date": "2026-08-15", "following_phase_id": "build", "following_start_date": "2026-08-16"},
                    "new_value": {"end_date": new_end, "following_phase_id": "build", "following_start_date": new_start},
                    "spec_patch": {"end_date": new_end, "following_phase_id": "build", "following_start_date": new_start},
                }],
                "ai_explanation": "test", "created_at": "2026-07-16T00:00:00Z",
            }
        )

    request = "把基础期延长两周"
    assert master_diff_matches_phase_resize_request(
        _boundary("2026-08-29", "2026-08-30"), request, plan=plan
    )
    assert not master_diff_matches_phase_resize_request(
        _boundary("2026-08-22", "2026-08-23"), request, plan=plan
    )
    assert not master_diff_matches_phase_resize_request(
        _boundary("2026-08-29", "2026-08-31"), request, plan=plan
    )


class _ScriptedLLM:
    def __init__(self, responses: list[AIMessage]) -> None:
        self._responses = list(responses)
        self.bound_tool_names: set[str] = set()
        self.invocations: list[list[Any]] = []

    def bind_tools(self, tools: list[Any], **_kwargs: Any) -> "_ScriptedLLM":
        self.bound_tool_names = {tool.name for tool in tools}
        return self

    def invoke(self, messages: list[Any]) -> AIMessage:
        self.invocations.append(messages)
        if not self._responses:
            raise AssertionError("scripted LLM ran out of responses")
        return self._responses.pop(0)


class _NoArgRead:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def __call__(self) -> ToolResult:
        self.calls.append({})
        return ToolResult(ok=True, data={})


class _PmcRead:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def __call__(self, *, days: int = 42, granularity: str = "daily") -> ToolResult:
        self.calls.append({"days": days, "granularity": granularity})
        return ToolResult(ok=True, data={})


class _MasterLoadRead:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def __call__(
        self,
        *,
        plan: dict | None = None,
        target_race: dict | None = None,
        weekly_run_days_max: int | None = None,
        injuries: list[str] | None = None,
        as_of_date: str | None = None,
    ) -> ToolResult:
        self.calls.append({"plan": plan})
        return ToolResult(ok=True, data={})


class _ProposeReductionAlternatives:
    def __init__(self, result: ToolResult | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.result = result or ToolResult(ok=True, data={})

    def __call__(self, *, plan_id: str, reduction_request: str) -> ToolResult:
        self.calls.append(
            {"plan_id": plan_id, "reduction_request": reduction_request}
        )
        return self.result


class _SetPhaseWeeklyRange:
    def __init__(self, result: ToolResult | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.result = result or ToolResult(ok=True, data={})

    def set_result(self, result: ToolResult) -> None:
        self.result = result

    def __call__(
        self,
        *,
        plan_id: str,
        phase_id: str,
        weekly_distance_km_low: float,
        weekly_distance_km_high: float,
        adjustment_request: str,
        reason: str,
    ) -> ToolResult:
        self.calls.append(
            {
                "plan_id": plan_id,
                "phase_id": phase_id,
                "weekly_distance_km_low": weekly_distance_km_low,
                "weekly_distance_km_high": weekly_distance_km_high,
                "adjustment_request": adjustment_request,
                "reason": reason,
            }
        )
        return self.result


def _toolkit() -> FakeToolkit:
    toolkit = FakeToolkit()
    toolkit.get_master_plan_current = _NoArgRead()
    toolkit.get_health_snapshot = _NoArgRead()
    toolkit.get_pmc_series = _PmcRead()
    toolkit.estimate_master_plan_load = _MasterLoadRead()
    toolkit.set_phase_weekly_range = _SetPhaseWeeklyRange()
    toolkit.propose_reduction_alternatives = _ProposeReductionAlternatives()
    return toolkit


def _tool_calls(*calls: tuple[str, dict[str, Any]]) -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[
            {
                "name": name,
                "args": args,
                "id": f"call-{index}",
                "type": "tool_call",
            }
            for index, (name, args) in enumerate(calls)
        ],
    )


def _read_calls() -> AIMessage:
    return _tool_calls(
        ("get_master_plan_current", {}),
        ("get_health_snapshot", {}),
        ("get_pmc_series", {"days": 42}),
        ("estimate_master_plan_load", {}),
    )


def _invoke(
    llm: _ScriptedLLM,
    toolkit: FakeToolkit,
    *,
    request: str = "我想降低基础期周跑量",
    consulted_tools: list[str] | None = None,
    tracked_request: str | None = None,
    assessment: dict[str, Any] | None = None,
) -> dict[str, Any]:
    graph = build_conversation_graph(
        toolkit=toolkit, llm=llm, checkpointer=None, scope="master_chat"
    )
    return graph.invoke(
        {
            "history": [HumanMessage(content=request)],
            "scope": "master_chat",
            "user_id": "u1",
            "plan_id": "plan-1",
            "consulted_tools": consulted_tools or [],
            "master_adjustment_request": tracked_request or request,
            "master_adjustment_assessment": assessment,
            "last_diff": None,
            "iteration": 0,
        },
        config={},
    )


def test_assessment_is_rejected_until_required_data_has_been_read() -> None:
    toolkit = _toolkit()
    llm = _ScriptedLLM(
        [
            _tool_calls(
                (
                    "assess_master_adjustment",
                    {
                        "adjustment_request": "我想降低基础期周跑量",
                        "verdict": "reasonable",
                        "rationale": "看起来可以",
                    },
                )
            ),
            AIMessage(content="我需要先读取你的训练数据。"),
        ]
    )

    state = _invoke(llm, toolkit)

    assert state.get("master_adjustment_assessment") is None
    assert state.get("last_diff") is None
    assert state.get("tool_trace") == [
        {"name": "assess_master_adjustment", "outcome": "blocked", "reason": "assessment_gate"}
    ]
    stage_messages = [
        message.content
        for message in llm.invocations[0]
        if isinstance(message, HumanMessage) and "【本轮工具阶段" in message.content
    ]
    assert len(stage_messages) == 1
    assert "读取" in stage_messages[0]
    assert "不要调用 assess_master_adjustment" in stage_messages[0]


def test_draft_is_rejected_without_a_reasonable_assessment() -> None:
    toolkit = _toolkit()
    llm = _ScriptedLLM(
        [
            _tool_calls(
                (
                    "propose_reduction_alternatives",
                    {"plan_id": "plan-1", "reduction_request": "降低基础期周跑量"},
                )
            ),
            AIMessage(content="我需要先评估这个想法是否合理。"),
        ]
    )

    state = _invoke(llm, toolkit)

    assert toolkit.propose_reduction_alternatives.calls == []
    assert state.get("last_diff") is None


def test_unreasonable_assessment_never_allows_a_proposal() -> None:
    toolkit = _toolkit()
    llm = _ScriptedLLM(
        [
            _read_calls(),
            _tool_calls(
                (
                    "assess_master_adjustment",
                    {
                        "adjustment_request": "我想降低基础期周跑量",
                        "verdict": "unreasonable",
                        "rationale": "会压缩必要的赛前调整期",
                    },
                )
            ),
            _tool_calls(
                (
                    "propose_reduction_alternatives",
                    {"plan_id": "plan-1", "reduction_request": "降低基础期周跑量"},
                )
            ),
            AIMessage(content="这个调整目前不合理，因此不会生成提案。"),
        ]
    )

    state = _invoke(llm, toolkit)

    assert state["master_adjustment_assessment"]["verdict"] == "unreasonable"
    assert toolkit.propose_reduction_alternatives.calls == []
    assert state.get("last_diff") is None


def test_reasonable_assessment_after_data_reads_allows_a_proposal() -> None:
    request = "给我两个降低基础期周跑量的方案"
    toolkit = _toolkit()
    diff = {
        "diff_id": "d1",
        "plan_id": "plan-1",
        "ops": [
            {
                "id": "op-1",
                "op": "replace_weekly_range",
                "phase_id": "phase-base",
                "old_value": {
                    "weekly_distance_km_low": 70,
                    "weekly_distance_km_high": 80,
                },
                "new_value": {
                    "weekly_distance_km_low": 66.5,
                    "weekly_distance_km_high": 76,
                },
                "spec_patch": {
                    "weekly_distance_km_low": 66.5,
                    "weekly_distance_km_high": 76,
                },
            }
        ],
        "ai_explanation": "降低基础期周跑量",
        "created_at": "2026-07-15T00:00:00+00:00",
    }
    toolkit.propose_reduction_alternatives = _ProposeReductionAlternatives(
        ToolResult(ok=True, data={"alternatives": [diff], "reduction_request": "降低基础期周跑量"})
    )
    llm = _ScriptedLLM(
        [
            _read_calls(),
            _tool_calls(
                (
                    "assess_master_adjustment",
                    {
                        "adjustment_request": request,
                        "verdict": "reasonable",
                        "rationale": "近期负荷和恢复数据支持温和下调",
                    },
                )
            ),
            _tool_calls(
                (
                    "propose_reduction_alternatives",
                    {"plan_id": "plan-1", "reduction_request": "降低基础期周跑量"},
                )
            ),
        ]
    )

    state = _invoke(llm, toolkit, request=request)

    assert {
        "get_master_plan_current",
        "get_health_snapshot",
        "get_pmc_series",
        "estimate_master_plan_load",
    }.issubset(state["consulted_tools"])
    assert state["master_adjustment_assessment"]["verdict"] == "reasonable"
    assert toolkit.propose_reduction_alternatives.calls == [
        {"plan_id": "plan-1", "reduction_request": "降低基础期周跑量"}
    ]
    assert state["last_diff"]["alternatives"][0]["diff_id"] == "d1"
    assert "assess_master_adjustment" in llm.bound_tool_names
    stage_messages = [
        next(
            message.content
            for message in invocation
            if isinstance(message, HumanMessage) and "【本轮工具阶段" in message.content
        )
        for invocation in llm.invocations
    ]
    assert "读取" in stage_messages[0]
    assert "评估" in stage_messages[1]
    assert "提案" in stage_messages[2]


@pytest.mark.parametrize(
    "user_request",
    [
        "我想降低基础期周跑量",
        "不要给我两个方案，只给一个降低基础期周跑量的建议",
        "我不需要比较，直接给一个降低基础期周跑量的方案",
    ],
)
def test_alternatives_are_rejected_without_an_explicit_comparison_request(
    user_request: str,
) -> None:
    request = user_request
    toolkit = _toolkit()
    llm = _ScriptedLLM(
        [
            _tool_calls(
                (
                    "propose_reduction_alternatives",
                    {"plan_id": "plan-1", "reduction_request": request},
                )
            ),
            AIMessage(content="你没有要求比较多个方案，我只会提出一个方向。"),
        ]
    )

    state = _invoke(
        llm,
        toolkit,
        request=request,
        assessment={
            "adjustment_request": request,
            "verdict": "reasonable",
            "rationale": "近期负荷和恢复数据支持温和下调",
        },
    )

    assert toolkit.propose_reduction_alternatives.calls == []
    assert state.get("last_diff") is None
    assert state["tool_trace"][-1] == {
        "name": "propose_reduction_alternatives",
        "outcome": "blocked",
        "reason": "alternatives_gate",
    }


def test_reduction_alternatives_are_rejected_for_an_increase_request() -> None:
    request = "专项期增加到 82–96 公里：我想要加量"
    toolkit = _toolkit()
    llm = _ScriptedLLM(
        [
            _tool_calls(
                (
                    "propose_reduction_alternatives",
                    {"plan_id": "plan-1", "reduction_request": "给两个减量方案"},
                )
            ),
            AIMessage(content="加量请求不能使用减量备选工具。"),
        ]
    )

    state = _invoke(
        llm,
        toolkit,
        request=request,
        assessment={
            "adjustment_request": request,
            "verdict": "reasonable",
            "rationale": "当前数据支持适度增加。",
        },
    )

    assert toolkit.propose_reduction_alternatives.calls == []
    assert state.get("last_diff") is None
    assert state["tool_trace"][-1]["reason"] == "alternatives_gate"


def test_decreasing_weekly_diff_is_rejected_for_an_increase_request() -> None:
    request = "专项期增加到 82–96 公里：我想要加量"
    toolkit = _toolkit()
    toolkit.set_phase_weekly_range.set_result(
        ToolResult(
            ok=True,
            data={
                "diff_id": "wrong-direction",
                "plan_id": "plan-1",
                "ops": [{
                    "id": "op-1",
                    "op": "replace_weekly_range",
                    "phase_id": "phase-build",
                    "old_value": {
                        "weekly_distance_km_low": 75,
                        "weekly_distance_km_high": 88,
                    },
                    "new_value": {
                        "weekly_distance_km_low": 67.5,
                        "weekly_distance_km_high": 79.2,
                    },
                    "spec_patch": {
                        "weekly_distance_km_low": 67.5,
                        "weekly_distance_km_high": 79.2,
                    },
                }],
                "ai_explanation": "错误的减量方案",
                "created_at": "2026-07-16T00:00:00Z",
            },
        )
    )
    llm = _ScriptedLLM(
        [
            _tool_calls(
                (
                    "set_phase_weekly_range",
                    {
                        "plan_id": "plan-1",
                        "phase_id": "phase-build",
                        "weekly_distance_km_low": 67.5,
                        "weekly_distance_km_high": 79.2,
                        "adjustment_request": request,
                        "reason": "错误方向",
                    },
                )
            ),
            AIMessage(content="该方案方向与请求不一致，已拒绝。"),
        ]
    )

    state = _invoke(
        llm,
        toolkit,
        request=request,
        assessment={
            "adjustment_request": request,
            "verdict": "reasonable",
            "rationale": "当前数据支持适度增加。",
        },
    )

    assert state.get("last_diff") is None
    assert state["tool_trace"][-1] == {
        "name": "set_phase_weekly_range",
        "outcome": "blocked",
        "reason": "proposal_direction_gate",
    }


def test_wrong_percentage_diff_is_rejected_even_when_direction_is_correct() -> None:
    request = "把专项期跑量提高 10%"
    toolkit = _toolkit()
    toolkit.set_phase_weekly_range.set_result(
        ToolResult(
            ok=True,
            data={
                "diff_id": "wrong-percentage",
                "plan_id": "plan-1",
                "ops": [{
                    "id": "op-1",
                    "op": "replace_weekly_range",
                    "phase_id": "phase-build",
                    "old_value": {
                        "weekly_distance_km_low": 75,
                        "weekly_distance_km_high": 88,
                    },
                    "new_value": {
                        "weekly_distance_km_low": 80,
                        "weekly_distance_km_high": 95,
                    },
                    "spec_patch": {
                        "weekly_distance_km_low": 80,
                        "weekly_distance_km_high": 95,
                    },
                }],
                "ai_explanation": "方向向上但幅度不是 10%",
                "created_at": "2026-07-16T00:00:00Z",
            },
        )
    )
    llm = _ScriptedLLM(
        [
            _tool_calls(
                (
                    "set_phase_weekly_range",
                    {
                        "plan_id": "plan-1",
                        "phase_id": "phase-build",
                        "weekly_distance_km_low": 80,
                        "weekly_distance_km_high": 95,
                        "adjustment_request": request,
                        "reason": "错误计算",
                    },
                )
            ),
            AIMessage(content="方案与用户指定的 10% 不一致，已拒绝。"),
        ]
    )

    state = _invoke(
        llm,
        toolkit,
        request=request,
        assessment={
            "adjustment_request": request,
            "verdict": "reasonable",
            "rationale": "数据支持精确增加 10%。",
        },
    )

    assert state.get("last_diff") is None
    assert state["tool_trace"][-1]["reason"] == "proposal_direction_gate"


def test_reasonable_assessment_for_an_old_request_cannot_authorize_a_new_draft() -> None:
    toolkit = _toolkit()
    llm = _ScriptedLLM(
        [
            _tool_calls(
                (
                    "propose_reduction_alternatives",
                    {"plan_id": "plan-1", "reduction_request": "降低基础期周跑量"},
                )
            ),
            AIMessage(content="我需要先评估当前这条调整想法。"),
        ]
    )

    state = _invoke(
        llm,
        toolkit,
        assessment={
            "adjustment_request": "我想延长基础期两周",
            "verdict": "reasonable",
            "rationale": "旧想法合理",
        },
    )

    assert toolkit.propose_reduction_alternatives.calls == []
    assert state.get("last_diff") is None


def test_reads_for_an_old_request_cannot_authorize_a_new_assessment() -> None:
    toolkit = _toolkit()
    llm = _ScriptedLLM(
        [
            _tool_calls(
                (
                    "assess_master_adjustment",
                    {
                        "adjustment_request": "我想降低基础期周跑量",
                        "verdict": "reasonable",
                        "rationale": "旧数据不能用于新想法",
                    },
                )
            ),
            AIMessage(content="我需要针对这个想法重新读取数据。"),
        ]
    )

    state = _invoke(
        llm,
        toolkit,
        consulted_tools=[
            "get_master_plan_current",
            "get_health_snapshot",
            "get_pmc_series",
            "estimate_master_plan_load",
        ],
        tracked_request="我想延长基础期两周",
    )

    assert state.get("master_adjustment_assessment") is None
    assert state.get("last_diff") is None


def test_target_time_assessment_requires_prediction_and_pb_reads() -> None:
    request = "把目标马拉松完赛成绩从 3:15:00 调整到 3:10:00"
    toolkit = _toolkit()
    llm = _ScriptedLLM(
        [
            _tool_calls(
                (
                    "assess_master_adjustment",
                    {
                        "adjustment_request": request,
                        "verdict": "reasonable",
                        "rationale": "without prediction evidence",
                    },
                )
            ),
            AIMessage(content="我还需要读取预测和 PB。"),
        ]
    )

    state = _invoke(
        llm,
        toolkit,
        request=request,
        consulted_tools=[
            "get_master_plan_current",
            "get_health_snapshot",
            "get_pmc_series",
            "estimate_master_plan_load",
        ],
    )

    assert state.get("master_adjustment_assessment") is None
    stage_messages = [
        message.content
        for message in llm.invocations[0]
        if isinstance(message, HumanMessage) and "【本轮工具阶段" in message.content
    ]
    assert "get_race_predictions" in stage_messages[0]
    assert "get_pbs" in stage_messages[0]


def test_focus_draft_requires_exact_current_request_binding() -> None:
    request = "专项期训练重点改为马拉松配速耐力与补给演练"
    toolkit = _toolkit()
    llm = _ScriptedLLM(
        [
            _tool_calls(
                (
                    "set_phase_focus",
                    {
                        "plan_id": "plan-1",
                        "phase_id": "phase-build",
                        "focus": "马拉松配速耐力与补给演练",
                        "adjustment_request": "专项期训练重点改为上坡力量",
                        "reason": "错误绑定",
                    },
                )
            ),
            AIMessage(content="重点调整请求未正确绑定，已拒绝。"),
        ]
    )

    state = _invoke(
        llm,
        toolkit,
        request=request,
        assessment={
            "adjustment_request": request,
            "verdict": "reasonable",
            "rationale": "数据支持该明确重点",
        },
    )

    assert toolkit.set_phase_focus.calls == []
    assert state.get("last_diff") is None
    assert state["tool_trace"][-1]["reason"] == "focus_request_gate"


def test_phase_resize_draft_requires_exact_current_request_weeks() -> None:
    request = "把基础期延长两周"
    toolkit = _toolkit()
    llm = _ScriptedLLM(
        [
            _tool_calls(
                (
                    "extend_phase",
                    {
                        "plan_id": "plan-1",
                        "phase_id": "phase-base",
                        "weeks": 1,
                        "adjustment_request": request,
                    },
                )
            ),
            AIMessage(content="周数不匹配，已拒绝。"),
        ]
    )

    state = _invoke(
        llm,
        toolkit,
        request=request,
        assessment={
            "adjustment_request": request,
            "verdict": "reasonable",
            "rationale": "数据支持延长两周",
        },
    )

    assert toolkit.extend_phase.calls == []
    assert state.get("last_diff") is None
    assert state["tool_trace"][-1]["reason"] == "phase_resize_request_gate"
