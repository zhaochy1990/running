"""A2 — weekly_plan runner wraps the week_chat graph as a SpecialistContract."""

from __future__ import annotations

from datetime import date
from types import SimpleNamespace
from typing import Any

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from coach.contracts import SpecialistTask, TargetHint, TargetRef, Turn
from stride_core.master_plan import (
    MasterPlan,
    MasterPlanGoal,
    MasterPlanStatus,
    MasterPlanWeek,
)
from stride_core.plan_diff import PlanDiff
from stride_core.plan_spec import PlannedSession, SessionKind, WeeklyPlan
from stride_core.weekly_plan_proposal import WeeklyPlanCreateProposal
from stride_server.coach_adapters.orchestrator import weekly_plan as wp
from stride_server.coach_adapters.orchestrator.weekly_plan import (
    WEEKLY_PLAN_CARD,
    make_current_week_target_resolver,
    make_weekly_plan_runner,
    resolve_current_week_folder,
    resolve_master_week_folder,
)

_FOLDER = "2026-06-22_06-28(W8)"


@pytest.fixture(autouse=True)
def _existing_week_by_default(monkeypatch):
    """Legacy adjustment tests operate on an existing canonical week."""
    monkeypatch.setattr(
        wp,
        "get_weekly_plan_store",
        lambda: _FakeWeeklyPlanStore(WeeklyPlan(week_folder=_FOLDER)),
    )


def _plan_diff_dict() -> dict[str, Any]:
    return PlanDiff(
        diff_id="d1",
        folder=_FOLDER,
        ops=[],
        ai_explanation="把周三换到周四",
        created_at="2026-06-28T00:00:00Z",
    ).model_dump()


class _FakeGraph:
    """Mimics the week_chat graph: appends an AIMessage (+ optional ToolMessage)
    and optionally sets last_diff like a draft-tool turn."""

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
            # A draft-tool turn ends with a ToolMessage after the AIMessage.
            history.append(ToolMessage(content="{}", tool_call_id="t1", name="swap_sessions"))
            out["last_diff"] = self._last_diff
        return out


def _factory(reply: str, last_diff: dict | None, capture: dict[str, Any]):
    def _make(*, toolkit: Any, llm: Any, checkpointer: Any, scope: str) -> _FakeGraph:
        capture["build"] = {"checkpointer": checkpointer, "scope": scope}
        return _FakeGraph(reply, last_diff, capture)

    return _make


def _task(objective: str, *, folder: str | None = _FOLDER, **kw) -> SpecialistTask:
    target = TargetRef(kind="week", folder=folder) if folder else None
    return SpecialistTask(objective=objective, active_target=target, **kw)


def test_card_is_a_writer_with_routing_metadata() -> None:
    assert WEEKLY_PLAN_CARD.id == "weekly_plan"
    assert WEEKLY_PLAN_CARD.writes is True
    assert WEEKLY_PLAN_CARD.examples


def test_runner_extracts_proposal_from_draft_turn() -> None:
    capture: dict[str, Any] = {}
    runner = make_weekly_plan_runner(
        user_id="u1",
        llm=object(),
        toolkit=object(),
        graph_factory=_factory("已把周三换到周四。", _plan_diff_dict(), capture),
    )
    result = runner(_task("把周三换到周四"))
    assert result.status == "completed"
    assert result.reply_fragment == "已把周三换到周四。"
    assert len(result.proposals) == 1
    assert isinstance(result.proposals[0], PlanDiff)
    assert result.proposals[0].folder == _FOLDER
    assert capture["build"]["scope"] == "week_chat"
    assert capture["build"]["checkpointer"] is None


def test_runner_question_turn_has_no_proposal() -> None:
    capture: dict[str, Any] = {}
    runner = make_weekly_plan_runner(
        user_id="u1",
        llm=object(),
        toolkit=object(),
        graph_factory=_factory("本周一共 45 公里。", None, capture),
    )
    result = runner(_task("这周跑量多少"))
    assert result.status == "completed"
    assert result.reply_fragment == "本周一共 45 公里。"
    assert result.proposals == []


