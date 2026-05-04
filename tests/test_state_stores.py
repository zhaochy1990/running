"""Smoke tests for the Phase 1 state-store abstraction.

These confirm that the SQLite-backed implementations produce the same
results as the underlying ``Database`` calls, so route consumers can be
migrated to the store interface without behavior changes.
"""

from __future__ import annotations

import json

import pytest

from stride_core.db import Database
from stride_core.plan_spec import (
    PlannedNutrition,
    PlannedSession,
    SessionKind,
)
from stride_core.state_stores import (
    SqliteCommentaryStore,
    SqliteInBodyStore,
    SqlitePlanStateStore,
)
from stride_core.workout_spec import (
    Duration,
    NormalizedRunWorkout,
    StepKind,
    Target,
    WorkoutBlock,
    WorkoutStep,
)


@pytest.fixture
def db(tmp_path):
    d = Database(tmp_path / "test.db")
    yield d
    d.close()


def _make_run_session(date: str, idx: int = 0) -> PlannedSession:
    spec = NormalizedRunWorkout(
        name="Easy",
        date=date,
        blocks=(
            WorkoutBlock(
                steps=(
                    WorkoutStep(
                        step_kind=StepKind.WORK,
                        duration=Duration.of_distance_km(10),
                        target=Target.pace_range_s_km(360, 330),
                    ),
                ),
                repeat=1,
            ),
        ),
    )
    return PlannedSession(
        date=date,
        session_index=idx,
        kind=SessionKind.RUN,
        summary="Easy 10K",
        spec=spec,
    )


# ─────────────────────────────────────────────────────────────────────────────
# PlanStateStore
# ─────────────────────────────────────────────────────────────────────────────


class TestSqlitePlanStateStore:
    def test_weekly_plan_roundtrip(self, db):
        store = SqlitePlanStateStore(db)
        store.upsert_weekly_plan(
            "2026-04-20_04-26(W0)", "# Week", generated_by="user",
        )
        row = store.get_weekly_plan_row("2026-04-20_04-26(W0)")
        assert row is not None
        assert row["content_md"] == "# Week"
        assert row["generated_by"] == "user"

    def test_weekly_feedback_roundtrip(self, db):
        store = SqlitePlanStateStore(db)
        store.upsert_weekly_feedback(
            "2026-04-20_04-26(W0)", "felt fine", generated_by="user",
        )
        row = store.get_weekly_feedback_row("2026-04-20_04-26(W0)")
        assert row is not None
        assert row["content_md"] == "felt fine"

    def test_planned_sessions_filter_by_week(self, db):
        store = SqlitePlanStateStore(db)
        # apply_weekly_plan_atomic seeds a week_folder + sessions atomically.
        store.apply_weekly_plan_atomic(
            "2026-04-20_04-26(W0)", "# Week",
            generated_by="user",
            sessions=[_make_run_session("2026-04-20"), _make_run_session("2026-04-22")],
            nutrition=[],
            structured_status="fresh",
            structured_source="fresh",
            parsed_from_md_hash="abc",
        )
        sessions = store.get_planned_sessions(week_folder="2026-04-20_04-26(W0)")
        assert len(sessions) == 2
        assert {s["date"] for s in sessions} == {"2026-04-20", "2026-04-22"}
        # Lookup by (date, session_index).
        single = store.get_planned_session_by_date_index("2026-04-20", 0)
        assert single is not None
        assert single["date"] == "2026-04-20"

    def test_planned_nutrition_filter_by_date(self, db):
        store = SqlitePlanStateStore(db)
        store.apply_weekly_plan_atomic(
            "2026-04-20_04-26(W0)", "# Week",
            generated_by="user",
            sessions=[],
            nutrition=[
                PlannedNutrition(
                    date="2026-04-20", kcal_target=2400, protein_g=130,
                ),
            ],
            structured_status="fresh",
            structured_source="fresh",
            parsed_from_md_hash="abc",
        )
        rows = store.get_planned_nutrition(
            date_from="2026-04-19", date_to="2026-04-21",
        )
        assert len(rows) == 1
        assert rows[0]["kcal_target"] == 2400

    def test_apply_weekly_plan_atomic_sets_status(self, db):
        store = SqlitePlanStateStore(db)
        store.apply_weekly_plan_atomic(
            "2026-04-20_04-26(W0)", "# Week",
            generated_by="user",
            sessions=None,
            nutrition=None,
            structured_status="parse_failed",
            structured_source="parse_failed",
            parsed_from_md_hash="hash1",
        )
        row = store.get_weekly_plan_row("2026-04-20_04-26(W0)")
        assert row["structured_status"] == "parse_failed"
        assert row["parsed_from_md_hash"] == "hash1"

    def test_apply_weekly_plan_atomic_replaces_sessions(self, db):
        store = SqlitePlanStateStore(db)
        # Seed with 2 sessions.
        store.apply_weekly_plan_atomic(
            "2026-04-20_04-26(W0)", "# Week",
            generated_by="user",
            sessions=[_make_run_session("2026-04-20"), _make_run_session("2026-04-22")],
            nutrition=[],
            structured_status="fresh",
            structured_source="fresh",
            parsed_from_md_hash="h1",
        )
        # Replace with 1 session.
        store.apply_weekly_plan_atomic(
            "2026-04-20_04-26(W0)", "# Week (v2)",
            generated_by="user",
            sessions=[_make_run_session("2026-04-21")],
            nutrition=[],
            structured_status="fresh",
            structured_source="fresh",
            parsed_from_md_hash="h2",
        )
        rows = store.get_planned_sessions(week_folder="2026-04-20_04-26(W0)")
        assert len(rows) == 1
        assert rows[0]["date"] == "2026-04-21"

    def test_set_planned_session_scheduled_workout(self, db):
        store = SqlitePlanStateStore(db)
        store.apply_weekly_plan_atomic(
            "2026-04-20_04-26(W0)", "# Week",
            generated_by="user",
            sessions=[_make_run_session("2026-04-20")],
            nutrition=[],
            structured_status="fresh",
            structured_source="fresh",
            parsed_from_md_hash="h",
        )
        row = store.get_planned_session_by_date_index("2026-04-20", 0)
        # Bind to a fake scheduled_workout id (no FK needed for this assertion;
        # the column is just a back-pointer integer).
        store.set_planned_session_scheduled_workout(row["id"], 999)
        row2 = store.get_planned_session(row["id"])
        assert row2["scheduled_workout_id"] == 999


