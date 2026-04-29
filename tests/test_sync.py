"""Smoke tests for coros_sync.sync helpers — focused on the ability hook."""

from __future__ import annotations

import time

import pytest

from coros_sync.sync import (
    ActivityDetailSyncTimeout,
    _fmt_delta,
    _fmt_marathon,
    _fmt_time_delta,
    _run_detail_jobs,
    _try_run_ability_hook,
    sync_activities,
)
from stride_core.models import ActivityDetail


def _activity_summary(label_id: str, date: str) -> dict:
    return {
        "labelId": label_id,
        "name": label_id,
        "sportType": 100,
        "date": date,
        "distance": 10000,
        "totalTime": 3000,
    }


def _activity_detail(label_id: str) -> dict:
    return {
        "data": {
            "summary": {
                "name": label_id,
                "sportType": 100,
                "distance": 1_000_000,
                "totalTime": 300_000,
            },
            "lapList": [],
            "zoneList": [],
            "frequencyList": [],
        }
    }


class TestFormatHelpers:
    def test_fmt_marathon(self):
        assert _fmt_marathon(None) == "—"
        assert _fmt_marathon(0) == "—"
        assert _fmt_marathon(10200) == "2:50:00"
        assert _fmt_marathon(11022) == "3:03:42"

    def test_fmt_delta(self):
        assert _fmt_delta(None, 10.0) == "—"
        assert _fmt_delta(10.0, None) == "—"
        assert _fmt_delta(60.0, 61.2) == "+1.2"
        assert _fmt_delta(60.0, 58.8) == "-1.2"

    def test_fmt_time_delta(self):
        assert _fmt_time_delta(None, 10200) == "—"
        assert _fmt_time_delta(10200, None) == "—"
        assert _fmt_time_delta(10200, 10000) == "-3:20"
        assert _fmt_time_delta(10000, 10100) == "+1:40"


class TestActivityDetailJobs:
    def test_stall_timeout_aborts_instead_of_hanging(self, monkeypatch):
        monkeypatch.setenv("COROS_DETAIL_STALL_TIMEOUT_SECONDS", "0.05")
        progress_events: list[dict] = []

        def fetch_detail(item: str):
            time.sleep(0.2)
            return item, None

        with pytest.raises(ActivityDetailSyncTimeout) as exc_info:
            _run_detail_jobs(
                ["a", "b"],
                jobs=1,
                fetch_detail=fetch_detail,
                label_for=lambda item: item,
                on_commit=lambda _item, _detail, _processed, _fetched: None,
                progress_callback=progress_events.append,
            )

        assert "没有进展" in str(exc_info.value)
        assert progress_events[-1]["phase"] == "activity_details"
        assert progress_events[-1]["current"] == 0
        assert progress_events[-1]["total"] == 2

    def test_detail_jobs_collect_completed_results(self, monkeypatch):
        monkeypatch.setenv("COROS_DETAIL_STALL_TIMEOUT_SECONDS", "1")
        results: dict[str, str] = {}
        completed: list[tuple[str, int, int]] = []

        def fetch_detail(item: str):
            return item, f"detail-{item}"

        _run_detail_jobs(
            ["a", "b"],
            jobs=2,
            fetch_detail=fetch_detail,
            label_for=lambda item: item,
            on_commit=lambda item, detail, processed, fetched: (
                results.__setitem__(item, detail),
                completed.append((item, processed, fetched)),
            ),
        )

        assert results == {"a": "detail-a", "b": "detail-b"}
        assert [item for item, _, _ in completed] == ["a", "b"]
        assert [processed for _, processed, _ in completed] == [1, 2]

    def test_detail_jobs_commit_only_contiguous_prefix(self, monkeypatch):
        monkeypatch.setenv("COROS_DETAIL_STALL_TIMEOUT_SECONDS", "0.05")
        committed: list[str] = []

        def fetch_detail(item: str):
            if item == "b":
                time.sleep(0.2)
            return item, f"detail-{item}"

        with pytest.raises(ActivityDetailSyncTimeout):
            _run_detail_jobs(
                ["a", "b", "c"],
                jobs=3,
                fetch_detail=fetch_detail,
                label_for=lambda item: item,
                on_commit=lambda item, _detail, _processed, _fetched: committed.append(item),
            )

        assert committed == ["a"]

    def test_sync_activities_persists_completed_prefix_before_timeout(self, db, monkeypatch):
        monkeypatch.setenv("COROS_DETAIL_STALL_TIMEOUT_SECONDS", "0.05")

        class FakeClient:
            def list_activities(self, page: int = 1, size: int = 20):
                if page > 1:
                    return {"data": {"dataList": []}}
                return {
                    "data": {
                        "dataList": [
                            _activity_summary("new", "20240103"),
                            _activity_summary("stuck", "20240102"),
                            _activity_summary("old", "20240101"),
                        ],
                    },
                }

            def get_activity_detail(self, label_id: str, _sport_type: int):
                if label_id == "stuck":
                    time.sleep(0.2)
                return _activity_detail(label_id)

        with pytest.raises(ActivityDetailSyncTimeout):
            sync_activities(FakeClient(), db, jobs=3)

        assert db.activity_exists("old")
        assert not db.activity_exists("stuck")
        assert not db.activity_exists("new")
        assert db.get_meta("last_activity_date") == "20240101"

    def test_sync_activities_retry_skips_existing_saved_prefix(self, db, monkeypatch):
        monkeypatch.setenv("COROS_DETAIL_STALL_TIMEOUT_SECONDS", "1")
        old_detail = ActivityDetail.from_api(_activity_detail("old"), "old")
        old_detail.date = "20240101"
        db.upsert_activity(old_detail)
        calls: list[str] = []

        class FakeClient:
            def list_activities(self, page: int = 1, size: int = 20):
                if page > 1:
                    return {"data": {"dataList": []}}
                return {
                    "data": {
                        "dataList": [
                            _activity_summary("new", "20240103"),
                            _activity_summary("stuck", "20240102"),
                            _activity_summary("old", "20240101"),
                        ],
                    },
                }

            def get_activity_detail(self, label_id: str, _sport_type: int):
                calls.append(label_id)
                return _activity_detail(label_id)

        synced = sync_activities(FakeClient(), db, jobs=1)

        assert synced == 2
        assert calls == ["stuck", "new"]
        assert db.activity_exists("old")
        assert db.activity_exists("stuck")
        assert db.activity_exists("new")


class TestAbilityHook:
    def test_empty_new_activities_does_not_fail(self, db, capsys):
        """With no activities or new label_ids, the hook should run silently and persist
        an empty snapshot without raising. The sync pipeline must remain robust."""
        _try_run_ability_hook(db, [])

        # Should not raise — and snapshot rows for today may or may not be written
        # depending on data availability, but the hook must not leak an exception.
        captured = capsys.readouterr()
        # Prints a summary line.
        assert "ability:" in captured.out

    def test_hook_with_unknown_label_id_skips_gracefully(self, db, capsys):
        """Passing a label_id that isn't in the DB should not raise."""
        _try_run_ability_hook(db, ["nonexistent_label"])
        captured = capsys.readouterr()
        assert "ability:" in captured.out

    def test_hook_tolerates_broken_db(self, capsys):
        """Any unexpected exception during the ability hook must be swallowed."""

        class BrokenDB:
            def __getattr__(self, name):
                raise RuntimeError(f"boom:{name}")

        # Should not raise.
        _try_run_ability_hook(BrokenDB(), ["x"])
