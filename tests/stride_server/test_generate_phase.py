"""Tests for coach_adapters.phase_specialist_adapter.generate_phase_validated (PA-T4).

``generate_phase_validated(phase, week_metas, context, injuries=None, *,
feedback=None, max_attempts=3)`` is the phase-at-once replacement for the per-week
``generate_phase_weeks`` loop. It:

  * computes the rule_filter inputs once (the athlete-relative Z4-Z5 threshold
    = ``pace_targets.threshold_pace_s_km``),
  * generates the whole phase via ``generate_specialist_phase`` (PA-T3),
  * runs ``run_rule_filter`` on each week with ``prev_week_km`` = the prior
    week's **deterministic target** (``week_metas[i-1].target_weekly_km``),
  * on any HARD-rule (severity=="error") violation, regenerates the phase WITH
    the specific violations fed back (bounded by ``max_attempts``),
  * after ``max_attempts`` drops the still-violating weeks (keeps the clean
    ones), and NEVER raises — a persistent ``parse_failed`` degrades to ``[]``.

All LLM calls are faked. A calibration snapshot is seeded so the real
``pace_targets`` / ``volume_targets`` calculators run end-to-end.
"""

from __future__ import annotations

import json
from datetime import date

import pytest

from stride_storage.sqlite.database import Database
from stride_core.master_plan import Phase, PhaseType
from stride_core.plan_spec import WeeklyPlan
from stride_storage.sqlite.calibration_connector import (
    SQLiteRunningCalibrationRepository,
)
from stride_core.running_calibration.types import (
    CalibrationConfidence,
    RunningCalibrationSnapshot,
)
import stride_server.coach_adapters.phase_specialist_adapter as adapter_mod
from stride_server.coach_adapters.phase_specialist_adapter import (
    generate_phase_validated,
)

from tests.stride_server._fake_bindable_llm import FakeBindableLLM, ai_text

_THRESHOLD_SPEED_MPS = 4.0  # → threshold pace 250 s/km
_AS_OF = date(2026, 6, 1)

USER_ID = "a1b2c3d4-e5f6-4aaa-89ab-0000000000aa"


# ---------------------------------------------------------------------------
# Seeding helpers
# ---------------------------------------------------------------------------


def _seed_calibration(db: Database) -> None:
    repo = SQLiteRunningCalibrationRepository(db)
    repo.save_snapshot(
        RunningCalibrationSnapshot(
            as_of_date=date(2026, 5, 20),
            threshold_speed_mps=_THRESHOLD_SPEED_MPS,
            threshold_hr=168.0,
            threshold_speed_confidence=CalibrationConfidence.HIGH,
            threshold_hr_confidence=CalibrationConfidence.HIGH,
            hrmax_confidence=CalibrationConfidence.NONE,
        )
    )


def _fm_goal() -> dict:
    return {"distance": "fm", "goal_time_s": 3 * 3600 + 30 * 60, "race_date": "2026-11-01"}


def _build_phase(phase_type: PhaseType = PhaseType.BUILD) -> Phase:
    return Phase(
        id="ph1",
        name="build",
        focus="阈值 + 长跑推进",
        start_date="2026-06-15",
        end_date="2026-07-12",
        weekly_distance_km_low=70.0,
        weekly_distance_km_high=90.0,
        key_session_types=["长距离", "阈值", "有氧"],
        milestone_ids=["m1"],
        phase_type=phase_type,
    )


def _week_metas(targets: list[float]) -> list:
    from coach.graphs.generation.weekly_prompt import WeekMeta

    metas = []
    for i, km in enumerate(targets):
        metas.append(
            WeekMeta(
                phase_position=f"build week {i + 1}/{len(targets)}",
                week_folder=f"2026-06-{15 + i * 7:02d}_W{i + 1}",
                target_weekly_km=km,
            )
        )
    return metas


def _run_session(date_str: str, dist_m: int, summary: str = "run") -> dict:
    return {
        "schema": "plan-session/v1",
        "date": date_str,
        "session_index": 0,
        "kind": "run",
        "summary": summary,
        "spec": None,
        "notes_md": "",
        "total_distance_m": dist_m,
        "total_duration_s": None,
        "scheduled_workout_id": None,
    }


