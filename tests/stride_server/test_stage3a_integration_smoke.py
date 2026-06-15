"""Stage-3a per-phase integration smoke test (Task 7).

This is the end-to-end smoke proving the *real* Stage-3a stack runs wired
together, with only the LLM and the user DB as test doubles:

    generate_phase_weeks
      → build_week_specialist_graph (Task 5)
        → generate_specialist_week (Task 4)
          → build_specialist_context  (pace_targets + volume_targets, Task 3)
          → build_weekly_system_prompt (Task 2, 必传上下文 injected)
          → fake LLM
          → _parse_llm_output (shared 3-tier parse)
          → WeeklyPlan.from_dict
        → run_rule_filter (Task 0/§7.3)

Headline contract: a realistic specialist output for *every* week of a phase
flows clean through the whole stack — ``generate_phase_weeks`` returns exactly
N plans for N weeks (no week blocked) — and the athlete's real pace table +
volume budget + phase guidance were genuinely injected into the prompt the LLM
saw (not defaulted / empty).

All LLM calls are faked (no network). A calibration snapshot + activities are
seeded so the real ``pace_targets`` / ``volume_targets`` / ``recent_training``
calculators run end-to-end and the rule_filter's athlete-relative Z4-Z5
threshold (= ``pace_targets.threshold_pace_s_km``) is a real number.

The fake-LLM / seeded-DB / monkeypatch patterns here are deliberately the same
as the Task-4 (``test_week_specialist_adapter.py``) and Task-6
(``test_phase_weeks_loop.py``) unit tests; the value-add of this smoke is
capturing and asserting on the *real composed prompt* and running the full
loop unmocked above the LLM boundary.
"""

from __future__ import annotations

import json
from datetime import date

import pytest

from coach.graphs.generation.rule_filter import run_rule_filter
from stride_core.db import Database
from stride_core.master_plan import Phase, PhaseType
from stride_core.plan_spec import WeeklyPlan
from stride_core.running_calibration.sqlite_connector import (
    SQLiteRunningCalibrationRepository,
)
from stride_core.running_calibration.types import (
    CalibrationConfidence,
    RunningCalibrationSnapshot,
)
import stride_server.coach_adapters.week_specialist_adapter as adapter_mod
from stride_server.coach_adapters.week_specialist_adapter import generate_phase_weeks

# threshold speed 4.0 m/s → threshold pace 250 s/km (4:10/km)
_THRESHOLD_SPEED_MPS = 4.0
_THRESHOLD_PACE_S_KM = 1000.0 / _THRESHOLD_SPEED_MPS  # 250.0
_AS_OF = date(2026, 6, 1)

USER_ID = "a1b2c3d4-e5f6-4aaa-89ab-000000000099"

N_WEEKS = 4
_BASE_WEEKLY_KM = 64.0  # week-1 run total; within the phase band (60–85)
_PROGRESSION = 1.08  # ≤ 1.10 cap → weekly_progression rule stays clean


# ---------------------------------------------------------------------------
# Seeding helpers (mirror Task-4 / Task-6)
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
    # 3:30:00 marathon with a goal_time_s (drives MP derivation).
    return {
        "distance": "fm",
        "goal_time_s": 3 * 3600 + 30 * 60,
        "race_date": "2026-11-01",
    }


def _phase() -> Phase:
    """A realistic 专项期 (build) phase spanning the 4 weeks."""
    return Phase(
        id="p-build-1",
        name="专项期",
        start_date="2026-06-08",
        end_date="2026-07-05",
        focus="专项耐力 + 阈值",
        weekly_distance_km_low=60.0,
        weekly_distance_km_high=85.0,
        key_session_types=["长距离", "阈值", "有氧"],
        milestone_ids=[],
        phase_type=PhaseType.BUILD,
    )


def _target_for_week(i: int) -> float:
    """Planned weekly km for week i — rises with the progression, in band."""
    return round(_BASE_WEEKLY_KM * (_PROGRESSION ** i), 1)


def _week_descriptors(n: int) -> list[dict]:
    """N ordered per-week meta descriptors inside the phase band."""
    out: list[dict] = []
    for i in range(n):
        out.append(
            {
                "week_index": i,
                "week_folder": f"2026-06-{8 + i * 7:02d}_06-{14 + i * 7:02d}(W{i + 1})",
                "phase_position": f"专项期 week {i + 1}/{n}",
                "target_weekly_km": _target_for_week(i),
            }
        )
    return out


def _context() -> dict:
    return {
        "user_id": USER_ID,
        "goal": _fm_goal(),
        "level": 65.0,
        "continuity": {"macro_cycle": "build", "current_chronic_load": 62.0},
    }