def test_runner_falls_back_to_diff_explanation_when_reply_empty() -> None:
    """A tool-call-only turn (empty AIMessage text) + a proposal → reply falls
    back to the diff's explanation so the UI never shows a blank bubble."""
    capture: dict[str, Any] = {}
    runner = make_weekly_plan_runner(
        user_id="u1",
        llm=object(),
        toolkit=object(),
        graph_factory=_factory("", _plan_diff_dict(), capture),  # empty reply text
    )
    result = runner(_task("把周三换到周四"))
    assert result.status == "completed"
    assert len(result.proposals) == 1
    assert result.reply_fragment == "把周三换到周四"  # == diff.ai_explanation


def test_runner_seeds_folder_value_into_context() -> None:
    capture: dict[str, Any] = {}
    runner = make_weekly_plan_runner(
        user_id="u1",
        llm=object(),
        toolkit=object(),
        graph_factory=_factory("ok", None, capture),
    )
    runner(_task("把周三换到周四"))
    seeded = " ".join(
        m.content for m in capture["state_in"]["history"] if isinstance(m, HumanMessage)
    )
    assert _FOLDER in seeded
    assert capture["state_in"]["folder"] == _FOLDER


def test_runner_next_week_toolkit_can_read_injected_folder(monkeypatch) -> None:
    next_folder = "2026-07-20_07-26"
    next_plan = WeeklyPlan(
        week_folder=next_folder,
        sessions=(PlannedSession(
            date="2026-07-22", session_index=0, kind=SessionKind.RUN,
            summary="Next-week interval",
        ),),
    )

    class _Store:
        def get_plan(self, _user_id, folder):
            return next_plan if folder == next_folder else None

    class _Graph:
        def invoke(self, state_in, config):
            result = toolkit.get_week_plan(folder=state_in["folder"])
            assert result.ok
            assert result.data["sessions"][0]["summary"] == "Next-week interval"
            return {"history": [AIMessage(content="已读取并调整下一周。")]}

    from stride_server.coach_adapters.tool_impls.read_impls import GetWeekPlanImpl

    toolkit = SimpleNamespace(get_week_plan=GetWeekPlanImpl("u1"))
    monkeypatch.setattr(
        "stride_server.weekly_plan_store.get_weekly_plan_store", lambda: _Store()
    )
    monkeypatch.setattr(wp, "get_weekly_plan_store", lambda: _Store())
    runner = make_weekly_plan_runner(
        user_id="u1",
        llm=object(),
        toolkit=toolkit,
        graph_factory=lambda **_kwargs: _Graph(),
    )
    result = runner(_task("调整下一周", folder=next_folder))

    assert result.status == "completed"
    assert result.reply_fragment == "已读取并调整下一周。"


def test_runner_without_folder_asks_clarification() -> None:
    capture: dict[str, Any] = {}
    runner = make_weekly_plan_runner(
        user_id="u1",
        llm=object(),
        toolkit=object(),
        graph_factory=_factory("unused", None, capture),
    )
    result = runner(_task("帮我改一下", folder=None))
    assert result.status == "needs_clarification"
    assert result.clarification
    assert "build" not in capture  # graph never built without a folder


