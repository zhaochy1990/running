"""A2 — weekly_plan runner wraps the week_chat graph as a SpecialistContract."""

from __future__ import annotations

from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from coach.contracts import SpecialistTask, TargetRef, Turn
from stride_core.plan_diff import PlanDiff
from stride_server.coach_adapters.orchestrator import weekly_plan as wp
from stride_server.coach_adapters.orchestrator.weekly_plan import (
    WEEKLY_PLAN_CARD,
    make_current_week_target_resolver,
    make_weekly_plan_runner,
    resolve_current_week_folder,
)

_FOLDER = "2026-06-22_06-28(W8)"


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


def test_target_resolver_none_when_no_current_week(monkeypatch) -> None:
    monkeypatch.setattr(wp, "resolve_current_week_folder", lambda _u: None)
    resolver = make_current_week_target_resolver("u1")
    assert resolver(None) is None
