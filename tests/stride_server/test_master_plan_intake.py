from __future__ import annotations

import json
from datetime import date
from types import SimpleNamespace

from stride_server.master_plan_intake import (
    _normalise_extracted_fields,
    build_history_analysis,
    extract_intake_fields,
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

        rows = db.list_race_effort_activities(as_of_date="2026-06-30", limit=5)

        assert [row["label_id"] for row in rows] == ["race-new", "race-old"]
        assert rows[0]["shanghai_date"] == "2026-06-10"
    finally:
        db.close()


def test_history_analysis_reconstructs_pbs_and_races_at_as_of(tmp_path, monkeypatch):
    from stride_storage.sqlite.database import Database

    db = Database(db_path=tmp_path / "coros.db")
    entry = {
        "distance": "FM",
        "pb_time_sec": 10200.0,
        "achieved_at": "2026-07-12",
        "source": "activity",
        "label_id": "future-pb",
        "name": "Future Marathon",
        "history": [
            {
                "date": "2026-04-12",
                "best_so_far_sec": 10800.0,
                "label_id": "past-pb",
                "source": "activity",
            },
            {
                "date": "2026-07-12",
                "best_so_far_sec": 10200.0,
                "label_id": "future-pb",
                "source": "activity",
            },
        ],
    }
    db._conn.execute(
        "INSERT INTO personal_bests (distance, pb_time_sec, achieved_at, source, entry_json) "
        "VALUES (?, ?, ?, ?, ?)",
        ("FM", 10200.0, "2026-07-12", "activity", json.dumps(entry)),
    )
    db._conn.execute("INSERT INTO sync_meta (key, value) VALUES ('personal_bests_scanned', '1')")
    db._conn.executemany(
        "INSERT INTO activities "
        "(label_id, name, sport_type, sport_name, date, distance_m, duration_s, train_kind) "
        "VALUES (?, ?, 100, 'Run', ?, ?, ?, 'race')",
        [
            ("past-race", "Past Marathon", "2026-04-12T00:00:00+00:00", 42195.0, 10800.0),
            ("future-race", "Future Marathon", "2026-07-12T00:00:00+00:00", 42195.0, 10200.0),
        ],
    )
    db._conn.commit()
    monkeypatch.setattr("stride_storage.sqlite.database.Database", lambda **kw: db)

    history = build_history_analysis(USER_ID, as_of=date(2026, 5, 1))

    assert history["pbs"][0]["time"] == "3:00:00"
    assert history["pbs"][0]["achieved_at"] == "2026-04-12"
    assert [race["label_id"] for race in history["recent_races"]] == ["past-race"]


def test_race_effort_reader_requires_strong_evidence_and_respects_as_of(tmp_path):
    from stride_storage.sqlite.database import Database

    db = Database(db_path=tmp_path / "coros.db")
    try:
        db._conn.executemany(
            "INSERT INTO activities "
            "(label_id, name, sport_type, sport_name, date, distance_m, duration_s, train_kind) "
            "VALUES (?, ?, 100, 'Run', ?, ?, ?, ?)",
            [
                ("ordinary-10k", "Morning Run", "2026-06-01T00:00:00+00:00", 10000.0, 3600.0, None),
                ("training", "马拉松备赛长距", "2026-06-02T00:00:00+00:00", 42195.0, 14400.0, None),
                ("named-workout", "Marathon workout", "2026-06-02T01:00:00+00:00", 8000.0, 3000.0, None),
                ("race-pace-hyphen", "10K race-pace", "2026-06-02T02:00:00+00:00", 10000.0, 3000.0, None),
                ("race-pace-underscore", "10K race_pace", "2026-06-02T03:00:00+00:00", 10000.0, 3000.0, None),
                ("race-training", "10K Race Training", "2026-06-02T04:00:00+00:00", 10000.0, 3000.0, None),
                ("race-brackets", "10K Race [Interval]", "2026-06-02T05:00:00+00:00", 10000.0, 3000.0, None),
                ("named-race", "上海马拉松", "2026-06-03T00:00:00+00:00", 42195.0, 10800.0, None),
                ("space-coast", "Space Coast Marathon", "2026-06-04T00:00:00+00:00", 42195.0, 10900.0, None),
                ("fortune", "Fortune Marathon", "2026-06-05T00:00:00+00:00", 42195.0, 11000.0, None),
                ("city-race", "City Race: 10K", "2026-06-06T00:00:00+00:00", 10000.0, 2450.0, None),
                ("future-race", "Future Race", "2026-07-03T00:00:00+00:00", 10000.0, 2400.0, "race"),
            ],
        )
        db._conn.commit()

        rows = db.list_race_effort_activities(as_of_date="2026-06-30", limit=10)

        assert [row["label_id"] for row in rows] == [
            "city-race",
            "fortune",
            "space-coast",
            "named-race",
        ]
    finally:
        db.close()


def test_model_extraction_normalises_and_validates_dates_times_and_clear_intents():
    fields = _normalise_extracted_fields({
        "race_date": "2026-02-30",
        "target_finish_time": "2:50",
        "pb_time": "1:75:00",
        "finish_only": True,
        "injury_free": True,
    })

    assert "race_date" not in fields
    assert "pb_time" not in fields
    assert fields["target_finish_time"] is None
    assert fields["injuries"] == ["none"]

    assert _normalise_extracted_fields({"target_finish_time": "2:50"}) == {
        "target_finish_time": "2:50:00"
    }


def test_fallback_extract_supports_explicit_clear_intents():
    fields = fallback_extract_intake_fields("这次仅完赛即可，而且没有伤病")

    assert fields["target_finish_time"] is None
    assert fields["injuries"] == ["none"]


def test_fallback_extract_does_not_treat_negated_phrases_as_clear_intents():
    fields = fallback_extract_intake_fields("我不是只要完赛，也不是完全没有伤病；not currently injury-free")
    target = fallback_extract_intake_fields("我不想只要完赛，目标3:30")
    uncertain = fallback_extract_intake_fields("不能说没有伤病，膝盖仍需观察")

    assert "target_finish_time" not in fields
    assert "injuries" not in fields
    assert target["target_finish_time"] == "3:30:00"
    assert "injuries" not in uncertain


def test_fallback_extract_accepts_positive_clear_intents_with_negated_goals():
    finish = fallback_extract_intake_fields("不追求成绩，完赛即可")
    no_time_goal = fallback_extract_intake_fields("没有时间目标，只要完赛")

    assert finish["target_finish_time"] is None
    assert no_time_goal["target_finish_time"] is None


def test_model_extraction_preserves_explicit_clear_intents(monkeypatch):
    class FakeLlm:
        def invoke(self, messages):
            return SimpleNamespace(content=json.dumps({
                "target_finish_time": None,
                "finish_only": True,
                "injuries": None,
                "injury_free": True,
            }))

    monkeypatch.setattr("stride_server.master_plan_intake._get_lightweight_llm", lambda: FakeLlm())

    fields = extract_intake_fields("这次仅完赛即可，而且没有伤病")

    assert fields["target_finish_time"] is None
    assert fields["injuries"] == ["none"]