def test_runner_creates_full_plan_proposal_when_week_missing(monkeypatch) -> None:
    folder = "2026-07-13_07-19"
    generated_plan = WeeklyPlan(
        week_folder=folder,
        sessions=(
            PlannedSession(
                date="2026-07-13",
                session_index=0,
                kind=SessionKind.REST,
                summary="休息",
            ),
        ),
        notes_md="本周保持稳定负荷",
    )
    monkeypatch.setattr(wp, "get_weekly_plan_store", lambda: _FakeWeeklyPlanStore())
    monkeypatch.setattr(wp, "today_shanghai", lambda: date(2026, 7, 15))
    monkeypatch.setattr(
        wp,
        "build_weekly_plan",
        lambda **_: SimpleNamespace(plan=generated_plan, total_distance_km=40.0),
    )
    capture: dict[str, Any] = {}
    runner = make_weekly_plan_runner(
        user_id="u1",
        llm=object(),
        toolkit=object(),
        graph_factory=_factory("unused", None, capture),
    )

    result = runner(_task("创建本周计划", folder=folder))

    assert result.status == "completed"
    assert len(result.proposals) == 1
    proposal = result.proposals[0]
    assert isinstance(proposal, WeeklyPlanCreateProposal)
    assert proposal.to_weekly_plan().notes_md == "本周保持稳定负荷"
    assert "确认后才会保存" in result.reply_fragment
    assert "build" not in capture


def test_runner_rejects_week_after_next_without_generation(monkeypatch) -> None:
    monkeypatch.setattr(wp, "get_weekly_plan_store", lambda: _FakeWeeklyPlanStore())
    monkeypatch.setattr(wp, "today_shanghai", lambda: date(2026, 7, 15))
    capture: dict[str, Any] = {}
    runner = make_weekly_plan_runner(
        user_id="u1",
        llm=object(),
        toolkit=object(),
        graph_factory=_factory("unused", None, capture),
    )

    result = runner(_task("生成下下周计划", folder="2026-07-27_08-02"))

    assert result.status == "rejected"
    assert "当前周和下一周" in result.reply_fragment
    assert "build" not in capture


def test_runner_does_not_create_missing_far_week_for_adjustment(monkeypatch) -> None:
    monkeypatch.setattr(wp, "get_weekly_plan_store", lambda: _FakeWeeklyPlanStore())
    monkeypatch.setattr(wp, "today_shanghai", lambda: date(2026, 7, 15))
    runner = make_weekly_plan_runner(
        user_id="u1", llm=object(), toolkit=object(),
        graph_factory=lambda **_: pytest.fail("graph must not run"),
    )

    result = runner(_task("调整下下周的周三", folder="2026-07-27_08-02"))

    assert result.status == "rejected"
    assert "当前周和下一周" in result.reply_fragment


def test_runner_does_not_silently_drop_adjustment_when_supported_week_missing(
    monkeypatch,
) -> None:
    folder = "2026-07-20_07-26"
    monkeypatch.setattr(wp, "get_weekly_plan_store", lambda: _FakeWeeklyPlanStore())
    monkeypatch.setattr(wp, "today_shanghai", lambda: date(2026, 7, 15))
    runner = make_weekly_plan_runner(
        user_id="u1",
        llm=object(),
        toolkit=object(),
        graph_factory=lambda **_: pytest.fail("graph must not run"),
    )

    result = runner(_task("把下一周周三改成45分钟轻松跑", folder=folder))

    assert result.status == "needs_clarification"
    assert result.proposals == []
    assert "还没有训练计划" in (result.clarification or "")
    assert "先创建并应用" in (result.clarification or "")
    assert "重新提出这项调整" in (result.clarification or "")


def test_negated_generation_phrase_can_adjust_existing_far_week(monkeypatch) -> None:
    folder = "2026-07-27_08-02"
    monkeypatch.setattr(
        wp, "get_weekly_plan_store",
        lambda: _FakeWeeklyPlanStore(WeeklyPlan(week_folder=folder)),
    )
    monkeypatch.setattr(wp, "today_shanghai", lambda: date(2026, 7, 15))
    capture: dict[str, Any] = {}
    runner = make_weekly_plan_runner(
        user_id="u1", llm=object(), toolkit=object(),
        graph_factory=_factory("已调整。", None, capture),
    )

    result = runner(_task("不要重新生成，只调整下下周的周三", folder=folder))

    assert result.status == "completed"
    assert capture["build"]["scope"] == "week_chat"


