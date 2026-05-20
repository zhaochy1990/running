"""Tests for body-composition DB upsert/read helpers."""

from stride_core.models import BodyCompositionScan


def _make_scan(scan_date: str = "2026-04-23", *, weight: float = 71.6) -> BodyCompositionScan:
    return BodyCompositionScan.from_dict({
        "scan_date": scan_date,
        "weight_kg": weight, "body_fat_pct": 22.9, "smm_kg": 31.1,
        "fat_mass_kg": 16.4, "visceral_fat_level": 5,
        "inbody_score": 68,
        "segments": [
            {"segment": "left_arm",  "lean_mass_kg": 2.59, "fat_mass_kg": 1.0, "lean_pct_of_standard": 76.1},
            {"segment": "right_arm", "lean_mass_kg": 2.66, "fat_mass_kg": 1.0, "lean_pct_of_standard": 78.0},
            {"segment": "trunk",     "lean_mass_kg": 23.2, "fat_mass_kg": 7.8, "lean_pct_of_standard": 85.2},
            {"segment": "left_leg",  "lean_mass_kg": 9.83, "fat_mass_kg": 2.8, "lean_pct_of_standard": 103.8},
            {"segment": "right_leg", "lean_mass_kg": 9.99, "fat_mass_kg": 2.8, "lean_pct_of_standard": 105.5},
        ],
    })


class TestBodyCompositionUpsert:
    def test_roundtrip(self, db):
        scan = _make_scan()
        db.upsert_body_composition_scan(scan)
        row = db.get_body_composition_scan("2026-04-23")
        assert row is not None
        assert dict(row)["weight_kg"] == 71.6
        segs = db.get_body_composition_segments("2026-04-23")
        assert len(segs) == 5
        assert {dict(s)["segment"] for s in segs} == {
            "left_arm", "right_arm", "trunk", "left_leg", "right_leg"
        }

    def test_idempotent(self, db):
        db.upsert_body_composition_scan(_make_scan())
        db.upsert_body_composition_scan(_make_scan())
        assert len(db.list_body_composition_scans()) == 1
        assert len(db.get_body_composition_segments("2026-04-23")) == 5

    def test_reupsert_replaces_segments(self, db):
        db.upsert_body_composition_scan(_make_scan())
        # Re-upsert with different weight and same segments — should not duplicate
        db.upsert_body_composition_scan(_make_scan(weight=72.0))
        row = db.get_body_composition_scan("2026-04-23")
        assert dict(row)["weight_kg"] == 72.0
        assert len(db.get_body_composition_segments("2026-04-23")) == 5

    def test_list_newest_first(self, db):
        db.upsert_body_composition_scan(_make_scan("2026-04-01"))
        db.upsert_body_composition_scan(_make_scan("2026-04-23"))
        db.upsert_body_composition_scan(_make_scan("2026-04-10"))
        scans = db.list_body_composition_scans()
        dates = [dict(s)["scan_date"] for s in scans]
        assert dates == ["2026-04-23", "2026-04-10", "2026-04-01"]

    def test_latest(self, db):
        assert db.latest_body_composition_scan() is None
        db.upsert_body_composition_scan(_make_scan("2026-04-01"))
        db.upsert_body_composition_scan(_make_scan("2026-04-23"))
        latest = db.latest_body_composition_scan()
        assert dict(latest)["scan_date"] == "2026-04-23"

    def test_get_missing_returns_none(self, db):
        assert db.get_body_composition_scan("2099-01-01") is None
        assert db.get_body_composition_segments("2099-01-01") == []

    def test_upsert_without_segments_preserves_existing(self, db):
        """Main-metrics-only correction must not erase existing segment rows."""
        db.upsert_body_composition_scan(_make_scan(weight=71.6))
        assert len(db.get_body_composition_segments("2026-04-23")) == 5

        from stride_core.models import BodyCompositionScan
        bare = BodyCompositionScan.from_dict({
            "scan_date": "2026-04-23",
            "weight_kg": 72.0, "body_fat_pct": 22.5, "smm_kg": 31.2,
            "fat_mass_kg": 16.1, "visceral_fat_level": 5,
        })
        assert bare.segments == []
        db.upsert_body_composition_scan(bare)

        row = db.get_body_composition_scan("2026-04-23")
        assert dict(row)["weight_kg"] == 72.0
        # Segment breakdown preserved — not silently wiped.
        assert len(db.get_body_composition_segments("2026-04-23")) == 5


def test_migration_renames_legacy_tables(tmp_path):
    """Existing inbody_scan / inbody_segment tables auto-rename on Database() open."""
    import sqlite3
    from stride_core.db import Database

    db_path = tmp_path / "coros.db"
    conn = sqlite3.connect(str(db_path))
    conn.executescript("""
        CREATE TABLE inbody_scan (
            scan_date TEXT PRIMARY KEY,
            jpg_path TEXT,
            weight_kg REAL NOT NULL,
            body_fat_pct REAL NOT NULL,
            smm_kg REAL NOT NULL,
            fat_mass_kg REAL NOT NULL,
            visceral_fat_level INTEGER NOT NULL,
            bmr_kcal INTEGER,
            protein_kg REAL,
            water_l REAL,
            smi REAL,
            inbody_score INTEGER,
            ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE inbody_segment (
            scan_date TEXT NOT NULL,
            segment TEXT NOT NULL,
            lean_mass_kg REAL NOT NULL,
            fat_mass_kg REAL NOT NULL,
            lean_pct_of_standard REAL,
            fat_pct_of_standard REAL,
            PRIMARY KEY (scan_date, segment)
        );
        INSERT INTO inbody_scan
            (scan_date, weight_kg, body_fat_pct, smm_kg, fat_mass_kg, visceral_fat_level)
            VALUES ('2026-04-23', 71.6, 22.9, 31.1, 16.4, 5);
        INSERT INTO inbody_segment
            (scan_date, segment, lean_mass_kg, fat_mass_kg)
            VALUES ('2026-04-23', 'left_arm', 2.59, 1.0);
    """)
    conn.commit()
    conn.close()

    with Database(db_path) as db:
        scan = db.get_body_composition_scan("2026-04-23")
        assert scan is not None
        assert dict(scan)["weight_kg"] == 71.6
        segs = db.get_body_composition_segments("2026-04-23")
        assert len(segs) == 1

        tables = {r[0] for r in db._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()}
        assert "inbody_scan" not in tables
        assert "inbody_segment" not in tables
        assert "body_composition_scan" in tables
        assert "body_composition_segment" in tables

    # Idempotent re-open: a second open on the already-migrated DB must not error.
    with Database(db_path) as db2:
        scan = db2.get_body_composition_scan("2026-04-23")
        assert scan is not None
        tables = {r[0] for r in db2._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()}
        assert "body_composition_scan" in tables
        assert "inbody_scan" not in tables
