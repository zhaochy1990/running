"""Tests for coach_adapters.phase_specialist_adapter (phase-at-once PA-T3).

The phase generator adapter ``generate_specialist_phase(phase, week_metas,
context, injuries=None, *, feedback=None)``:
  * builds the per-week ``PhaseWeekSpec`` list (one shared pace table, one
    per-week volume budget, deload derived from a target-km dip),
  * composes the phase-level system prompt (``build_phase_system_prompt``),
  * binds the specialist's tools + runs the tool loop once (one retry on parse
    failure),
  * parses the ``{"weeks":[…×N]}`` batch and validates each week via
    ``WeeklyPlan.from_dict``,
  * returns the list of N validated ``WeeklyPlan`` dicts.

All LLM calls are faked (no network). A calibration snapshot is seeded so the
real ``pace_targets`` / ``volume_targets`` calculators run end-to-end.
"""

from __future__ import annotations

import json
from datetime import date

import pytest

from stride_core.db import Database
from stride_core.master_plan import Milestone, MilestoneType, Phase, PhaseType
from stride_core.plan_spec import WeeklyPlan
from stride_core.running_calibration.sqlite_connector import (
    SQLiteRunningCalibrationRepository,
)
from stride_core.running_calibration.types import (
    CalibrationConfidence,
    RunningCalibrationSnapshot,
)
import stride_server.coach_adapters.phase_specialist_adapter as adapter_mod
from stride_server.coach_adapters.phase_specialist_adapter import (
    build_phase_week_specs,
    generate_specialist_phase,
    parse_phase_batch,
)

from tests.stride_server._fake_bindable_llm import (
    FakeBindableLLM,
    ai_text,
    ai_tool_call,
)

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
    """Build a WeekMeta list from a list of target weekly km."""
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


def _valid_plan_dict(week_folder: str) -> dict:
    """A valid aspirational WeeklyPlan (all spec=null) for the given folder."""
    return {
        "schema": "weekly-plan/v1",
        "week_folder": week_folder,
        "sessions": [
            {
                "schema": "plan-session/v1",
                "date": "2026-06-15",
                "session_index": 0,
                "kind": "run",
                "summary": "z2 easy 12km @ 5:30/km",
                "spec": None,
                "notes_md": "轻松有氧",
                "total_distance_m": 12000,
                "total_duration_s": None,
                "scheduled_workout_id": None,
            },
            {
                "schema": "plan-session/v1",
                "date": "2026-06-18",
                "session_index": 0,
                "kind": "run",
                "summary": "阈值 2k * 4 @ 4:10/km",
                "spec": None,
                "notes_md": "组间 90s",
                "total_distance_m": 14000,
                "total_duration_s": None,
                "scheduled_workout_id": None,
            },
            {
                "schema": "plan-session/v1",
                "date": "2026-06-21",
                "session_index": 0,
                "kind": "run",
                "summary": "专项长跑 30km（后 12km @ MP）",
                "spec": None,
                "notes_md": "MP 段 4:58/km",
                "total_distance_m": 30000,
                "total_duration_s": None,
                "scheduled_workout_id": None,
            },
        ],
        "nutrition": [],
        "notes_md": "专项期",
    }


