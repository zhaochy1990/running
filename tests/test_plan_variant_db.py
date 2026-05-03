"""Tests for the multi-variant weekly plan layer (Step 1).

Covers:
- weekly_plan_variant schema (insert / supersede / partial unique index)
- weekly_plan_variant_rating (UPSERT semantics, multi-user)
- delete_weekly_plan_variants (explicit two-step, no orphan ratings)
- (commit=False, conn=) plumbing on the 5 transactionalized helpers
- select_weekly_plan_variant FALLBACK design (per Step 0 spike)
- Concurrent select isolation via open_immediate_txn busy_timeout
- schema_version skew handling

Default test DB lives at the conftest `db` fixture's tmp_path. Tests that
call `select_weekly_plan_variant` (which internally `apply_weekly_plan`s
via its own Database(user=...) instance) monkeypatch Database.__init__
to redirect to the same tmp_path so all three connections (test fixture,
apply_weekly_plan's main conn, dedicated immediate-txn) hit the same DB.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Iterator

import pytest

from stride_core.db import Database
from stride_core.plan_spec import (
    Meal,
    PlannedNutrition,
    PlannedSession,
    SessionKind,
    SUPPORTED_SCHEMA_VERSION,
    WeeklyPlan,
)


WEEK = "2026-05-04_05-10(P1W2)"


# ── Helpers ────────────────────────────────────────────────────────────


def _make_plan(week: str = WEEK) -> WeeklyPlan:
    return WeeklyPlan(
        week_folder=week,
        sessions=tuple([
            PlannedSession(date="2026-05-04", session_index=0,
                           kind=SessionKind.RUN, summary="easy 10k"),
            PlannedSession(date="2026-05-06", session_index=0,
                           kind=SessionKind.RUN, summary="tempo"),
            PlannedSession(date="2026-05-09", session_index=0,
                           kind=SessionKind.RUN, summary="long"),
        ]),
        nutrition=tuple([
            PlannedNutrition(date="2026-05-04", kcal_target=2400.0,
                             meals=(Meal(name="早"), Meal(name="午"))),
        ]),
    )


def _structured_json(plan: WeeklyPlan) -> str:
    return json.dumps(plan.to_dict())


@pytest.fixture
def patched_db(tmp_path: Path) -> Iterator[Database]:
    """Database fixture that ALSO monkey-patches Database.__init__ so
    select_weekly_plan_variant's internal apply_weekly_plan(user=...)
    routes back to the same tmp_path. Restores on teardown.
    """
    db_path = tmp_path / "test.db"
    orig_init = Database.__init__

    def patched(self, db_path_arg=None, user=None):
        return orig_init(self, db_path=str(db_path), user=None)

    Database.__init__ = patched  # type: ignore[method-assign]
    try:
        with Database() as database:
            yield database
    finally:
        Database.__init__ = orig_init  # type: ignore[method-assign]


def _seed_pushed_session(db: Database, *, week: str, date: str,
                         session_index: int, kind: str = "run") -> int:
    """Create a planned_session + scheduled_workout pair, stitch them.
    Returns the scheduled_workout id.
    """
    db._conn.execute(
        "INSERT OR REPLACE INTO weekly_plan (week, content_md, generated_at, updated_at) "
        "VALUES (?,?, datetime('now'), datetime('now'))",
        (week, "seed"),
    )
    cur_sw = db._conn.execute(
        """INSERT INTO scheduled_workout
           (date, kind, name, spec_json, status, provider, provider_workout_id,
            pushed_at, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?, datetime('now'),
                   datetime('now'), datetime('now'))""",
        (date, kind, f"[STRIDE] {date}", "{}", "pushed", "coros",
         f"prov-{date}-{kind}"),
    )
    sw_id = cur_sw.lastrowid
    db._conn.execute(
        """INSERT INTO planned_session
           (week_folder, date, session_index, kind, summary,
            scheduled_workout_id, updated_at)
           VALUES (?,?,?,?,?,?, datetime('now'))""",
        (week, date, session_index, kind, "seed", sw_id),
    )
    db._conn.commit()
    return sw_id


# ── Schema / insert / supersede ────────────────────────────────────────


def test_insert_weekly_plan_variant_basic(db: Database) -> None:
    vid = db.insert_weekly_plan_variant(
        week_folder=WEEK, model_id="claude",
        content_md="# v1", structured_json='{"k":1}',
        schema_version=1,
    )
    assert vid > 0
    row = db.get_weekly_plan_variant(vid)
    assert row is not None
    assert row["week_folder"] == WEEK
    assert row["model_id"] == "claude"
    assert row["content_md"] == "# v1"
    assert row["schema_version"] == 1
    assert row["variant_parse_status"] == "fresh"
    assert row["superseded_at"] is None


def test_insert_weekly_plan_variant_supersede_same_model(db: Database) -> None:
    """Re-running same model on same week: prior row gets superseded_at,
    new row inserted.
    """
    v1 = db.insert_weekly_plan_variant(WEEK, "claude", "# v1", "{}")
    # Sleep to ensure superseded_at > generated_at on row 1.
    time.sleep(0.01)
    v2 = db.insert_weekly_plan_variant(WEEK, "claude", "# v2", "{}")
    assert v2 != v1

    active = db.get_weekly_plan_variants(WEEK)
    assert len(active) == 1
    assert active[0]["id"] == v2
    assert active[0]["superseded_at"] is None

    all_rows = db.get_weekly_plan_variants(WEEK, include_superseded=True)
    assert len(all_rows) == 2
    superseded = [r for r in all_rows if r["id"] == v1][0]
    assert superseded["superseded_at"] is not None


def test_insert_weekly_plan_variant_different_models_coexist(db: Database) -> None:
    v_claude = db.insert_weekly_plan_variant(WEEK, "claude", "c", "{}")
    v_codex = db.insert_weekly_plan_variant(WEEK, "codex", "x", "{}")
    v_gem = db.insert_weekly_plan_variant(WEEK, "gemini", "g", "{}")
    active = db.get_weekly_plan_variants(WEEK)
    assert {r["id"] for r in active} == {v_claude, v_codex, v_gem}


def test_partial_unique_index_blocks_duplicate_active(db: Database) -> None:
    """Direct SQL bypass of the supersede helper must hit the partial
    unique index — only one ACTIVE row per (week, model).
    """
    db.insert_weekly_plan_variant(WEEK, "claude", "first", "{}")
    with pytest.raises(sqlite3.IntegrityError):
        db._conn.execute(
            """INSERT INTO weekly_plan_variant
               (week_folder, model_id, schema_version, content_md, generated_at)
               VALUES (?,?,?,?, datetime('now'))""",
            (WEEK, "claude", 1, "duplicate-active"),
        )


def test_insert_weekly_plan_variant_parse_failed(db: Database) -> None:
    """parse_failed variants store md but null structured_json."""
    vid = db.insert_weekly_plan_variant(
        WEEK, "codex", "raw md", None,
        variant_parse_status="parse_failed",
    )
    row = db.get_weekly_plan_variant(vid)
    assert row["variant_parse_status"] == "parse_failed"
    assert row["structured_json"] is None


# ── Ratings ────────────────────────────────────────────────────────────


def test_upsert_variant_rating_basic(db: Database) -> None:
    vid = db.insert_weekly_plan_variant(WEEK, "claude", "x", "{}")
    db.upsert_variant_rating(vid, "overall", 4, comment="ok",
                             rated_by="user-uuid-A")
    rs = db.get_variant_ratings(vid)
    assert len(rs) == 1
    assert rs[0]["score"] == 4
    assert rs[0]["comment"] == "ok"
    assert rs[0]["dimension"] == "overall"


def test_upsert_variant_rating_replaces_same_user(db: Database) -> None:
    vid = db.insert_weekly_plan_variant(WEEK, "claude", "x", "{}")
    db.upsert_variant_rating(vid, "overall", 3, rated_by="user-A")
    db.upsert_variant_rating(vid, "overall", 5, comment="changed mind",
                             rated_by="user-A")
    rs = db.get_variant_ratings(vid)
    assert len(rs) == 1
    assert rs[0]["score"] == 5
    assert rs[0]["comment"] == "changed mind"


def test_upsert_variant_rating_multi_user_coexist(db: Database) -> None:
    vid = db.insert_weekly_plan_variant(WEEK, "claude", "x", "{}")
    db.upsert_variant_rating(vid, "overall", 4, rated_by="user-A")
    db.upsert_variant_rating(vid, "overall", 2, rated_by="user-B")
    rs = db.get_variant_ratings(vid)
    assert len(rs) == 2
    by_user = {r["rated_by"]: r["score"] for r in rs}
    assert by_user == {"user-A": 4, "user-B": 2}


def test_upsert_variant_rating_validates_score_range(db: Database) -> None:
    vid = db.insert_weekly_plan_variant(WEEK, "claude", "x", "{}")
    with pytest.raises(ValueError):
        db.upsert_variant_rating(vid, "overall", 0, rated_by="u")
    with pytest.raises(ValueError):
        db.upsert_variant_rating(vid, "overall", 6, rated_by="u")


def test_upsert_variant_rating_multi_dimension(db: Database) -> None:
    vid = db.insert_weekly_plan_variant(WEEK, "claude", "x", "{}")
    for dim in ("suitability", "structure", "nutrition", "difficulty",
                "overall"):
        db.upsert_variant_rating(vid, dim, 4, rated_by="u")
    rs = db.get_variant_ratings(vid)
    assert {r["dimension"] for r in rs} == {
        "suitability", "structure", "nutrition", "difficulty", "overall",
    }


# ── Delete ─────────────────────────────────────────────────────────────


def test_delete_weekly_plan_variants_two_step(db: Database) -> None:
    """Explicit two-step delete leaves 0 orphan ratings even though the
    project runs PRAGMA foreign_keys=OFF (CASCADE is silent no-op).
    """
    v1 = db.insert_weekly_plan_variant(WEEK, "claude", "c", "{}")
    v2 = db.insert_weekly_plan_variant(WEEK, "codex", "x", "{}")
    db.upsert_variant_rating(v1, "overall", 4, rated_by="u")
    db.upsert_variant_rating(v2, "overall", 3, rated_by="u")
    deleted = db.delete_weekly_plan_variants(WEEK)
    assert deleted == 2
    assert db._conn.execute(
        "SELECT COUNT(*) FROM weekly_plan_variant_rating",
    ).fetchone()[0] == 0


def test_delete_weekly_plan_variants_only_targets_week(db: Database) -> None:
    other_week = "2026-05-11_05-17"
    v_keep = db.insert_weekly_plan_variant(other_week, "claude", "k", "{}")
    db.insert_weekly_plan_variant(WEEK, "claude", "x", "{}")
    db.delete_weekly_plan_variants(WEEK)
    surviving = db.get_weekly_plan_variant(v_keep)
    assert surviving is not None
    assert surviving["week_folder"] == other_week


# ── Transaction plumbing (Phase A regression) ──────────────────────────


def test_open_immediate_txn_busy_timeout_set(db: Database) -> None:
    txn = db.open_immediate_txn()
    try:
        bt = txn.execute("PRAGMA busy_timeout").fetchone()[0]
        assert bt == 100
    finally:
        txn.execute("ROLLBACK")
        txn.close()


def test_helpers_default_commit_unchanged(db: Database) -> None:
    """Default commit=True, conn=None: writes persist on db._conn (the
    Phase A regression-guard claim).
    """
    db.upsert_weekly_plan(WEEK, "content")
    row = db.get_weekly_plan_row(WEEK)
    assert row is not None
    assert row["content_md"] == "content"


def test_helpers_commit_false_conn_rolls_back(db: Database) -> None:
    """Helpers run on dedicated txn conn don't persist after ROLLBACK."""
    txn = db.open_immediate_txn()
    try:
        db.upsert_weekly_plan(WEEK, "txn-content", commit=False, conn=txn)
        # Visible inside the txn.
        inside = txn.execute(
            "SELECT content_md FROM weekly_plan WHERE week=?", (WEEK,),
        ).fetchone()
        assert inside is not None
        assert inside["content_md"] == "txn-content"
        txn.execute("ROLLBACK")
    finally:
        txn.close()
    # Not visible after rollback on main conn.
    assert db.get_weekly_plan_row(WEEK) is None


