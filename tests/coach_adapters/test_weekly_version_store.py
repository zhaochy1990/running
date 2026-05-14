"""US-004 acceptance tests for FileWeeklyVersionStore."""

from __future__ import annotations

import time
from pathlib import Path

from stride_server.coach_adapters.persistence.weekly_version_store import (
    FileWeeklyVersionStore,
    WeeklyPlanVersion,
    make_reverse_time_key,
)


def _make_version(
    *,
    user_id: str = "u1",
    folder: str = "2026-05-11_05-17(P1W3)",
    version_id: str = "v1",
    parent_version_id: str | None = None,
    rationale: str = "test",
) -> WeeklyPlanVersion:
    return WeeklyPlanVersion(
        user_id=user_id,
        folder=folder,
        version_id=version_id,
        parent_version_id=parent_version_id,
        artifact_json='{"schema":"weekly-plan/v1"}',
        rationale=rationale,
        applied_op_ids=["op-1"],
        proposal_id=None,
        created_by="claude-sonnet-4-5",
        created_at="2026-05-13T10:00:00Z",
    )


def test_reverse_time_key_orders_newest_first() -> None:
    earlier = make_reverse_time_key(ms_since_epoch=1_000_000)
    later = make_reverse_time_key(ms_since_epoch=2_000_000)
    assert later < earlier
    # And they're both 20-char zero-padded
    assert len(earlier) == 20
    assert len(later) == 20


def test_add_and_get_version(tmp_path: Path) -> None:
    store = FileWeeklyVersionStore(tmp_path)
    v = _make_version()
    row_key = store.add_version(v)
    assert row_key.endswith("|v1")
    got = store.get_version("u1", "2026-05-11_05-17(P1W3)", "v1")
    assert got is not None
    assert got.applied_op_ids == ["op-1"]
    assert got.rationale == "test"


def test_get_missing_returns_none(tmp_path: Path) -> None:
    store = FileWeeklyVersionStore(tmp_path)
    assert store.get_version("u1", "any", "nope") is None


def test_list_versions_reverse_chronological(tmp_path: Path) -> None:
    store = FileWeeklyVersionStore(tmp_path)
    folder = "2026-05-11_05-17(P1W3)"
    # Insert 3 versions with measurable temporal gaps
    store.add_version(_make_version(folder=folder, version_id="v1", parent_version_id=None))
    time.sleep(0.01)
    store.add_version(_make_version(folder=folder, version_id="v2", parent_version_id="v1"))
    time.sleep(0.01)
    store.add_version(_make_version(folder=folder, version_id="v3", parent_version_id="v2"))
    listed = store.list_versions("u1", folder)
    assert [v.version_id for v in listed] == ["v3", "v2", "v1"]
    # And parent chain is intact
    assert listed[0].parent_version_id == "v2"
    assert listed[1].parent_version_id == "v1"
    assert listed[2].parent_version_id is None


def test_list_versions_partition_isolation(tmp_path: Path) -> None:
    store = FileWeeklyVersionStore(tmp_path)
    store.add_version(_make_version(folder="W01", version_id="v1"))
    store.add_version(_make_version(folder="W02", version_id="v1"))
    store.add_version(_make_version(user_id="other", folder="W01", version_id="v1"))
    w01_u1 = store.list_versions("u1", "W01")
    w02_u1 = store.list_versions("u1", "W02")
    w01_other = store.list_versions("other", "W01")
    assert len(w01_u1) == 1
    assert len(w02_u1) == 1
    assert len(w01_other) == 1


def test_delete_user_sweep(tmp_path: Path) -> None:
    store = FileWeeklyVersionStore(tmp_path)
    store.add_version(_make_version(user_id="doomed", folder="W01", version_id="v1"))
    store.add_version(_make_version(user_id="doomed", folder="W02", version_id="v1"))
    store.add_version(_make_version(user_id="keeper", folder="W01", version_id="v1"))
    deleted = store.delete_user("doomed")
    assert deleted == 2
    assert store.list_versions("doomed", "W01") == []
    assert store.list_versions("doomed", "W02") == []
    assert len(store.list_versions("keeper", "W01")) == 1


def test_azure_range_upper_bound_after_pipe() -> None:
    """Regression: the Azure delete_user range query must use ``}`` (0x7D), the
    byte immediately after ``|`` (0x7C), as the upper bound. ``;`` (0x3B) is
    LESS than ``|`` and would silently match zero rows — see architect review
    finding for weekly_version_store.py:235."""
    # The file backend already uses startswith, so this test exercises the
    # exact lexical fence used in the Azure code path against a synthetic
    # set of partition keys.
    user_id = "alice"
    candidate_keys = [
        f"{user_id}|W01",
        f"{user_id}|W02",
        f"{user_id}|2026-05-11_05-17",
        f"alic_other|W01",     # different user
        f"bob|W01",            # different user
        f"{user_id}xtra|W01",  # impostor with a longer prefix
    ]
    lo = f"{user_id}|"
    hi = f"{user_id}}}"
    matched = sorted(k for k in candidate_keys if lo <= k < hi)
    assert matched == sorted(
        [f"{user_id}|W01", f"{user_id}|W02", f"{user_id}|2026-05-11_05-17"]
    )
    # Sanity check: the broken upper bound ``;`` matches nothing.
    broken_hi = f"{user_id};"
    assert [k for k in candidate_keys if lo <= k < broken_hi] == []


def test_list_versions_limit(tmp_path: Path) -> None:
    store = FileWeeklyVersionStore(tmp_path)
    for i in range(5):
        store.add_version(_make_version(version_id=f"v{i}"))
        time.sleep(0.005)
    listed = store.list_versions("u1", "2026-05-11_05-17(P1W3)", limit=2)
    assert len(listed) == 2
