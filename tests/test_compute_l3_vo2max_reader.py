"""Tests for the per-race_type top-vdot reader query used by
compute_ability_snapshot when blending PB history into L3 vo2max."""
from __future__ import annotations

import pytest

from stride_core.db import Database


READER_QUERY = """
SELECT race_type, distance_m, duration_s, vdot, pb_date, label_id, even_paced
FROM (
    SELECT race_type, distance_m, duration_s, vdot, pb_date, label_id, even_paced,
           ROW_NUMBER() OVER (
             PARTITION BY race_type
             ORDER BY vdot DESC, pb_date DESC
           ) AS rn
    FROM vo2max_pb
)
WHERE rn = 1
"""


def _insert_pb(db, race_type, label_id, vdot, pb_date,
               distance_m=5000.0, duration_s=1200.0):
    db._conn.execute(
        "INSERT INTO vo2max_pb (race_type, distance_m, duration_s, vdot, "
        "pb_date, label_id, even_paced, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'))",
        (race_type, distance_m, duration_s, vdot, pb_date, label_id),
    )
    db._conn.commit()


def test_reader_picks_highest_vdot_when_multiple_rows_same_race_type(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    _insert_pb(db, "5K", "OLD", vdot=49.8, pb_date="2026-04-24")
    _insert_pb(db, "5K", "NEW", vdot=51.2, pb_date="2026-05-27")

    rows = list(db._conn.execute(READER_QUERY))
    assert len(rows) == 1
    assert rows[0]["race_type"] == "5K"
    assert rows[0]["label_id"] == "NEW"
    assert rows[0]["vdot"] == pytest.approx(51.2)


def test_reader_tie_break_prefers_newer_pb_date(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    _insert_pb(db, "5K", "OLDER", vdot=50.0, pb_date="2026-04-24")
    _insert_pb(db, "5K", "NEWER", vdot=50.0, pb_date="2026-05-27")
    rows = list(db._conn.execute(READER_QUERY))
    assert rows[0]["label_id"] == "NEWER"


def test_reader_one_row_per_race_type(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    _insert_pb(db, "5K", "A", vdot=51.0, pb_date="2026-05-27")
    _insert_pb(db, "5K", "B", vdot=50.0, pb_date="2026-04-24")
    _insert_pb(db, "10K", "C", vdot=52.0, pb_date="2026-04-25",
               distance_m=10000.0)
    _insert_pb(db, "10K", "D", vdot=51.5, pb_date="2026-03-15",
               distance_m=10000.0)
    rows = list(db._conn.execute(READER_QUERY))
    by_type = {r["race_type"]: r for r in rows}
    assert set(by_type) == {"5K", "10K"}
    assert by_type["5K"]["label_id"] == "A"
    assert by_type["10K"]["label_id"] == "C"


def test_reader_empty_table(tmp_path):
    db = Database(db_path=tmp_path / "coros.db")
    rows = list(db._conn.execute(READER_QUERY))
    assert rows == []


def test_ability_module_uses_this_query():
    """Guard against the query in ability.py drifting from this test's copy."""
    from pathlib import Path
    import re
    src = Path(__file__).parent.parent / "src" / "stride_core" / "ability.py"
    text = src.read_text(encoding="utf-8")
    pattern = re.compile(
        r"ROW_NUMBER\(\)\s+OVER\s*\(\s*PARTITION\s+BY\s+race_type\s+"
        r"ORDER\s+BY\s+vdot\s+DESC", re.IGNORECASE
    )
    assert pattern.search(text), (
        "ability.py no longer contains the expected PARTITION BY race_type "
        "ORDER BY vdot DESC reader — either revert the change or update this test"
    )