def test_set_planned_session_scheduled_workout_no_self_commit(db: Database) -> None:
    """Phase A BLOCKER-B fix: with commit=False/conn=, helper must NOT
    self-commit. ROLLBACK on caller-controlled txn reverts the UPDATE.
    """
    sw_id = _seed_pushed_session(db, week=WEEK, date="2026-05-04",
                                 session_index=0)
    ps_id = db._conn.execute(
        "SELECT id FROM planned_session WHERE scheduled_workout_id=?",
        (sw_id,),
    ).fetchone()["id"]

    txn = db.open_immediate_txn()
    try:
        db.set_planned_session_scheduled_workout(
            ps_id, 999_999, commit=False, conn=txn,
        )
        # Inside the txn, value changed.
        assert txn.execute(
            "SELECT scheduled_workout_id FROM planned_session WHERE id=?",
            (ps_id,),
        ).fetchone()["scheduled_workout_id"] == 999_999
        txn.execute("ROLLBACK")
    finally:
        txn.close()
    # Outside, original sw_id stuck.
    assert db._conn.execute(
        "SELECT scheduled_workout_id FROM planned_session WHERE id=?",
        (ps_id,),
    ).fetchone()["scheduled_workout_id"] == sw_id


# ── select_weekly_plan_variant happy path / fallback ───────────────────