def test_runner_rejects_regenerating_existing_week_after_next(monkeypatch) -> None:
    folder = "2026-07-27_08-02"
    monkeypatch.setattr(
        wp,
        "get_weekly_plan_store",
        lambda: _FakeWeeklyPlanStore(WeeklyPlan(week_folder=folder)),
    )
    monkeypatch.setattr(wp, "today_shanghai", lambda: date(2026, 7, 15))
    capture: dict[str, Any] = {}
    runner = make_weekly_plan_runner(
        user_id="u1",
        llm=object(),
        toolkit=object(),
        graph_factory=_factory("unused", None, capture),
    )

    result = runner(_task("重新生成下下周计划", folder=folder))

    assert result.status == "rejected"
    assert "当前周和下一周" in result.reply_fragment
    assert "build" not in capture


def test_runner_seeds_window_and_memory_notes() -> None:
    from coach.contracts import ScopedContext

    capture: dict[str, Any] = {}
    runner = make_weekly_plan_runner(
        user_id="u1",
        llm=object(),
        toolkit=object(),
        graph_factory=_factory("ok", None, capture),
    )
    runner(
        _task(
            "现在呢",
            context=ScopedContext(notes="用户有跟腱伤史"),
            conversation_window=[Turn(role="user", content="昨天我跑了10公里")],
        )
    )
    contents = [m.content for m in capture["state_in"]["history"] if isinstance(m, HumanMessage)]
    assert any("跟腱伤史" in c for c in contents)
    assert any("昨天我跑了10公里" in c for c in contents)
    assert capture["state_in"]["history"][-1].content == "现在呢"


# --- current-week folder resolution -----------------------------------------


class _FakeWeeklyPlanStore:
    def __init__(self, current=None):
        self.current = current

    def get_current_plan(self, _user_id, _today):
        return self.current

    def get_plan(self, _user_id, _folder):
        return self.current


def _master_plan_with_week(week_index: int = 11) -> MasterPlan:
    week = MasterPlanWeek(
        week_index=week_index,
        week_start="2026-07-13",
        phase_id="phase-1",
        target_weekly_km_low=68,
        target_weekly_km_high=74,
        key_sessions=[],
    )
    return MasterPlan(
        plan_id="master-1",
        user_id="u1",
        status=MasterPlanStatus.ACTIVE,
        goal=MasterPlanGoal(
            goal_id="goal-1",
            race_date="2026-10-18",
            target_time="2:50:00",
        ),
        start_date="2026-05-04",
        end_date="2026-10-18",
        total_weeks=24,
        phases=[],
        milestones=[],
        weeks=[week],
        training_principles=[],
        generated_by="test",
        version=1,
        created_at="2026-05-01T00:00:00Z",
        updated_at="2026-05-01T00:00:00Z",
    )


class _MasterStore:
    def __init__(self, plan=None):
        self.plan = plan

    def get_active_plan(self, _user_id):
        return self.plan


def test_resolve_master_week_folder_from_active_plan(monkeypatch) -> None:
    monkeypatch.setattr(
        "stride_server.master_plan_store.get_master_plan_store",
        lambda: _MasterStore(_master_plan_with_week()),
    )
    monkeypatch.setattr(wp, "get_weekly_plan_store", lambda: _FakeWeeklyPlanStore())

    assert resolve_master_week_folder("u1", 11) == "2026-07-13_07-19"
    assert resolve_master_week_folder("u1", 12) is None


def test_resolve_master_week_folder_reuses_existing_canonical_folder(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "stride_server.master_plan_store.get_master_plan_store",
        lambda: _MasterStore(_master_plan_with_week()),
    )
    existing = WeeklyPlan(week_folder="2026-07-13_07-19(W3)")
    monkeypatch.setattr(
        wp, "get_weekly_plan_store", lambda: _FakeWeeklyPlanStore(existing)
    )

    assert resolve_master_week_folder("u1", 11) == existing.week_folder


