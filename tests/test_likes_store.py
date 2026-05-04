"""Tests for the file-backed (default in-test) likes_store backend."""

from __future__ import annotations

import pytest


USER_A = "a1b2c3d4-e5f6-4aaa-89ab-111111111111"
USER_B = "b1b2c3d4-e5f6-4aaa-89ab-222222222222"
USER_C = "c1b2c3d4-e5f6-4aaa-89ab-333333333333"
LABEL = "act-label-001"


@pytest.fixture
def store(tmp_path, monkeypatch):
    import stride_core.db as core_db
    import stride_server.likes_store as ls

    monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)
    monkeypatch.delenv("STRIDE_LIKES_TABLE_ACCOUNT_URL", raising=False)
    ls.reset_backend_cache()
    yield ls
    ls.reset_backend_cache()


TEAM = "t1"


def test_put_like_idempotent(store):
    store.put_like(
        team_id=TEAM, owner_user_id=USER_A, label_id=LABEL,
        liker_user_id=USER_B, liker_display_name="Bob",
    )
    store.put_like(
        team_id=TEAM, owner_user_id=USER_A, label_id=LABEL,
        liker_user_id=USER_B, liker_display_name="Bob",
    )
    rows = store.list_likes(team_id=TEAM, owner_user_id=USER_A, label_id=LABEL)
    assert len(rows) == 1
    assert rows[0].liker_user_id == USER_B
    assert rows[0].liker_display_name == "Bob"


def test_delete_like_returns_true_then_false(store):
    store.put_like(
        team_id=TEAM, owner_user_id=USER_A, label_id=LABEL,
        liker_user_id=USER_B, liker_display_name="Bob",
    )
    assert store.delete_like(
        team_id=TEAM, owner_user_id=USER_A, label_id=LABEL, liker_user_id=USER_B,
    ) is True
    assert store.delete_like(
        team_id=TEAM, owner_user_id=USER_A, label_id=LABEL, liker_user_id=USER_B,
    ) is False
    assert store.list_likes(team_id=TEAM, owner_user_id=USER_A, label_id=LABEL) == []


def test_list_likes_for_multiple_likers(store):
    for liker, name in [(USER_B, "Bob"), (USER_C, "Carol")]:
        store.put_like(
            team_id=TEAM, owner_user_id=USER_A, label_id=LABEL,
            liker_user_id=liker, liker_display_name=name,
        )
    rows = store.list_likes(team_id=TEAM, owner_user_id=USER_A, label_id=LABEL)
    assert {r.liker_user_id for r in rows} == {USER_B, USER_C}
    assert all(r.team_id == TEAM for r in rows)


def test_list_likes_bulk(store):
    other_label = "act-label-002"
    store.put_like(
        team_id=TEAM, owner_user_id=USER_A, label_id=LABEL,
        liker_user_id=USER_B, liker_display_name="Bob",
    )
    store.put_like(
        team_id=TEAM, owner_user_id=USER_A, label_id=LABEL,
        liker_user_id=USER_C, liker_display_name="Carol",
    )
    store.put_like(
        team_id=TEAM, owner_user_id=USER_A, label_id=other_label,
        liker_user_id=USER_B, liker_display_name="Bob",
    )
    bulk = store.list_likes_bulk(
        team_id=TEAM, targets=[(USER_A, LABEL), (USER_A, other_label)],
    )
    assert len(bulk[(USER_A, LABEL)]) == 2
    assert len(bulk[(USER_A, other_label)]) == 1


def test_list_likes_bulk_skips_invalid_targets(store):
    """Invalid (user_id, label_id) pairs are silently skipped, not raised."""
    store.put_like(
        team_id=TEAM, owner_user_id=USER_A, label_id=LABEL,
        liker_user_id=USER_B, liker_display_name="Bob",
    )
    bulk = store.list_likes_bulk(team_id=TEAM, targets=[
        (USER_A, LABEL),
        ("not-a-uuid", "anything"),
        (USER_A, "../../etc/passwd"),
    ])
    assert len(bulk) == 1
    assert (USER_A, LABEL) in bulk


def test_likes_are_scoped_per_team(store):
    """A like in team A must NOT appear when listing for team B (cross-team isolation)."""
    store.put_like(
        team_id="teamA", owner_user_id=USER_A, label_id=LABEL,
        liker_user_id=USER_B, liker_display_name="Bob",
    )
    rows_a = store.list_likes(team_id="teamA", owner_user_id=USER_A, label_id=LABEL)
    rows_b = store.list_likes(team_id="teamB", owner_user_id=USER_A, label_id=LABEL)
    assert len(rows_a) == 1
    assert rows_b == []


def test_invalid_user_id_rejected(store):
    with pytest.raises(ValueError):
        store.put_like(
            team_id=TEAM, owner_user_id="not-a-uuid", label_id=LABEL,
            liker_user_id=USER_B, liker_display_name="Bob",
        )


def test_invalid_label_id_rejected(store):
    with pytest.raises(ValueError):
        store.put_like(
            team_id=TEAM, owner_user_id=USER_A, label_id="../../etc/passwd",
            liker_user_id=USER_B, liker_display_name="Bob",
        )


def test_invalid_team_id_rejected(store):
    with pytest.raises(ValueError):
        store.put_like(
            team_id="../etc/passwd", owner_user_id=USER_A, label_id=LABEL,
            liker_user_id=USER_B, liker_display_name="Bob",
        )