def test_select_variant_happy_path_no_prior_pushes(patched_db: Database) -> None:
    plan = _make_plan()
    vid = patched_db.insert_weekly_plan_variant(
        WEEK, "claude", "# v1", _structured_json(plan),
        schema_version=SUPPORTED_SCHEMA_VERSION,
    )
    res = patched_db.select_weekly_plan_variant(
        user="spike", week_folder=WEEK, variant_id=vid,
    )
    assert res == {
        "ok": True,
        "selected_variant_id": vid,
        "no_change": False,
        "dropped_scheduled_workout_ids": [],
    }
    # Side effects: planned_session rows + selected_variant_id stamp.
    n_ps = patched_db._conn.execute(
        "SELECT COUNT(*) FROM planned_session WHERE week_folder=?", (WEEK,),
    ).fetchone()[0]
    assert n_ps == len(plan.sessions)
    wp = patched_db._conn.execute(
        "SELECT selected_variant_id, selected_at FROM weekly_plan WHERE week=?",
        (WEEK,),
    ).fetchone()
    assert wp["selected_variant_id"] == vid
    assert wp["selected_at"] is not None


def test_select_variant_fallback_marks_all_prior_abandoned(
    patched_db: Database,
) -> None:
    """The decision driver — Step 0 spike Phase B exp 2 outcome.
    Re-stitch is NOT attempted: ALL prior_map entries → abandoned, new
    planned_session.scheduled_workout_id all NULL.
    """
    sw1 = _seed_pushed_session(patched_db, week=WEEK, date="2026-05-04",
                               session_index=0)
    sw2 = _seed_pushed_session(patched_db, week=WEEK, date="2026-05-09",
                               session_index=0)

    plan = _make_plan()
    vid = patched_db.insert_weekly_plan_variant(
        WEEK, "claude", "# v1", _structured_json(plan),
    )
    res = patched_db.select_weekly_plan_variant(
        user="spike", week_folder=WEEK, variant_id=vid, force=True,
    )
    assert res["ok"] is True
    assert set(res["dropped_scheduled_workout_ids"]) == {sw1, sw2}

    # Both prior scheduled_workouts marked abandoned.
    flags = {
        r["id"]: r["abandoned_by_promote_at"]
        for r in patched_db._conn.execute(
            "SELECT id, abandoned_by_promote_at FROM scheduled_workout "
            "WHERE id IN (?, ?)",
            (sw1, sw2),
        ).fetchall()
    }
    assert flags[sw1] is not None
    assert flags[sw2] is not None

    # New planned_session rows ALL have scheduled_workout_id=NULL — no
    # re-stitch attempted (FALLBACK design).
    new_rows = patched_db._conn.execute(
        "SELECT scheduled_workout_id FROM planned_session WHERE week_folder=?",
        (WEEK,),
    ).fetchall()
    assert len(new_rows) == len(plan.sessions)
    assert all(r["scheduled_workout_id"] is None for r in new_rows)