def test_resolve_master_week_folder_supports_legacy_plan_without_weeks(
    monkeypatch,
) -> None:
    legacy = _master_plan_with_week().model_copy(
        update={"weeks": [], "weekly_key_sessions": []}
    )
    monkeypatch.setattr(
        "stride_server.master_plan_store.get_master_plan_store",
        lambda: _MasterStore(legacy),
    )
    monkeypatch.setattr(wp, "get_weekly_plan_store", lambda: _FakeWeeklyPlanStore())

    assert resolve_master_week_folder("u1", 11) == "2026-07-13_07-19"
    assert resolve_master_week_folder("u1", 25) is None


def test_resolve_current_week_folder_prefers_canonical_store(monkeypatch) -> None:
    from stride_core.plan_spec import WeeklyPlan

    current = WeeklyPlan(week_folder=_FOLDER)
    monkeypatch.setattr(wp, "get_weekly_plan_store", lambda: _FakeWeeklyPlanStore(current))

    assert resolve_current_week_folder("u1") == _FOLDER


def test_resolve_current_week_folder_none_when_no_cover(monkeypatch) -> None:
    monkeypatch.setattr(wp, "get_weekly_plan_store", lambda: _FakeWeeklyPlanStore())
    assert resolve_current_week_folder("u1") is None


def test_resolve_current_week_folder_does_not_fallback_on_store_error(
    monkeypatch
) -> None:
    class _BrokenStore:
        def get_current_plan(self, _user_id, _today):
            raise RuntimeError("azure unavailable")

    monkeypatch.setattr(wp, "get_weekly_plan_store", lambda: _BrokenStore())

    assert resolve_current_week_folder("u1") is None


def test_target_resolver_fills_week_folder(monkeypatch) -> None:
    monkeypatch.setattr(wp, "resolve_current_week_folder", lambda _u: _FOLDER)
    resolver = make_current_week_target_resolver("u1")
    # bare None target → assume current week
    assert resolver(None) == TargetRef(kind="week", folder=_FOLDER)
    # week kind without folder → filled
    assert resolver(TargetRef(kind="week")) == TargetRef(kind="week", folder=_FOLDER)
    # master kind → not resolvable here
    assert resolver(TargetRef(kind="master")) is None


def test_target_resolver_uses_calendar_folder_when_current_week_missing(
    monkeypatch,
) -> None:
    monkeypatch.setattr(wp, "resolve_current_week_folder", lambda _u: None)
    monkeypatch.setattr(wp, "get_weekly_plan_store", lambda: _FakeWeeklyPlanStore())
    monkeypatch.setattr(wp, "today_shanghai", lambda: date(2026, 7, 15))
    resolver = make_current_week_target_resolver("u1")
    assert resolver(None) is None
    assert resolver(
        TargetRef(kind="week"),
        TargetHint(kind="week", ref_phrase="本周"),
    ) == TargetRef(
        kind="week", folder="2026-07-13_07-19"
    )
    assert resolver(
        TargetRef(kind="week"),
        TargetHint(kind="week", ref_phrase="下周"),
    ) == TargetRef(kind="week", folder="2026-07-20_07-26")
    assert resolver(
        TargetRef(kind="week"),
        TargetHint(kind="week", ref_phrase="下下周"),
    ) == TargetRef(kind="week", folder="2026-07-27_08-02")
    assert resolver(
        TargetRef(kind="session", date="2026-07-15"),
        TargetHint(kind="session", ref_phrase="本周三的间歇"),
    ) is None


def test_target_resolver_maps_master_week_number_to_folder(monkeypatch) -> None:
    monkeypatch.setattr(
        wp,
        "resolve_master_week_folder",
        lambda _user_id, week_index: (
            "2026-07-13_07-19(W11)" if week_index == 11 else None
        ),
    )
    resolver = make_current_week_target_resolver("u1")

    assert resolver(
        TargetRef(kind="week"),
        TargetHint(kind="week", ref_phrase="总体训练计划的第11周"),
    ) == TargetRef(kind="week", folder="2026-07-13_07-19(W11)")
