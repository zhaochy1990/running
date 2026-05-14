"""Scope enum + thread-id helpers — see plan §6.3, §6.4.

A scope identifies which "kind" of conversation graph instance to use:

* ``master_chat`` — review/adjust a long-term master plan
* ``week_chat``  — adjust this week's planned sessions
* ``qa``         — open-ended daily question-and-answer

Each scope binds a different prompt + tool set + diff type. Thread ids are
derived from the user id + scope + a per-scope key so the same checkpointer
can host all three concurrently without collision:

    user:master:<plan_id>
    user:week:<folder>
    user:qa:<YYYY-MM-DD>           # one thread per Shanghai day
"""

from __future__ import annotations

from enum import Enum

from stride_core.plan_diff import PlanDiff
from stride_core.master_plan_diff import MasterPlanDiff
from stride_core.timefmt import today_shanghai


class Scope(str, Enum):
    MASTER_CHAT = "master_chat"
    WEEK_CHAT = "week_chat"
    QA = "qa"


SCOPE_DIFF_TYPE: dict[str, type | None] = {
    Scope.MASTER_CHAT.value: MasterPlanDiff,
    Scope.WEEK_CHAT.value: PlanDiff,
    Scope.QA.value: None,
}


def thread_id_for(user_id: str, scope: str | Scope, *, key: str | None = None) -> str:
    """Build a deterministic thread id for ``(user_id, scope, key)``.

    For ``qa`` scope the key is ignored and the current Shanghai date is used,
    so each calendar day starts a fresh thread (and the history never grows
    unboundedly).
    """
    scope_str = scope.value if isinstance(scope, Scope) else scope
    if scope_str == Scope.QA.value:
        return f"{user_id}:qa:{today_shanghai().isoformat()}"
    if scope_str == Scope.MASTER_CHAT.value:
        if not key:
            raise ValueError("master_chat thread_id requires a plan_id key")
        return f"{user_id}:master:{key}"
    if scope_str == Scope.WEEK_CHAT.value:
        if not key:
            raise ValueError("week_chat thread_id requires a folder key")
        return f"{user_id}:week:{key}"
    raise ValueError(f"unknown scope: {scope_str!r}")


def parse_thread_id(thread_id: str) -> tuple[str, str, str]:
    """Return ``(user_id, scope, key)`` for a thread id.

    Raises ``ValueError`` for malformed ids — the HTTP layer translates that
    into a 400 response so cross-user probing returns a deterministic error.
    """
    parts = thread_id.split(":", 2)
    if len(parts) != 3:
        raise ValueError(f"malformed thread_id {thread_id!r}; expected 3 colon-separated segments")
    user_id, scope, key = parts
    if scope not in {Scope.MASTER_CHAT.value, Scope.WEEK_CHAT.value, Scope.QA.value}:
        raise ValueError(
            f"malformed thread_id {thread_id!r}; scope must be one of "
            "master_chat/week_chat/qa (note: master/week/qa segment names are master/week/qa)"
        )
    return user_id, scope, key


def parse_short_thread_id(thread_id: str) -> tuple[str, str, str]:
    """Parser that accepts the short scope segment names used in our thread ids.

    Our IDs use ``master`` / ``week`` / ``qa`` as the middle segment (not the
    full Scope enum value). This helper handles that quirk so the HTTP layer
    can validate ownership cleanly.
    """
    parts = thread_id.split(":", 2)
    if len(parts) != 3:
        raise ValueError(f"malformed thread_id {thread_id!r}; expected 3 colon-separated segments")
    user_id, segment, key = parts
    if segment not in {"master", "week", "qa"}:
        raise ValueError(
            f"malformed thread_id {thread_id!r}; scope segment must be 'master', 'week', or 'qa'"
        )
    scope_map = {
        "master": Scope.MASTER_CHAT.value,
        "week": Scope.WEEK_CHAT.value,
        "qa": Scope.QA.value,
    }
    return user_id, scope_map[segment], key