# ─────────────────────────────────────────────────────────────────────────────
# CommentaryStore
# ─────────────────────────────────────────────────────────────────────────────


class TestSqliteCommentaryStore:
    def test_roundtrip(self, db):
        # Need an activity row first because activity_commentary FKs label_id
        # into activities. Insert a minimal activity directly.
        db._conn.execute(
            "INSERT INTO activities (label_id, sport_type, sport_name, date) "
            "VALUES (?, ?, 'Run', '2026-04-20T07:00:00')",
            ("act-1", 100),
        )
        db._conn.commit()

        store = SqliteCommentaryStore(db)
        store.upsert_activity_commentary(
            "act-1", "looked easy", generated_by="claude-opus-4-7",
        )
        row = store.get_activity_commentary_row("act-1")
        assert row is not None
        assert row["commentary"] == "looked easy"
        assert row["generated_by"] == "claude-opus-4-7"


# ─────────────────────────────────────────────────────────────────────────────
# InBodyStore
# ─────────────────────────────────────────────────────────────────────────────


class TestSqliteInBodyStore:
    def test_roundtrip(self, db):
        from stride_core.models import BodyCompositionScan, BodySegment

        store = SqliteInBodyStore(db)
        scan = BodyCompositionScan(
            scan_date="2026-04-20",
            jpg_path=None,
            weight_kg=68.0,
            body_fat_pct=12.5,
            smm_kg=33.0,
            fat_mass_kg=8.5,
            visceral_fat_level=4,
            bmr_kcal=1600,
            protein_kg=12.0,
            water_l=42.0,
            smi=8.5,
            inbody_score=82,
            segments=(
                BodySegment(
                    segment="left_arm", lean_mass_kg=2.5, fat_mass_kg=0.6,
                    lean_pct_of_standard=0.95, fat_pct_of_standard=0.5,
                ),
            ),
        )
        store.upsert_inbody_scan(scan)

        row = store.get_inbody_scan("2026-04-20")
        assert row is not None
        assert row["weight_kg"] == 68.0

        rows = store.list_inbody_scans()
        assert len(rows) == 1

        segs = store.get_inbody_segments("2026-04-20")
        assert len(segs) == 1
        assert segs[0]["segment"] == "left_arm"
