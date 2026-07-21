"""Plan diff schema — domain-semantic diff ops for weekly plan adjustments.

Design notes:
- Uses domain ops (MOVE_SESSION, REPLACE_KIND, etc.) rather than JSON Patch
  RFC 6902 so the frontend can render human-readable diff cards without
  re-parsing arbitrary JSON pointer paths.
- Each ``DiffOp`` carries both ``old_value`` / ``new_value`` (human-readable
  summaries for UI display) and ``spec_patch`` (complete field updates used
  by ``apply_diff`` to mutate the store).
- ``accepted`` is a tri-state: ``None`` = pending, ``True`` = accepted,
  ``False`` = rejected.  Only accepted ops are applied by ``apply_diff``.
- ``apply_diff`` takes a ``PlanStateStore``-compatible object; it calls the
  same ``get_planned_session_by_date_index`` + low-level DB methods already
  used by the plan routes.
"""

from __future__ import annotations

import dataclasses
import json
import logging
from enum import Enum
from typing import Any

from pydantic import BaseModel

from stride_core.plan_spec import PlannedSession, SessionKind, WeeklyPlan
from stride_core.timefmt import parse_week_folder_dates
from stride_core.workout_spec import NormalizedRunWorkout, NormalizedStrengthWorkout

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class DiffOpKind(str, Enum):
    MOVE_SESSION     = "move_session"       # move session to another date
    REPLACE_KIND     = "replace_kind"       # change session kind (e.g. run→strength)
    REPLACE_DISTANCE = "replace_distance"   # change distance / duration target
    ADD_SESSION      = "add_session"        # insert a new session
    REMOVE_SESSION   = "remove_session"     # delete a session
    REPLACE_NOTE     = "replace_note"       # update notes_md / summary text


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class DiffOp(BaseModel):
    id: str                     # uuid4 — frontend uses as React key
    op: DiffOpKind
    date: str                   # YYYY-MM-DD — source date (for MOVE: original date)
    session_index: int          # 0-based index within the day
    old_value: dict | None      # human-readable summary for UI display
    new_value: dict | None      # human-readable summary for UI display
    spec_patch: dict | None     # full field updates applied to the store row
    accepted: bool | None       # None=pending, True=accepted, False=rejected


class PlanDiff(BaseModel):
    diff_id: str                # uuid4 — identifies this diff round-trip
    folder: str                 # week folder e.g. "2026-05-04_05-10(W2)"
    ops: list[DiffOp]
    ai_explanation: str         # natural-language explanation shown to the user
    created_at: str             # ISO datetime UTC, e.g. "2026-05-12T08:00:00Z"
    # Snapshot fingerprint of the canonical week this diff was built against.
    # Persisted inside the proposal so refresh recovery cannot rebind an old diff
    # to a newer plan revision.
    base_revision: str | None = None


# ---------------------------------------------------------------------------
# pure apply
# ---------------------------------------------------------------------------


def op_touched_dates(op: "DiffOp") -> set[str]:
    """All calendar dates a single op reads or writes (source + any target).

    Used by the past-date immutability gate — an op that touches a past Shanghai
    day is refused regardless of which end (source vs move-target) is in the past.
    """
    dates = {op.date}
    patch = op.spec_patch or {}
    new_date = patch.get("new_date")
    if isinstance(new_date, str) and new_date:
        dates.add(new_date)
    return dates


def past_dated_op_ids(ops: "list[DiffOp]", *, today: str) -> list[str]:
    """Ids of ops that touch a Shanghai day strictly before ``today``.

    ``today`` is an ISO ``YYYY-MM-DD`` Shanghai day. ISO date strings compare
    lexicographically, so a plain ``<`` is a correct chronological test.
    """
    flagged: list[str] = []
    for op in ops:
        if any(d < today for d in op_touched_dates(op)):
            flagged.append(op.id)
    return flagged


def require_whole_plan_op_ids(
    ops: "list[DiffOp]", accepted_op_ids: "list[str]"
) -> list[str]:
    """Validate a whole-plan apply: ``accepted_op_ids`` must be exactly the set
    of applicable op ids (``accepted is not False``), order-ignored.

    Raises ``ValueError`` on any unknown id, duplicate id, a rejected op sent for
    apply, or an applicable op omitted (partial acceptance). Returns the
    applicable ids in the diff's own op order.
    """
    known = {op.id for op in ops}
    applicable = [op.id for op in ops if op.accepted is not False]
    applicable_set = set(applicable)

    seen: set[str] = set()
    for oid in accepted_op_ids:
        if oid not in known:
            raise ValueError(f"unknown op id {oid!r}")
        if oid in seen:
            raise ValueError(f"duplicate op id {oid!r}")
        seen.add(oid)
        if oid not in applicable_set:
            raise ValueError(f"op {oid!r} was rejected and cannot be applied")

    missing = applicable_set - seen
    if missing:
        raise ValueError(
            "whole-plan apply requires every applicable op; missing: "
            + ", ".join(sorted(missing))
        )
    return applicable


