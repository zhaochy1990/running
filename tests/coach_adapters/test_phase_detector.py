"""Tests for the current-phase detector adapter (dispatch + cross-validation)."""
from __future__ import annotations

from datetime import date
from types import SimpleNamespace

from stride_core.master_plan import PhaseType


def _db(tmp_path):
    from stride_storage.sqlite.database import Database

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


def test_existing_continuity_plan_skips_completed_base(tmp_path, monkeypatch):
    """Regenerating from a continuity plan whose completed base ends on/just
    after today must NOT re-detect the athlete as "in base". The completed base
    is skipped, surfaced as completed_aerobic_weeks, and the entry phase points
    at the first ACTIVE phase (speed) — otherwise the planner emits a degenerate
    2-week base instead of preserving the carried-over ~8-week one."""
    from stride_server.coach_adapters import phase_detector

    phases = [
        # completed base: 2026-05-04 → 2026-06-28 (~8 weeks), is_completed
        SimpleNamespace(name="已完成的有氧基础期", phase_type=PhaseType.BASE,
                        start_date="2026-05-04", end_date="2026-06-28",
                        is_completed=True),
        # active entry phase begins the day after; today is the base's last days
        SimpleNamespace(name="夏季速度衔接期", phase_type=PhaseType.SPEED,
                        start_date="2026-06-29", end_date="2026-07-26",
                        is_completed=False),
        SimpleNamespace(name="马拉松专项建设期", phase_type=PhaseType.BUILD,
                        start_date="2026-07-27", end_date="2026-09-06",
                        is_completed=False),
    ]
    fake_plan = SimpleNamespace(phases=phases)
    monkeypatch.setattr(phase_detector, "_get_active_plan", lambda uid: fake_plan)

    ctx = phase_detector.detect_current_phase(
        db=None, user_id="u", goal=_GOAL, profile=None, as_of=date(2026, 6, 27)
    )
    assert ctx.source == "existing_plan"
    # today (06-27) is inside the completed base's tail → must NOT be "base"
    assert ctx.recommended_entry_phase == PhaseType.SPEED
    assert ctx.current_phase_type == PhaseType.SPEED
    # 8 carried-over base weeks surfaced for the is_completed lead-in
    assert ctx.completed_aerobic_weeks == 8
    assert ctx.weeks_in_phase == 0  # active phase hasn't started yet
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
