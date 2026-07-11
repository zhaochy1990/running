from __future__ import annotations

import json

from stride_server.master_plan_intake import (
    build_history_analysis,
    fallback_extract_intake_fields,
    format_history_prompt_block,
)

USER_ID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"


def test_history_analysis_uses_personal_bests_and_race_efforts(tmp_path, monkeypatch):
    from stride_storage.sqlite.database import Database

    db = Database(db_path=tmp_path / "coros.db")
    c = db._conn
    entry = {
        "distance": "FM",
        "pb_time_sec": 10762.0,
        "achieved_at": "2026-04-12",
        "source": "activity",
        "label_id": "fm-pb",
        "name": "Shanghai Marathon",
    }
    c.execute(
        "INSERT INTO personal_bests (distance, pb_time_sec, achieved_at, source, entry_json) "
        "VALUES (?, ?, ?, ?, ?)",
        ("FM", 10762.0, "2026-04-12", "activity", json.dumps(entry)),
    )
    c.execute("INSERT INTO sync_meta (key, value) VALUES ('personal_bests_scanned', '1')")
    c.execute(
        "INSERT INTO activities "
        "(label_id, name, sport_type, sport_name, date, distance_m, duration_s, "
        " avg_pace_s_km, avg_hr, max_hr, train_kind) "
        "VALUES (?, ?, 100, 'Run', ?, ?, ?, ?, ?, ?, 'race')",
        ("race-1", "Xi'an Marathon tune-up", "2026-06-01T00:00:00+00:00", 42195.0, 10800.0, 256.0, 166, 184),
    )
    c.commit()
    monkeypatch.setattr("stride_storage.sqlite.database.Database", lambda **kw: db)

    history = build_history_analysis(USER_ID)

    assert history["data_available"] is True
    assert history["pbs"][0]["distance"] == "FM"
    assert history["pbs"][0]["time"] == "2:59:22"
    assert history["recent_races"][0]["distance_label"] == "全马"
    assert history["recent_races"][0]["pace"] == "4:16"
    block = format_history_prompt_block(history)
    assert "Pre-generation race/PB analysis" in block
    assert "FM: 2:59:22" in block
    assert "Recent race-like efforts" in block


def test_fallback_extract_handles_common_chinese_intake():
    fields = fallback_extract_intake_fields(
        "目标是2026年10月18日西安马拉松，全马sub-2:50，一周可以跑步5天，没有任何伤病史"
    )

    assert fields["race_distance"] == "FM"
    assert fields["race_date"] == "2026-10-18"
    assert fields["target_finish_time"] == "2:50:00"
    assert fields["weekly_training_days"] == 5
    assert fields["injuries"] == ["none"]


def test_storage_reader_lists_recent_race_efforts_without_route_sql(tmp_path):
    from stride_storage.sqlite.database import Database

    db = Database(db_path=tmp_path / "coros.db")
    try:
        db._conn.executemany(
            "INSERT INTO activities "
            "(label_id, name, sport_type, sport_name, date, distance_m, duration_s, train_kind) "
            "VALUES (?, ?, 100, 'Run', ?, ?, ?, ?)",
            [
                ("race-new", "City 10K", "2026-06-10T00:00:00+00:00", 10000.0, 2400.0, "Race"),
                ("race-old", "Spring Marathon", "2026-03-01T00:00:00+00:00", 42195.0, 10800.0, None),
                ("easy", "Easy run", "2026-06-11T00:00:00+00:00", 8000.0, 3000.0, None),
            ],
        )
        db._conn.commit()

        rows = db.list_race_effort_activities(limit=5)

        assert [row["label_id"] for row in rows] == ["race-new", "race-old"]
        assert rows[0]["shanghai_date"] == "2026-06-10"
    finally:
        db.close()
