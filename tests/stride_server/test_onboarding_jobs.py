from __future__ import annotations

from datetime import date
from types import SimpleNamespace

from stride_storage.interfaces.jobs import JobRecord, JobStatus


def test_onboarding_backfill_writes_training_load_before_ability(monkeypatch):
    from stride_server.jobs.handlers import onboarding as H

    events: list[str] = []

    class FakeDb:
        def __enter__(self):
            events.append("db_enter")
            return self

        def __exit__(self, exc_type, exc, tb):
            events.append("db_exit")
            return False

    monkeypatch.setattr(
        "stride_storage.sqlite.database.Database",
        lambda **kwargs: FakeDb(),
    )
    monkeypatch.setattr("stride_core.timefmt.today_shanghai", lambda: date(2026, 5, 20))

    captured: dict[str, object] = {}

    def fake_recompute_training_load(db, *, start=None, end=None):
        events.append("training_load")
        captured["load_db"] = db
        captured["start"] = start
        captured["end"] = end
        return SimpleNamespace(
            activities_processed=3,
            activity_rows_written=3,
            daily_rows_written=181,
        )

    def fake_backfill_ability(db, *, days):
        events.append("ability")
        captured["ability_db"] = db
        captured["ability_days"] = days
        return {"wrote": 7}

    monkeypatch.setattr(
        "stride_core.training_load.recompute_training_load",
        fake_recompute_training_load,
    )
    monkeypatch.setattr(
        "stride_core.ability_hook.backfill_ability_snapshots",
        fake_backfill_ability,
    )

    heartbeats = []
    job = JobRecord(
        job_id="j1",
        partition_key="a1b2c3d4-e5f6-4aaa-89ab-123456789012",
        job_type="onboarding_backfill",
        status=JobStatus.RUNNING,
    )

    result = H.handle_backfill(job, heartbeat=lambda **kw: heartbeats.append(kw))

    assert events == ["db_enter", "training_load", "ability", "db_exit"]
    assert captured["end"] == date(2026, 5, 20)
    assert (captured["end"] - captured["start"]).days == 180
    assert captured["load_db"] is captured["ability_db"]
    assert captured["ability_days"] == 180
    assert heartbeats == [
        {"stage": "training_load", "progress_pct": 65},
        {"stage": "scoring", "progress_pct": 80},
    ]
    assert result == {
        "training_load": {
            "activities_processed": 3,
            "activity_rows_written": 3,
            "daily_rows_written": 181,
        },
        "ability": {"wrote": 7},
    }
