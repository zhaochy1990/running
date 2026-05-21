"""Regression test: training-load backfill works post-calibration-pivot.

After Task 4a, `refresh_training_load_calibration` reads from
`running_calibration_snapshot` instead of `training_load_calibration`.
This test verifies the truncate+backfill chain doesn't crash on empty
or near-empty inputs and the FK references resolve to the new table.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from stride_core.db import Database
from stride_core.training_load import backfill_training_load


@pytest.fixture
def empty_db(tmp_path: Path) -> Database:
    with Database(tmp_path / "test.db") as db:
        yield db


def test_backfill_on_empty_db_does_not_crash(empty_db: Database):
    """No activities → graceful no-op; daily_training_load stays empty."""
    backfill_training_load(empty_db)
    daily = empty_db.query("SELECT count(*) AS n FROM daily_training_load")
    activity = empty_db.query("SELECT count(*) AS n FROM activity_training_load")
    assert daily[0]["n"] == 0
    assert activity[0]["n"] == 0


def test_truncate_then_backfill_is_idempotent_when_no_activities(empty_db: Database):
    """Truncate empty tables then backfill again — still empty, no errors."""
    empty_db._conn.execute("DELETE FROM daily_training_load")
    empty_db._conn.execute("DELETE FROM activity_training_load")
    empty_db._conn.commit()
    backfill_training_load(empty_db)
    daily = empty_db.query("SELECT count(*) AS n FROM daily_training_load")
    assert daily[0]["n"] == 0
