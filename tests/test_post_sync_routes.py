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


def test_onboarding_health_only_sync_does_not_run_activity_handlers(monkeypatch, tmp_path):
    import stride_server.routes.onboarding as ob_mod
    from stride_core.source import ProviderInfo, SyncResult

    monkeypatch.setattr(ob_mod, "_read_onboarding", lambda uuid: {})
    writes: list[tuple[str, dict]] = []
    monkeypatch.setattr(ob_mod, "_write_onboarding", lambda uuid, data: writes.append((uuid, data)))
    calls: list[dict] = []
    monkeypatch.setattr(ob_mod, "run_post_sync_for_result", lambda **kwargs: calls.append(kwargs))

    class Source:
        info = ProviderInfo("fake", "Fake", (), frozenset())

        def sync_user(self, user: str, *, full: bool = False, mode: str = "full", progress=None):
            assert mode == "health_only"
            return SyncResult(activities=0, health=7, activity_label_ids=())

    ob_mod._run_background_sync("u", Source(), mode="health_only")

    assert len(calls) == 1
    assert calls[0]["result"].activity_label_ids == ()
    assert calls[0]["result"].health == 7
