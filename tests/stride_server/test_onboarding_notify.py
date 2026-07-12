"""Tests for onboarding-progress notification wiring.

Three layers:
- onboarding_notify: copy + throttle + best-effort swallow (mock the store)
- handler _progress: activity_details payload → publish_syncing
- orchestrator transitions: step/run done + failure → correct publishers,
  non-onboarding pipelines ignored
Plus one integration pass over the real file-backed notification store.
"""

from __future__ import annotations

import pytest

from stride_server.jobs import onboarding_notify as N


@pytest.fixture(autouse=True)
def _reset_throttle():
    N.reset_throttle()
    yield
    N.reset_throttle()


# ── onboarding_notify: copy + throttle + swallow ───────────────────────────


def test_publish_syncing_body_and_progress(monkeypatch):
    calls = []
    monkeypatch.setattr(N, "_publish", lambda user_id, **kw: calls.append((user_id, kw)))
    N.publish_syncing("u1", 59, 783)
    assert len(calls) == 1
    user_id, kw = calls[0]
    assert user_id == "u1"
    assert kw["body"] == "STRIDE 正在同步你的数据，当前进度 59/783"
    assert kw["severity"] == "info"
    assert 0 <= kw["progress_pct"] <= N._SYNC_BAND_MAX


def test_publish_syncing_throttles_small_advances(monkeypatch):
    calls = []
    monkeypatch.setattr(N, "_publish", lambda user_id, **kw: calls.append(kw["progress_pct"]))
    # 0/783 → 0%, publishes; 1/783 → still 0% → throttled; jump to ~10% publishes.
    N.publish_syncing("u1", 0, 783)
    N.publish_syncing("u1", 1, 783)
    N.publish_syncing("u1", 5, 783)  # <5% mapped advance → throttled
    N.publish_syncing("u1", 130, 783)  # ~10% band → publishes
    assert calls == [0, 10]


def test_publish_syncing_always_emits_final(monkeypatch):
    calls = []
    monkeypatch.setattr(N, "_publish", lambda user_id, **kw: calls.append(kw["progress_pct"]))
    N.publish_syncing("u1", 400, 783)  # first, publishes (~31%)
    N.publish_syncing("u1", 783, 783)  # final, must publish even if <5% more
    assert len(calls) == 2
    assert calls[-1] == N._SYNC_BAND_MAX  # 783/783 → full sync band


def test_publish_syncing_ignores_zero_total(monkeypatch):
    calls = []
    monkeypatch.setattr(N, "_publish", lambda *a, **k: calls.append(1))
    N.publish_syncing("u1", 0, 0)
    assert calls == []


def test_publish_sync_done_copy(monkeypatch):
    calls = []
    monkeypatch.setattr(N, "_publish", lambda user_id, **kw: calls.append(kw))
    N.publish_sync_done("u1", 783)
    assert calls[0]["body"] == "STRIDE 已完成数据同步，共同步 783 条运动记录"
    assert calls[0]["progress_pct"] == N._SYNC_DONE_PCT


def test_publish_complete_is_success(monkeypatch):
    calls = []
    monkeypatch.setattr(N, "_publish", lambda user_id, **kw: calls.append(kw))
    N.publish_complete("u1")
    assert calls[0]["severity"] == "success"
    assert calls[0]["progress_pct"] == 100


def test_publish_started_copy(monkeypatch):
    calls = []
    monkeypatch.setattr(N, "_publish", lambda user_id, **kw: calls.append(kw))
    N.publish_started("u1")
    assert calls[0]["body"] == "STRIDE 正在处理你的数据"
    assert calls[0]["severity"] == "info"
    assert calls[0]["progress_pct"] == 5


def test_publish_failed_is_error_and_hides_detail(monkeypatch):
    calls = []
    monkeypatch.setattr(N, "_publish", lambda user_id, **kw: calls.append(kw))
    N.publish_failed("u1", "onboarding_calibration")
    assert calls[0]["severity"] == "error"
    assert "calibration" not in calls[0]["body"]  # no internal step detail leaked


