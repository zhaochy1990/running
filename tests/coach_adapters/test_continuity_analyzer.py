from datetime import date

from coach.schemas import ContinuitySignals


def _db(tmp_path):
    from stride_core.db import Database
    return Database(db_path=tmp_path / "coros.db")


def test_no_recent_race(tmp_path):
    from stride_server.coach_adapters.continuity_analyzer import analyze_continuity
    db = _db(tmp_path)
    sig = analyze_continuity(db, goal={"race_date": "2026-10-18"}, profile=None, as_of=date(2026, 6, 10))
    assert sig.post_race_recovery_status == "no_recent_race"
    assert sig.days_since_last_race is None


def test_injuries_from_profile(tmp_path):
    from stride_server.coach_adapters.continuity_analyzer import analyze_continuity
    db = _db(tmp_path)
    sig = analyze_continuity(db, goal={"race_date": "2026-10-18"}, profile={"injuries": ["achilles", "itbs"]}, as_of=date(2026, 6, 10))
    assert sig.injuries == ["achilles", "itbs"]


def test_injuries_none_tag_filtered(tmp_path):
    from stride_server.coach_adapters.continuity_analyzer import analyze_continuity
    db = _db(tmp_path)
    sig = analyze_continuity(db, goal={"race_date": "2026-10-18"}, profile={"injuries": ["none"]}, as_of=date(2026, 6, 10))
    assert sig.injuries == []


def test_macro_cycle_summer_for_autumn_race(tmp_path):
    from stride_server.coach_adapters.continuity_analyzer import analyze_continuity
    db = _db(tmp_path)
    sig = analyze_continuity(db, goal={"race_date": "2026-10-18"}, profile=None, as_of=date(2026, 6, 10))
    assert sig.macro_cycle == "summer"


def test_macro_cycle_winter_for_march_race(tmp_path):
    from stride_server.coach_adapters.continuity_analyzer import analyze_continuity
    db = _db(tmp_path)
    sig = analyze_continuity(db, goal={"race_date": "2027-03-21"}, profile=None, as_of=date(2026, 12, 1))
    assert sig.macro_cycle == "winter"


def test_volume_trend_and_aerobic_weeks(tmp_path):
    from stride_server.coach_adapters.continuity_analyzer import analyze_continuity
    from stride_core.db import Database
    db = Database(db_path=tmp_path / "coros.db")
    c = db._conn
    base = ["2026-04-27", "2026-05-04", "2026-05-11", "2026-05-18", "2026-05-25", "2026-06-01"]
    for i, d in enumerate(base):
        c.execute("INSERT INTO activities (label_id, sport_type, date, distance_m, duration_s) "
                  "VALUES (?, 100, ?, ?, 3600)", (f"r{i}", d + "T08:00:00+00:00", 38.0 + i))
    c.commit()
    sig = analyze_continuity(db, goal={"race_date": "2026-10-18"}, profile=None, as_of=date(2026, 6, 7))
    assert sig.recent_aerobic_weeks >= 5
    assert sig.recent_volume_trend == "rising"
    assert sig.recent_longest_run_km is not None


def test_recent_race_recovering(tmp_path):
    from stride_server.coach_adapters.continuity_analyzer import analyze_continuity
    db = _db(tmp_path)
    c = db._conn
    # A recent race 5 days before as_of → recovering (< 21 days).
    c.execute(
        "INSERT INTO activities (label_id, sport_type, date, distance_m, duration_s, train_kind) "
        "VALUES ('race1', 100, '2026-06-05T08:00:00+00:00', 42.2, 14400, 'race')"
    )
    c.commit()
    sig = analyze_continuity(db, goal={"race_date": "2026-10-18"}, profile=None, as_of=date(2026, 6, 10))
    assert sig.days_since_last_race == 5
    assert sig.post_race_recovery_status == "recovering"
