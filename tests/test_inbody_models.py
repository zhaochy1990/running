"""Tests for BodyCompositionScan / BodySegment validation."""

import pytest

from stride_core.models import BodyCompositionScan, BodySegment


def _segments_ok(**override):
    base = [
        {"segment": "left_arm",  "lean_mass_kg": 2.59, "fat_mass_kg": 1.0, "lean_pct_of_standard": 76.1},
        {"segment": "right_arm", "lean_mass_kg": 2.66, "fat_mass_kg": 1.0, "lean_pct_of_standard": 78.0},
        {"segment": "trunk",     "lean_mass_kg": 23.2, "fat_mass_kg": 7.8, "lean_pct_of_standard": 85.2},
        {"segment": "left_leg",  "lean_mass_kg": 9.83, "fat_mass_kg": 2.8, "lean_pct_of_standard": 103.8},
        {"segment": "right_leg", "lean_mass_kg": 9.99, "fat_mass_kg": 2.8, "lean_pct_of_standard": 105.5},
    ]
    for entry in base:
        for k, v in override.get(entry["segment"], {}).items():
            entry[k] = v
    return base


def _scan_ok(**override):
    data = {
        "scan_date": "2026-04-23",
        "weight_kg": 71.6, "body_fat_pct": 22.9, "smm_kg": 31.1,
        "fat_mass_kg": 16.4, "visceral_fat_level": 5,
        "bmr_kcal": 1563, "protein_kg": 11.0, "water_l": 40.2,
        "smi": 7.6, "inbody_score": 68,
        "segments": _segments_ok(),
    }
    data.update({k: v for k, v in override.items() if k != "segments"})
    if "segments" in override:
        data["segments"] = override["segments"]
    return data


class TestBodyCompositionScan:
    def test_happy_path(self):
        scan = BodyCompositionScan.from_dict(_scan_ok())
        assert scan.weight_kg == 71.6
        assert scan.smm_kg == 31.1
        assert scan.visceral_fat_level == 5
        assert len(scan.segments) == 5
        assert {s.segment for s in scan.segments} == {
            "left_arm", "right_arm", "trunk", "left_leg", "right_leg"
        }

    def test_optional_fields_default_none(self):
        data = _scan_ok()
        for k in ("bmr_kcal", "protein_kg", "water_l", "smi", "inbody_score"):
            data.pop(k)
        scan = BodyCompositionScan.from_dict(data)
        assert scan.bmr_kcal is None
        assert scan.protein_kg is None
        assert scan.inbody_score is None

    @pytest.mark.parametrize("weight", [9999, -5, "heavy", None])
    def test_reject_invalid_weight(self, weight):
        with pytest.raises(ValueError, match="weight_kg"):
            BodyCompositionScan.from_dict(_scan_ok(weight_kg=weight))

    @pytest.mark.parametrize("bf", [0, 60, -1, None])
    def test_reject_invalid_body_fat_pct(self, bf):
        with pytest.raises(ValueError, match="body_fat_pct"):
            BodyCompositionScan.from_dict(_scan_ok(body_fat_pct=bf))

    @pytest.mark.parametrize("smm", [0, 100, None])
    def test_reject_invalid_smm(self, smm):
        with pytest.raises(ValueError, match="smm_kg"):
            BodyCompositionScan.from_dict(_scan_ok(smm_kg=smm))

    @pytest.mark.parametrize("vf", [0, 25, 5.5, None])
    def test_reject_invalid_visceral_fat(self, vf):
        with pytest.raises(ValueError, match="visceral_fat_level"):
            BodyCompositionScan.from_dict(_scan_ok(visceral_fat_level=vf))

    @pytest.mark.parametrize("bad_date", ["20260423", "2026/04/23", "", None, "not-a-date"])
    def test_reject_invalid_scan_date(self, bad_date):
        with pytest.raises(ValueError, match="scan_date"):
            BodyCompositionScan.from_dict(_scan_ok(scan_date=bad_date))

    def test_reject_wrong_segment_count(self):
        segs = _segments_ok()[:4]
        with pytest.raises(ValueError, match="segments"):
            BodyCompositionScan.from_dict(_scan_ok(segments=segs))

    def test_reject_duplicate_segment_name(self):
        segs = _segments_ok()
        segs[1]["segment"] = "left_arm"  # duplicate
        with pytest.raises(ValueError, match="segments"):
            BodyCompositionScan.from_dict(_scan_ok(segments=segs))


class TestBodySegment:
    def test_happy_path(self):
        seg = BodySegment.from_dict({
            "segment": "left_leg", "lean_mass_kg": 9.83, "fat_mass_kg": 2.8,
            "lean_pct_of_standard": 103.8,
        })
        assert seg.segment == "left_leg"
        assert seg.lean_mass_kg == 9.83
        assert seg.lean_pct_of_standard == 103.8

    def test_optional_pct_can_be_none(self):
        seg = BodySegment.from_dict({
            "segment": "left_leg", "lean_mass_kg": 9.83, "fat_mass_kg": 2.8,
        })
        assert seg.lean_pct_of_standard is None

    def test_reject_unknown_segment(self):
        with pytest.raises(ValueError, match="segment"):
            BodySegment.from_dict({
                "segment": "head", "lean_mass_kg": 5.0, "fat_mass_kg": 0.5,
            })

    def test_reject_negative_lean(self):
        with pytest.raises(ValueError, match="lean_mass_kg"):
            BodySegment.from_dict({
                "segment": "left_leg", "lean_mass_kg": -1, "fat_mass_kg": 2.8,
            })