def _clean_plan_dict(week_folder: str) -> dict:
    """A rule-clean WeeklyPlan: 3 runs (longest 30% share), rest day present.

    Distances 12k/14k/14k → total 40k, longest 14k = 35% exactly (not > 35%),
    so long_run_share passes. Days Mon/Thu/Sun used → rest days available.
    """
    return {
        "schema": "weekly-plan/v1",
        "week_folder": week_folder,
        "sessions": [
            _run_session("2026-06-15", 14000, "z2 easy 14km"),
            _run_session("2026-06-18", 12000, "阈值 12km"),
            _run_session("2026-06-21", 14000, "长跑 14km"),
        ],
        "nutrition": [],
        "notes_md": "clean week",
    }


def _no_rest_plan_dict(week_folder: str) -> dict:
    """A plan that violates rest_days: a session on all 7 days of the week."""
    # 7 small runs (total 40km, matching target) so weekly_progression and
    # weekly_target_volume do NOT also trip — the ONLY violation is rest_days.
    sessions = []
    for i in range(7):
        dist = 4000 if i == 6 else 6000
        sessions.append(_run_session(f"2026-06-{15 + i:02d}", dist, f"run d{i}"))
    return {
        "schema": "weekly-plan/v1",
        "week_folder": week_folder,
        "sessions": sessions,
        "nutrition": [],
        "notes_md": "no rest day (violation)",
    }


def _long_run_violation_plan_dict(week_folder: str) -> dict:
    """A plan that violates long_run_share: longest run is 50% of weekly volume."""
    return {
        "schema": "weekly-plan/v1",
        "week_folder": week_folder,
        "sessions": [
            _run_session("2026-06-15", 10000, "easy 10km"),
            _run_session("2026-06-18", 10000, "easy 10km"),
            _run_session("2026-06-21", 20000, "长跑 20km (50% share)"),
        ],
        "nutrition": [],
        "notes_md": "long run too big (violation)",
    }


def _batch(week_dicts: list[dict]) -> str:
    return json.dumps(
        {"schema": "phase-weeks/v1", "weeks": week_dicts}, ensure_ascii=False
    )


def _context() -> dict:
    return {"user_id": USER_ID, "goal": _fm_goal(), "level": 65.0}


@pytest.fixture
def patch_db(db, monkeypatch):
    _seed_calibration(db)
    monkeypatch.setattr(adapter_mod, "Database", lambda **kw: db)
    monkeypatch.setattr(adapter_mod, "today_shanghai", lambda: _AS_OF)
    return db


def _install_model(monkeypatch, model: FakeBindableLLM) -> None:
    monkeypatch.setattr(adapter_mod, "get_generator_llm", lambda: model)


# ---------------------------------------------------------------------------
# clean phase: no regen
# ---------------------------------------------------------------------------


def test_clean_phase_returns_all_no_regen(patch_db, monkeypatch):
    metas = _week_metas([40.0, 40.0, 40.0])
    folders = [m.week_folder for m in metas]
    batch = _batch([_clean_plan_dict(f) for f in folders])
    model = FakeBindableLLM([ai_text(batch)])
    _install_model(monkeypatch, model)

    out = generate_phase_validated(_build_phase(), metas, _context())
    assert len(out) == 3
    for wk in out:
        WeeklyPlan.from_dict(wk)  # round-trips
    # exactly one LLM pass (no regen)
    assert len(model.captured) == 1


# ---------------------------------------------------------------------------
# rule-violation → feedback regen → clean
# ---------------------------------------------------------------------------


def test_violation_then_feedback_regen_then_clean(patch_db, monkeypatch):
    metas = _week_metas([40.0, 40.0, 40.0])
    folders = [m.week_folder for m in metas]

    # Attempt 1: week 2 (index 1) violates rest_days. Attempt 2: all clean.
    attempt1 = _batch(
        [
            _clean_plan_dict(folders[0]),
            _no_rest_plan_dict(folders[1]),
            _clean_plan_dict(folders[2]),
        ]
    )
    attempt2 = _batch([_clean_plan_dict(f) for f in folders])

    calls = {"n": 0}

    def response_fn(messages):
        # Each tool-loop pass starts fresh; count passes by SystemMessage.
        calls["n"] += 1
        return ai_text(attempt1 if calls["n"] == 1 else attempt2)

    model = FakeBindableLLM(response_fn=response_fn)
    _install_model(monkeypatch, model)

    out = generate_phase_validated(_build_phase(), metas, _context())
    assert len(out) == 3  # all clean after regen

    # 2nd attempt's system prompt must carry the rule-violation feedback naming
    # the violating week + rule.
    second_prompt = model.captured[1][0]
    assert "第 2 周" in second_prompt
    assert "rest_days" in second_prompt


