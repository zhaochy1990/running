"""Legacy SQLite plan projection used only by migration-era low-level APIs.

New imports, generation, Coach changes, and variant selection must write
``WeeklyPlanStore`` directly. This module remains temporarily so historical
database migration/tests can read or reconstruct pre-canonical SQLite plans.
"""

from __future__ import annotations

import hashlib
import sqlite3
from typing import Any, Literal

from stride_core.plan_spec import WeeklyPlan
from stride_storage.sqlite.database import Database

from .model_identity import configured_generator_id

_StructuredSource = Literal["fresh", "backfilled", "parse_failed", "authored"]


def apply_weekly_plan(
    user: str, folder: str, content: str, *, generated_by: str | None = None,
    structured: WeeklyPlan | None = None,
    structured_source: _StructuredSource = "fresh", commit: bool = True,
    conn: sqlite3.Connection | None = None,
) -> dict[str, Any]:
    """Legacy atomic projection; do not use for new structured-plan writes."""
    db = Database(user=user)
    try:
        author = configured_generator_id() if generated_by is None else generated_by
        md_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()

        def _write(target: sqlite3.Connection | None) -> None:
            db.upsert_weekly_plan(
                folder, content, generated_by=author, commit=False, conn=target
            )
            sessions = list(structured.sessions) if structured else []
            nutrition = list(structured.nutrition) if structured else []
            db.upsert_planned_sessions(folder, sessions, commit=False, conn=target)
            db.upsert_planned_nutrition(folder, nutrition, commit=False, conn=target)
            db.set_weekly_plan_structured_status(
                folder,
                status=structured_source if structured else "parse_failed",
                parsed_from_md_hash=md_hash,
                commit=False,
                conn=target,
            )

        if conn is not None:
            _write(conn)
        elif commit:
            with db._conn:
                _write(None)
        else:
            _write(None)
        row = db.get_weekly_plan_row(folder)
        return dict(row) if row else {"week": folder, "content_md": content}
    finally:
        db.close()
