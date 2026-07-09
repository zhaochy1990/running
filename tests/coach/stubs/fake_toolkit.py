"""FakeToolkit — canned ToolResults for every coach tool, used in graph tests.

Tests dial in expected behavior by assigning ``ToolResult`` objects to the
attributes; calls record their arguments in ``.calls`` so assertions can
inspect them.

Example::

    tk = FakeToolkit(user_id="u1")
    tk.get_health_snapshot.set_result(ToolResult(ok=True, data={"latest": {...}}))
    state = build_conversation_graph(toolkit=tk, ...).invoke(...)
    assert tk.get_health_snapshot.calls == [{}]
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from coach.runtime.toolkit import Toolkit
from coach.schemas import ToolResult


class _FakeTool:
    """Callable stub that records calls and returns a canned ToolResult."""

    def __init__(self, default: ToolResult | None = None) -> None:
        self._result: ToolResult = default or ToolResult(ok=True, data={})
        self.calls: list[dict[str, Any]] = []

    def set_result(self, result: ToolResult) -> None:
        self._result = result

    def __call__(self, **kwargs: Any) -> ToolResult:
        self.calls.append(dict(kwargs))
        return self._result


@dataclass
class FakeToolkit:
    """Concrete fake satisfying :class:`Toolkit` for graph tests."""

    user_id: str = "fake-user"

    # read (12)
    get_recent_activities: _FakeTool = field(default_factory=_FakeTool)
    get_health_snapshot: _FakeTool = field(default_factory=_FakeTool)
    get_health_series: _FakeTool = field(default_factory=_FakeTool)
    get_pmc_series: _FakeTool = field(default_factory=_FakeTool)
    get_body_composition_latest: _FakeTool = field(default_factory=_FakeTool)
    get_ability_snapshot: _FakeTool = field(default_factory=_FakeTool)
    get_race_predictions: _FakeTool = field(default_factory=_FakeTool)
    get_pbs: _FakeTool = field(default_factory=_FakeTool)
    get_master_plan_current: _FakeTool = field(default_factory=_FakeTool)
    get_master_plan_versions: _FakeTool = field(default_factory=_FakeTool)
    get_week_plan: _FakeTool = field(default_factory=_FakeTool)
    get_activity_detail: _FakeTool = field(default_factory=_FakeTool)

    # week-scope draft (7)
    swap_sessions: _FakeTool = field(default_factory=_FakeTool)
    shift_session: _FakeTool = field(default_factory=_FakeTool)
    reduce_intensity: _FakeTool = field(default_factory=_FakeTool)
    replace_session: _FakeTool = field(default_factory=_FakeTool)
    add_strength_session: _FakeTool = field(default_factory=_FakeTool)
    change_pace_target: _FakeTool = field(default_factory=_FakeTool)
    regenerate_week: _FakeTool = field(default_factory=_FakeTool)

    # master-scope draft (6)
    extend_phase: _FakeTool = field(default_factory=_FakeTool)
    compress_phase: _FakeTool = field(default_factory=_FakeTool)
    shift_milestone: _FakeTool = field(default_factory=_FakeTool)
    change_target: _FakeTool = field(default_factory=_FakeTool)
    propose_alternatives: _FakeTool = field(default_factory=_FakeTool)
    regenerate_master: _FakeTool = field(default_factory=_FakeTool)


def _assert_toolkit_protocol() -> None:
    """Static assertion that FakeToolkit satisfies the Toolkit Protocol.

    Called at import time; raises immediately if a tool attribute is missing
    so test failures point at the missing attribute, not a far-away graph
    assertion."""
    tk: Toolkit = FakeToolkit()  # type: ignore[assignment]
    # Touch every attribute named on the Toolkit Protocol
    for name in (
        "get_recent_activities", "get_health_snapshot", "get_pmc_series",
        "get_health_series",
        "get_body_composition_latest", "get_ability_snapshot", "get_race_predictions",
        "get_pbs", "get_master_plan_current", "get_master_plan_versions",
        "get_week_plan", "get_activity_detail",
        "swap_sessions", "shift_session", "reduce_intensity",
        "replace_session", "add_strength_session", "change_pace_target",
        "regenerate_week",
        "extend_phase", "compress_phase", "shift_milestone", "change_target",
        "propose_alternatives", "regenerate_master",
    ):
        getattr(tk, name)


_assert_toolkit_protocol()
