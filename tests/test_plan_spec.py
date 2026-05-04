"""Tests for stride_core.plan_spec + planned_* DB helpers."""

from __future__ import annotations

import json

import pytest

from stride_core.plan_spec import (
    Meal,
    PlannedNutrition,
    PlannedSession,
    SessionKind,
    WeeklyPlan,
)
from stride_core.workout_spec import (
    Duration,
    NormalizedRunWorkout,
    NormalizedStrengthWorkout,
    StepKind,
    StrengthExerciseSpec,
    StrengthTargetKind,
    Target,
    WorkoutBlock,
    WorkoutStep,
)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _easy_run(date: str = "2026-04-22") -> NormalizedRunWorkout:
    return NormalizedRunWorkout(
        name="Easy 10K",
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


def _interval_run(date: str = "2026-04-23") -> NormalizedRunWorkout:
    """6×800m @ 4:00/km + 60s recovery — full RepeatGroup roundtrip."""
    return NormalizedRunWorkout(
        name="6x800m",
        date=date,
        blocks=(
            WorkoutBlock(
                steps=(
                    WorkoutStep(
                        step_kind=StepKind.WORK,
                        duration=Duration.of_distance_m(800),
                        target=Target.pace_range_s_km(245, 235),
                    ),
                    WorkoutStep(
                        step_kind=StepKind.RECOVERY,
                        duration=Duration.of_time_s(60),
                        target=Target.open(),
                    ),
                ),
                repeat=6,
            ),
        ),
    )


def _strength(date: str = "2026-04-22") -> NormalizedStrengthWorkout:
    return NormalizedStrengthWorkout(
        name="Core",
        date=date,
        exercises=(
            StrengthExerciseSpec(
                canonical_id="plank_basic",
                display_name="平板支撑",
                sets=3,
                target_kind=StrengthTargetKind.TIME_S,
                target_value=45,
                rest_seconds=30,
            ),
        ),
    )


# ─────────────────────────────────────────────────────────────────────────────
# WorkoutStep schema — hr_cap_bpm round-trip
# ─────────────────────────────────────────────────────────────────────────────


class TestWorkoutStepHrCap:
    def test_default_is_none(self):
        step = WorkoutStep(
            step_kind=StepKind.WORK,
            duration=Duration.of_distance_m(3000),
            target=Target.pace_range_s_km(250, 245),
        )
        assert step.hr_cap_bpm is None
        # to_dict still emits the key (None) so consumers get a stable shape.
        assert step.to_dict()["hr_cap_bpm"] is None

    def test_roundtrip_with_cap(self):
        step = WorkoutStep(
            step_kind=StepKind.WORK,
            duration=Duration.of_distance_m(3000),
            target=Target.pace_range_s_km(250, 245),
            hr_cap_bpm=167,
            note="HR ≤167",
        )
        round = WorkoutStep.from_dict(step.to_dict())
        assert round == step
        assert round.hr_cap_bpm == 167

    def test_legacy_dict_without_field_loads_as_none(self):
        # Pre-schema-change DB rows — `hr_cap_bpm` key absent entirely.
        legacy = {
            "step_kind": "work",
            "duration": {"kind": "distance_m", "value": 3000},
            "target": {"kind": "pace_s_km", "low": 250, "high": 245},
            "note": None,
        }
        step = WorkoutStep.from_dict(legacy)
        assert step.hr_cap_bpm is None


# ─────────────────────────────────────────────────────────────────────────────
# PlannedSession schema
# ─────────────────────────────────────────────────────────────────────────────


class TestPlannedSession:
    def test_run_with_spec_pushable(self):
        ps = PlannedSession(
            date="2026-04-22",
            session_index=0,
            kind=SessionKind.RUN,
            summary="Easy 10K",
            spec=_easy_run(),
        )
        assert ps.pushable is True

    def test_run_without_spec_not_pushable(self):
        ps = PlannedSession(
            date="2026-04-22",
            session_index=0,
            kind=SessionKind.RUN,
            summary="Easy 10km, pace TBD",
            spec=None,
        )
        assert ps.pushable is False

    def test_strength_with_spec_pushable(self):
        ps = PlannedSession(
            date="2026-04-22",
            session_index=1,
            kind=SessionKind.STRENGTH,
            summary="Core 30min",
            spec=_strength(),
        )
        assert ps.pushable is True

    def test_strength_without_spec_not_pushable(self):
        ps = PlannedSession(
            date="2026-04-22",
            session_index=1,
            kind=SessionKind.STRENGTH,
            summary="TBD",
            spec=None,
        )
        assert ps.pushable is False

    def test_rest_is_not_pushable(self):
        ps = PlannedSession(
            date="2026-04-21",
            session_index=0,
            kind=SessionKind.REST,
            summary="完全休息",
        )
        assert ps.pushable is False

    @pytest.mark.parametrize("kind", [SessionKind.REST, SessionKind.CROSS, SessionKind.NOTE])
    def test_non_pushable_kind_rejects_spec(self, kind):
        with pytest.raises(ValueError, match="spec must be None"):
            PlannedSession(
                date="2026-04-22",
                session_index=0,
                kind=kind,
                summary="x",
                spec=_easy_run(),
            )

    def test_run_rejects_strength_spec(self):
        with pytest.raises(ValueError, match="kind=run requires"):
            PlannedSession(
                date="2026-04-22",
                session_index=0,
                kind=SessionKind.RUN,
                summary="x",
                spec=_strength(),
            )

    def test_strength_rejects_run_spec(self):
        with pytest.raises(ValueError, match="kind=strength requires"):
            PlannedSession(
                date="2026-04-22",
                session_index=0,
                kind=SessionKind.STRENGTH,
                summary="x",
                spec=_easy_run(),
            )

    def test_invalid_date(self):
        with pytest.raises(ValueError, match="date must be ISO"):
            PlannedSession(
                date="20260422",
                session_index=0,
                kind=SessionKind.REST,
                summary="rest",
            )

    def test_negative_session_index(self):
        with pytest.raises(ValueError, match="session_index"):
            PlannedSession(
                date="2026-04-22",
                session_index=-1,
                kind=SessionKind.REST,
                summary="rest",
            )

    def test_roundtrip_run_with_intervals(self):
        original = PlannedSession(
            date="2026-04-23",
            session_index=0,
            kind=SessionKind.RUN,
            summary="6×800m",
            spec=_interval_run(),
            notes_md="主项",
            total_distance_m=4800.0,
            total_duration_s=1500.0,
        )
        restored = PlannedSession.from_dict(original.to_dict())
        assert restored == original
        # Confirm the inner spec preserved RepeatGroup structure
        assert restored.spec is not None
        assert restored.spec.blocks[0].repeat == 6
        assert len(restored.spec.blocks[0].steps) == 2

    def test_roundtrip_aspirational_run(self):
        original = PlannedSession(
            date="2026-04-22",
            session_index=0,
            kind=SessionKind.RUN,
            summary="Easy 10km, pace TBD",
            spec=None,
        )
        restored = PlannedSession.from_dict(original.to_dict())
        assert restored == original
        assert restored.pushable is False

    def test_roundtrip_rest(self):
        original = PlannedSession(
            date="2026-04-21",
            session_index=0,
            kind=SessionKind.REST,
            summary="完全休息",
            notes_md="多睡一小时",
        )
        restored = PlannedSession.from_dict(original.to_dict())
        assert restored == original

    def test_to_dict_carries_schema_tag(self):
        d = PlannedSession(
            date="2026-04-21",
            session_index=0,
            kind=SessionKind.REST,
            summary="rest",
        ).to_dict()
        assert d["schema"] == "plan-session/v1"


# ─────────────────────────────────────────────────────────────────────────────
# PlannedNutrition / Meal
# ─────────────────────────────────────────────────────────────────────────────


class TestPlannedNutrition:
    def test_roundtrip(self):
        nutrition = PlannedNutrition(
            date="2026-04-22",
            kcal_target=2400,
            carbs_g=300,
            protein_g=140,
            fat_g=80,
            water_ml=3000,
            meals=(
                Meal(name="早餐", time_hint="7:30", kcal=600, carbs_g=80,
                     protein_g=30, fat_g=15, items_md="燕麦 80g + 鸡蛋 2 个"),
                Meal(name="午餐", time_hint="12:30", kcal=900),
                Meal(name="晚餐", time_hint="19:00", kcal=900),
            ),
            notes_md="跑日 +50g 碳水",
        )
        restored = PlannedNutrition.from_dict(nutrition.to_dict())
        assert restored == nutrition

    def test_invalid_date(self):
        with pytest.raises(ValueError, match="date must be ISO"):
            PlannedNutrition(date="04-22-2026")

    def test_to_dict_carries_schema_tag(self):
        d = PlannedNutrition(date="2026-04-22").to_dict()
        assert d["schema"] == "plan-nutrition/v1"

    def test_empty_meals_default(self):
        n = PlannedNutrition(date="2026-04-22")
        assert n.meals == ()


# ─────────────────────────────────────────────────────────────────────────────
# WeeklyPlan container
# ─────────────────────────────────────────────────────────────────────────────


class TestWeeklyPlan:
    def test_roundtrip_full_week(self):
        wp = WeeklyPlan(
            week_folder="2026-04-20_04-26(W0)",
            sessions=(
                PlannedSession(
                    date="2026-04-22", session_index=0,
                    kind=SessionKind.RUN, summary="Easy 10K",
                    spec=_easy_run(),
                ),
                PlannedSession(
                    date="2026-04-22", session_index=1,
                    kind=SessionKind.STRENGTH, summary="Core",
                    spec=_strength(),
                ),
                PlannedSession(
                    date="2026-04-23", session_index=0,
                    kind=SessionKind.RUN, summary="6×800m",
                    spec=_interval_run(),
                ),
                PlannedSession(
                    date="2026-04-21", session_index=0,
                    kind=SessionKind.REST, summary="完全休息",
                ),
            ),
            nutrition=(
                PlannedNutrition(date="2026-04-22", kcal_target=2400),
                PlannedNutrition(date="2026-04-23", kcal_target=2600),
            ),
            notes_md="W0 introduction",
        )
        restored = WeeklyPlan.from_dict(wp.to_dict())
        assert restored == wp

    def test_default_empty(self):
        wp = WeeklyPlan(week_folder="2026-04-20_04-26(W0)")
        assert wp.sessions == ()
        assert wp.nutrition == ()


# ─────────────────────────────────────────────────────────────────────────────
# DB helpers
# ─────────────────────────────────────────────────────────────────────────────


class TestPlannedSessionDB:
    def test_upsert_then_fetch(self, db):
        sessions = [
            PlannedSession(
                date="2026-04-22", session_index=0,
                kind=SessionKind.RUN, summary="Easy 10K",
                spec=_easy_run(),
            ),
            PlannedSession(
                date="2026-04-22", session_index=1,
                kind=SessionKind.STRENGTH, summary="Core",
                spec=_strength(),
            ),
            PlannedSession(
                date="2026-04-21", session_index=0,
                kind=SessionKind.REST, summary="rest",
            ),
        ]
        ids = db.upsert_planned_sessions("2026-04-20_04-26(W0)", sessions)
        assert len(ids) == 3
        rows = db.get_planned_sessions(week_folder="2026-04-20_04-26(W0)")
        assert len(rows) == 3
        # Ordering by date then session_index
        assert rows[0]["date"] == "2026-04-21"
        assert rows[1]["date"] == "2026-04-22"
        assert rows[1]["session_index"] == 0
        assert rows[2]["date"] == "2026-04-22"
        assert rows[2]["session_index"] == 1
        # Spec_json roundtrip — RepeatGroup-equivalent integrity
        spec_dict = json.loads(rows[1]["spec_json"])
        # rows[1] is the session_index=0 RUN — easy run
        assert spec_dict["name"] == "Easy 10K"
        # The aspirational/non-pushable REST has spec_json NULL
        assert rows[0]["spec_json"] is None

    def test_upsert_idempotent(self, db):
        wf = "2026-04-20_04-26(W0)"
        sessions = [
            PlannedSession(
                date="2026-04-22", session_index=0,
                kind=SessionKind.RUN, summary="v1", spec=_easy_run(),
            ),
        ]
        ids1 = db.upsert_planned_sessions(wf, sessions)
        # Second call wipes prior rows; total still 1
        sessions_v2 = [
            PlannedSession(
                date="2026-04-22", session_index=0,
                kind=SessionKind.RUN, summary="v2", spec=_easy_run(),
            ),
        ]
        ids2 = db.upsert_planned_sessions(wf, sessions_v2)
        assert ids1 != ids2  # new row each time (DELETE then INSERT)
        rows = db.get_planned_sessions(week_folder=wf)
        assert len(rows) == 1
        assert rows[0]["summary"] == "v2"

    def test_upsert_different_weeks_isolated(self, db):
        db.upsert_planned_sessions(
            "2026-04-20_04-26(W0)",
            [PlannedSession(date="2026-04-22", session_index=0,
                            kind=SessionKind.REST, summary="rest")],
        )
        db.upsert_planned_sessions(
            "2026-04-27_05-03(W1)",
            [PlannedSession(date="2026-04-29", session_index=0,
                            kind=SessionKind.REST, summary="rest")],
        )
        # W0 stays intact when W1 is upserted
        assert len(db.get_planned_sessions(week_folder="2026-04-20_04-26(W0)")) == 1
        assert len(db.get_planned_sessions(week_folder="2026-04-27_05-03(W1)")) == 1

    def test_date_range_query(self, db):
        db.upsert_planned_sessions(
            "2026-04-20_04-26(W0)",
            [
                PlannedSession(date="2026-04-21", session_index=0,
                               kind=SessionKind.REST, summary="r"),
                PlannedSession(date="2026-04-22", session_index=0,
                               kind=SessionKind.REST, summary="r"),
                PlannedSession(date="2026-04-26", session_index=0,
                               kind=SessionKind.REST, summary="r"),
            ],
        )
        rows = db.get_planned_sessions(date_from="2026-04-22", date_to="2026-04-25")
        assert len(rows) == 1
        assert rows[0]["date"] == "2026-04-22"

    def test_set_scheduled_workout_fk(self, db):
        wf = "2026-04-20_04-26(W0)"
        ids = db.upsert_planned_sessions(
            wf,
            [PlannedSession(date="2026-04-22", session_index=0,
                            kind=SessionKind.RUN, summary="Easy",
                            spec=_easy_run())],
        )
        sw_id = db.create_scheduled_workout(
            date="2026-04-22", kind="run", name="[STRIDE] Easy",
            spec_json=json.dumps(_easy_run().to_dict()), status="pushed",
        )
        db.set_planned_session_scheduled_workout(ids[0], sw_id)
        row = db.get_planned_session(ids[0])
        assert row["scheduled_workout_id"] == sw_id


class TestPlannedNutritionDB:
    def test_upsert_then_fetch(self, db):
        nutrition = [
            PlannedNutrition(
                date="2026-04-22", kcal_target=2400, carbs_g=300,
                meals=(Meal(name="早餐", kcal=600),),
            ),
            PlannedNutrition(date="2026-04-23", kcal_target=2600),
        ]
        db.upsert_planned_nutrition("2026-04-20_04-26(W0)", nutrition)
        rows = db.get_planned_nutrition(week_folder="2026-04-20_04-26(W0)")
        assert len(rows) == 2
        assert rows[0]["date"] == "2026-04-22"
        assert rows[0]["kcal_target"] == 2400
        meals = json.loads(rows[0]["meals_json"])
        assert meals[0]["name"] == "早餐"
        assert rows[1]["date"] == "2026-04-23"
        assert json.loads(rows[1]["meals_json"]) == []

    def test_upsert_idempotent_replaces_week(self, db):
        wf = "2026-04-20_04-26(W0)"
        db.upsert_planned_nutrition(
            wf, [PlannedNutrition(date="2026-04-22", kcal_target=2400)]
        )
        db.upsert_planned_nutrition(
            wf, [PlannedNutrition(date="2026-04-22", kcal_target=2500)]
        )
        rows = db.get_planned_nutrition(week_folder=wf)
        assert len(rows) == 1
        assert rows[0]["kcal_target"] == 2500


class TestStructuredStatus:
    def test_set_status_then_read(self, db):
        db.upsert_weekly_plan("2026-04-20_04-26(W0)", "# Plan", generated_by="claude-opus-4-7")
        db.set_weekly_plan_structured_status(
            "2026-04-20_04-26(W0)", status="fresh",
            parsed_from_md_hash="abc123",
        )
        row = dict(db._conn.execute(
            "SELECT structured_status, structured_parsed_at, parsed_from_md_hash "
            "FROM weekly_plan WHERE week = ?",
            ("2026-04-20_04-26(W0)",),
        ).fetchone())
        assert row["structured_status"] == "fresh"
        assert row["structured_parsed_at"] is not None
        assert row["parsed_from_md_hash"] == "abc123"

    def test_mark_parse_failed(self, db):
        db.upsert_weekly_plan("2026-04-20_04-26(W0)", "# Plan")
        db.mark_plan_parse_failed("2026-04-20_04-26(W0)")
        row = dict(db._conn.execute(
            "SELECT structured_status FROM weekly_plan WHERE week = ?",
            ("2026-04-20_04-26(W0)",),
        ).fetchone())
        assert row["structured_status"] == "parse_failed"
