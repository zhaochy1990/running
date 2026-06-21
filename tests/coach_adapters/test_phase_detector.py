"""Tests for the current-phase detector adapter (dispatch + cross-validation)."""
from __future__ import annotations

from datetime import date
from types import SimpleNamespace

from stride_core.master_plan import PhaseType


def _db(tmp_path):
    from stride_core.db import Database

    return Database(db_path=tmp_path / "coros.db")


def _seed_base_plus_quality(db):
    """7 weekly aerobic ≥35km runs + 2 recent threshold runs → base done + quality."""
    c = db._conn
    weeks = [
        "2026-04-26", "2026-05-03", "2026-05-10", "2026-05-17",
        "2026-05-24", "2026-05-31", "2026-06-07",
    ]
    for i, d in enumerate(weeks):
        c.execute(
            "INSERT INTO activities (label_id, sport_type, date, distance_m, duration_s, train_kind) "
            "VALUES (?, 100, ?, ?, 3600, 'aerobic')",
            (f"a{i}", d + "T08:00:00+00:00", 36000.0 + i * 1000),
        )
    # two recent threshold sessions (within 28 days of 2026-06-16)
    for i, d in enumerate(["2026-06-05", "2026-06-12"]):
        c.execute(
            "INSERT INTO activities (label_id, sport_type, date, distance_m, duration_s, train_kind) "
            "VALUES (?, 100, ?, 14000, 4200, 'threshold')",
            (f"t{i}", d + "T08:00:00+00:00"),
        )
    c.commit()


_GOAL = {"race_date": "2026-10-18", "race_distance": "FM"}
_AS_OF = date(2026, 6, 16)


def _fake_llm(content: str):
    return SimpleNamespace(invoke=lambda msgs: SimpleNamespace(content=content))


# ---- existing-plan path ----------------------------------------------------


def test_existing_plan_reads_current_phase(tmp_path, monkeypatch):
    from stride_server.coach_adapters import phase_detector

    phases = [
        SimpleNamespace(name="基础期", phase_type=PhaseType.BASE,
                        start_date="2026-04-01", end_date="2026-05-31"),
        SimpleNamespace(name="进展期", phase_type=PhaseType.BUILD,
                        start_date="2026-06-01", end_date="2026-08-01"),
    ]
    fake_plan = SimpleNamespace(phases=phases)
    monkeypatch.setattr(phase_detector, "_get_active_plan", lambda uid: fake_plan)

    ctx = phase_detector.detect_current_phase(
        db=None, user_id="u", goal=_GOAL, profile=None, as_of=_AS_OF
    )
    assert ctx.source == "existing_plan"
    assert ctx.current_phase_type == PhaseType.BUILD
    assert ctx.recommended_entry_phase == PhaseType.BUILD
    assert ctx.weeks_in_phase == 2  # 2026-06-01 → 2026-06-16 = 15 days // 7
    assert ctx.confidence == "high"


# ---- inferred path ---------------------------------------------------------


def test_inferred_deterministic_and_llm_agree_enters_speed(tmp_path, monkeypatch):
    from stride_server.coach_adapters import phase_detector

    db = _db(tmp_path)
    _seed_base_plus_quality(db)
    monkeypatch.setattr(phase_detector, "_get_active_plan", lambda uid: None)
    monkeypatch.setattr(
        "stride_server.coach_runtime.get_reviewer_llm",
        lambda: _fake_llm('{"phase":"speed","weeks_in_phase":1}'),
    )

    ctx = phase_detector.detect_current_phase(
        db=db, user_id="u", goal=_GOAL, profile=None, as_of=_AS_OF
    )
    assert ctx.source == "inferred"
    assert ctx.recommended_entry_phase == PhaseType.SPEED
    assert ctx.method_agreement is True
    assert ctx.confidence == "high"
    assert ctx.completed_aerobic_weeks >= 6


def test_inferred_llm_failure_safe_degrades(tmp_path, monkeypatch):
    from stride_server.coach_adapters import phase_detector

    db = _db(tmp_path)
    _seed_base_plus_quality(db)
    monkeypatch.setattr(phase_detector, "_get_active_plan", lambda uid: None)

    def _boom():
        raise RuntimeError("llm down")

    monkeypatch.setattr("stride_server.coach_runtime.get_reviewer_llm", _boom)

    ctx = phase_detector.detect_current_phase(
        db=db, user_id="u", goal=_GOAL, profile=None, as_of=_AS_OF
    )
    assert ctx.source == "inferred"
    assert ctx.recommended_entry_phase == PhaseType.SPEED  # deterministic still works
    assert ctx.method_agreement is None
    assert ctx.confidence == "medium"  # capped from high


def test_inferred_llm_disagree_keeps_deterministic_records_divergence(tmp_path, monkeypatch):
    from stride_server.coach_adapters import phase_detector

    db = _db(tmp_path)
    _seed_base_plus_quality(db)
    monkeypatch.setattr(phase_detector, "_get_active_plan", lambda uid: None)
    monkeypatch.setattr(
        "stride_server.coach_runtime.get_reviewer_llm",
        lambda: _fake_llm('{"phase":"build"}'),
    )

    ctx = phase_detector.detect_current_phase(
        db=db, user_id="u", goal=_GOAL, profile=None, as_of=_AS_OF
    )
    assert ctx.recommended_entry_phase == PhaseType.SPEED  # deterministic wins
    assert ctx.method_agreement is False
    assert ctx.confidence == "low"
    assert "分歧" in ctx.rationale
