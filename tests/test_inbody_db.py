"""Tests for InBody DB upsert/read helpers."""

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


class TestInBodyUpsert:
    def test_roundtrip(self, db):
        scan = _make_scan()
        db.upsert_inbody_scan(scan)
        row = db.get_inbody_scan("2026-04-23")
        assert row is not None
        assert dict(row)["weight_kg"] == 71.6
        segs = db.get_inbody_segments("2026-04-23")
        assert len(segs) == 5
        assert {dict(s)["segment"] for s in segs} == {
            "left_arm", "right_arm", "trunk", "left_leg", "right_leg"
        }

    def test_idempotent(self, db):
        db.upsert_inbody_scan(_make_scan())
        db.upsert_inbody_scan(_make_scan())
        assert len(db.list_inbody_scans()) == 1
        assert len(db.get_inbody_segments("2026-04-23")) == 5

    def test_reupsert_replaces_segments(self, db):
        db.upsert_inbody_scan(_make_scan())
        # Re-upsert with different weight and same segments — should not duplicate
        db.upsert_inbody_scan(_make_scan(weight=72.0))
        row = db.get_inbody_scan("2026-04-23")
        assert dict(row)["weight_kg"] == 72.0
        assert len(db.get_inbody_segments("2026-04-23")) == 5

    def test_list_newest_first(self, db):
        db.upsert_inbody_scan(_make_scan("2026-04-01"))
        db.upsert_inbody_scan(_make_scan("2026-04-23"))
        db.upsert_inbody_scan(_make_scan("2026-04-10"))
        scans = db.list_inbody_scans()
        dates = [dict(s)["scan_date"] for s in scans]
        assert dates == ["2026-04-23", "2026-04-10", "2026-04-01"]

    def test_latest(self, db):
        assert db.latest_inbody_scan() is None
        db.upsert_inbody_scan(_make_scan("2026-04-01"))
        db.upsert_inbody_scan(_make_scan("2026-04-23"))
        latest = db.latest_inbody_scan()
        assert dict(latest)["scan_date"] == "2026-04-23"

    def test_get_missing_returns_none(self, db):
        assert db.get_inbody_scan("2099-01-01") is None
        assert db.get_inbody_segments("2099-01-01") == []
