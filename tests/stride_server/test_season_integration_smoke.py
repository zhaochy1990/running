"""Stage-3b season integration smoke (Task 3b-T6) — the FINAL Stage-3b proof.

This is the end-to-end smoke proving the whole Stage-3b stack assembles a
realistic, multi-phase full season wired together, with ONLY the two LLMs
(generator + reviewer) and the user DB as test doubles. Everything between is
the real code path:

    generate_season
      → derive_phase_weeks            (T2, real deterministic ramp)
        → generate_phase_weeks        (Stage-3a, real per-week graph)
            → build_specialist_context (real pace/volume/recent-training calc)
            → fake generator LLM
            → run_rule_filter         (real per-week gate)
      → review_phase                  (T4, real per-phase reviewer + fake LLM)
      → run_season_rule_filter        (T3, real cross-phase aggregate rules)
    → SeasonPlanBundle assembled

The headline contract (load-bearing assertions):

  * ``generate_season`` returns a ``SeasonPlanBundle`` with one ``PhaseWeeks``
    per master-plan phase (4), in order, with the right ``phase_type``s.
  * EVERY generated week, across ALL phases, INDEPENDENTLY passes
    ``run_rule_filter`` when re-run with the correctly-threaded
    ``prev_week_km`` — belt-and-suspenders that the assembled artifacts are
    genuinely rule-clean, not merely un-blocked.
  * ``run_season_rule_filter(bundle, master_plan).ok`` is True — no cross-phase
    errors (volume arc, phase transitions, taper<peak), and no boundary spike
    between phases (phase N+1 week 1 ≤ 1.10× phase N's last week).
  * The REAL reviewer is genuinely in the loop: every ``PhaseWeeks.review`` is
    populated with ``verdict=="pass"`` (proving ``review_phase`` actually ran).
  * ``blocked_week_count`` is 0 for every phase (all weeks rule-clean).
  * The total week count across phases matches the sum of the
    ``derive_phase_weeks`` lengths for the master plan.

All LLM calls are faked (no network); the user DB is seeded so the real
``pace_targets`` / ``volume_targets`` / ``recent_training`` calculators run
end-to-end. The fakes + seed helpers mirror ``test_season_orchestrator.py`` (T5)
and ``test_stage3a_integration_smoke.py`` (Stage-3a smoke).
"""

from __future__ import annotations

import json
import re
from datetime import date

from langchain_core.messages import AIMessage, SystemMessage

from coach.graphs.generation.rule_filter import _total_run_distance_m, run_rule_filter
from coach.graphs.generation.season_rule_filter import run_season_rule_filter
from coach.graphs.generation.week_schedule import derive_phase_weeks
from stride_core.db import Database
from stride_core.master_plan import (
    MasterPlan,
    MasterPlanStatus,
    Milestone,
    MilestoneType,
    Phase,
    PhaseType,
)
from stride_core.plan_spec import WeeklyPlan
from stride_core.running_calibration.sqlite_connector import (
    SQLiteRunningCalibrationRepository,
)
from stride_core.running_calibration.types import (
    CalibrationConfidence,
    RunningCalibrationSnapshot,
)

import stride_server.coach_adapters.phase_review_adapter as review_mod
import stride_server.coach_adapters.season_orchestrator as orch_mod
import stride_server.coach_adapters.week_specialist_adapter as week_mod
from stride_server.coach_adapters.season_orchestrator import generate_season

# threshold speed 4.0 m/s → threshold pace 250 s/km (4:10/km)
_THRESHOLD_SPEED_MPS = 4.0
_THRESHOLD_PACE_S_KM = 1000.0 / _THRESHOLD_SPEED_MPS  # 250.0
_AS_OF = date(2026, 6, 1)

USER_ID = "a1b2c3d4-e5f6-4aaa-89ab-0000000000a6"


# ---------------------------------------------------------------------------
# Seeding helpers (mirror Stage-3a smoke / T5)
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
        "race_date": "2026-10-11",
    }


# ---------------------------------------------------------------------------
# A REALISTIC multi-phase master plan: base(6) → build(7) → peak(3) → taper(2).
# Calendar-contiguous Shanghai Mondays; bands step up across phases (base
# lower, build/peak higher, taper drops). Two quantifiable milestones (a
# build-phase MP test and a peak race). Bands + dates chosen so the
# deterministic ramp produces a clean ≤1.10× arc the fake generator can fill.
# ---------------------------------------------------------------------------


