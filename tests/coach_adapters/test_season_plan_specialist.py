"""A3 — season_plan runner wraps the master_chat graph as a SpecialistContract."""

from __future__ import annotations

from typing import Any

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from coach.contracts import SpecialistTask, TargetRef, Turn
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
)

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
            _diff_dict(end_date="2026-08-15"),
            {**_diff_dict(end_date="2026-08-29"), "diff_id": "d2"},
        ],
        "intent": "比较保守和激进方向",
    }
    runner = _runner(capture, reply="", last_diff=alternatives, monkeypatch=monkeypatch)
    result = runner(_task("给我两个降低基础期周跑量的方向"))

    assert [proposal.diff_id for proposal in result.proposals] == ["d1", "d2"]
    assert result.reply_fragment == "我准备了 2 个通过安全校验的调整方向，请选择一个方案。"


def test_runner_drops_only_invalid_alternative(monkeypatch) -> None:
    capture: dict[str, Any] = {}
    alternatives = {
        "alternatives": [
            _diff_dict(end_date="2026-05-15"),
            {**_diff_dict(end_date="2026-08-29"), "diff_id": "valid"},
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
        "把基础期周跑量降到 100 公里",
        "把专项期周跑量加到 120 公里",
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
