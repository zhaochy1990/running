"""Tests for the reusable specialist helpers in ``week_specialist_adapter``.

The per-week generator (``generate_specialist_week``) and its per-phase loop
(``generate_phase_weeks``) were removed in the phase-at-once optimization
(PA-T6) — they are superseded by ``phase_specialist_adapter`` (covered by
``test_phase_specialist_adapter.py`` / ``test_generate_phase.py``). What remains
in ``week_specialist_adapter`` are the shared helpers the phase-at-once adapter
imports; this file locks their direct unit behaviour:

  * ``build_specialist_context`` — pace table + volume budget (必传上下文),
  * ``_coerce_phase_type`` — phase-type input coercion,
  * ``_render_context_block`` — continuity / prior-tail / injuries rendering,
  * ``_build_specialist_tools`` — the specialist's declared pull-tool wiring.
"""

from __future__ import annotations

from datetime import date

import pytest

from stride_core.db import Database
from stride_core.master_plan import PhaseType
from stride_core.running_calibration.sqlite_connector import (
    SQLiteRunningCalibrationRepository,
)
from stride_core.running_calibration.types import (
    CalibrationConfidence,
    RunningCalibrationSnapshot,
)
from coach.graphs.generation.weekly_prompt import WeekMeta
from stride_server.coach_adapters.week_specialist_adapter import (
    _build_specialist_tools,
    _coerce_phase_type,
    _render_context_block,
    build_specialist_context,
)

# threshold speed 4.0 m/s → threshold pace 250 s/km (4:10/km)
_THRESHOLD_SPEED_MPS = 4.0
_AS_OF = date(2026, 6, 1)

USER_ID = "a1b2c3d4-e5f6-4aaa-89ab-000000000099"
WEEK_FOLDER = "2026-06-15_06-21(W3)"


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
    # 3:30:00 marathon
    return {"distance": "fm", "goal_time_s": 3 * 3600 + 30 * 60, "race_date": "2026-11-01"}


# ---------------------------------------------------------------------------
# build_specialist_context helper
# ---------------------------------------------------------------------------


def test_build_specialist_context_returns_pace_and_volume(db: Database):
    _seed_calibration(db)

    wm = WeekMeta(phase_position="build week 3/7", week_folder=WEEK_FOLDER, target_weekly_km=80.0)
    pt, vt = build_specialist_context(
        db, goal=_fm_goal(), phase_type=PhaseType.BUILD, week_meta=wm, level=65.0, as_of=_AS_OF
    )
    # threshold pace = 1000 / 4.0 = 250
    assert pt.threshold_pace_s_km == pytest.approx(250.0, abs=0.5)
    # volume budget honours the week target
    assert vt.weekly_km == pytest.approx(80.0, abs=0.5)
    assert vt.long_run_km / vt.weekly_km <= 0.35 + 1e-9


def test_build_specialist_context_missing_calibration_raises(db: Database):
    """No seeded calibration snapshot → ``pace_targets`` raises a ValueError whose
    message references ``pace_targets`` (the documented precondition contract:
    a missing-calibration failure is distinct, not swallowed)."""
    wm = WeekMeta(phase_position="build week 3/7", week_folder=WEEK_FOLDER, target_weekly_km=80.0)
    with pytest.raises(ValueError, match="pace_targets"):
        build_specialist_context(
            db, goal=_fm_goal(), phase_type=PhaseType.BUILD, week_meta=wm, level=65.0, as_of=_AS_OF
        )


# ---------------------------------------------------------------------------
# _coerce_phase_type
# ---------------------------------------------------------------------------


def test_coerce_phase_type_accepts_enum_and_value_string():
    assert _coerce_phase_type(PhaseType.BUILD) is PhaseType.BUILD
    assert _coerce_phase_type("build") is PhaseType.BUILD


def test_coerce_phase_type_rejects_unknown_with_bad_schema():
    with pytest.raises(ValueError, match="bad_schema") as exc:
        _coerce_phase_type("nonsense")
    assert str(exc.value).startswith("bad_schema")


# ---------------------------------------------------------------------------
# _render_context_block
# ---------------------------------------------------------------------------


def test_render_context_block_empty_when_nothing_applies():
    assert _render_context_block(continuity=None, prior_week_tail=None, injuries=None) == ""
    # "none"-string injuries + empty continuity dict are dropped too.
    assert _render_context_block(continuity={}, prior_week_tail="", injuries=["none"]) == ""


def test_render_context_block_renders_each_section():
    block = _render_context_block(
        continuity={
            "macro_cycle": "build",
            "current_chronic_load": 62.0,
            "post_race_recovery_status": "recovered",
        },
        prior_week_tail="上周完成约 78km；尾段课次：专项长跑 30km",
        injuries=["achilles", "knee"],
    )
    assert "延续性信号" in block
    assert "build" in block
    assert "62.0" in block
    assert "上周尾段" in block
    assert "专项长跑 30km" in block
    assert "伤病" in block
    assert "achilles" in block and "knee" in block


# ---------------------------------------------------------------------------
# _build_specialist_tools — declared pull-tools become StructuredTools
# ---------------------------------------------------------------------------


def test_build_specialist_tools_base_phase_wires_declared_tools():
    """A base specialist declares ('strength_library', 'recent_training') → both
    are built as StructuredTools (so the tool loop can drive them)."""
    tools = _build_specialist_tools(PhaseType.BASE, user_id=USER_ID, injuries=["knee"])
    names = {t.name for t in tools}
    assert "strength_library" in names
    assert "recent_training" in names


def test_build_specialist_tools_taper_phase_has_no_tools():
    """Taper declares no pull-tools → an empty list (the loop degrades to a plain
    invoke)."""
    tools = _build_specialist_tools(PhaseType.TAPER, user_id=USER_ID, injuries=[])
    assert tools == []
