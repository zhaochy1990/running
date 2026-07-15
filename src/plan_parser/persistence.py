"""Persist a weekly plan markdown + structured layer to the per-user DB."""

from __future__ import annotations

import hashlib
import sqlite3
from typing import Any, Literal

from stride_storage.sqlite.database import Database
from stride_core.plan_spec import WeeklyPlan

from .model_identity import configured_generator_id


_StructuredSource = Literal["fresh", "backfilled", "parse_failed", "authored"]


def apply_weekly_plan(
    user: str,
    folder: str,
    content: str,
    *,
    generated_by: str | None = None,
    structured: WeeklyPlan | None = None,
    structured_source: _StructuredSource = "fresh",
    commit: bool = True,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    """Persist a weekly plan markdown + (optional) structured layer.

    Markdown always lands in ``weekly_plan.content_md`` as the legacy authoring
    layer. When ``structured`` is supplied we additionally upsert the planned_session
    + planned_nutrition rows for ``folder`` and stamp ``structured_status``
    (``fresh`` for live LLM output, ``backfilled`` for historical re-parse).
    When ``structured`` is ``None`` we mark the row ``parse_failed`` so the UI
    can show a "重新解析" affordance.

    Default behavior (``commit=True, conn=None``): all writes go through a
    single SQLite transaction (``with db._conn:`` block + ``commit=False``
    on each helper). The block commits on clean exit and rolls back on any
    exception, so a mid-call failure never leaves partial state — either
    every row landed or none did.

    Promote/select callers pass ``commit=False, conn=<dedicated immediate-txn>``
    so this whole apply lives inside the caller's larger transaction; the
    caller is then responsible for the final ``commit()``/``rollback()``.
    """
    db = Database(user=user)
    try:
        if generated_by is None:
            author = configured_generator_id()
        else:
            author = generated_by
        md_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()

        def _do_writes(_c: sqlite3.Connection | None) -> None:
            db.upsert_weekly_plan(folder, content, generated_by=author,
                                  commit=False, conn=_c)
            if structured is not None:
                db.upsert_planned_sessions(
                    folder, list(structured.sessions), commit=False, conn=_c,
                )
                db.upsert_planned_nutrition(
                    folder, list(structured.nutrition), commit=False, conn=_c,
                )
                db.set_weekly_plan_structured_status(
                    folder, status=structured_source,
                    parsed_from_md_hash=md_hash, commit=False, conn=_c,
                )
            else:
                # Wipe any prior structured rows so we don't leave stale
                # data claiming to belong to this week.
                db.upsert_planned_sessions(folder, [], commit=False, conn=_c)
                db.upsert_planned_nutrition(folder, [], commit=False, conn=_c)
                db.set_weekly_plan_structured_status(
                    folder, status="parse_failed",
                    parsed_from_md_hash=md_hash, commit=False, conn=_c,
                )

        if conn is not None:
            # Caller (e.g. promote/select) owns the txn boundary on the
            # dedicated immediate-txn connection.
            _do_writes(conn)
        elif commit:
            with db._conn:
                _do_writes(None)
        else:
            # commit=False with no conn = run on db._conn but do not
            # commit. Caller is responsible for committing db._conn later.
            _do_writes(None)

        row = db.get_weekly_plan_row(folder)
        return dict(row) if row else {"week": folder, "content_md": content, "generated_by": author}
    finally:
        db.close()
