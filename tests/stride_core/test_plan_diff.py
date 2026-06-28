"""Unit tests for stride_core.plan_diff.

Uses an in-memory SQLite DB (via the shared ``db`` fixture from conftest.py)
wrapped in a minimal stub that satisfies the interface expected by apply_diff.
"""

from __future__ import annotations

import uuid

import pytest

from stride_core.plan_diff import (
    DiffOp,
    DiffOpKind,
    PlanDiff,
    apply_diff,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

FOLDER = "2026-05-04_05-10(W2)"


def _op_id() -> str:
    return str(uuid.uuid4())


def _insert_session(db, *, date: str, session_index: int, kind: str = "run",
                    summary: str = "Easy 10km", notes_md: str | None = None,
                    total_distance_m: float | None = 10000.0) -> int:
    """Insert a planned_session row and return its id."""
    cur = db._conn.execute(
        """INSERT INTO planned_session
           (week_folder, date, session_index, kind, summary, notes_md, total_distance_m)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (FOLDER, date, session_index, kind, summary, notes_md, total_distance_m),
    )
    db._conn.commit()
    return cur.lastrowid


def _get_session(db, row_id: int) -> dict | None:
    rows = db._conn.execute(
        "SELECT * FROM planned_session WHERE id = ?", (row_id,)
    ).fetchall()
    return dict(rows[0]) if rows else None


def _all_sessions(db) -> list[dict]:
    rows = db._conn.execute(
        "SELECT * FROM planned_session WHERE week_folder = ? ORDER BY date, session_index",
        (FOLDER,),
    ).fetchall()
    return [dict(r) for r in rows]


class _StoreStub:
    """Minimal PlanStateStore-compatible stub wrapping the test DB."""

    def __init__(self, db):
        self._db = db

    def get_planned_session_by_date_index(self, date: str, session_index: int):
        rows = self._db._conn.execute(
            "SELECT * FROM planned_session WHERE date = ? AND session_index = ?",
            (date, session_index),
        ).fetchall()
        return dict(rows[0]) if rows else None


def _make_diff(ops: list[DiffOp]) -> PlanDiff:
    return PlanDiff(
        diff_id=str(uuid.uuid4()),
        folder=FOLDER,
        ops=ops,
        ai_explanation="Test diff",
        created_at="2026-05-12T08:00:00Z",
    )


# ---------------------------------------------------------------------------
# REMOVE_SESSION
# ---------------------------------------------------------------------------


def test_remove_session(db):
    row_id = _insert_session(db, date="2026-05-05", session_index=0)
    assert _get_session(db, row_id) is not None

    op_id = _op_id()
    diff = _make_diff([
        DiffOp(
            id=op_id,
            op=DiffOpKind.REMOVE_SESSION,
            date="2026-05-05",
            session_index=0,
            old_value={"summary": "Easy 10km"},
            new_value=None,
            spec_patch=None,   # REMOVE doesn't need spec_patch
            accepted=None,
        )
    ])
    store = _StoreStub(db)
    apply_diff(store, FOLDER, diff, accepted_op_ids=[op_id])

    assert _get_session(db, row_id) is None


def test_remove_session_not_in_accepted_list_is_noop(db):
    row_id = _insert_session(db, date="2026-05-05", session_index=0)

    diff = _make_diff([
        DiffOp(
            id="some-op-id",
            op=DiffOpKind.REMOVE_SESSION,
            date="2026-05-05",
            session_index=0,
            old_value=None,
            new_value=None,
            spec_patch=None,
            accepted=None,
        )
    ])
    store = _StoreStub(db)
    # Pass an empty accepted list — op should be skipped
    apply_diff(store, FOLDER, diff, accepted_op_ids=[])

    # Row must still be there
    assert _get_session(db, row_id) is not None


# ---------------------------------------------------------------------------
# ADD_SESSION
# ---------------------------------------------------------------------------


def test_add_session(db):
    op_id = _op_id()
    diff = _make_diff([
        DiffOp(
            id=op_id,
            op=DiffOpKind.ADD_SESSION,
            date="2026-05-08",
            session_index=0,
            old_value=None,
            new_value={"summary": "Tempo 8km"},
            spec_patch={"kind": "run", "summary": "Tempo 8km", "total_distance_m": 8000.0},
            accepted=None,
        )
    ])
    store = _StoreStub(db)
    apply_diff(store, FOLDER, diff, accepted_op_ids=[op_id])

    sessions = _all_sessions(db)
    assert len(sessions) == 1
    assert sessions[0]["date"] == "2026-05-08"
    assert sessions[0]["summary"] == "Tempo 8km"
    assert sessions[0]["kind"] == "run"
    assert sessions[0]["total_distance_m"] == 8000.0


def test_add_session_spec_patch_none_is_skipped(db):
    op_id = _op_id()
    diff = _make_diff([
        DiffOp(
            id=op_id,
            op=DiffOpKind.ADD_SESSION,
            date="2026-05-08",
            session_index=0,
            old_value=None,
            new_value={"summary": "Tempo 8km"},
            spec_patch=None,   # no patch → should be skipped
            accepted=None,
        )
    ])
    store = _StoreStub(db)
    apply_diff(store, FOLDER, diff, accepted_op_ids=[op_id])

    # Nothing should be inserted
    assert _all_sessions(db) == []


# ---------------------------------------------------------------------------
# MOVE_SESSION
# ---------------------------------------------------------------------------


def test_move_session(db):
    row_id = _insert_session(db, date="2026-05-05", session_index=0)

    op_id = _op_id()
    diff = _make_diff([
        DiffOp(
            id=op_id,
            op=DiffOpKind.MOVE_SESSION,
            date="2026-05-05",
            session_index=0,
            old_value={"date": "2026-05-05"},
            new_value={"date": "2026-05-06"},
            spec_patch={"new_date": "2026-05-06", "new_session_index": 0},
            accepted=None,
        )
    ])
    store = _StoreStub(db)
    apply_diff(store, FOLDER, diff, accepted_op_ids=[op_id])

    row = _get_session(db, row_id)
    assert row is not None
    assert row["date"] == "2026-05-06"
    assert row["session_index"] == 0


# ---------------------------------------------------------------------------
# REPLACE_KIND
# ---------------------------------------------------------------------------


def test_replace_kind(db):
    row_id = _insert_session(db, date="2026-05-06", session_index=0, kind="run")

    op_id = _op_id()
    diff = _make_diff([
        DiffOp(
            id=op_id,
            op=DiffOpKind.REPLACE_KIND,
            date="2026-05-06",
            session_index=0,
            old_value={"kind": "run"},
            new_value={"kind": "strength"},
            spec_patch={"kind": "strength", "summary": "力量训练 A"},
            accepted=None,
        )
    ])
    store = _StoreStub(db)
    apply_diff(store, FOLDER, diff, accepted_op_ids=[op_id])

    row = _get_session(db, row_id)
    assert row["kind"] == "strength"
    assert row["summary"] == "力量训练 A"


# ---------------------------------------------------------------------------
# REPLACE_DISTANCE
# ---------------------------------------------------------------------------


def test_replace_distance(db):
    row_id = _insert_session(db, date="2026-05-07", session_index=0,
                              total_distance_m=10000.0)

    op_id = _op_id()
    diff = _make_diff([
        DiffOp(
            id=op_id,
            op=DiffOpKind.REPLACE_DISTANCE,
            date="2026-05-07",
            session_index=0,
            old_value={"total_distance_m": 10000.0},
            new_value={"total_distance_m": 12000.0},
            spec_patch={"total_distance_m": 12000.0},
            accepted=None,
        )
    ])
    store = _StoreStub(db)
    apply_diff(store, FOLDER, diff, accepted_op_ids=[op_id])

    row = _get_session(db, row_id)
    assert row["total_distance_m"] == 12000.0


# ---------------------------------------------------------------------------
# REPLACE_NOTE
# ---------------------------------------------------------------------------


def test_replace_note(db):
    row_id = _insert_session(db, date="2026-05-08", session_index=0,
                              notes_md="Old notes")

    op_id = _op_id()
    diff = _make_diff([
        DiffOp(
            id=op_id,
            op=DiffOpKind.REPLACE_NOTE,
            date="2026-05-08",
            session_index=0,
            old_value={"notes_md": "Old notes"},
            new_value={"notes_md": "New notes with detail"},
            spec_patch={"notes_md": "New notes with detail"},
            accepted=None,
        )
    ])
    store = _StoreStub(db)
    apply_diff(store, FOLDER, diff, accepted_op_ids=[op_id])

    row = _get_session(db, row_id)
    assert row["notes_md"] == "New notes with detail"


# ---------------------------------------------------------------------------
# Partial acceptance — only accepted_op_ids list entries are applied
# ---------------------------------------------------------------------------


def test_partial_acceptance(db):
    """Only ops in accepted_op_ids should be applied; others are ignored."""
    row_id_mon = _insert_session(db, date="2026-05-04", session_index=0,
                                  kind="run", summary="Easy 10km")
    row_id_tue = _insert_session(db, date="2026-05-05", session_index=0,
                                  kind="run", summary="Tempo 8km")

    op_accept = _op_id()   # this one will be accepted
    op_reject = _op_id()   # this one will NOT be accepted

    diff = _make_diff([
        DiffOp(
            id=op_accept,
            op=DiffOpKind.REPLACE_NOTE,
            date="2026-05-04",
            session_index=0,
            old_value=None,
            new_value=None,
            spec_patch={"notes_md": "Accepted note"},
            accepted=None,
        ),
        DiffOp(
            id=op_reject,
            op=DiffOpKind.REPLACE_NOTE,
            date="2026-05-05",
            session_index=0,
            old_value=None,
            new_value=None,
            spec_patch={"notes_md": "Rejected note"},
            accepted=None,
        ),
    ])
    store = _StoreStub(db)
    apply_diff(store, FOLDER, diff, accepted_op_ids=[op_accept])

    mon = _get_session(db, row_id_mon)
    tue = _get_session(db, row_id_tue)

    assert mon["notes_md"] == "Accepted note"
    assert tue["notes_md"] is None   # unchanged


# ---------------------------------------------------------------------------
# Empty ops list → no-op
# ---------------------------------------------------------------------------


def test_empty_ops_list_is_noop(db):
    row_id = _insert_session(db, date="2026-05-05", session_index=0)

    diff = _make_diff([])
    store = _StoreStub(db)
    apply_diff(store, FOLDER, diff, accepted_op_ids=[])

    assert _get_session(db, row_id) is not None


# ---------------------------------------------------------------------------
# spec_patch None for non-REMOVE op is skipped
# ---------------------------------------------------------------------------


def test_replace_kind_spec_patch_none_is_skipped(db):
    row_id = _insert_session(db, date="2026-05-06", session_index=0, kind="run")

    op_id = _op_id()
    diff = _make_diff([
        DiffOp(
            id=op_id,
            op=DiffOpKind.REPLACE_KIND,
            date="2026-05-06",
            session_index=0,
            old_value={"kind": "run"},
            new_value={"kind": "strength"},
            spec_patch=None,   # no patch → should be skipped
            accepted=None,
        )
    ])
    store = _StoreStub(db)
    apply_diff(store, FOLDER, diff, accepted_op_ids=[op_id])

    row = _get_session(db, row_id)
    # kind must NOT have changed
    assert row["kind"] == "run"


# ---------------------------------------------------------------------------
# Folder guard — an op whose session lives in a different week is skipped
# ---------------------------------------------------------------------------


def _insert_session_in(db, *, folder: str, date: str, session_index: int = 0,
                       kind: str = "run", summary: str = "Easy 10km") -> int:
    cur = db._conn.execute(
        """INSERT INTO planned_session
           (week_folder, date, session_index, kind, summary, total_distance_m)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (folder, date, session_index, kind, summary, 10000.0),
    )
    db._conn.commit()
    return cur.lastrowid


def test_apply_skips_session_in_another_folder(db):
    """A crafted op targeting a date that belongs to a different week must not
    mutate that other week's session (the apply endpoint takes a client diff)."""
    other_folder = "2026-04-13_04-19(W-1)"
    row_id = _insert_session_in(db, folder=other_folder, date="2026-04-15", kind="run")

    op_id = _op_id()
    diff = _make_diff([  # diff.folder == FOLDER, but the op date is in other_folder
        DiffOp(
            id=op_id,
            op=DiffOpKind.REMOVE_SESSION,
            date="2026-04-15",
            session_index=0,
            old_value=None,
            new_value=None,
            spec_patch=None,
            accepted=None,
        )
    ])
    store = _StoreStub(db)
    apply_diff(store, FOLDER, diff, accepted_op_ids=[op_id])

    # The other week's session must survive — the guard refused the cross-folder hit.
    assert _get_session(db, row_id) is not None