def test_publish_swallows_store_errors(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("azure down")

    import stride_server.notifications.store as nstore
    monkeypatch.setattr(nstore, "upsert_notification", boom)
    # Must not raise — best-effort.
    N.publish_complete("u1")


# ── handler _progress → publish_syncing ────────────────────────────────────


def test_full_sync_progress_emits_syncing(monkeypatch):
    from stride_server.jobs.handlers import onboarding as H

    published = []
    monkeypatch.setattr(
        H.onboarding_notify, "publish_syncing",
        lambda uuid, current, total: published.append((uuid, current, total)),
    )

    captured = {}

    class _Src:
        def is_logged_in(self, uuid):
            return True

        def sync_user(self, uuid, *, full, progress):
            captured["progress"] = progress
            # Simulate the sync engine emitting an activity_details tick + a
            # non-count phase.
            progress({"phase": "activity_details", "current": 59, "total": 783})
            progress({"phase": "activities_scan", "message": "scanning"})

            class _R:
                activities = 783
                health = 3
            return _R()

    class _Reg:
        def for_user(self, uuid):
            return _Src()

    monkeypatch.setattr(H, "_registry", lambda: _Reg())

    from stride_storage.interfaces.jobs import JobRecord, JobStatus
    job = JobRecord(
        job_id="j1", partition_key="a1b2c3d4-e5f6-4aaa-89ab-123456789012",
        job_type="onboarding_full_sync", status=JobStatus.RUNNING,
    )
    H.handle_full_sync(job, heartbeat=lambda **kw: None)

    assert published == [("a1b2c3d4-e5f6-4aaa-89ab-123456789012", 59, 783)]


# ── orchestrator transitions ───────────────────────────────────────────────


def _mk_run(pipeline_name="onboarding"):
    from stride_storage.interfaces.jobs import PipelineRunRecord, JobStatus
    return PipelineRunRecord(
        run_id="r1", partition_key="u1", pipeline_name=pipeline_name,
        status=JobStatus.RUNNING,
    )


def _mk_job(job_type, *, result_json=None):
    from stride_storage.interfaces.jobs import JobRecord, JobStatus
    return JobRecord(
        job_id="j1", partition_key="u1", job_type=job_type,
        status=JobStatus.DONE, result_json=result_json,
    )


def test_transition_full_sync_done_emits_sync_done_and_analyzing(monkeypatch):
    from stride_server.jobs import orchestrator as O

    events = []
    monkeypatch.setattr(O, "_synced_activities", lambda job: 783)
    import stride_server.jobs.onboarding_notify as N2
    monkeypatch.setattr(N2, "publish_sync_done", lambda u, n: events.append(("done", u, n)))
    monkeypatch.setattr(N2, "publish_analyzing", lambda u: events.append(("analyzing", u)))
    monkeypatch.setattr(N2, "publish_complete", lambda u: events.append(("complete", u)))

    O._notify_run_transition(_mk_run(), _mk_job("onboarding_full_sync"), "full_sync", next_step="calibration")
    assert events == [("done", "u1", 783), ("analyzing", "u1")]


def test_transition_run_done_emits_complete(monkeypatch):
    from stride_server.jobs import orchestrator as O
    import stride_server.jobs.onboarding_notify as N2

    events = []
    monkeypatch.setattr(N2, "publish_complete", lambda u: events.append(("complete", u)))
    O._notify_run_transition(_mk_run(), _mk_job("onboarding_backfill"), "backfill", next_step=None)
    assert events == [("complete", "u1")]


def test_transition_ignores_non_onboarding_pipeline(monkeypatch):
    from stride_server.jobs import orchestrator as O
    import stride_server.jobs.onboarding_notify as N2

    events = []
    for name in ("publish_sync_done", "publish_analyzing", "publish_complete"):
        monkeypatch.setattr(N2, name, lambda *a, **k: events.append(name))
    O._notify_run_transition(_mk_run("other"), _mk_job("x"), "full_sync", next_step=None)
    assert events == []


def test_synced_activities_parses_result_json():
    from stride_server.jobs import orchestrator as O
    assert O._synced_activities(_mk_job("x", result_json='{"activities": 783}')) == 783
    assert O._synced_activities(_mk_job("x", result_json=None)) == 0
    assert O._synced_activities(_mk_job("x", result_json="not json")) == 0


# ── integration: real file-backed store, single row in place ───────────────


def test_end_to_end_single_notification_row(tmp_path, monkeypatch):
    """Driving the phases against the real file store leaves ONE notification
    row (upsert-by-id), ending success/100."""
    import stride_core.db as core_db
    import stride_server.notifications.store as nstore

    monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)
    nstore.reset_backend_cache()
    for key in ("STRIDE_NOTIFICATIONS_TABLE_ACCOUNT_URL",):
        monkeypatch.delenv(key, raising=False)

    user = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"
    N.publish_syncing(user, 59, 783)
    N.publish_syncing(user, 783, 783)
    N.publish_sync_done(user, 783)
    N.publish_analyzing(user)
    N.publish_complete(user)

    rows = nstore.list_notifications(user)
    onboarding_rows = [r for r in rows if r["id"] == N.ONBOARDING_NOTIFICATION_ID]
    assert len(onboarding_rows) == 1
    row = onboarding_rows[0]
    assert row["severity"] == "success"
    assert row["progress_pct"] == 100
    assert "已完成初始化" in row["body"]