def _master_plan() -> MasterPlan:
    base = Phase(
        id="p-base",
        name="基础期",
        start_date="2026-06-08",
        end_date="2026-07-19",  # 6 Shanghai weeks
        focus="有氧基础",
        weekly_distance_km_low=45.0,
        weekly_distance_km_high=62.0,
        key_session_types=["有氧", "长距离"],
        milestone_ids=[],
        phase_type=PhaseType.BASE,
    )
    build = Phase(
        id="p-build",
        name="专项期",
        start_date="2026-07-20",
        end_date="2026-09-06",  # 7 weeks
        focus="专项耐力 + 阈值",
        weekly_distance_km_low=58.0,
        weekly_distance_km_high=80.0,
        key_session_types=["阈值", "长距离", "有氧"],
        milestone_ids=["ms-build-mp"],
        phase_type=PhaseType.BUILD,
    )
    peak = Phase(
        id="p-peak",
        name="赛前巅峰期",
        start_date="2026-09-07",
        end_date="2026-09-27",  # 3 weeks
        focus="比赛配速巩固",
        weekly_distance_km_low=70.0,
        weekly_distance_km_high=85.0,
        key_session_types=["比赛配速", "长距离", "阈值"],
        milestone_ids=["ms-peak-race"],
        phase_type=PhaseType.PEAK,
    )
    taper = Phase(
        id="p-taper",
        name="减量期",
        start_date="2026-09-28",
        end_date="2026-10-11",  # 2 weeks
        focus="减量保持",
        weekly_distance_km_low=30.0,
        weekly_distance_km_high=60.0,
        key_session_types=["比赛配速", "有氧"],
        milestone_ids=[],
        phase_type=PhaseType.TAPER,
    )
    ms_build = Milestone(
        id="ms-build-mp",
        type=MilestoneType.TEST_RUN,
        date="2026-09-06",
        phase_id="p-build",
        target="30K 含 marathon pace MP 段",
        metric="race_time_s_fm",
        target_value=12600.0,
        comparator="<=",
    )
    ms_peak = Milestone(
        id="ms-peak-race",
        type=MilestoneType.RACE,
        date="2026-09-27",
        phase_id="p-peak",
        target="35K 比赛配速 race pace 长距离演练",
        metric="race_time_s_fm",
        target_value=12600.0,
        comparator="<=",
    )
    return MasterPlan(
        plan_id="mp-season-smoke",
        user_id=USER_ID,
        status=MasterPlanStatus.DRAFT,
        goal_id="goal-1",
        start_date="2026-06-08",
        end_date="2026-10-11",
        phases=[base, build, peak, taper],
        milestones=[ms_build, ms_peak],
        training_principles=["渐进负荷", "充分恢复", "3:1 减量周期"],
        generated_by="test-model",
        version=1,
        created_at="2026-06-01T00:00:00+00:00",
        updated_at="2026-06-01T00:00:00+00:00",
    )


def _context() -> dict:
    return {
        "user_id": USER_ID,
        "goal": _fm_goal(),
        "level": 63.0,
        "continuity": {"macro_cycle": "base", "current_chronic_load": 55.0},
    }


# ---------------------------------------------------------------------------
# Clean-week builder — honours the per-week threaded target_weekly_km so the
# generated week tracks the derive ramp (no phase-boundary spike) and passes
# run_rule_filter: ≥1 rest day, longest run ≤35% of weekly, ≤1.10× progression,
# all sessions aspirational (spec=None). The 4 run sessions sum EXACTLY to
# total_km (last session absorbs rounding) so the emitted run total equals the
# floored ≤1.10×-safe ramp target. Includes a threshold touch + an MP/long
# touch so milestone-coverage keywords match (warning-only, but kept clean).
# ---------------------------------------------------------------------------


def _clean_week_plan(week_folder: str, *, total_km: float) -> dict:
    long_km = round(total_km * 0.32, 1)
    quality_km = round(total_km * 0.22, 1)
    easy_each = round((total_km - long_km - quality_km) / 2.0, 1)
    last_easy = round(total_km - long_km - quality_km - easy_each, 1)
    start = date.fromisoformat(week_folder[:10])

    def _d(offset: int) -> str:
        return start.fromordinal(start.toordinal() + offset).isoformat()

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

    return {
        "schema": "weekly-plan/v1",
        "week_folder": week_folder,
        "sessions": [
            _run(_d(0), f"z2 easy {easy_each:.0f}km @ 5:30/km", easy_each, "轻松有氧"),
            _run(
                _d(2),
                f"阈值 threshold {quality_km:.0f}km @ 4:10/km",
                quality_km,
                "阈值段",
            ),
            _run(_d(4), f"有氧 {last_easy:.0f}km @ 5:20/km", last_easy, "中等有氧"),
            _run(
                _d(6),
                f"long 专项长跑 {long_km:.0f}km（后段 marathon pace MP / race pace）",
                long_km,
                "MP 段 / 比赛配速",
            ),
        ],
        "nutrition": [],
        "notes_md": f"{week_folder}: long + threshold + 2 easy + rest",
    }