def apply_diff_to_weekly_plan(
    plan: WeeklyPlan,
    diff: PlanDiff,
    accepted_op_ids: list[str],
) -> WeeklyPlan:
    """Return an adjusted copy; no database or infrastructure access."""
    if diff.folder != plan.week_folder:
        raise ValueError("diff folder does not match weekly plan")
    bounds = parse_week_folder_dates(plan.week_folder)
    if bounds is None:
        raise ValueError(f"invalid weekly plan folder {plan.week_folder!r}")
    accepted = set(accepted_op_ids)
    original = {(s.date, s.session_index): s for s in plan.sessions}
    changed: dict[tuple[str, int], PlannedSession | None] = dict(original)
    additions: list[PlannedSession] = []

    for op in diff.ops:
        if op.id not in accepted:
            continue
        if op.op != DiffOpKind.REMOVE_SESSION and op.spec_patch is None:
            continue
        source_key = (op.date, op.session_index)
        # Compose accepted operations against the result of earlier operations
        # on the same source identity. Reading from ``original`` here would
        # make the last op silently undo every field changed by prior ops.
        source = changed.get(source_key)
        if op.op == DiffOpKind.ADD_SESSION:
            _require_within(bounds, op.date)
            additions.append(_session_from_patch(op))
            continue
        if source_key not in original or source is None:
            raise ValueError(f"source session {source_key!r} does not exist")
        if op.op == DiffOpKind.REMOVE_SESSION:
            changed[source_key] = None
        elif op.op == DiffOpKind.MOVE_SESSION:
            patch = op.spec_patch or {}
            new_date = str(patch.get("new_date", op.date))
            new_index = int(patch.get("new_session_index", op.session_index))
            _require_within(bounds, new_date)
            changed[source_key] = dataclasses.replace(
                source, date=new_date, session_index=new_index
            )
        else:
            changed[source_key] = _patch_session(source, op.spec_patch or {})

    sessions = [session for session in changed.values() if session is not None]
    sessions.extend(additions)
    identities = [(s.date, s.session_index) for s in sessions]
    if len(identities) != len(set(identities)):
        raise ValueError("plan diff creates duplicate session identities")
    sessions.sort(key=lambda s: (s.date, s.session_index))
    return dataclasses.replace(plan, sessions=tuple(sessions))


def _require_within(bounds: tuple[str, str], date_str: str) -> None:
    """Reject a diff that moves or creates a session outside its week."""
    if not bounds[0] <= date_str <= bounds[1]:
        raise ValueError(f"session date {date_str!r} is outside plan bounds")


def _spec_from_patch(kind: SessionKind, raw: Any):
    if raw is None:
        return None
    if isinstance(raw, str):
        raw = json.loads(raw)
    if kind == SessionKind.RUN:
        return NormalizedRunWorkout.from_dict(raw)
    if kind == SessionKind.STRENGTH:
        return NormalizedStrengthWorkout.from_dict(raw)
    raise ValueError(f"kind {kind.value!r} cannot carry a workout spec")


def _session_from_patch(op: DiffOp) -> PlannedSession:
    patch = op.spec_patch or {}
    kind = SessionKind(patch.get("kind", "note"))
    return PlannedSession(
        date=op.date, session_index=op.session_index, kind=kind,
        summary=str(patch.get("summary", "")),
        notes_md=patch.get("notes_md"),
        total_distance_m=patch.get("total_distance_m"),
        total_duration_s=patch.get("total_duration_s"),
        spec=_spec_from_patch(kind, patch.get("spec_json") or patch.get("spec")),
    )


def _patch_session(session: PlannedSession, patch: dict[str, Any]) -> PlannedSession:
    kind = SessionKind(patch.get("kind", session.kind.value))
    spec = session.spec
    if kind != session.kind:
        spec = None
    if "spec_json" in patch or "spec" in patch:
        spec = _spec_from_patch(kind, patch.get("spec_json", patch.get("spec")))
    allowed = {
        "summary", "notes_md", "total_distance_m", "total_duration_s"
    }
    updates = {key: value for key, value in patch.items() if key in allowed}
    return dataclasses.replace(session, kind=kind, spec=spec, **updates)
