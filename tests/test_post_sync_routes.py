from __future__ import annotations

from unittest.mock import MagicMock


def test_trigger_sync_runs_post_sync_once_after_success(monkeypatch):
    import stride_server.routes.sync as sync_mod
    from stride_core.source import ProviderInfo, SyncResult

    class Source:
        info = ProviderInfo("fake", "Fake", (), frozenset())

        def is_logged_in(self, user: str) -> bool:
            return True

        def sync_user(self, user: str, *, full: bool = False):
            return SyncResult(activities=1, health=2, activity_label_ids=("a1",))

    calls: list[dict] = []
    monkeypatch.setattr(sync_mod, "run_post_sync_for_result", lambda **kwargs: calls.append(kwargs))

    response = sync_mod.trigger_sync("u", source=Source(), _claims={})

    assert response["success"] is True
    assert len(calls) == 1
    assert calls[0]["user"] == "u"
    assert calls[0]["provider"] == "fake"
    assert calls[0]["operation"] == "sync"
    assert calls[0]["result"].activity_label_ids == ("a1",)


def test_trigger_sync_invalidates_backfill_before_source_write_even_on_failure(
    monkeypatch,
):
    import stride_server.routes.sync as sync_mod
    from stride_core.source import ProviderInfo

    invalidated: list[str] = []
    monkeypatch.setattr(
        sync_mod,
        "invalidate_training_load_backfill_progress",
        invalidated.append,
    )

    class Source:
        info = ProviderInfo("fake", "Fake", (), frozenset())

        def is_logged_in(self, user: str) -> bool:
            return True

        def sync_user(self, user: str, *, full: bool = False):
            raise RuntimeError("partial write then failure")

    response = sync_mod.trigger_sync("u", source=Source(), _claims={})

    assert response == {"success": False, "error": "sync failed"}
    assert invalidated == ["u"]


def test_trigger_sync_still_succeeds_when_post_sync_runner_fails(monkeypatch):
    import stride_server.routes.sync as sync_mod
    from stride_core.source import ProviderInfo, SyncResult

    class Source:
        info = ProviderInfo("fake", "Fake", (), frozenset())

        def is_logged_in(self, user: str) -> bool:
            return True

        def sync_user(self, user: str, *, full: bool = False):
            return SyncResult(activities=1, health=2, activity_label_ids=("a1",))

    def fail_runner(**_kwargs):
        raise RuntimeError("post-sync failed")

    monkeypatch.setattr(sync_mod, "run_post_sync_for_result", fail_runner)

    response = sync_mod.trigger_sync("u", source=Source(), _claims={})

    assert response["success"] is True


def test_resync_activity_runs_post_sync_for_single_label(monkeypatch):
    import stride_server.routes.activities as activities_mod
    from stride_core.source import ProviderInfo

    class Source:
        info = ProviderInfo("fake", "Fake", (), frozenset())

        def is_logged_in(self, user: str) -> bool:
            return True

        def resync_activity(self, user: str, label_id: str) -> bool:
            return True

    calls: list[dict] = []
    monkeypatch.setattr(activities_mod, "run_post_sync_for_labels", lambda **kwargs: calls.append(kwargs))

    response = activities_mod.resync_activity("u", "label-1", source=Source(), _claims={})

    assert response == {"success": True}
    assert calls == [
        {
            "user": "u",
            "provider": "fake",
            "operation": "resync_activity",
            "activity_label_ids": ("label-1",),
        }
    ]


def test_resync_activity_stops_before_sqlite_write_when_writer_is_busy(monkeypatch):
    import stride_server.routes.activities as activities_mod
    from stride_server.sqlite_writer import try_user_sqlite_writer

    source = MagicMock()
    source.is_logged_in.return_value = True

    with try_user_sqlite_writer("u") as acquired:
        assert acquired is True
        response = activities_mod.resync_activity(
            "u", "label-1", source=source, _claims={}
        )

    assert response == {
        "success": False,
        "error": "用户数据正在更新，请稍后重试",
        "retryable": True,
    }
    source.resync_activity.assert_not_called()