def _batch(week_folders: list[str]) -> str:
    return json.dumps(
        {
            "schema": "phase-weeks/v1",
            "weeks": [_valid_plan_dict(wf) for wf in week_folders],
        },
        ensure_ascii=False,
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
# build_phase_week_specs helper — pace shared / volume per-week / deload
# ---------------------------------------------------------------------------


def test_build_phase_week_specs_pace_shared_volume_per_week(patch_db):
    metas = _week_metas([70.0, 80.0, 90.0])
    pace, specs = build_phase_week_specs(
        patch_db,
        goal=_fm_goal(),
        phase_type=PhaseType.BUILD,
        week_metas=metas,
        level=65.0,
        as_of=_AS_OF,
    )
    assert pace.threshold_pace_s_km == pytest.approx(250.0, abs=0.5)
    assert len(specs) == 3
    # week_index 1-based, n_weeks set
    assert [s.week_index for s in specs] == [1, 2, 3]
    assert all(s.n_weeks == 3 for s in specs)
    # distinct per-week volume budgets
    weekly = [s.volume.weekly_km for s in specs]
    assert weekly == pytest.approx([70.0, 80.0, 90.0], abs=0.5)
    assert len(set(weekly)) == 3


def test_is_deload_derived_from_dip(patch_db):
    # week 3 dips below week 2 → deload; others not (week 1 never deload).
    metas = _week_metas([70.0, 80.0, 60.0, 85.0])
    _pace, specs = build_phase_week_specs(
        patch_db,
        goal=_fm_goal(),
        phase_type=PhaseType.BUILD,
        week_metas=metas,
        level=65.0,
        as_of=_AS_OF,
    )
    assert [s.is_deload for s in specs] == [False, False, True, False]


# ---------------------------------------------------------------------------
# parse_phase_batch helper
# ---------------------------------------------------------------------------


def test_parse_phase_batch_extracts_weeks_list():
    raw = _batch(["w1", "w2"])
    weeks = parse_phase_batch(raw)
    assert isinstance(weeks, list)
    assert len(weeks) == 2
    assert weeks[0]["week_folder"] == "w1"


def test_parse_phase_batch_garbage_raises_parse_failed():
    with pytest.raises(ValueError) as exc:
        parse_phase_batch("完全无法解析，没有 JSON")
    assert str(exc.value).startswith("parse_failed")


def test_parse_phase_batch_missing_weeks_raises_parse_failed():
    raw = json.dumps({"schema": "phase-weeks/v1"})
    with pytest.raises(ValueError) as exc:
        parse_phase_batch(raw)
    assert str(exc.value).startswith("parse_failed")


# ---------------------------------------------------------------------------
# valid → N validated week dicts
# ---------------------------------------------------------------------------


def test_valid_batch_returns_n_week_dicts(patch_db, monkeypatch):
    metas = _week_metas([70.0, 80.0, 90.0])
    folders = [m.week_folder for m in metas]
    model = FakeBindableLLM([ai_text(_batch(folders))])
    _install_model(monkeypatch, model)

    out = generate_specialist_phase(_build_phase(), metas, _context())
    assert len(out) == 3
    for wk in out:
        plan = WeeklyPlan.from_dict(wk)  # round-trips
        assert all(s.spec is None for s in plan.sessions)


# ---------------------------------------------------------------------------
# tool fires at phase granularity
# ---------------------------------------------------------------------------


def test_strength_library_tool_fires_for_phase(patch_db, monkeypatch):
    metas = _week_metas([60.0, 65.0])
    folders = [m.week_folder for m in metas]
    model = FakeBindableLLM(
        [
            ai_tool_call("strength_library", {"targets": ["glute_med"]}, tc_id="c1"),
            ai_text(_batch(folders)),
        ]
    )
    _install_model(monkeypatch, model)

    phase = _build_phase(PhaseType.BASE)  # base declares strength_library
    out = generate_specialist_phase(phase, metas, _context(), injuries=["knee"])
    assert len(out) == 2

    bound_names = {getattr(t, "name", None) for t in model.bound_tools}
    assert "strength_library" in bound_names

    from langchain_core.messages import ToolMessage

    second_round = model.invocations[1]
    tool_msgs = [m for m in second_round if isinstance(m, ToolMessage)]
    assert len(tool_msgs) == 1
    assert tool_msgs[0].tool_call_id == "c1"
    # injuries=['knee'] filtered the squat move; clamshell survived.
    assert "clamshell" in tool_msgs[0].content
    assert "single leg squats" not in tool_msgs[0].content


# ---------------------------------------------------------------------------
# parse_failed / bad_schema
# ---------------------------------------------------------------------------


def test_garbage_raises_parse_failed_after_retry(patch_db, monkeypatch):
    metas = _week_metas([70.0, 80.0])
    model = FakeBindableLLM([ai_text("完全无法解析，没有 JSON。")])
    _install_model(monkeypatch, model)

    with pytest.raises(ValueError) as exc:
        generate_specialist_phase(_build_phase(), metas, _context())
    assert str(exc.value).startswith("parse_failed")
    # retried exactly once → two passes captured
    assert len(model.captured) == 2


def test_n_mismatch_short_raises_parse_failed_after_retry(patch_db, monkeypatch):
    # Requested N=3, LLM returns only 2 weeks on BOTH attempts → parse_failed,
    # retried exactly once (mirrors test_garbage_raises_parse_failed_after_retry).
    metas = _week_metas([70.0, 80.0, 90.0])
    folders = [m.week_folder for m in metas]
    short = _batch(folders[:2])  # 2 weeks for an N=3 request
    model = FakeBindableLLM([ai_text(short)])  # last reply reused on retry
    _install_model(monkeypatch, model)

    with pytest.raises(ValueError) as exc:
        generate_specialist_phase(_build_phase(), metas, _context())
    assert str(exc.value).startswith("parse_failed")
    # count check participates in the retry → two passes captured
    assert len(model.captured) == 2


def test_n_mismatch_over_raises_parse_failed(patch_db, monkeypatch):
    # Requested N=2, LLM returns 3 weeks → parse_failed (silently-carried guard).
    metas = _week_metas([70.0, 80.0])
    over = _batch(["w1", "w2", "w3"])  # 3 weeks for an N=2 request
    model = FakeBindableLLM([ai_text(over)])
    _install_model(monkeypatch, model)

    with pytest.raises(ValueError) as exc:
        generate_specialist_phase(_build_phase(), metas, _context())
    assert str(exc.value).startswith("parse_failed")
    assert len(model.captured) == 2


def test_empty_weeks_for_nonzero_n_raises_parse_failed(patch_db, monkeypatch):
    # {"weeks": []} for N>0 must NOT look like a clean empty success.
    metas = _week_metas([70.0, 80.0])
    empty = json.dumps({"schema": "phase-weeks/v1", "weeks": []}, ensure_ascii=False)
    model = FakeBindableLLM([ai_text(empty)])
    _install_model(monkeypatch, model)

    with pytest.raises(ValueError) as exc:
        generate_specialist_phase(_build_phase(), metas, _context())
    assert str(exc.value).startswith("parse_failed")
    assert len(model.captured) == 2


def test_n_mismatch_recovers_on_retry(patch_db, monkeypatch):
    # Wrong count on attempt 1, correct N on attempt 2 → succeeds with N weeks.
    # Proves the count check participates in the retry (not a hard fail).
    metas = _week_metas([70.0, 80.0, 90.0])
    folders = [m.week_folder for m in metas]
    wrong = _batch(folders[:2])  # 2 weeks (wrong)
    good = _batch(folders)  # 3 weeks (correct)
    model = FakeBindableLLM([ai_text(wrong), ai_text(good)])
    _install_model(monkeypatch, model)

    out = generate_specialist_phase(_build_phase(), metas, _context())
    assert len(out) == 3
    assert len(model.captured) == 2  # one regen consumed


def test_empty_week_metas_raises_without_parse_failed_prefix(patch_db):
    # Caller precondition (empty week_metas) — fires before any LLM output, so it
    # must be a plain ValueError WITHOUT the parse_failed sentinel.
    with pytest.raises(ValueError) as exc:
        build_phase_week_specs(
            patch_db,
            goal=_fm_goal(),
            phase_type=PhaseType.BUILD,
            week_metas=[],
            level=65.0,
            as_of=_AS_OF,
        )
    assert not str(exc.value).startswith("parse_failed")
    assert "empty week_metas" in str(exc.value)


def test_bad_schema_when_a_week_invalid(patch_db, monkeypatch):
    metas = _week_metas([70.0, 80.0])
    folders = [m.week_folder for m in metas]
    weeks = [_valid_plan_dict(folders[0]), {"schema": "weekly-plan/v1", "sessions": [{"kind": "run"}]}]
    raw = json.dumps({"schema": "phase-weeks/v1", "weeks": weeks}, ensure_ascii=False)
    model = FakeBindableLLM([ai_text(raw)])
    _install_model(monkeypatch, model)

    with pytest.raises(ValueError) as exc:
        generate_specialist_phase(_build_phase(), metas, _context())
    assert str(exc.value).startswith("bad_schema")


# ---------------------------------------------------------------------------
# feedback flows into the prompt
# ---------------------------------------------------------------------------


def test_feedback_carried_in_prompt(patch_db, monkeypatch):
    metas = _week_metas([70.0, 80.0])
    folders = [m.week_folder for m in metas]
    model = FakeBindableLLM([ai_text(_batch(folders))])
    _install_model(monkeypatch, model)

    generate_specialist_phase(
        _build_phase(), metas, _context(), feedback="第3周缺少MP课"
    )
    system_prompt = model.captured[0][0]
    assert "第3周缺少MP课" in system_prompt
    assert "本次重生成必须逐条修复" in system_prompt


# ---------------------------------------------------------------------------
# OPT-B: phase milestone flows into the generation prompt (single-source render)
# ---------------------------------------------------------------------------


def _build_milestone() -> Milestone:
    return Milestone(
        id="m1",
        type=MilestoneType.TEST_RUN,
        date="2026-07-12",
        phase_id="ph1",
        target="30K 节奏跑 4:45/km",
        metric="race_time_s_fm",
        target_value=12600.0,
        comparator="<=",
    )


def test_milestone_carried_in_generation_prompt(patch_db, monkeypatch):
    metas = _week_metas([70.0, 80.0])
    folders = [m.week_folder for m in metas]
    model = FakeBindableLLM([ai_text(_batch(folders))])
    _install_model(monkeypatch, model)

    ms = _build_milestone()
    generate_specialist_phase(
        _build_phase(), metas, _context(), milestones=[ms]
    )
    system_prompt = model.captured[0][0]
    # the milestone block label appears
    assert "本阶段 milestone" in system_prompt
    # the rendered milestone (natural-language target + quantified metric) appears
    assert "30K 节奏跑 4:45/km" in system_prompt
    assert "race_time_s_fm <= 12600" in system_prompt


def test_generator_milestone_render_matches_reviewer(patch_db, monkeypatch):
    """The generator's milestone text MUST equal what the reviewer would render —
    proving ``_render_milestone_summary`` is the single source (no divergence)."""
    from stride_server.coach_adapters.phase_review_adapter import (
        _render_milestone_summary,
    )

    metas = _week_metas([70.0, 80.0])
    folders = [m.week_folder for m in metas]
    model = FakeBindableLLM([ai_text(_batch(folders))])
    _install_model(monkeypatch, model)

    ms = _build_milestone()
    generate_specialist_phase(
        _build_phase(), metas, _context(), milestones=[ms]
    )
    system_prompt = model.captured[0][0]
    reviewer_render = _render_milestone_summary([ms])
    assert reviewer_render is not None
    # the exact reviewer render is the string injected into the generation prompt
    assert reviewer_render in system_prompt


def test_no_milestone_block_when_none(patch_db, monkeypatch):
    metas = _week_metas([70.0, 80.0])
    folders = [m.week_folder for m in metas]
    model = FakeBindableLLM([ai_text(_batch(folders))])
    _install_model(monkeypatch, model)

    generate_specialist_phase(_build_phase(), metas, _context())
    system_prompt = model.captured[0][0]
    assert "本阶段 milestone（生成时必须朝它设计）" not in system_prompt


# ---------------------------------------------------------------------------
# pace shared / volume per-week reflected in the composed prompt
# ---------------------------------------------------------------------------


def test_prompt_carries_one_pace_table_and_n_volume_budgets(patch_db, monkeypatch):
    metas = _week_metas([70.0, 80.0, 90.0])
    folders = [m.week_folder for m in metas]
    model = FakeBindableLLM([ai_text(_batch(folders))])
    _install_model(monkeypatch, model)

    generate_specialist_phase(_build_phase(), metas, _context())
    system_prompt = model.captured[0][0]
    # one shared pace table render (single "阈值" pace marker)
    assert "VO2max" in system_prompt
    # three distinct per-week volume budget rows
    assert system_prompt.count("量预算:") == 3
    assert "周量 70km" in system_prompt
    assert "周量 80km" in system_prompt
    assert "周量 90km" in system_prompt


def test_deload_marker_in_prompt(patch_db, monkeypatch):
    metas = _week_metas([70.0, 80.0, 60.0])  # week 3 dips → deload
    folders = [m.week_folder for m in metas]
    model = FakeBindableLLM([ai_text(_batch(folders))])
    _install_model(monkeypatch, model)

    generate_specialist_phase(_build_phase(), metas, _context())
    system_prompt = model.captured[0][0]
    assert "DELOAD" in system_prompt