# ---------------------------------------------------------------------------
# persistent violation → drop
# ---------------------------------------------------------------------------


def test_persistent_violation_drops_week(patch_db, monkeypatch, caplog):
    metas = _week_metas([40.0, 40.0, 40.0])
    folders = [m.week_folder for m in metas]

    # Week 3 (index 2) ALWAYS violates long_run_share → never fixed → dropped.
    batch = _batch(
        [
            _clean_plan_dict(folders[0]),
            _clean_plan_dict(folders[1]),
            _long_run_violation_plan_dict(folders[2]),
        ]
    )
    model = FakeBindableLLM([ai_text(batch)])
    _install_model(monkeypatch, model)

    import logging

    with caplog.at_level(logging.WARNING):
        out = generate_phase_validated(_build_phase(), metas, _context(), max_attempts=3)

    assert len(out) == 2  # the violating week dropped
    surviving_folders = {wk["week_folder"] for wk in out}
    assert folders[2] not in surviving_folders
    # exhausted all attempts
    assert len(model.captured) == 3
    # a warning was logged for the dropped week
    assert any("drop" in r.message.lower() or "dropp" in r.message.lower()
               for r in caplog.records)


# ---------------------------------------------------------------------------
# parse_failed degrade → []
# ---------------------------------------------------------------------------


def test_parse_failed_degrades_to_empty(patch_db, monkeypatch):
    metas = _week_metas([40.0, 40.0])
    model = FakeBindableLLM([ai_text("完全无法解析，没有 JSON。")])
    _install_model(monkeypatch, model)

    out = generate_phase_validated(_build_phase(), metas, _context())
    assert out == []  # degraded, no raise


# ---------------------------------------------------------------------------
# prev_week_km uses the deterministic target, not the generated km
# ---------------------------------------------------------------------------


def test_prev_week_km_uses_target_not_generated_km(patch_db, monkeypatch):
    """Week i's progression check uses week_metas[i-1].target_weekly_km.

    Targets are 40km then 43km. The generated km DRIFTS inside the allowed
    target-volume tolerance: week 1 = 39km, week 2 = 43km. A *generated-km*
    progression check would see 43/39 = 1.10x+ and trip the 1.10x cap. The
    *target-based* check sees 43/40 = 1.075x and passes. So
    generate_phase_validated must return BOTH weeks (no false violation).
    """
    metas = _week_metas([40.0, 43.0])
    folders = [m.week_folder for m in metas]

    # Week 1 generated total = 39km (within target tolerance), week 2 = 43km.
    week1 = {
        "schema": "weekly-plan/v1",
        "week_folder": folders[0],
        "sessions": [
            _run_session("2026-06-15", 13000, "easy"),
            _run_session("2026-06-18", 13000, "easy"),
            _run_session("2026-06-21", 13000, "长跑 13km"),
        ],
        "nutrition": [],
        "notes_md": "39km week",
    }
    week2 = {
        "schema": "weekly-plan/v1",
        "week_folder": folders[1],
        "sessions": [
            _run_session("2026-06-22", 15000, "长跑 15km"),
            _run_session("2026-06-25", 14000, "easy"),
            _run_session("2026-06-28", 14000, "easy"),
        ],
        "nutrition": [],
        "notes_md": "43km week",
    }
    model = FakeBindableLLM([ai_text(_batch([week1, week2]))])
    _install_model(monkeypatch, model)

    out = generate_phase_validated(_build_phase(), metas, _context())
    # If prev_week_km used the generated 39km, week2 (43km) > 1.10x → dropped.
    # Target-based (43/40 = 1.075x) → both survive.
    assert len(out) == 2
    assert len(model.captured) == 1  # no regen (no false violation)


