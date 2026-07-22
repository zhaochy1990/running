from __future__ import annotations

from datetime import timedelta
from types import SimpleNamespace


def test_health_handler_syncs_health_without_writing_content_store(monkeypatch):
    from stride_core.source import ProviderInfo, SyncResult
    from stride_server.jobs.handlers import onboarding as handlers
    from stride_storage.interfaces.jobs import JobRecord, JobStatus

    user_id = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
    calls: list[tuple] = []

    class Source:
        info = ProviderInfo("fake", "Fake", (), frozenset())

        def is_logged_in(self, user: str) -> bool:
            return user == user_id

        def sync_user(self, user: str, **kwargs):
            calls.append(("sync", user, kwargs))
            kwargs["progress"]({"phase": "health", "percent": 50})
            return SyncResult(activities=0, health=7)

    class Registry:
        def for_user(self, user: str):
            assert user == user_id
            return Source()

    monkeypatch.setattr(handlers, "_registry", lambda: Registry())

    result = handlers.handle_health_sync(
        JobRecord(
            job_id="job-health",
            partition_key=user_id,
            job_type="onboarding_health_sync",
            status=JobStatus.RUNNING,
        ),
        heartbeat=lambda **kwargs: calls.append(("heartbeat", kwargs)),
    )

    assert calls[0] == ("heartbeat", {"stage": "health_sync", "progress_pct": 5})
    assert calls[1][0:2] == ("sync", user_id)
    assert calls[1][2]["mode"] == "health_only"
    assert calls[2] == ("heartbeat", {"stage": "health", "progress_pct": 50})
    assert calls[-1] == (
        "heartbeat",
        {"stage": "health_complete", "progress_pct": 100},
    )
    assert result == {"activities": 0, "health": 7}


def test_backfill_handler_persists_current_training_load_before_ability(monkeypatch):
    from stride_core.timefmt import today_shanghai
    from stride_server.jobs.handlers import onboarding as handlers
    from stride_storage.interfaces.jobs import JobRecord, JobStatus

    user_id = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
    db = object()
    calls: list[tuple] = []
    heartbeats: list[dict] = []

    class FakeDatabase:
        def __init__(self, *, user: str):
            assert user == user_id

        def __enter__(self):
            return db

        def __exit__(self, *_args):
            return None

    def fake_recompute(db_arg, **kwargs):
        calls.append(("training_load", db_arg, kwargs))
        return SimpleNamespace(activities_processed=24, daily_rows_written=366)

    def fake_ability(db_arg, *, days: int):
        calls.append(("ability", db_arg, days))
        return {"snapshots_written": 180}

    monkeypatch.setattr(
        "stride_storage.sqlite.database.Database", FakeDatabase
    )
    monkeypatch.setattr(
        "stride_core.training_load.recompute_training_load", fake_recompute
    )
    monkeypatch.setattr(
        "stride_core.ability_hook.backfill_ability_snapshots", fake_ability
    )
    result = handlers.handle_backfill(
        JobRecord(
            job_id="job-1",
            partition_key=user_id,
            job_type="onboarding_backfill",
            status=JobStatus.RUNNING,
        ),
        heartbeat=lambda **kwargs: heartbeats.append(kwargs),
    )

    assert [call[0] for call in calls] == ["training_load", "ability"]
    load_kwargs = calls[0][2]
    assert load_kwargs == {
        "start": today_shanghai() - timedelta(days=365),
        "end": today_shanghai(),
        "persist": True,
    }
    assert heartbeats == [
        {"stage": "training_load", "progress_pct": 65},
        {"stage": "scoring", "progress_pct": 90},
    ]
    assert result == {
        "training_load": {
            "activities_processed": 24,
            "daily_rows_written": 366,
        },
        "ability": {"snapshots_written": 180},
    }