# ---------------------------------------------------------------------------
# Fake generator LLM — reads the per-week ``目标周量: NN.N`` the volume budget
# rendered into the system prompt and returns a clean week summing to it, so the
# generated season's volume arc follows the deterministic derive ramp.
# ---------------------------------------------------------------------------


def _extract_week_folder(prompt: str) -> str:
    m = re.search(r"\d{4}-\d{2}-\d{2}_\d{2}-\d{2}\(W\d+\)", prompt)
    return m.group(0) if m else "2026-06-08_06-14(W1)"


def _extract_target_km(prompt: str) -> float:
    m = re.search(r"目标周量[:：]\s*(\d+(?:\.\d+)?)", prompt)
    if m:
        return float(m.group(1))
    return 50.0


class _FakeGenLLM:
    """Fake bindable generator: returns a clean week tracking the prompt's
    injected ``目标周量``. Satisfies the langchain tool-loop surface
    (``bind_tools`` → self, ``invoke`` → AIMessage with the plan JSON, no
    tool_calls so the loop returns it verbatim). Captures every system prompt."""

    def __init__(self) -> None:
        self.captured: list[str] = []

    def bind_tools(self, tools, **_kw):  # type: ignore[no-untyped-def]
        return self

    def invoke(self, messages: list) -> AIMessage:
        sys_text = ""
        for m in messages:
            if isinstance(m, SystemMessage):
                sys_text = m.content if isinstance(m.content, str) else str(m.content)
                break
        self.captured.append(sys_text)
        folder = _extract_week_folder(sys_text)
        total_km = _extract_target_km(sys_text)
        return AIMessage(
            content=json.dumps(
                _clean_week_plan(folder, total_km=total_km), ensure_ascii=False
            )
        )


# ---------------------------------------------------------------------------
# Fake reviewer LLM — always returns a pass verdict.
# ---------------------------------------------------------------------------


class _FakeReply:
    def __init__(self, content: str) -> None:
        self.content = content


class _FakeReviewerLLM:
    """Reviewer-role fake that always passes. ``calls`` counts invocations so
    the test can prove the real reviewer was actually driven (in the loop)."""

    def __init__(self) -> None:
        self.calls = 0

    def invoke(self, messages):  # noqa: ANN001
        self.calls += 1
        return _FakeReply(
            "<review><verdict>pass</verdict>"
            "<commentary>fake pass</commentary></review>"
        )


# ---------------------------------------------------------------------------
# Wiring — patch generator LLM + DB + today on the week adapter; reviewer LLM on
# the review adapter; stub the provenance model so we don't read real config.
# ---------------------------------------------------------------------------


def _wire(monkeypatch, db, *, gen: _FakeGenLLM, reviewer: _FakeReviewerLLM) -> None:
    monkeypatch.setattr(week_mod, "get_generator_llm", lambda: gen)
    monkeypatch.setattr(week_mod, "today_shanghai", lambda: _AS_OF)
    monkeypatch.setattr(week_mod, "Database", lambda **kw: db)
    monkeypatch.setattr(review_mod, "get_reviewer_llm", lambda: reviewer)
    monkeypatch.setattr(orch_mod, "get_generator_model", lambda: "test-gen-model")


# ---------------------------------------------------------------------------
# Helpers for the assertions
# ---------------------------------------------------------------------------


def _week_run_km(week_dict: dict) -> float:
    return _total_run_distance_m(WeeklyPlan.from_dict(week_dict)) / 1000.0


def _expected_total_weeks(mp: MasterPlan) -> int:
    """Sum of derive_phase_weeks lengths, threading exit volume exactly like the
    orchestrator does (so the count matches what generate_season actually
    produced — derive is deterministic on the threaded entry volume)."""
    total = 0
    prev: float | None = None
    for phase in mp.phases:
        metas = derive_phase_weeks(phase, prev_phase_end_km=prev)
        total += len(metas)
        if metas:
            prev = metas[-1].target_weekly_km
    return total


# ---------------------------------------------------------------------------
# THE SMOKE
# ---------------------------------------------------------------------------