def test_post_deload_week_uses_last_load_target_for_progression(patch_db, monkeypatch):
    """The per-week rule gate must mirror season/master-plan semantics:
    recovery weeks are intentional dips, and the following load week is compared
    to the last load target rather than the recovery trough.

    Targets: 80 -> 86 -> 64(deload) -> 88. Generated weeks match those targets.
    Comparing week 4 against the 64km trough would falsely trip 1.38x; comparing
    against the previous load week 86km passes at 1.02x.
    """
    metas = _week_metas([80.0, 86.0, 64.0, 88.0])
    folders = [m.week_folder for m in metas]

    week_dicts = [
        {
            "schema": "weekly-plan/v1",
            "week_folder": folders[0],
            "sessions": [
                _run_session("2026-06-15", 28000, "长跑 28km"),
                _run_session("2026-06-17", 22000, "阈值"),
                _run_session("2026-06-19", 16000, "easy"),
                _run_session("2026-06-21", 14000, "easy"),
            ],
            "nutrition": [],
        },
        {
            "schema": "weekly-plan/v1",
            "week_folder": folders[1],
            "sessions": [
                _run_session("2026-06-22", 30000, "长跑 30km"),
                _run_session("2026-06-24", 22000, "tempo"),
                _run_session("2026-06-26", 18000, "easy"),
                _run_session("2026-06-28", 16000, "easy"),
            ],
            "nutrition": [],
        },
        {
            "schema": "weekly-plan/v1",
            "week_folder": folders[2],
            "sessions": [
                _run_session("2026-06-29", 22000, "轻松长跑 22km"),
                _run_session("2026-07-01", 16000, "easy"),
                _run_session("2026-07-03", 14000, "easy"),
                _run_session("2026-07-05", 12000, "easy"),
            ],
            "nutrition": [],
        },
        {
            "schema": "weekly-plan/v1",
            "week_folder": folders[3],
            "sessions": [
                _run_session("2026-07-06", 30000, "长跑 30km"),
                _run_session("2026-07-08", 24000, "MP"),
                _run_session("2026-07-10", 18000, "easy"),
                _run_session("2026-07-12", 16000, "easy"),
            ],
            "nutrition": [],
        },
    ]
    model = FakeBindableLLM([ai_text(_batch(week_dicts))])
    _install_model(monkeypatch, model)

    out = generate_phase_validated(_build_phase(), metas, _context(), max_attempts=1)

    assert len(out) == 4
    assert len(model.captured) == 1


# ---------------------------------------------------------------------------
# max_attempts boundary: 1 = drop-without-regen, 0 = [] without raising
# ---------------------------------------------------------------------------


def test_max_attempts_one_drops_without_regen(patch_db, monkeypatch):
    """max_attempts=1 → a persistently-violating week is dropped after EXACTLY
    one LLM pass (no regeneration), keeping the clean weeks."""
    metas = _week_metas([40.0, 40.0, 40.0])
    folders = [m.week_folder for m in metas]

    # Week 3 (index 2) violates long_run_share. With max_attempts=1 there is no
    # second attempt → it is dropped on the single pass.
    batch = _batch(
        [
            _clean_plan_dict(folders[0]),
            _clean_plan_dict(folders[1]),
            _long_run_violation_plan_dict(folders[2]),
        ]
    )
    model = FakeBindableLLM([ai_text(batch)])
    _install_model(monkeypatch, model)

    out = generate_phase_validated(_build_phase(), metas, _context(), max_attempts=1)

    assert len(out) == 2  # violating week dropped, clean ones kept
    surviving_folders = {wk["week_folder"] for wk in out}
    assert folders[2] not in surviving_folders
    assert len(model.captured) == 1  # exactly one LLM pass, no regen


def test_max_attempts_zero_returns_empty_without_raising(patch_db, monkeypatch):
    """max_attempts=0 → empty attempt loop must degrade to [] (locks the M1 fix:
    per_week_errors is hoisted, so the post-loop drop code never hits a
    NameError)."""
    metas = _week_metas([40.0, 40.0])
    folders = [m.week_folder for m in metas]
    # The model should never be invoked (empty loop) — but install one anyway so
    # an accidental call would surface rather than error on a missing model.
    model = FakeBindableLLM([ai_text(_batch([_clean_plan_dict(f) for f in folders]))])
    _install_model(monkeypatch, model)

    out = generate_phase_validated(_build_phase(), metas, _context(), max_attempts=0)
    assert out == []  # never raises, no LLM pass
    assert len(model.captured) == 0