def test_select_variant_conflict_without_force(patched_db: Database) -> None:
    sw1 = _seed_pushed_session(patched_db, week=WEEK, date="2026-05-04",
                               session_index=0)
    plan = _make_plan()
    vid = patched_db.insert_weekly_plan_variant(
        WEEK, "claude", "# v1", _structured_json(plan),
    )
    res = patched_db.select_weekly_plan_variant(
        user="spike", week_folder=WEEK, variant_id=vid, force=False,
    )
    assert res["ok"] is False
    assert res["error"] == "selection_conflict"
    assert res["already_pushed_count"] == 1

    # No DB writes — abandoned flag NOT set.
    flag = patched_db._conn.execute(
        "SELECT abandoned_by_promote_at FROM scheduled_workout WHERE id=?",
        (sw1,),
    ).fetchone()["abandoned_by_promote_at"]
    assert flag is None
    # No selected_variant_id stamp.
    wp = patched_db._conn.execute(
        "SELECT selected_variant_id FROM weekly_plan WHERE week=?", (WEEK,),
    ).fetchone()
    assert wp["selected_variant_id"] is None


def test_select_variant_idempotent(patched_db: Database) -> None:
    plan = _make_plan()
    vid = patched_db.insert_weekly_plan_variant(
        WEEK, "claude", "# v1", _structured_json(plan),
    )
    first = patched_db.select_weekly_plan_variant(
        user="spike", week_folder=WEEK, variant_id=vid,
    )
    second = patched_db.select_weekly_plan_variant(
        user="spike", week_folder=WEEK, variant_id=vid,
    )
    assert first["no_change"] is False
    assert second["no_change"] is True
    assert second["selected_variant_id"] == vid