def test_season_integration_all_weeks_rule_clean(db, monkeypatch):
    """Headline smoke: a realistic 4-phase season runs end-to-end; every week
    across every phase is independently run_rule_filter-clean, the season
    aggregate rules pass with no boundary spike, the real per-phase reviewer ran
    and passed every phase, and the SeasonPlanBundle is assembled correctly."""
    _seed_calibration(db)
    gen = _FakeGenLLM()
    reviewer = _FakeReviewerLLM()
    _wire(monkeypatch, db, gen=gen, reviewer=reviewer)

    mp = _master_plan()
    bundle = generate_season(mp, _context(), injuries=[])

    # --- Bundle shape: one PhaseWeeks per phase, in order, right phase_types. -
    assert bundle.master_plan_id == "mp-season-smoke"
    assert bundle.generated_by == "test-gen-model"
    assert len(bundle.phases) == len(mp.phases) == 4
    for pw, phase in zip(bundle.phases, mp.phases):
        assert pw.phase_id == phase.id
        assert pw.phase_type == phase.phase_type
        assert pw.weeks, f"phase {pw.phase_id} produced no weeks"
    # the exact phase_type arc base → build → peak → taper.
    assert [pw.phase_type for pw in bundle.phases] == [
        PhaseType.BASE,
        PhaseType.BUILD,
        PhaseType.PEAK,
        PhaseType.TAPER,
    ]

    # --- The real reviewer is genuinely in the loop: every phase reviewed pass.
    assert reviewer.calls >= len(mp.phases), (
        "reviewer was not driven once per phase — review_phase may be skipped"
    )
    for pw in bundle.phases:
        assert pw.review is not None, f"{pw.phase_id} has no review (reviewer skipped)"
        assert pw.review.verdict == "pass", (
            f"{pw.phase_id} verdict {pw.review.verdict} (expected pass)"
        )

    # --- blocked_week_count is 0 for every phase (all weeks rule-clean). ------
    for pw in bundle.phases:
        assert pw.blocked_week_count == 0, (
            f"{pw.phase_id} blocked {pw.blocked_week_count} week(s) — a week was "
            f"dropped by the wired-up per-week rule_filter"
        )

    # --- Total week count == sum of derive_phase_weeks lengths. ---------------
    expected = _expected_total_weeks(mp)
    produced = sum(len(pw.weeks) for pw in bundle.phases)
    assert produced == expected, (
        f"produced {produced} weeks but derive ramp implies {expected}"
    )

    # === HEADLINE: every week across ALL phases independently passes ==========
    # run_rule_filter, re-run with the correctly threaded prev_week_km (the last
    # successful week's run total), and the real athlete-relative Z4-Z5 threshold
    # from the seeded calibration snapshot. This proves the assembled artifacts
    # are genuinely rule-clean, not merely un-blocked by the loop.
    prev_km: float | None = None
    checked = 0
    for pw in bundle.phases:
        for week in pw.weeks:
            report = run_rule_filter(
                week,
                prev_week_km=prev_km,
                injuries=None,
                z45_pace_threshold_s_km=_THRESHOLD_PACE_S_KM,
            )
            assert report.ok, (
                f"week {week.get('week_folder')!r} in phase {pw.phase_id!r} "
                f"independently trips a rule: "
                f"{[v.rule + ': ' + v.message for v in report.errors()]}"
            )
            prev_km = _week_run_km(week)
            checked += 1
    assert checked == produced, "every produced week must have been re-checked"

    # === Season aggregate rules pass (no cross-phase errors). =================
    report = run_season_rule_filter(bundle, mp)
    assert report.ok, [v.rule + ": " + v.message for v in report.errors()]

    # --- No boundary spike between phases (phase N+1 wk1 ≤ 1.10× phase N last).
    for prev_pw, next_pw in zip(bundle.phases, bundle.phases[1:]):
        prev_last = _week_run_km(prev_pw.weeks[-1])
        next_first = _week_run_km(next_pw.weeks[0])
        assert next_first <= prev_last * 1.10 + 1e-6, (
            f"phase boundary spike {prev_pw.phase_id!r} → {next_pw.phase_id!r}: "
            f"first {next_first:.1f}km > 1.10 * last {prev_last:.1f}km"
        )
    # and the season transition rule independently agrees there's no spike.
    transition_errors = [v for v in report.errors() if v.rule == "phase_transition"]
    assert not transition_errors, [v.message for v in transition_errors]

    # --- Taper volume actually drops below the peak (taper_peak_sanity clean). -
    def _phase_total(pw) -> float:
        return sum(_week_run_km(w) for w in pw.weeks)

    peak_total = _phase_total(bundle.phases[2])
    taper_total = _phase_total(bundle.phases[3])
    assert taper_total < peak_total, (
        f"taper total {taper_total:.1f}km did not drop below peak {peak_total:.1f}km"
    )
    assert not [v for v in report.errors() if v.rule == "taper_peak_sanity"]
