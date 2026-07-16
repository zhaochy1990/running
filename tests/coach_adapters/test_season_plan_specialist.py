"""A3 — season_plan runner wraps the master_chat graph as a SpecialistContract."""

from __future__ import annotations

from typing import Any

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver

from coach.contracts import (
    IntentHit,
    ResolverDraft,
    SpecialistRegistry,
    SpecialistTask,
    TargetHint,
    TargetRef,
    Turn,
)
from coach.orchestrator.memory import MemoryExtraction
from stride_core.master_plan import (
    MasterPlan,
    MasterPlanStatus,
    Milestone,
    MilestoneType,
    Phase,
)
from stride_core.master_plan_diff import MasterPlanDiff
from stride_server.coach_adapters.orchestrator import season_plan as sp
from stride_server.coach_adapters.orchestrator.season_plan import (
    SEASON_PLAN_CARD,
    make_current_master_target_resolver,
    make_season_plan_runner,
    preflight_season_plan_turn,
)
from stride_server.coach_adapters.orchestrator.runtime import run_coach_turn

_PLAN_ID = "plan-test"
_TS = "2026-05-12T08:00:00+00:00"


def _plan() -> MasterPlan:
    return MasterPlan(
        plan_id=_PLAN_ID,
        user_id="u1",
        status=MasterPlanStatus.ACTIVE,
        goal_id="goal-1",
        start_date="2026-06-01",
        end_date="2026-11-15",
        phases=[
            Phase(
                id="phase-1", name="基础期", start_date="2026-06-01", end_date="2026-07-31",
                focus="有氧", weekly_distance_km_low=50.0, weekly_distance_km_high=65.0,
                key_session_types=["有氧"], milestone_ids=["ms-1"],
            )
        ],
        milestones=[
            Milestone(id="ms-1", type=MilestoneType.LONG_RUN, date="2026-07-20",
                      phase_id="phase-1", target="30K"),
        ],
        training_principles=["循序渐进"],
        generated_by="gpt-4.1", version=1, created_at=_TS, updated_at=_TS,
    )


def _diff_dict(*, end_date: str = "2026-08-15") -> dict[str, Any]:
    """A RESIZE_PHASE diff; default extends phase-1 (valid)."""
    return MasterPlanDiff(
        diff_id="d1",
        plan_id=_PLAN_ID,
        ops=[{
            "id": "op1",
            "op": "resize_phase",
            "phase_id": "phase-1",
            "old_value": {"end_date": "2026-07-31"},
            "new_value": {"end_date": end_date},
            "spec_patch": {"end_date": end_date},
            "accepted": None,
        }],
        ai_explanation="把基础期延长到 " + end_date,
        created_at=_TS,
    ).model_dump()


def _weekly_range_diff(
    *, low: float = 47.5, high: float = 61.8, diff_id: str = "d1"
) -> dict[str, Any]:
    return MasterPlanDiff(
        diff_id=diff_id,
        plan_id=_PLAN_ID,
        ops=[{
            "id": f"op-{diff_id}",
            "op": "replace_weekly_range",
            "phase_id": "phase-1",
            "old_value": {
                "weekly_distance_km_low": 50.0,
                "weekly_distance_km_high": 65.0,
            },
            "new_value": {
                "weekly_distance_km_low": low,
                "weekly_distance_km_high": high,
            },
            "spec_patch": {
                "weekly_distance_km_low": low,
                "weekly_distance_km_high": high,
            },
        }],
        ai_explanation=f"降低基础期周跑量到 {low}–{high} 公里",
        created_at=_TS,
    ).model_dump()