def _clean_week_plan(week_folder: str, *, total_km: float) -> dict:
    """A realistic aspirational WeeklyPlan summing to ~total_km.

    Built to PASS ``run_rule_filter`` every check:
      * ≥1 full rest day — only 4 of the 7-day window carry sessions.
      * longest run ≤ 35% of weekly volume — long run held at 33%.
      * weekly progression ≤ 1.10× the threaded prev_week_km — the caller
        scales total_km by ≤ 1.08× per week.
      * all sessions aspirational (spec=None) → intensity_distribution &
        injury_conflict are no-ops (they need a structured spec / strength).
    The mix differs week-to-week only in distances, so each call yields a
    *different but still-clean* week (the point of the smoke).
    """
    long_km = round(total_km * 0.33, 1)
    quality_km = round(total_km * 0.22, 1)
    # Two easy runs absorb the remainder, keeping 3 runs + 1 rest day minimum.
    easy_each = round((total_km - long_km - quality_km) / 2.0, 1)

    def _run(day: str, summary: str, km: float, notes: str) -> dict:
        return {
            "schema": "plan-session/v1",
            "date": day,
            "session_index": 0,
            "kind": "run",
            "summary": summary,
            "spec": None,
            "notes_md": notes,
            "total_distance_m": km * 1000.0,
            "total_duration_s": None,
            "scheduled_workout_id": None,
        }

    # Derive the in-window dates from the week_folder's ISO start.
    start = date.fromisoformat(week_folder[:10])

    def _d(offset: int) -> str:
        return start.fromordinal(start.toordinal() + offset).isoformat()

    return {
        "schema": "weekly-plan/v1",
        "week_folder": week_folder,
        "sessions": [
            _run(_d(0), f"z2 easy {easy_each:.0f}km @ 5:30/km", easy_each, "轻松有氧"),
            _run(
                _d(2),
                f"阈值 {quality_km:.0f}km @ 4:10/km（含组间慢跑）",
                quality_km,
                "阈值段配速取注入 pace_targets 阈值",
            ),
            _run(_d(4), f"有氧 {easy_each:.0f}km @ 5:20/km", easy_each, "中等有氧"),
            _run(
                _d(6),
                f"专项长跑 {long_km:.0f}km（后段 MP）",
                long_km,
                "MP 段取注入 pace_targets 的 MP",
            ),
        ],
        "nutrition": [
            {
                "schema": "plan-nutrition/v1",
                "date": _d(6),
                "kcal_target": 2800,
                "carbs_g": 400,
                "protein_g": 130,
                "fat_g": 70,
                "water_ml": 2800,
                "meals": [
                    {
                        "name": "早餐",
                        "time_hint": "7:00",
                        "kcal": 650,
                        "carbs_g": 100,
                        "protein_g": 25,
                        "fat_g": 12,
                        "items_md": "燕麦 80g + 香蕉 + 鸡蛋 2 个",
                    }
                ],
                "notes_md": "长跑日加碳",
            }
        ],
        "notes_md": f"{week_folder}: 1 长跑 + 1 阈值 + 2 有氧 + 休息日",
    }


def _run_total_km(plan_dict: dict) -> float:
    return (
        sum(
            (s.get("total_distance_m") or 0)
            for s in plan_dict.get("sessions") or []
            if s.get("kind") == "run"
        )
        / 1000.0
    )


# ---------------------------------------------------------------------------
# Fake LLM — returns a per-call clean week, captures every (system, messages).
# ---------------------------------------------------------------------------


from langchain_core.messages import AIMessage, SystemMessage


class _FakeLLM:
    """Fake bindable generator model: returns a distinct clean week per invoke,
    scaled so the threaded ``prev_week_km`` rises ≤ 1.08× week-over-week (under
    the rule_filter's 1.10× progression cap). Captures every system prompt.

    The per-week generator now drives the LLM through the langchain tool loop
    bound to ``get_generator_llm()``; this fake satisfies that surface
    (``bind_tools`` → self, ``invoke`` → an ``AIMessage`` with the plan JSON and
    no tool_calls, so the loop returns it verbatim).
    """

    captured: list[tuple[str, list]] = []
    week_folders: list[str] = []
    bound_tools: list = []
    _idx = 0

    def __init__(self) -> None:
        pass

    def bind_tools(self, tools, **_kw):  # type: ignore[no-untyped-def]
        _FakeLLM.bound_tools = list(tools)
        return self

    def invoke(self, messages: list) -> AIMessage:
        sys_text = ""
        for m in messages:
            if isinstance(m, SystemMessage):
                sys_text = m.content if isinstance(m.content, str) else str(m.content)
                break
        _FakeLLM.captured.append((sys_text, list(messages)))
        i = min(_FakeLLM._idx, len(_FakeLLM.week_folders) - 1)
        _FakeLLM._idx += 1
        folder = _FakeLLM.week_folders[i]
        total_km = round(_BASE_WEEKLY_KM * (_PROGRESSION ** i), 1)
        return AIMessage(
            content=json.dumps(
                _clean_week_plan(folder, total_km=total_km), ensure_ascii=False
            )
        )