def test_select_variant_schema_outdated(patched_db: Database) -> None:
    plan = _make_plan()
    # variant declares schema_version 999, but server SUPPORTED is 1.
    vid = patched_db.insert_weekly_plan_variant(
        WEEK, "claude", "# v1", _structured_json(plan),
        schema_version=999,
    )
    res = patched_db.select_weekly_plan_variant(
        user="spike", week_folder=WEEK, variant_id=vid,
    )
    assert res["ok"] is False
    assert res["error"] == "variant_schema_outdated"
    assert res["variant_version"] == 999
    assert res["server_version"] == SUPPORTED_SCHEMA_VERSION


def test_select_variant_parse_failed_rejected(patched_db: Database) -> None:
    vid = patched_db.insert_weekly_plan_variant(
        WEEK, "claude", "# raw", None,
        variant_parse_status="parse_failed",
    )
    res = patched_db.select_weekly_plan_variant(
        user="spike", week_folder=WEEK, variant_id=vid,
    )
    assert res["ok"] is False
    assert res["error"] == "variant_parse_failed"


def test_select_variant_superseded_rejected(patched_db: Database) -> None:
    plan = _make_plan()
    v1 = patched_db.insert_weekly_plan_variant(
        WEEK, "claude", "# v1", _structured_json(plan),
    )
    time.sleep(0.01)
    patched_db.insert_weekly_plan_variant(
        WEEK, "claude", "# v2", _structured_json(plan),
    )
    # v1 is now superseded.
    res = patched_db.select_weekly_plan_variant(
        user="spike", week_folder=WEEK, variant_id=v1,
    )
    assert res["ok"] is False
    assert res["error"] == "variant_superseded"


def test_select_variant_wrong_week(patched_db: Database) -> None:
    plan = _make_plan(week="2026-05-11_05-17")
    vid = patched_db.insert_weekly_plan_variant(
        "2026-05-11_05-17", "claude", "# x", _structured_json(plan),
    )
    res = patched_db.select_weekly_plan_variant(
        user="spike", week_folder=WEEK, variant_id=vid,
    )
    assert res["ok"] is False
    assert res["error"] == "variant_wrong_week"


def test_select_variant_not_found(patched_db: Database) -> None:
    res = patched_db.select_weekly_plan_variant(
        user="spike", week_folder=WEEK, variant_id=99999,
    )
    assert res["ok"] is False
    assert res["error"] == "variant_not_found"


