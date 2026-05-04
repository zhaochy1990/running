"""Protocol-typed seams for non-watch-data state.

Phase 1 of the "everything except watch-synced data leaves SQLite" migration.
The interfaces below define the surface the routes / coach agent rely on for
plan, commentary, and InBody state. SQLite implementations wrap the existing
``Database`` class so behavior is unchanged. A future Azure Table backend can
implement the same Protocols without route-side changes.

Watch-synced tables (``activities`` / ``laps`` / ``zones`` / ``timeseries`` /
``daily_health`` / ``daily_hrv`` / ``dashboard`` / ``race_predictions`` /
``sync_meta`` / ``ability_*``) intentionally stay direct on ``Database`` — they
won't move out, so the abstraction tax isn't worth paying for them.

Notes on shape:

- All read methods return ``Mapping[str, Any]``. ``sqlite3.Row`` satisfies
  this naturally (string-indexable + iterable). An Azure Table implementation
  can return ``TableEntity`` or a plain dict.
- ``apply_weekly_plan_atomic`` replaces the previous ``commit=False, conn=...``
  pattern that leaked SQLite-specific transaction mechanics into the agent.
  Backends are free to implement atomicity however suits them (single SQLite
  transaction; Azure Table entity batch within a partition; etc.).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Protocol

from stride_core.models import BodyCompositionScan
from stride_core.plan_spec import (
    PlannedNutrition,
    PlannedSession,
)


# ─────────────────────────────────────────────────────────────────────────────
# Protocols
# ─────────────────────────────────────────────────────────────────────────────


class PlanStateStore(Protocol):
    """Storage for weekly plans, planned sessions/nutrition, variants, and
    weekly feedback. Everything spec-related except the spec content itself
    (which is the authored markdown / JSON file plus, for now, the
    ``spec_json`` blob — that's slated for removal in a later phase)."""

    def close(self) -> None: ...

    # weekly_plan ---------------------------------------------------------

    def get_weekly_plan_row(self, week: str) -> Mapping[str, Any] | None: ...

    def upsert_weekly_plan(
        self, week: str, content_md: str, *, generated_by: str | None = None,
    ) -> None: ...

    def set_weekly_plan_structured_status(
        self, week: str, *, status: str,
        parsed_from_md_hash: str | None = None,
    ) -> None: ...

    def mark_plan_parse_failed(self, week: str) -> None: ...

    # weekly_feedback -----------------------------------------------------

    def get_weekly_feedback_row(
        self, week: str,
    ) -> Mapping[str, Any] | None: ...

    def upsert_weekly_feedback(
        self, week: str, content_md: str, *,
        generated_by: str | None = None,
    ) -> None: ...

    # planned_session / planned_nutrition ---------------------------------

    def get_planned_sessions(
        self, *, date_from: str | None = None,
        date_to: str | None = None,
        week_folder: str | None = None,
    ) -> list[Mapping[str, Any]]: ...

    def get_planned_nutrition(
        self, *, date_from: str | None = None,
        date_to: str | None = None,
        week_folder: str | None = None,
    ) -> list[Mapping[str, Any]]: ...

    def get_planned_session(
        self, planned_session_id: int,
    ) -> Mapping[str, Any] | None: ...

    def get_planned_session_by_date_index(
        self, date: str, session_index: int,
    ) -> Mapping[str, Any] | None: ...

    def set_planned_session_scheduled_workout(
        self, planned_session_id: int, scheduled_workout_id: int,
    ) -> None: ...

    # Atomic transaction --------------------------------------------------

    def apply_weekly_plan_atomic(
        self,
        week: str,
        content_md: str,
        *,
        generated_by: str | None,
        sessions: Sequence[PlannedSession] | None,
        nutrition: Sequence[PlannedNutrition] | None,
        structured_status: str | None,
        structured_source: str | None,
        parsed_from_md_hash: str | None,
    ) -> None:
        """Atomically: upsert content_md + generated_by, replace this week's
        ``planned_session`` and ``planned_nutrition`` rows if provided, and
        stamp ``structured_status`` / ``structured_source`` /
        ``structured_parsed_at``.

        ``sessions=None`` (or ``nutrition=None``) means "leave that list
        untouched". An empty sequence ``[]`` means "delete all rows for this
        week".
        """
        ...

    # Variants ------------------------------------------------------------

    def insert_weekly_plan_variant(
        self,
        *,
        week_folder: str,
        model_id: str,
        variant_index: int | None,
        schema_version: int,
        variant_parse_status: str,
        content_md: str,
        spec_json: str | None,
        generated_at: str,
        generation_metadata: str | None,
    ) -> int: ...

    def get_weekly_plan_variants(
        self, week_folder: str, *, include_superseded: bool = False,
    ) -> list[Mapping[str, Any]]: ...

    def get_weekly_plan_variant(
        self, variant_id: int,
    ) -> Mapping[str, Any] | None: ...

    def delete_weekly_plan_variants(self, week_folder: str) -> int: ...

    def upsert_variant_rating(
        self, *, variant_id: int, dimension: str, score: int,
        comment: str | None = None,
    ) -> None: ...

    def get_variant_ratings(
        self, variant_id: int,
    ) -> list[Mapping[str, Any]]: ...

    def select_weekly_plan_variant(
        self, user: str, week_folder: str, variant_id: int, *,
        force: bool = False,
    ) -> dict[str, Any]: ...


class CommentaryStore(Protocol):
    """Per-activity commentary rows. Author can be AOAI, Claude, or a human;
    the row carries ``generated_by`` so future overwrites stay deterministic.
    """

    def close(self) -> None: ...

    def get_activity_commentary_row(
        self, label_id: str,
    ) -> Mapping[str, Any] | None: ...

    def upsert_activity_commentary(
        self, label_id: str, commentary: str, *,
        generated_by: str | None = None,
    ) -> None: ...


class InBodyStore(Protocol):
    """InBody body-composition scans + per-segment breakdown. Authoring is
    out-of-band (OCR from JPG into a sidecar JSON), but the rows are queried
    constantly by the coach context + dashboard."""

    def close(self) -> None: ...

    def upsert_inbody_scan(self, scan: BodyCompositionScan) -> None: ...

    def list_inbody_scans(
        self, days: int | None = None,
    ) -> list[Mapping[str, Any]]: ...

    def get_inbody_scan(
        self, scan_date: str,
    ) -> Mapping[str, Any] | None: ...

    def get_inbody_segments(
        self, scan_date: str,
    ) -> list[Mapping[str, Any]]: ...

    def latest_inbody_scan(self) -> Mapping[str, Any] | None: ...

    def inbody_scan_before(
        self, scan_date: str,
    ) -> Mapping[str, Any] | None: ...


# ─────────────────────────────────────────────────────────────────────────────
# SQLite implementations — pure delegation to existing Database methods
# ─────────────────────────────────────────────────────────────────────────────


class SqlitePlanStateStore:
    """``PlanStateStore`` backed by the per-user SQLite ``Database``."""

    def __init__(self, db: Any) -> None:
        # ``db`` is ``stride_core.db.Database``; typed as Any here to avoid a
        # circular import (db.py imports nothing from this module).
        self._db = db

    def close(self) -> None:
        self._db.close()

    # weekly_plan

    def get_weekly_plan_row(self, week: str) -> Mapping[str, Any] | None:
        return self._db.get_weekly_plan_row(week)

    def upsert_weekly_plan(
        self, week: str, content_md: str, *,
        generated_by: str | None = None,
    ) -> None:
        self._db.upsert_weekly_plan(week, content_md, generated_by=generated_by)

    def set_weekly_plan_structured_status(
        self, week: str, *, status: str,
        parsed_from_md_hash: str | None = None,
    ) -> None:
        self._db.set_weekly_plan_structured_status(
            week, status=status, parsed_from_md_hash=parsed_from_md_hash,
        )

    def mark_plan_parse_failed(self, week: str) -> None:
        self._db.mark_plan_parse_failed(week)

    # weekly_feedback

    def get_weekly_feedback_row(self, week: str) -> Mapping[str, Any] | None:
        return self._db.get_weekly_feedback_row(week)

    def upsert_weekly_feedback(
        self, week: str, content_md: str, *,
        generated_by: str | None = None,
    ) -> None:
        self._db.upsert_weekly_feedback(
            week, content_md, generated_by=generated_by,
        )

    # planned_session / planned_nutrition

    def get_planned_sessions(
        self, *, date_from: str | None = None,
        date_to: str | None = None,
        week_folder: str | None = None,
    ) -> list[Mapping[str, Any]]:
        return self._db.get_planned_sessions(
            date_from=date_from, date_to=date_to, week_folder=week_folder,
        )

    def get_planned_nutrition(
        self, *, date_from: str | None = None,
        date_to: str | None = None,
        week_folder: str | None = None,
    ) -> list[Mapping[str, Any]]:
        return self._db.get_planned_nutrition(
            date_from=date_from, date_to=date_to, week_folder=week_folder,
        )

    def get_planned_session(
        self, planned_session_id: int,
    ) -> Mapping[str, Any] | None:
        return self._db.get_planned_session(planned_session_id)

    def get_planned_session_by_date_index(
        self, date: str, session_index: int,
    ) -> Mapping[str, Any] | None:
        return self._db.get_planned_session_by_date_index(date, session_index)

    def set_planned_session_scheduled_workout(
        self, planned_session_id: int, scheduled_workout_id: int,
    ) -> None:
        self._db.set_planned_session_scheduled_workout(
            planned_session_id, scheduled_workout_id,
        )

    # Atomic transaction

    def apply_weekly_plan_atomic(
        self,
        week: str,
        content_md: str,
        *,
        generated_by: str | None,
        sessions: Sequence[PlannedSession] | None,
        nutrition: Sequence[PlannedNutrition] | None,
        structured_status: str | None,
        structured_source: str | None,
        parsed_from_md_hash: str | None,
    ) -> None:
        # Uses ``commit=False, conn=<dedicated immediate-txn>`` under the
        # hood — same mechanics as the previous in-line agent code, now
        # encapsulated so callers don't deal with a sqlite3.Connection.
        txn = self._db.open_immediate_txn()
        try:
            self._db.upsert_weekly_plan(
                week, content_md, generated_by=generated_by,
                commit=False, conn=txn,
            )
            if sessions is not None:
                self._db.upsert_planned_sessions(
                    week, list(sessions), commit=False, conn=txn,
                )
            if nutrition is not None:
                self._db.upsert_planned_nutrition(
                    week, list(nutrition), commit=False, conn=txn,
                )
            if structured_status is not None:
                self._db.set_weekly_plan_structured_status(
                    week,
                    status=structured_status,
                    parsed_from_md_hash=parsed_from_md_hash,
                    commit=False, conn=txn,
                )
                # Mirror structured_source — `set_weekly_plan_structured_status`
                # writes both status and source from the same value today, so
                # we don't need a separate column update.
                _ = structured_source  # kept in signature for future API parity
            txn.execute("COMMIT")
        except Exception:
            txn.execute("ROLLBACK")
            raise
        finally:
            txn.close()

    # Variants

    def insert_weekly_plan_variant(
        self,
        *,
        week_folder: str,
        model_id: str,
        variant_index: int | None,
        schema_version: int,
        variant_parse_status: str,
        content_md: str,
        spec_json: str | None,
        generated_at: str,
        generation_metadata: str | None,
    ) -> int:
        return self._db.insert_weekly_plan_variant(
            week_folder=week_folder,
            model_id=model_id,
            variant_index=variant_index,
            schema_version=schema_version,
            variant_parse_status=variant_parse_status,
            content_md=content_md,
            spec_json=spec_json,
            generated_at=generated_at,
            generation_metadata=generation_metadata,
        )

    def get_weekly_plan_variants(
        self, week_folder: str, *, include_superseded: bool = False,
    ) -> list[Mapping[str, Any]]:
        return self._db.get_weekly_plan_variants(
            week_folder, include_superseded=include_superseded,
        )

    def get_weekly_plan_variant(
        self, variant_id: int,
    ) -> Mapping[str, Any] | None:
        return self._db.get_weekly_plan_variant(variant_id)

    def delete_weekly_plan_variants(self, week_folder: str) -> int:
        return self._db.delete_weekly_plan_variants(week_folder)

    def upsert_variant_rating(
        self, *, variant_id: int, dimension: str, score: int,
        comment: str | None = None,
    ) -> None:
        self._db.upsert_variant_rating(
            variant_id=variant_id, dimension=dimension, score=score,
            comment=comment,
        )

    def get_variant_ratings(
        self, variant_id: int,
    ) -> list[Mapping[str, Any]]:
        return self._db.get_variant_ratings(variant_id)

    def select_weekly_plan_variant(
        self, user: str, week_folder: str, variant_id: int, *,
        force: bool = False,
    ) -> dict[str, Any]:
        return self._db.select_weekly_plan_variant(
            user, week_folder, variant_id, force=force,
        )


class SqliteCommentaryStore:
    def __init__(self, db: Any) -> None:
        self._db = db

    def close(self) -> None:
        self._db.close()

    def get_activity_commentary_row(
        self, label_id: str,
    ) -> Mapping[str, Any] | None:
        return self._db.get_activity_commentary_row(label_id)

    def upsert_activity_commentary(
        self, label_id: str, commentary: str, *,
        generated_by: str | None = None,
    ) -> None:
        self._db.upsert_activity_commentary(
            label_id, commentary, generated_by=generated_by,
        )


class SqliteInBodyStore:
    def __init__(self, db: Any) -> None:
        self._db = db

    def close(self) -> None:
        self._db.close()

    def upsert_inbody_scan(self, scan: BodyCompositionScan) -> None:
        self._db.upsert_inbody_scan(scan)

    def list_inbody_scans(
        self, days: int | None = None,
    ) -> list[Mapping[str, Any]]:
        return self._db.list_inbody_scans(days)

    def get_inbody_scan(
        self, scan_date: str,
    ) -> Mapping[str, Any] | None:
        return self._db.get_inbody_scan(scan_date)

    def get_inbody_segments(
        self, scan_date: str,
    ) -> list[Mapping[str, Any]]:
        return self._db.get_inbody_segments(scan_date)

    def latest_inbody_scan(self) -> Mapping[str, Any] | None:
        return self._db.latest_inbody_scan()

    def inbody_scan_before(
        self, scan_date: str,
    ) -> Mapping[str, Any] | None:
        rows = self._db._conn.execute(
            "SELECT * FROM inbody_scan WHERE scan_date < ? "
            "ORDER BY scan_date DESC LIMIT 1",
            (scan_date,),
        ).fetchall()
        return rows[0] if rows else None