@pytest.fixture
def fake_llm(monkeypatch):
    _FakeLLM.captured = []
    _FakeLLM.week_folders = []
    _FakeLLM.bound_tools = []
    _FakeLLM._idx = 0
    model = _FakeLLM()
    monkeypatch.setattr(adapter_mod, "get_generator_llm", lambda: model)
    # Pin a deterministic "today" so pace_targets snapshot lookups are stable.
    monkeypatch.setattr(adapter_mod, "today_shanghai", lambda: _AS_OF)
    return _FakeLLM


# ---------------------------------------------------------------------------
# The smoke
# ---------------------------------------------------------------------------


def test_phase_end_to_end_all_weeks_clean(db, monkeypatch, fake_llm):
    """Headline smoke: a full build phase runs end-to-end, every week is
    rule_filter-clean (no block), round-trips, is aspirational, and the real
    pace/volume/phase context was injected into the prompt.
    """
    _seed_calibration(db)
    monkeypatch.setattr(adapter_mod, "Database", lambda **kw: db)

    weeks = _week_descriptors(N_WEEKS)
    fake_llm.week_folders = [w["week_folder"] for w in weeks]

    plans = generate_phase_weeks(_phase(), weeks, _context(), injuries=[])

    # --- Headline: N weeks → N plans, NO week blocked. -----------------------
    assert len(plans) == N_WEEKS, (
        f"expected {N_WEEKS} plans (every week rule_filter-clean end-to-end), "
        f"got {len(plans)} — a week was blocked by the wired-up stack"
    )

    # --- Each plan round-trips and is aspirational (spec=None). --------------
    for w, p in zip(weeks, plans):
        plan = WeeklyPlan.from_dict(p)
        assert plan.week_folder == w["week_folder"]
        assert plan.sessions, "a returned week has no sessions"
        assert all(
            s.spec is None for s in plan.sessions
        ), "Stage-3a weeks must be aspirational (every session spec=None)"

    # --- Pace table + volume budget + phase guidance present in the prompt. --
    # Capture the *real* composed system prompt the fake LLM received for the
    # first week and assert the required 必传上下文 was injected for real.
    assert len(fake_llm.captured) >= N_WEEKS, (
        "fake LLM should have been called at least once per week"
    )
    first_prompt = fake_llm.captured[0][0]
    # pace table markers (from PaceTargets.render)
    assert "MP" in first_prompt
    assert "阈值" in first_prompt
    assert "VO2max" in first_prompt
    # the seeded threshold pace (250 s/km → 4:10) must render with the athlete's
    # real number, proving pace_targets ran against the calibration snapshot.
    assert "4:10" in first_prompt
    # volume budget markers (from VolumeTargets.render)
    assert "周量" in first_prompt
    assert "质量预算" in first_prompt
    # the build (专项期) specialist guidance got composed in
    assert "专项期" in first_prompt
    # the week framing (folder) got injected
    assert weeks[0]["week_folder"] in first_prompt

    # --- Belt-and-suspenders: independently rule_filter each returned plan. --
    # Thread prev_week_km exactly as the loop does (last successful run total),
    # with the same athlete-relative Z4-Z5 threshold from the seeded snapshot.
    prev_km: float | None = None
    for p in plans:
        report = run_rule_filter(
            p,
            prev_week_km=prev_km,
            injuries=None,
            z45_pace_threshold_s_km=_THRESHOLD_PACE_S_KM,
        )
        assert report.ok, (
            f"returned plan {p.get('week_folder')!r} independently trips a rule: "
            f"{[v.rule + ': ' + v.message for v in report.errors()]}"
        )
        prev_km = _run_total_km(p)

    # --- (Nice to have) threaded prev_week_km rises week-over-week, within cap.
    run_totals = [_run_total_km(p) for p in plans]
    for earlier, later in zip(run_totals, run_totals[1:]):
        assert later > earlier, "weekly run volume should progress upward"
        assert later <= earlier * 1.10 + 1e-6, (
            f"week-over-week jump {later / earlier:.3f}x exceeds the 1.10x cap "
            "the rule_filter enforces"
        )