def test_select_variant_replaces_planned_sessions_on_force(
    patched_db: Database,
) -> None:
    """force=True with existing planned_session rows triggers
    apply_weekly_plan REPLACE — the new variant's sessions fully
    replace whatever was there (any prior session not in the new plan
    disappears).
    """
    # Seed a planned_session that exists ONLY in the prior state, not in
    # the new variant.
    patched_db._conn.execute(
        "INSERT OR REPLACE INTO weekly_plan (week, content_md, generated_at, updated_at) "
        "VALUES (?,?, datetime('now'), datetime('now'))",
        (WEEK, "old"),
    )
    patched_db._conn.execute(
        """INSERT INTO planned_session
           (week_folder, date, session_index, kind, summary, updated_at)
           VALUES (?,?,?,?,?, datetime('now'))""",
        (WEEK, "2026-05-05", 0, "strength", "old strength session"),
    )
    patched_db._conn.commit()
    pre_count = patched_db._conn.execute(
        "SELECT COUNT(*) FROM planned_session WHERE week_folder=?", (WEEK,),
    ).fetchone()[0]
    assert pre_count == 1

    plan = _make_plan()
    vid = patched_db.insert_weekly_plan_variant(
        WEEK, "claude", "# v1", _structured_json(plan),
    )
    res = patched_db.select_weekly_plan_variant(
        user="spike", week_folder=WEEK, variant_id=vid, force=True,
    )
    assert res["ok"] is True

    new_rows = patched_db._conn.execute(
        "SELECT date FROM planned_session WHERE week_folder=? ORDER BY date",
        (WEEK,),
    ).fetchall()
    # Only the variant's 3 dates remain; old strength session gone.
    assert [r["date"] for r in new_rows] == [
        "2026-05-04", "2026-05-06", "2026-05-09",
    ]


# ── Concurrent isolation (Phase B exp 3 regression) ────────────────────


def test_concurrent_open_immediate_txn_serializes(db: Database) -> None:
    """Two threads racing open_immediate_txn: first wins lock, second
    blocks until busy_timeout (100ms) then surfaces 'database is locked'.
    """
    started = threading.Event()
    second_error: list[Exception] = []

    def winner() -> None:
        txn = db.open_immediate_txn()
        try:
            started.set()
            time.sleep(0.3)  # hold > busy_timeout
            txn.execute("ROLLBACK")
        finally:
            txn.close()

    def loser() -> None:
        started.wait(timeout=2.0)
        try:
            txn = db.open_immediate_txn()
            txn.execute("ROLLBACK")
            txn.close()
        except sqlite3.OperationalError as e:
            second_error.append(e)

    t1 = threading.Thread(target=winner)
    t2 = threading.Thread(target=loser)
    t1.start()
    t2.start()
    t1.join(timeout=3.0)
    t2.join(timeout=3.0)
    assert not t1.is_alive() and not t2.is_alive()
    assert len(second_error) == 1
    assert "locked" in str(second_error[0]).lower()


# ── Schema migration idempotence ───────────────────────────────────────


def test_migrate_idempotent_on_existing_db(tmp_path: Path) -> None:
    """Re-instantiating Database on the same path doesn't error or
    duplicate columns. _migrate is wrapped to swallow 'duplicate column'.
    """
    p = tmp_path / "test.db"
    db1 = Database(db_path=p)
    db1.close()
    db2 = Database(db_path=p)
    cols = {r[1] for r in db2._conn.execute(
        "PRAGMA table_info(weekly_plan)",
    ).fetchall()}
    assert "selected_variant_id" in cols
    assert "selected_at" in cols
    cols_sw = {r[1] for r in db2._conn.execute(
        "PRAGMA table_info(scheduled_workout)",
    ).fetchall()}
    assert "abandoned_by_promote_at" in cols_sw
    db2.close()


def test_variant_tables_created_on_fresh_db(tmp_path: Path) -> None:
    p = tmp_path / "test.db"
    with Database(db_path=p) as db:
        names = {r[0] for r in db._conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name LIKE 'weekly_plan_variant%'",
        ).fetchall()}
        assert names == {"weekly_plan_variant", "weekly_plan_variant_rating"}
