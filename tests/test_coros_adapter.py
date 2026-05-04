"""Unit tests for CorosDataSource — verifies Protocol conformance and forwarding."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from coros_sync.adapter import (
    ActivityNotFoundError,
    CorosDataSource,
    CorosNotLoggedInError,
)
from stride_core.source import DataSource, SyncResult


def test_conforms_to_datasource_protocol():
    """Runtime-checkable Protocol check: instance matches structural contract."""
    src = CorosDataSource()
    assert isinstance(src, DataSource)
    assert src.name == "coros"


def test_is_logged_in_false_for_fresh_creds(tmp_path, monkeypatch):
    # Point the auth module at a fresh temp data dir, so no prior creds exist.
    monkeypatch.setattr("coros_sync.auth.USER_DATA_DIR", tmp_path)
    src = CorosDataSource()
    assert src.is_logged_in("nobody") is False


def test_is_logged_in_true_when_credentials_saved(tmp_path, monkeypatch):
    from coros_sync.auth import Credentials
    monkeypatch.setattr("coros_sync.auth.USER_DATA_DIR", tmp_path)
    creds = Credentials(email="x@y", pwd_hash="h", access_token="tok", region="cn")
    creds.save(user="alice")

    src = CorosDataSource()
    assert src.is_logged_in("alice") is True


def test_sync_user_raises_when_not_logged_in(tmp_path, monkeypatch):
    monkeypatch.setattr("coros_sync.auth.USER_DATA_DIR", tmp_path)
    src = CorosDataSource()
    with pytest.raises(CorosNotLoggedInError):
        src.sync_user("nobody")


def test_sync_user_forwards_to_run_sync(tmp_path, monkeypatch):
    from coros_sync.auth import Credentials
    monkeypatch.setattr("coros_sync.auth.USER_DATA_DIR", tmp_path)
    Credentials(email="x@y", pwd_hash="h", access_token="tok", region="cn").save(user="alice")

    fake_client = MagicMock()
    fake_client.__enter__.return_value = fake_client
    fake_client.__exit__.return_value = False
    fake_db = MagicMock()
    fake_db.__enter__.return_value = fake_db
    fake_db.__exit__.return_value = False

    with patch("coros_sync.adapter.CorosClient", return_value=fake_client), \
         patch("coros_sync.adapter.Database", return_value=fake_db), \
         patch("coros_sync.adapter.run_sync", return_value=(7, 3)) as run_sync_mock:
        result = CorosDataSource(jobs=2).sync_user("alice", full=True)

    assert result == SyncResult(activities=7, health=3)
    run_sync_mock.assert_called_once_with(fake_client, fake_db, full=True, jobs=2)


def test_resync_activity_raises_when_activity_missing(tmp_path, monkeypatch):
    from coros_sync.auth import Credentials
    monkeypatch.setattr("coros_sync.auth.USER_DATA_DIR", tmp_path)
    Credentials(email="x@y", pwd_hash="h", access_token="tok", region="cn").save(user="alice")

    fake_db = MagicMock()
    fake_db.query.return_value = []

    with patch("coros_sync.adapter.Database", return_value=fake_db):
        with pytest.raises(ActivityNotFoundError):
            CorosDataSource().resync_activity("alice", "LABEL_MISSING")

    fake_db.close.assert_called_once()


def test_delete_scheduled_workout_success(tmp_path, monkeypatch):
    """STRIDE-prefixed entity on date → client.delete called, returns True."""
    from coros_sync.auth import Credentials
    monkeypatch.setattr("coros_sync.auth.USER_DATA_DIR", tmp_path)
    Credentials(email="x@y", pwd_hash="h", access_token="tok", region="cn").save(user="alice")

    fake_client = MagicMock()
    fake_client.__enter__.return_value = fake_client
    fake_client.__exit__.return_value = False
    stride_entity = {
        "happenDay": "20260504",
        "idInPlan": "ID1",
        "exerciseBarChart": [{"exerciseType": 2, "name": "[STRIDE] 力量训练"}],
    }
    fake_client.query_schedule.return_value = {
        "data": {"id": "PLAN_ID_1", "entities": [stride_entity]},
    }

    with patch("coros_sync.adapter.CorosClient", return_value=fake_client):
        result = CorosDataSource().delete_scheduled_workout("alice", "2026-05-04")

    assert result is True
    fake_client.query_schedule.assert_called_once_with("20260504", "20260504")
    fake_client.delete_scheduled_workout.assert_called_once_with(stride_entity, "PLAN_ID_1")


def test_delete_scheduled_workout_skips_non_stride(tmp_path, monkeypatch):
    """Non-STRIDE entity on date → not deleted, returns False."""
    from coros_sync.auth import Credentials
    monkeypatch.setattr("coros_sync.auth.USER_DATA_DIR", tmp_path)
    Credentials(email="x@y", pwd_hash="h", access_token="tok", region="cn").save(user="alice")

    fake_client = MagicMock()
    fake_client.__enter__.return_value = fake_client
    fake_client.__exit__.return_value = False
    fake_client.query_schedule.return_value = {
        "data": {
            "id": "PLAN_ID_2",
            "entities": [
                {
                    "happenDay": "20260504",
                    "idInPlan": "ID_USER",
                    "exerciseBarChart": [{"exerciseType": 2, "name": "user-own-workout"}],
                },
            ],
        },
    }

    with patch("coros_sync.adapter.CorosClient", return_value=fake_client):
        result = CorosDataSource().delete_scheduled_workout("alice", "2026-05-04")

    assert result is False
    fake_client.delete_scheduled_workout.assert_not_called()


def test_delete_scheduled_workout_no_entities_on_date(tmp_path, monkeypatch):
    """Empty schedule → no deletes, returns False."""
    from coros_sync.auth import Credentials
    monkeypatch.setattr("coros_sync.auth.USER_DATA_DIR", tmp_path)
    Credentials(email="x@y", pwd_hash="h", access_token="tok", region="cn").save(user="alice")

    fake_client = MagicMock()
    fake_client.__enter__.return_value = fake_client
    fake_client.__exit__.return_value = False
    fake_client.query_schedule.return_value = {"data": {"id": "PLAN_ID_3", "entities": []}}

    with patch("coros_sync.adapter.CorosClient", return_value=fake_client):
        result = CorosDataSource().delete_scheduled_workout("alice", "2026-05-04")

    assert result is False
    fake_client.delete_scheduled_workout.assert_not_called()


def test_delete_scheduled_workout_iso_to_coros_date_conversion(tmp_path, monkeypatch):
    """ISO YYYY-MM-DD must be coerced to COROS YYYYMMDD before query/match."""
    from coros_sync.auth import Credentials
    monkeypatch.setattr("coros_sync.auth.USER_DATA_DIR", tmp_path)
    Credentials(email="x@y", pwd_hash="h", access_token="tok", region="cn").save(user="alice")

    fake_client = MagicMock()
    fake_client.__enter__.return_value = fake_client
    fake_client.__exit__.return_value = False
    # happenDay is the COROS-format date; mismatch (ISO not coerced) means
    # the entity would be skipped. We assert the query call carries the
    # COROS-format string AND the match works (delete called).
    fake_client.query_schedule.return_value = {
        "data": {
            "id": "PLAN_ID_4",
            "entities": [
                {
                    "happenDay": "20260504",
                    "idInPlan": "ID2",
                    "exerciseBarChart": [{"exerciseType": 2, "name": "[STRIDE] easy run"}],
                },
            ],
        },
    }

    with patch("coros_sync.adapter.CorosClient", return_value=fake_client):
        result = CorosDataSource().delete_scheduled_workout("alice", "2026-05-04")

    assert result is True
    # Both args must be coerced ("20260504"), not the ISO form.
    fake_client.query_schedule.assert_called_once_with("20260504", "20260504")


def test_delete_scheduled_workout_raises_when_not_logged_in(tmp_path, monkeypatch):
    monkeypatch.setattr("coros_sync.auth.USER_DATA_DIR", tmp_path)
    src = CorosDataSource()
    with pytest.raises(CorosNotLoggedInError):
        src.delete_scheduled_workout("nobody", "2026-05-04")


def test_resync_activity_fetches_and_upserts(tmp_path, monkeypatch):
    from coros_sync.auth import Credentials
    monkeypatch.setattr("coros_sync.auth.USER_DATA_DIR", tmp_path)
    Credentials(email="x@y", pwd_hash="h", access_token="tok", region="cn").save(user="alice")

    fake_db = MagicMock()
    fake_db.query.return_value = [{"sport_type": 100, "date": "20260420"}]

    fake_client = MagicMock()
    fake_client.__enter__.return_value = fake_client
    fake_client.__exit__.return_value = False
    fake_client.get_activity_detail.return_value = {"data": {"summary": {"sportType": 100}}}

    fake_detail = MagicMock()
    fake_detail.date = None

    with patch("coros_sync.adapter.Database", return_value=fake_db), \
         patch("coros_sync.adapter.CorosClient", return_value=fake_client), \
         patch("coros_sync.adapter.ActivityDetail") as detail_cls:
        detail_cls.from_api.return_value = fake_detail
        result = CorosDataSource().resync_activity("alice", "LABEL_123")

    assert result is True
    fake_client.get_activity_detail.assert_called_once_with("LABEL_123", 100)
    # date filled from DB since detail.date was None
    assert fake_detail.date == "20260420"
    fake_db.upsert_activity.assert_called_once_with(fake_detail)
    fake_db.close.assert_called_once()
