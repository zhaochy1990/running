"""Tests for coach-agent deterministic context loaders."""

from __future__ import annotations

import json

from stride_core.db import Database


USER_UUID = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
WEEK = "2026-04-20_04-26(W0)"


def _patch_data_dir(monkeypatch, tmp_path):
    import stride_core.db as core_db
    import stride_server.content_store as content_store

    monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)
    content_store._container_client.cache_clear()
    for key in (
        content_store.ACCOUNT_URL_ENV,
        content_store.CONTAINER_ENV,
        content_store.PREFIX_ENV,
    ):
        monkeypatch.delenv(key, raising=False)


def test_load_coach_context_collects_training_inputs(tmp_path, monkeypatch):
    _patch_data_dir(monkeypatch, tmp_path)
    user_dir = tmp_path / USER_UUID
    week_dir = user_dir / "logs" / WEEK
    week_dir.mkdir(parents=True)
    (user_dir / "profile.json").write_text(
        json.dumps({"display_name": "Runner", "target_time": "2:50:00"}),
        encoding="utf-8",
    )
    (user_dir / "TRAINING_PLAN.md").write_text("# Overall plan", encoding="utf-8")
    (week_dir / "plan.md").write_text("# Week plan\n\nEasy running.", encoding="utf-8")
    (week_dir / "feedback.md").write_text("Tired after workout.", encoding="utf-8")

    db = Database(user=USER_UUID)
    try:
        db._conn.execute(
            """INSERT INTO activities
               (label_id, name, sport_type, sport_name, date, distance_m, duration_s,
                avg_pace_s_km, avg_hr, training_load)
               VALUES ('a1', 'Easy Run', 100, 'Run', '2026-04-21T08:00:00', 10.0, 3000, 300, 140, 80)"""
        )
        db._conn.execute(
            """INSERT INTO daily_health
               (date, ati, cti, rhr, training_load_ratio, training_load_state, fatigue)
               VALUES ('20260421', 50, 60, 48, 0.83, 'Optimal', 35)"""
        )
        db._conn.commit()
    finally:
        db.close()

    from stride_server.coach_agent.context import load_coach_context

    ctx = load_coach_context(USER_UUID, folder=WEEK, sync_before=False)

    assert ctx["profile"]["display_name"] == "Runner"
    assert ctx["training_plan"]["content"] == "# Overall plan"
    assert ctx["selected_week"]["plan"] == "# Week plan\n\nEasy running."
    assert ctx["selected_week"]["feedback"] == "Tired after workout."
    assert ctx["selected_week"]["summary"]["activity_count"] == 1
    assert ctx["recent_activities"][0]["pace_fmt"] == "5:00/km"
    assert ctx["health"]["latest"]["tsb"] == 10


def test_load_week_context_prefers_db_plan_and_feedback(tmp_path, monkeypatch):
    _patch_data_dir(monkeypatch, tmp_path)
    week_dir = tmp_path / USER_UUID / "logs" / WEEK
    week_dir.mkdir(parents=True)
    (week_dir / "plan.md").write_text("FROM FILE PLAN", encoding="utf-8")
    (week_dir / "feedback.md").write_text("FROM FILE FEEDBACK", encoding="utf-8")

    db = Database(user=USER_UUID)
    try:
        db.upsert_weekly_plan(WEEK, "FROM DB PLAN", generated_by="gpt-5.5")
        db.upsert_weekly_feedback(WEEK, "FROM DB FEEDBACK", generated_by="user")

        from stride_server.coach_agent.context import load_week_context

        week = load_week_context(USER_UUID, WEEK, db)
    finally:
        db.close()

    assert week["plan"] == "FROM DB PLAN"
    assert week["plan_source"] == "db"
    assert week["feedback"] == "FROM DB FEEDBACK"
    assert week["feedback_source"] == "db"