class _FakeGraph:
    def __init__(self, reply: str, last_diff: dict | None, capture: dict[str, Any]):
        self._reply = reply
        self._last_diff = last_diff
        self._capture = capture

    def invoke(self, state_in: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
        self._capture["state_in"] = state_in
        history = list(state_in["history"])
        history.append(AIMessage(content=self._reply))
        out: dict[str, Any] = {"history": history, "iteration": 1}
        if self._last_diff is not None:
            history.append(ToolMessage(content="{}", tool_call_id="t1", name="extend_phase"))
            out["last_diff"] = self._last_diff
            out["master_adjustment_assessment"] = {
                "adjustment_request": state_in["master_adjustment_request"],
                "verdict": "reasonable",
                "rationale": "测试数据支持这个调整。",
            }
        return out


def _factory(reply: str, last_diff: dict | None, capture: dict[str, Any]):
    def _make(*, toolkit: Any, llm: Any, checkpointer: Any, scope: str) -> _FakeGraph:
        capture["build"] = {"checkpointer": checkpointer, "scope": scope}
        return _FakeGraph(reply, last_diff, capture)
    return _make


def _task(objective: str, *, plan_id: str | None = _PLAN_ID, **kw) -> SpecialistTask:
    target = TargetRef(kind="master", plan_id=plan_id) if plan_id else None
    return SpecialistTask(objective=objective, active_target=target, **kw)


def _runner(capture, reply="已把基础期延长两周。", last_diff=None, monkeypatch=None):
    if monkeypatch is not None:
        monkeypatch.setattr(sp, "get_master_plan_store", lambda: _StoreStub())
    return make_season_plan_runner(
        user_id="u1", llm=object(), toolkit=object(),
        graph_factory=_factory(reply, last_diff, capture),
    )


class _StoreStub:
    def get_plan(self, user_id: str, plan_id: str):
        return _plan() if plan_id == _PLAN_ID else None

    def get_active_plan(self, user_id: str):
        return _plan()


def test_card_is_a_writer_with_routing_metadata() -> None:
    assert SEASON_PLAN_CARD.id == "season_plan"
    assert SEASON_PLAN_CARD.writes is True
    assert SEASON_PLAN_CARD.examples


def test_runner_extracts_valid_proposal(monkeypatch) -> None:
    capture: dict[str, Any] = {}
    runner = _runner(capture, last_diff=_diff_dict(end_date="2026-08-15"), monkeypatch=monkeypatch)
    result = runner(_task("把基础期延长两周"))
    assert result.status == "completed"
    assert len(result.proposals) == 1
    assert isinstance(result.proposals[0], MasterPlanDiff)
    assert result.proposals[0].plan_id == _PLAN_ID
    assert capture["build"]["scope"] == "master_chat"
    assert capture["build"]["checkpointer"] is None


def test_runner_extracts_and_validates_alternative_proposals(monkeypatch) -> None:
    capture: dict[str, Any] = {}
    alternatives = {
        "alternatives": [
            _weekly_range_diff(),
            _weekly_range_diff(low=45.0, high=58.5, diff_id="d2"),
        ],
        "reduction_request": "比较保守和激进减量方向",
    }
    runner = _runner(capture, reply="", last_diff=alternatives, monkeypatch=monkeypatch)
    result = runner(_task("给我两个降低基础期周跑量的方向"))

    assert [proposal.diff_id for proposal in result.proposals] == ["d1", "d2"]
    assert result.reply_fragment == "我准备了 2 个通过安全校验的调整方向，请选择一个方案。"


def test_runner_drops_only_invalid_alternative(monkeypatch) -> None:
    capture: dict[str, Any] = {}
    alternatives = {
        "alternatives": [
            _weekly_range_diff(low=70.0, high=80.0),
            _weekly_range_diff(low=45.0, high=58.5, diff_id="valid"),
        ]
    }
    runner = _runner(
        capture,
        reply="我准备了两个方案，请选择。",
        last_diff=alternatives,
        monkeypatch=monkeypatch,
    )
    result = runner(_task("给我两个降低基础期周跑量的方向"))

    assert len(result.proposals) == 1
    assert isinstance(result.proposals[0], MasterPlanDiff)
    assert result.proposals[0].diff_id == "valid"
    assert "只剩 1 个可应用" in result.reply_fragment
    assert "两个方案" not in result.reply_fragment
    assert result.proposals[0].ai_explanation in result.reply_fragment


def test_runner_rejects_reduction_diff_for_increase_request(monkeypatch) -> None:
    capture: dict[str, Any] = {}
    runner = _runner(
        capture,
        reply="错误的两个减量方案。",
        last_diff={
            "alternatives": [
                _weekly_range_diff(),
                _weekly_range_diff(low=45.0, high=58.5, diff_id="d2"),
            ]
        },
        monkeypatch=monkeypatch,
    )

    result = runner(_task("专项期增加到 70–80 公里：我想要加量"))

    assert result.proposals == []
    assert "方向不一致" in result.reply_fragment
    assert "增加周跑量" in result.reply_fragment


def test_runner_drops_diff_that_fails_the_gate(monkeypatch) -> None:
    """A structurally broken diff (inverted phase) is dropped, not surfaced."""
    capture: dict[str, Any] = {}
    runner = _runner(
        capture, reply="", last_diff=_diff_dict(end_date="2026-05-15"), monkeypatch=monkeypatch
    )
    result = runner(_task("把基础期缩到上个月"))
    assert result.status == "completed"
    assert result.proposals == []
    assert "结构问题" in result.reply_fragment


def test_runner_drops_proposal_without_matching_reasonable_assessment(
    monkeypatch,
) -> None:
    capture: dict[str, Any] = {}

    class _UngatedGraph:
        def invoke(self, state_in, config):
            capture["state_in"] = state_in
            return {
                "history": [*state_in["history"], AIMessage(content="不建议这样调整。")],
                "last_diff": _diff_dict(),
                "master_adjustment_assessment": {
                    "adjustment_request": state_in["master_adjustment_request"],
                    "verdict": "unreasonable",
                    "rationale": "负荷跳升过大。",
                },
            }

    runner = make_season_plan_runner(
        user_id="u1",
        llm=object(),
        toolkit=object(),
        plan_store=_StoreStub(),
        graph_factory=lambda **_kwargs: _UngatedGraph(),
    )

    result = runner(_task("把基础期周跑量加到 110–120 公里"))

    assert result.status == "completed"
    assert result.proposals == []
    assert result.reply_fragment == "不建议这样调整。"


def test_runner_surfaces_assessment_clarification_as_specialist_status() -> None:
    class _ClarifyingGraph:
        def invoke(self, state_in, config):
            return {
                "history": [*state_in["history"], AIMessage(content="你希望降低到多少公里？")],
                "master_adjustment_assessment": {
                    "adjustment_request": state_in["master_adjustment_request"],
                    "verdict": "needs_clarification",
                    "rationale": "缺少目标周量。",
                },
            }

    runner = make_season_plan_runner(
        user_id="u1",
        llm=object(),
        toolkit=object(),
        plan_store=_StoreStub(),
        graph_factory=lambda **_kwargs: _ClarifyingGraph(),
    )

    result = runner(_task("把基础期周跑量降低到 45–55 公里"))

    assert result.status == "needs_clarification"
    assert result.clarification == "你希望降低到多少公里？"
    assert result.proposals == []


def test_runner_misrouted_read_question_does_not_enter_write_graph(monkeypatch) -> None:
    capture: dict[str, Any] = {}
    runner = _runner(capture, reply="你的赛季计划目前 24 周。", last_diff=None, monkeypatch=monkeypatch)
    result = runner(_task("我的赛季计划多长"))
    assert result.status == "needs_clarification"
    assert result.proposals == []
    assert "build" not in capture


def test_runner_seeds_plan_id_into_context(monkeypatch) -> None:
    capture: dict[str, Any] = {}
    runner = _runner(capture, last_diff=None, monkeypatch=monkeypatch)
    runner(_task("延长基础期"))
    seeded = " ".join(
        m.content for m in capture["state_in"]["history"] if isinstance(m, HumanMessage)
    )
    assert _PLAN_ID in seeded
    assert capture["state_in"]["plan_id"] == _PLAN_ID
    assert capture["state_in"]["scope"] == "master_chat"


def test_runner_without_plan_asks_clarification() -> None:
    capture: dict[str, Any] = {}
    runner = make_season_plan_runner(
        user_id="u1", llm=object(), toolkit=object(),
        graph_factory=_factory("unused", None, capture),
    )
    result = runner(_task("帮我改赛季计划", plan_id=None))
    assert result.status == "needs_clarification"
    assert result.clarification
    assert "build" not in capture  # graph never built without a plan


def test_runner_without_adjustment_direction_asks_before_loading_data(monkeypatch) -> None:
    capture: dict[str, Any] = {}
    runner = _runner(capture, last_diff=_diff_dict(), monkeypatch=monkeypatch)

    result = runner(_task("我想要调整我的整体训练计划"))

    assert result.status == "needs_clarification"
    assert result.proposals == []
    assert "具体怎么调整" in (result.clarification or "")
    assert "build" not in capture


def test_orchestrator_preflight_clarifies_vague_master_adjustment() -> None:
    result = preflight_season_plan_turn("我想调整整体训练计划", [])

    assert result is not None
    assert result.clarification is not None
    assert result.proposals == []
    assert result.active_target == TargetRef(kind="master")


def test_orchestrator_preflight_does_not_capture_read_only_master_question() -> None:
    assert preflight_season_plan_turn("我的赛季计划目前是什么样", []) is None
    assert preflight_season_plan_turn("我是否需要调整整体训练计划？", []) is None
    assert preflight_season_plan_turn("你觉得我该不该减少赛季计划的训练量？", []) is None
    assert preflight_season_plan_turn("你觉得我需要减少周跑量吗？", []) is None


def test_orchestrator_preflight_does_not_treat_need_statement_as_advice() -> None:
    result = preflight_season_plan_turn("我需要调整整体训练计划", [])

    assert result is not None
    assert "具体怎么调整" in (result.clarification or "")


def test_orchestrator_preflight_allows_concrete_master_adjustment() -> None:
    assert preflight_season_plan_turn("把基础期延长两周", []) is None


def test_orchestrator_preflight_asks_phase_after_direction_followup() -> None:
    result = preflight_season_plan_turn(
        "我想减量",
        [Turn(role="assistant", content="你希望具体怎么调整整体训练计划？")],
    )

    assert result is not None
    assert "哪个阶段" in (result.clarification or "")


def test_orchestrator_preflight_asks_for_increase_phase_and_amount() -> None:
    result = preflight_season_plan_turn(
        "我想要加量",
        [
            Turn(role="user", content="我想调整整体训练计划"),
            Turn(
                role="assistant",
                content="我准备了两个减量方向：方案 A 降低 5%，方案 B 降低 10%。",
            ),
        ],
    )

    assert result is not None
    assert "调整哪个阶段" in (result.clarification or "")
    assert "区间" in (result.clarification or "")
    assert result.proposals == []


def test_orchestrator_preflight_asks_only_amount_when_increase_phase_is_known() -> None:
    result = preflight_season_plan_turn("专项期加量", [])

    assert result is not None
    assert "这个阶段" in (result.clarification or "")
    assert "百分比" in (result.clarification or "")


def test_run_coach_turn_preflight_does_not_construct_any_llm(monkeypatch) -> None:
    import stride_server.coach_runtime as coach_runtime

    def fail():
        raise AssertionError("LLM or memory singleton must not be constructed")

    monkeypatch.setattr(coach_runtime, "get_generator_llm", fail)
    monkeypatch.setattr(coach_runtime, "get_status_insight_llm", fail)
    monkeypatch.setattr(coach_runtime, "get_orchestrator_llm", fail)
    monkeypatch.setattr(coach_runtime, "get_athlete_memory_store", fail)

    result = run_coach_turn(
        user_id="u1",
        session_id="clarify",
        message="我想调整整体训练计划",
        checkpointer=InMemorySaver(),
    )

    assert result.clarification is not None
    assert result.proposals == []


def test_run_coach_turn_restores_adjustment_after_phase_checkpoint(
    monkeypatch,
) -> None:
    saver = InMemorySaver()
    capture: dict[str, Any] = {}
    monkeypatch.setattr(sp, "get_master_plan_store", lambda: _StoreStub())

    registry = SpecialistRegistry()
    registry.register(
        SEASON_PLAN_CARD,
        make_season_plan_runner(
            user_id="u1",
            llm=object(),
            toolkit=object(),
            graph_factory=_factory("这个方向合理，可以提出调整方案。", None, capture),
        ),
    )

    class _MemoryStore:
        def fetch_active(self, user_id: str, *, top_k: int = 10):
            return []

    def _draft(_system: str, _user: str) -> ResolverDraft:
        return ResolverDraft(
            intents=[
                IntentHit(
                    specialist_id="season_plan", action="write", confidence=0.99
                )
            ],
            target_hint=TargetHint(kind="master", ref_phrase="专项期"),
        )

    first = run_coach_turn(
        user_id="u1",
        session_id="phase-checkpoint",
        message="训练重点改成上坡力量与跑姿经济性",
        checkpointer=saver,
    )
    assert "哪个阶段" in (first.clarification or "")

    second = run_coach_turn(
        user_id="u1",
        session_id="phase-checkpoint",
        message="专项期",
        checkpointer=saver,
        registry=registry,
        draft_fn=_draft,
        specialist_llm=object(),
        memory_store=_MemoryStore(),
        memory_extract_fn=lambda _system, _user: MemoryExtraction(),
    )

    assert second.clarification is None
    assert second.reply == "这个方向合理，可以提出调整方案。"
    assert capture["state_in"]["master_adjustment_request"] == (
        "专项期：训练重点改成上坡力量与跑姿经济性"
    )
    assert capture["state_in"]["history"][-1].content == (
        "专项期：训练重点改成上坡力量与跑姿经济性"
    )


def test_runner_restores_increase_direction_after_details_followup(monkeypatch) -> None:
    capture: dict[str, Any] = {}
    runner = _runner(capture, last_diff=None, monkeypatch=monkeypatch)
    question = (
        "你想调整哪个阶段的周跑量，以及希望调整到什么区间或调整多少百分比？"
        "例如“专项期提高 10%”或“专项期增加到 80–95 公里”。"
        "确认阶段和幅度后我再加载数据评估这个想法。"
    )

    result = runner(
        _task(
            "专项期，增加到 82–96 公里",
            conversation_window=[
                Turn(role="user", content="我想要加量"),
                Turn(role="assistant", content=question),
            ],
        )
    )

    assert result.status == "completed"
    assert capture["state_in"]["master_adjustment_request"] == (
        "专项期，增加到 82–96 公里：我想要加量"
    )


@pytest.mark.parametrize(
    "objective",
    [
        "训练重点改成上坡力量与跑姿经济性",
        "把周跑量降到 60–70 公里",
        "把阶段延长两周",
    ],
)
def test_runner_asks_for_missing_phase_before_loading_data(
    objective: str, monkeypatch
) -> None:
    capture: dict[str, Any] = {}
    runner = _runner(capture, last_diff=_diff_dict(), monkeypatch=monkeypatch)

    result = runner(_task(objective))

    assert result.status == "needs_clarification"
    assert result.proposals == []
    assert "哪个阶段" in (result.clarification or "")
    assert "build" not in capture


@pytest.mark.parametrize(
    "objective",
    [
        "把基础期训练重点改成上坡力量与跑姿经济性",
        "把当前阶段周跑量降到 60–70 公里",
        "把下一阶段延长两周",
    ],
)
def test_runner_accepts_explicit_phase_targets(
    objective: str, monkeypatch
) -> None:
    capture: dict[str, Any] = {}
    runner = _runner(capture, last_diff=None, monkeypatch=monkeypatch)

    result = runner(_task(objective))

    assert result.status == "completed"
    assert "build" in capture
    assert capture["state_in"]["master_adjustment_request"] == objective
    assert capture["state_in"]["history"][-1].content == objective


def test_runner_resumes_focus_request_after_phase_clarification(monkeypatch) -> None:
    capture: dict[str, Any] = {}
    runner = _runner(capture, last_diff=None, monkeypatch=monkeypatch)

    result = runner(
        _task(
            "专项期",
            conversation_window=[
                Turn(role="user", content="训练重点改成上坡力量与跑姿经济性"),
                Turn(
                    role="assistant",
                    content="你希望调整哪个阶段？确认阶段后我再加载数据评估。",
                ),
            ],
        )
    )

    assert result.status == "completed"
    assert "build" in capture
    assert capture["state_in"]["master_adjustment_request"] == (
        "专项期：训练重点改成上坡力量与跑姿经济性"
    )
    assert capture["state_in"]["history"][-1].content == (
        "专项期：训练重点改成上坡力量与跑姿经济性"
    )


@pytest.mark.parametrize(
    "objective",
    [
        "专项期，不过先别改",
        "专项期，我还需要想想",
    ],
)
def test_runner_does_not_resume_when_phase_answer_contains_a_new_instruction(
    objective: str, monkeypatch
) -> None:
    capture: dict[str, Any] = {}
    runner = _runner(capture, last_diff=None, monkeypatch=monkeypatch)

    result = runner(
        _task(
            objective,
            conversation_window=[
                Turn(role="user", content="训练重点改成上坡力量与跑姿经济性"),
                Turn(
                    role="assistant",
                    content="你希望调整哪个阶段？确认阶段后我再加载数据评估。",
                ),
            ],
        )
    )

    assert result.status == "needs_clarification"
    assert "build" not in capture


def test_runner_does_not_resume_a_stale_phase_question(monkeypatch) -> None:
    capture: dict[str, Any] = {}
    runner = _runner(capture, last_diff=None, monkeypatch=monkeypatch)

    result = runner(
        _task(
            "专项期",
            conversation_window=[
                Turn(role="user", content="训练重点改成上坡力量与跑姿经济性"),
                Turn(
                    role="assistant",
                    content="你希望调整哪个阶段？确认阶段后我再加载数据评估。",
                ),
                Turn(role="user", content="我晚点再决定"),
            ],
        )
    )

    assert result.status == "needs_clarification"
    assert "build" not in capture


def test_runner_does_not_treat_isolated_phase_name_as_complete_request(
    monkeypatch,
) -> None:
    capture: dict[str, Any] = {}
    runner = _runner(capture, last_diff=None, monkeypatch=monkeypatch)

    result = runner(_task("专项期"))

    assert result.status == "needs_clarification"
    assert "build" not in capture


@pytest.mark.parametrize(
    "objective",
    [
        "我还没想好是增加还是减少周跑量",
        "我不确定要延长还是缩短基础期",
        "你觉得我是应该增加还是减少周跑量？",
        "帮我决定要延长还是缩短基础期",
    ],
)
def test_runner_does_not_treat_undecided_options_as_a_direction(
    objective: str, monkeypatch
) -> None:
    capture: dict[str, Any] = {}
    runner = _runner(capture, last_diff=_diff_dict(), monkeypatch=monkeypatch)

    result = runner(_task(objective))

    assert result.status == "needs_clarification"
    assert result.proposals == []
    assert "具体怎么调整" in (result.clarification or "")
    assert "build" not in capture


@pytest.mark.parametrize(
    "objective",
    [
        "把基础期周跑量降到 90–100 公里",
        "把专项期周跑量加到 110–120 公里",
        "将比赛目标设为 2:55",
        "目标比赛延期到 2026-11-08，请把计划顺延",
        "专项期更侧重马拉松配速耐力与补给演练",
    ],
)
def test_runner_recognizes_common_concrete_adjustment_directions(
    objective: str, monkeypatch
) -> None:
    capture: dict[str, Any] = {}
    runner = _runner(capture, last_diff=None, monkeypatch=monkeypatch)

    result = runner(_task(objective))

    assert result.status == "completed"
    assert "build" in capture


def test_runner_empty_reply_falls_back_to_diff_explanation(monkeypatch) -> None:
    capture: dict[str, Any] = {}
    runner = _runner(
        capture, reply="", last_diff=_diff_dict(end_date="2026-08-15"), monkeypatch=monkeypatch
    )
    result = runner(_task("延长基础期"))
    assert len(result.proposals) == 1
    assert result.reply_fragment == "把基础期延长到 2026-08-15"


def test_runner_drops_proposal_when_plan_vanishes_midturn(monkeypatch) -> None:
    """get_plan returns None (deleted mid-turn) → no un-gated proposal surfaced."""
    capture: dict[str, Any] = {}

    class _Vanished:
        def get_plan(self, user_id, plan_id):
            return None  # gone

    monkeypatch.setattr(sp, "get_master_plan_store", lambda: _Vanished())
    runner = make_season_plan_runner(
        user_id="u1", llm=object(), toolkit=object(),
        graph_factory=_factory("ok", _diff_dict(), capture),
    )
    result = runner(_task("延长基础期"))
    assert result.status == "completed"
    assert result.proposals == []


# --- master target resolver -------------------------------------------------


def test_master_target_resolver_fills_active_plan_id(monkeypatch) -> None:
    monkeypatch.setattr(sp, "get_master_plan_store", lambda: _StoreStub())
    resolver = make_current_master_target_resolver("u1")
    assert resolver(TargetRef(kind="master")) == TargetRef(kind="master", plan_id=_PLAN_ID)
    # non-master targets fall through (combined resolver handles week)
    assert resolver(TargetRef(kind="week")) is None
    assert resolver(None) is None


def test_master_target_resolver_none_when_no_active_plan(monkeypatch) -> None:
    class _Empty:
        def get_active_plan(self, user_id: str):
            return None
    monkeypatch.setattr(sp, "get_master_plan_store", lambda: _Empty())
    resolver = make_current_master_target_resolver("u1")
    assert resolver(TargetRef(kind="master")) is None
