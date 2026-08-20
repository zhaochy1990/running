"""Tests for the ``activities.feel`` legacy-enum → unified 0-10 numeric backfill.

Older databases stored ``feel`` as a FeelLevel string
('excellent'/'good'/'normal'/'bad'/'awful'). The column is now REAL and adapters
write ``feel_type``-derived numbers (COROS ``feel_type × 2``, Garmin raw ÷ 10).
``Database._backfill_feel_numeric`` rebuilds the historical values from the
untouched raw ``feel_type`` column, keyed off ``provider`` for scale direction.
"""

from __future__ import annotations

from stride_core.models import ActivityDetail
from stride_storage.sqlite.database import Database


def _make_detail(label_id: str) -> ActivityDetail:
    return ActivityDetail(
        label_id=label_id, name="Test Run", sport_type=100,
        sport_name="Run", date="20260315", distance_m=10000, duration_s=3000,
        avg_pace_s_km=300, adjusted_pace=None, best_km_pace=None, max_pace=None,
        avg_hr=145, max_hr=170, avg_cadence=180, max_cadence=190,
        avg_power=None, max_power=None, avg_step_len_cm=None,
        ascent_m=None, descent_m=None, calories_kcal=500,
        aerobic_effect=None, anaerobic_effect=None,
        training_load=None, vo2max=None, performance=None, train_type=None,
        temperature=None, humidity=None, feels_like=None, wind_speed=None,
    )


def _seed_legacy_feel(db: Database, rows: list[tuple[str, str, object, str]]) -> None:
    """Insert well-formed activities, then overwrite feel with a legacy text enum.

    Each row is ``(label_id, legacy_feel_text, feel_type, provider)``.
    """
    for label_id, feel_text, feel_type, provider in rows:
        db.upsert_activity(_make_detail(label_id))
        db._conn.execute(
            "UPDATE activities SET feel = ?, feel_type = ?, provider = ? "
            "WHERE label_id = ?",
            (feel_text, feel_type, provider, label_id),
        )
    db._conn.commit()


def _feel_of(db: Database, label_id: str) -> object:
    return db._conn.execute(
        "SELECT feel FROM activities WHERE label_id = ?", (label_id,)
    ).fetchone()["feel"]


def test_backfill_converts_coros_and_garmin_legacy_enums(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    _seed_legacy_feel(
        db,
        [
            ("coros_good", "good", 2, "coros"),      # 2 * 2  = 4.0
            ("coros_awful", "awful", 5, "coros"),    # 5 * 2  = 10.0
            ("garmin_hi", "excellent", 90, "garmin"),  # 90 / 10 = 9.0
            ("garmin_lo", "bad", 30, "garmin"),        # 30 / 10 = 3.0
        ],
    )

    db._backfill_feel_numeric()

    assert _feel_of(db, "coros_good") == 4.0
    assert _feel_of(db, "coros_awful") == 10.0
    assert _feel_of(db, "garmin_hi") == 9.0
    assert _feel_of(db, "garmin_lo") == 3.0


def test_backfill_nulls_feel_when_feel_type_missing(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    _seed_legacy_feel(db, [("no_rating", "normal", None, "coros")])

    db._backfill_feel_numeric()

    assert _feel_of(db, "no_rating") is None


def test_backfill_leaves_already_numeric_values_untouched(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    # A row written by the current adapter path: feel is already numeric.
    db.upsert_activity(_make_detail("already"))
    db._conn.execute(
        "UPDATE activities SET feel = 6.0, feel_type = 3, provider = 'coros' "
        "WHERE label_id = 'already'"
    )
    db._conn.commit()

    db._backfill_feel_numeric()

    assert _feel_of(db, "already") == 6.0


def test_backfill_is_idempotent(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    _seed_legacy_feel(db, [("coros_good", "good", 2, "coros")])

    db._backfill_feel_numeric()
    db._backfill_feel_numeric()

    assert _feel_of(db, "coros_good") == 4.0


def test_legacy_feel_auto_backfills_on_open(tmp_path):
    """Opening a DB carrying legacy text-enum feel must convert it on open."""
    db_path = tmp_path / "coros.db"
    db = Database(db_path=db_path)
    _seed_legacy_feel(
        db,
        [
            ("coros_good", "good", 2, "coros"),
            ("garmin_hi", "excellent", 80, "garmin"),
        ],
    )
    db.close()

    reopened = Database(db_path=db_path)  # _migrate should run _backfill_feel_numeric
    assert _feel_of(reopened, "coros_good") == 4.0
    assert _feel_of(reopened, "garmin_hi") == 8.0
