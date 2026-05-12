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

import logging
from enum import Enum
from typing import Any

from pydantic import BaseModel

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


# ---------------------------------------------------------------------------
# apply_diff
# ---------------------------------------------------------------------------


def apply_diff(
    plan_store: Any,
    folder: str,
    diff: PlanDiff,
    accepted_op_ids: list[str],
) -> None:
    """Apply only the accepted ops to the planned_session store.

    ``plan_store`` must expose:
      - ``get_planned_session_by_date_index(date, session_index)``
            → Mapping[str, Any] | None
      - ``_db`` attribute with a ``_conn`` sqlite3 connection for low-level
        mutations (avoids the need for a full set of protocol methods that
        don't yet exist on PlanStateStore for individual-field updates).

    For each accepted op:
      MOVE_SESSION     — delete old (date, session_index), insert at new date/index
      REPLACE_*        — update fields in-place from spec_patch
      ADD_SESSION      — insert new row from spec_patch
      REMOVE_SESSION   — delete row
      REPLACE_NOTE     — update notes_md / summary from spec_patch

    Ops whose id is not in ``accepted_op_ids`` are silently skipped.
    Ops with ``spec_patch=None`` are silently skipped (no data to apply).
    """
    if not diff.ops:
        return

    accepted_set = set(accepted_op_ids)

    for op in diff.ops:
        if op.id not in accepted_set:
            logger.debug("apply_diff: skipping op %s (not accepted)", op.id)
            continue
        if op.op not in (DiffOpKind.REMOVE_SESSION,) and op.spec_patch is None:
            logger.debug("apply_diff: skipping op %s (spec_patch is None)", op.id)
            continue
        try:
            _apply_op(plan_store, folder, op)
        except Exception:
            logger.exception("apply_diff: error applying op %s (%s)", op.id, op.op)
            raise


def _apply_op(plan_store: Any, folder: str, op: DiffOp) -> None:
    db = plan_store._db
    conn = db._conn

    if op.op == DiffOpKind.REMOVE_SESSION:
        row = plan_store.get_planned_session_by_date_index(op.date, op.session_index)
        if row is None:
            logger.warning(
                "apply_diff REMOVE_SESSION: no session at date=%s idx=%s",
                op.date, op.session_index,
            )
            return
        conn.execute(
            "DELETE FROM planned_session WHERE id = ?",
            (row["id"],),
        )
        conn.commit()
        logger.info("apply_diff: removed session id=%s", row["id"])

    elif op.op == DiffOpKind.ADD_SESSION:
        patch = op.spec_patch or {}
        conn.execute(
            """INSERT INTO planned_session
               (week_folder, date, session_index, kind, summary, notes_md,
                total_distance_m, total_duration_s, spec_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                folder,
                op.date,
                op.session_index,
                patch.get("kind", "note"),
                patch.get("summary", ""),
                patch.get("notes_md"),
                patch.get("total_distance_m"),
                patch.get("total_duration_s"),
                patch.get("spec_json"),
            ),
        )
        conn.commit()
        logger.info("apply_diff: added session date=%s idx=%s", op.date, op.session_index)

    elif op.op == DiffOpKind.MOVE_SESSION:
        row = plan_store.get_planned_session_by_date_index(op.date, op.session_index)
        if row is None:
            logger.warning(
                "apply_diff MOVE_SESSION: no session at date=%s idx=%s",
                op.date, op.session_index,
            )
            return
        patch = op.spec_patch or {}
        new_date = patch.get("new_date", op.date)
        new_index = patch.get("new_session_index", op.session_index)
        conn.execute(
            "UPDATE planned_session SET date = ?, session_index = ? WHERE id = ?",
            (new_date, new_index, row["id"]),
        )
        conn.commit()
        logger.info(
            "apply_diff: moved session id=%s → date=%s idx=%s",
            row["id"], new_date, new_index,
        )

    elif op.op in (
        DiffOpKind.REPLACE_KIND,
        DiffOpKind.REPLACE_DISTANCE,
        DiffOpKind.REPLACE_NOTE,
    ):
        row = plan_store.get_planned_session_by_date_index(op.date, op.session_index)
        if row is None:
            logger.warning(
                "apply_diff %s: no session at date=%s idx=%s",
                op.op.value, op.date, op.session_index,
            )
            return
        patch = op.spec_patch or {}
        _update_session_fields(conn, row["id"], patch)

    else:
        logger.warning("apply_diff: unknown op kind %s, skipping", op.op)


def _update_session_fields(conn: Any, session_id: int, patch: dict[str, Any]) -> None:
    """Apply arbitrary field updates to a planned_session row."""
    _ALLOWED_COLUMNS = {
        "kind", "summary", "notes_md",
        "total_distance_m", "total_duration_s",
        "spec_json",
    }
    updates = {k: v for k, v in patch.items() if k in _ALLOWED_COLUMNS}
    if not updates:
        logger.debug("_update_session_fields: no valid columns in patch %s", list(patch.keys()))
        return
    set_clause = ", ".join(f"{col} = ?" for col in updates)
    values = list(updates.values()) + [session_id]
    conn.execute(
        f"UPDATE planned_session SET {set_clause} WHERE id = ?",
        values,
    )
    conn.commit()
    logger.info("apply_diff: updated session id=%s fields=%s", session_id, list(updates.keys()))
