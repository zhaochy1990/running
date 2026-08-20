from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from stride_core.training_load import TRAINING_LOAD_MODEL_VERSION

USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"


@pytest.fixture
def app_client(tmp_path, monkeypatch):
    import stride_core.db as core_db_mod
    import stride_server.deps as deps_mod

    monkeypatch.setattr(core_db_mod, "USER_DATA_DIR", tmp_path)
    monkeypatch.setattr(deps_mod, "USER_DATA_DIR", tmp_path)

    from stride_server.routes.health import router as health_router

    app = FastAPI()
    app.include_router(health_router)
    return TestClient(app, raise_server_exceptions=False), tmp_path


def _open_user_db(tmp_path):
    user_dir = tmp_path / USER_UUID
    user_dir.mkdir(parents=True, exist_ok=True)

    from stride_storage.sqlite.database import Database

    return Database(user=USER_UUID)


def test_pmc_returns_stride_daily_load_payload(app_client):
    client, tmp_path = app_client
    db = _open_user_db(tmp_path)
    try:
        db._conn.execute(
            """INSERT INTO daily_health
               (date, ati, cti, training_load_ratio, training_load_state, fatigue, rhr)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            ("2026-05-08", 35.0, 45.0, 0.78, "Optimal", 42.0, 48),
        )
        db._conn.execute(
            """INSERT INTO daily_training_load
               (date, algorithm_version, training_dose, acute_load, chronic_load,
                form, load_ratio, readiness_gate, readiness_reasons_json, coverage_status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("2026-05-01", TRAINING_LOAD_MODEL_VERSION, 80.0, 8.0, 18.0, 10.0, 0.44, "green", json.dumps([]), "complete"),
        )
        db._conn.execute(
            """INSERT INTO daily_training_load
               (date, algorithm_version, training_dose, acute_load, chronic_load,
                form, load_ratio, readiness_gate, readiness_reasons_json, coverage_status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                "2026-05-08",
                TRAINING_LOAD_MODEL_VERSION,
                120.0,
                21.0,
                27.0,
                6.0,
                0.78,
                "yellow",
                json.dumps(["low_hrv"]),
                "partial",
            ),
        )
        db._conn.commit()
    finally:
        db.close()

    resp = client.get(f"/api/{USER_UUID}/pmc?days=14")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["summary"]["current_cti"] == 45.0
    assert body["stride_pmc"] == [
        {
            "date": "2026-05-01",
            "algorithm_version": TRAINING_LOAD_MODEL_VERSION,
            "coverage_status": "complete",
            "training_dose": 80.0,
            "acute_load": 8.0,
            "chronic_load": 18.0,
            "form": 10.0,
            "load_ratio": 0.44,
            "readiness_gate": "green",
            "readiness_reasons": [],
            "chronic_load_ramp": None,
        },
        {
            "date": "2026-05-08",
            "algorithm_version": TRAINING_LOAD_MODEL_VERSION,
            "coverage_status": "partial",
            "training_dose": 120.0,
            "acute_load": 21.0,
            "chronic_load": 27.0,
            "form": 6.0,
            "load_ratio": 0.78,
            "readiness_gate": "yellow",
            "readiness_reasons": ["low_hrv"],
            "chronic_load_ramp": 9.0,
        },
    ]
    assert body["stride_summary"] == {
        "date": "2026-05-08",
        "current_training_dose": 120.0,
        "current_acute_load": 21.0,
        "current_chronic_load": 27.0,
        "current_form": 6.0,
        "current_load_ratio": 0.78,
        "current_coverage_status": "partial",
        "current_readiness_gate": "yellow",
        "current_readiness_reasons": ["low_hrv"],
        "chronic_load_ramp": 9.0,
    }


def test_pmc_summary_skips_latest_unknown_placeholder(app_client):
    client, tmp_path = app_client
    db = _open_user_db(tmp_path)
    try:
        db._conn.executemany(
            """INSERT INTO daily_training_load
               (date, algorithm_version, training_dose, acute_load, chronic_load,
                form, load_ratio, readiness_gate, readiness_reasons_json, coverage_status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [
                ("2026-05-08", TRAINING_LOAD_MODEL_VERSION, 75.0, 20.0, 25.0,
                 5.0, 0.8, "yellow", '["measured"]', "partial"),
                ("2026-05-09", TRAINING_LOAD_MODEL_VERSION, 0.0, 20.0, 25.0,
                 5.0, 0.8, "green", '[]', "unknown"),
            ],
        )
        db._conn.commit()
    finally:
        db.close()

    resp = client.get(f"/api/{USER_UUID}/pmc?days=14")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [row["coverage_status"] for row in body["stride_pmc"]] == [
        "partial",
        "unknown",
    ]
    assert body["stride_summary"]["date"] == "2026-05-08"
    assert body["stride_summary"]["current_coverage_status"] == "partial"
    assert body["stride_summary"]["current_readiness_gate"] == "yellow"


def test_pmc_reads_canonical_row_regardless_of_algorithm_version(app_client):
    """Daily load is canonical (one row per date). The reader must surface
    whatever row exists — including a row stamped with a *legacy* algorithm
    version — instead of filtering to the current version. This proves the
    reader no longer version-gates: a prod DB whose only backfilled rows carry
    an older ``algorithm_version`` still renders its PMC."""
    client, tmp_path = app_client
    legacy_version = TRAINING_LOAD_MODEL_VERSION - 1 or 1
    db = _open_user_db(tmp_path)
    try:
        rows = [
            # One canonical row per date. First date carries a legacy version.
            ("2026-05-01", legacy_version, 100.0, 10.0, 30.0, 20.0, 0.33, "yellow", ["legacy"], "complete"),
            ("2026-05-02", TRAINING_LOAD_MODEL_VERSION, 110.0, 12.0, 34.0, 22.0, 0.35, "yellow", ["v2"], "partial"),
        ]
        db._conn.executemany(
            """INSERT INTO daily_training_load
               (date, algorithm_version, training_dose, acute_load, chronic_load,
                form, load_ratio, readiness_gate, readiness_reasons_json, coverage_status)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            [(*row[:-2], json.dumps(row[-2]), row[-1]) for row in rows],
        )
        db._conn.commit()
    finally:
        db.close()

    resp = client.get(f"/api/{USER_UUID}/pmc?days=14")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert [row["date"] for row in body["stride_pmc"]] == ["2026-05-01", "2026-05-02"]
    # Both versions readable — reader does not filter by current version.
    assert {row["algorithm_version"] for row in body["stride_pmc"]} == {
        legacy_version,
        TRAINING_LOAD_MODEL_VERSION,
    }
    assert body["stride_summary"]["date"] == "2026-05-02"
    assert body["stride_summary"]["current_training_dose"] == 110.0


def test_activity_detail_returns_stride_training_load(app_client):
    _client, tmp_path = app_client
    db = _open_user_db(tmp_path)
    try:
        db._conn.execute(
            """INSERT INTO activities
               (label_id, name, sport_type, sport_name, date, distance_m,
                duration_s, training_load)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                "run1",
                "Easy Run",
                100,
                "Run",
                "2026-05-08T00:30:00+00:00",
                10.0,
                3600.0,
                321.0,
            ),
        )
        db._conn.execute(
            """INSERT INTO activity_training_load
               (label_id, activity_date, sport, session_class, algorithm_version,
                cardio_load_raw, cardio_tss, external_tss, mechanical_load,
                subjective_internal_load, training_dose, load_confidence,
                excluded_from_pmc, reasons_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                "run1",
                "2026-05-08",
                "run_outdoor",
                "easy",
                TRAINING_LOAD_MODEL_VERSION,
                70.5,
                84.2,
                91.4,
                10.3,
                None,
                86.4,
                "high",
                0,
                json.dumps(["gps_ok"]),
            ),
        )
        db._conn.commit()

        from stride_server.routes.activities import build_activity_detail

        detail = build_activity_detail(db, "run1")
    finally:
        db.close()

    assert detail is not None
    assert detail["activity"]["training_load"] == 321.0
    assert detail["stride_training_load"] == {
        "label_id": "run1",
        "activity_date": "2026-05-08",
        "sport": "run_outdoor",
        "session_class": "easy",
        "algorithm_version": TRAINING_LOAD_MODEL_VERSION,
        "calibration_id": None,
        "cardio_load_raw": 70.5,
        "cardio_tss": 84.2,
        "external_tss": 91.4,
        "high_intensity_tss": None,
        "mechanical_load": 10.3,
        "subjective_internal_load": None,
        "training_dose": 86.4,
        "training_dose_source": None,
        "cardio_coverage": 0.0,
        "external_coverage": 0.0,
        "high_intensity_coverage": 0.0,
        "coverage_status": "unknown",
        "load_confidence": "high",
        "excluded_from_pmc": False,
        "reasons": ["gps_ok"],
    }
