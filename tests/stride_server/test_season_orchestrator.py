"""Tests for coach_adapters.season_orchestrator.generate_season (Stage-3b T5).

``generate_season(master_plan, context, injuries, *, generated_by=None,
max_phase_attempts=2)`` drives the whole Stage-3a + 3b stack across every
master-plan phase into a ``SeasonPlanBundle``:

    per phase →
      derive_phase_weeks (T2, deterministic ramp)
      → generate_phase_validated (phase-at-once PA-T4, real generator + fake LLM
        + DB; one {"weeks":[…×N]} batch per phase, rule-gated per week)
      → review_phase (T4, real reviewer + fake reviewer LLM)
    → thread exit volume into the next phase
    → run_season_rule_filter (T3)
    → bounded regeneration of offending phases (PA-T5: carries reviewer feedback)
    → assemble SeasonPlanBundle

All LLM calls are faked (no network); the user DB is seeded so the real
``pace_targets`` / ``volume_targets`` calculators run end-to-end. The
batch-fake-LLM + seeded-DB patterns mirror ``test_phase_specialist_adapter.py``
/ ``test_generate_phase.py``; the reviewer fake mirrors
``test_phase_review_adapter.py``.
"""

from __future__ import annotations

import json
from datetime import date

import pytest

from stride_core.db import Database
from stride_core.master_plan import (
    MasterPlan,
    MasterPlanStatus,
    Milestone,
    MilestoneType,
    Phase,
    PhaseType,
)
from stride_core.running_calibration.sqlite_connector import (
    SQLiteRunningCalibrationRepository,
)
from stride_core.running_calibration.types import (
    CalibrationConfidence,
    RunningCalibrationSnapshot,
)

import stride_server.coach_adapters.week_specialist_adapter as week_mod
import stride_server.coach_adapters.phase_specialist_adapter as phase_mod
import stride_server.coach_adapters.phase_review_adapter as review_mod
import stride_server.coach_adapters.season_orchestrator as orch_mod
from stride_server.coach_adapters.season_orchestrator import generate_season
from coach.graphs.generation.season_rule_filter import run_season_rule_filter

# threshold speed 4.0 m/s → threshold pace 250 s/km (4:10/km)
_THRESHOLD_SPEED_MPS = 4.0
_AS_OF = date(2026, 6, 1)

USER_ID = "a1b2c3d4-e5f6-4aaa-89ab-000000000099"


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
    return {
        "distance": "fm",
        "goal_time_s": 3 * 3600 + 30 * 60,
        "race_date": "2026-09-13",
    }


def _master_plan() -> MasterPlan:
    """A 3-phase master plan: base → build → taper, each 2 weeks, one milestone.

    Bands sit so the deterministic ramp keeps every phase within a sane,
    rule-clean envelope. The phases are calendar-contiguous Mondays.
    """
    base = Phase(
        id="p-base",
        name="基础期",
        start_date="2026-06-08",
        end_date="2026-06-21",  # 2 Shanghai weeks
        focus="有氧基础",
        weekly_distance_km_low=50.0,
        weekly_distance_km_high=70.0,
        key_session_types=["有氧", "长距离"],
        milestone_ids=[],
        phase_type=PhaseType.BASE,
    )
    build = Phase(
        id="p-build",
        name="专项期",
        start_date="2026-06-22",
        end_date="2026-07-05",  # 2 weeks
        focus="专项耐力 + 阈值",
        weekly_distance_km_low=60.0,
        weekly_distance_km_high=85.0,
        key_session_types=["阈值", "长距离", "有氧"],
        milestone_ids=["ms-build"],
        phase_type=PhaseType.BUILD,
    )
    taper = Phase(
        id="p-taper",
        name="减量期",
        start_date="2026-07-06",
        end_date="2026-07-19",  # 2 weeks
        focus="减量保持",
        weekly_distance_km_low=35.0,
        weekly_distance_km_high=60.0,
        key_session_types=["比赛配速", "有氧"],
        milestone_ids=[],
        phase_type=PhaseType.TAPER,
    )
    milestone = Milestone(
        id="ms-build",
        type=MilestoneType.TEST_RUN,
        date="2026-07-05",
        phase_id="p-build",
        target="30K 节奏跑 4:45/km",
        metric="race_time_s_fm",
        target_value=12600.0,
        comparator="<=",
    )
    return MasterPlan(
        plan_id="mp-1",
        user_id=USER_ID,
        status=MasterPlanStatus.DRAFT,
        goal_id="goal-1",
        start_date="2026-06-08",
        end_date="2026-07-19",
        phases=[base, build, taper],
        milestones=[milestone],
        training_principles=["渐进负荷", "充分恢复"],
        generated_by="test-model",
        version=1,
        created_at="2026-06-01T00:00:00+00:00",
        updated_at="2026-06-01T00:00:00+00:00",
    )


def _context() -> dict:
    return {
        "user_id": USER_ID,
        "goal": _fm_goal(),
        "level": 62.0,
        "continuity": {"macro_cycle": "build", "current_chronic_load": 60.0},
    }


# ---------------------------------------------------------------------------
# Clean week builder — total_km supplied by the loop's threaded target so the
# generated week tracks derive_phase_weeks' descriptor (and the season volume
# arc stays within the 1.10x cap).
# ---------------------------------------------------------------------------


def _clean_week_plan(week_folder: str, *, total_km: float) -> dict:
    """A valid aspirational WeeklyPlan (all spec=None) summing to ~total_km.

    4 sessions over 4 of 7 days (≥1 rest day); longest run ≤ 33% of volume;
    one threshold + one MP/long touch so milestone-coverage keywords match.
    """
    # IMPORTANT: the 4 run sessions must sum to EXACTLY total_km so the
    # generated week's run total equals the derive ramp's target (which is
    # already floored ≤1.10×-safe). Independent per-session rounding would drift
    # the sum a few hundred metres and can tip a phase boundary just over the
    # 1.10× cap — so the last session absorbs the rounding remainder.
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
                f"long 专项长跑 {long_km:.0f}km（后段 marathon pace MP）",
                long_km,
                "MP 段",
            ),
        ],
        "nutrition": [],
        "notes_md": f"{week_folder}: long + threshold + 2 easy + rest",
    }


# ---------------------------------------------------------------------------
# Fake generator LLM — returns a {"weeks":[…×N]} batch for the whole phase,
# each week tracking the per-week descriptor target_km parsed out of the
# phase-at-once system prompt (one row per week).
# ---------------------------------------------------------------------------


from langchain_core.messages import AIMessage, SystemMessage


class _FakeGenLLM:
    """Fake bindable generator for the PHASE-AT-ONCE path. The phase prompt
    lists every week of the phase (one row per week carrying its
    ``week_folder`` + ``目标周量``); this fake parses all rows and returns a
    ``{"weeks":[…×N]}`` batch, each week summing to its row's target km so the
    generated season's volume arc follows the deterministic derive ramp.
    """

    def __init__(self) -> None:
        self.captured: list[str] = []

    def bind_tools(self, tools, **_kw):  # type: ignore[no-untyped-def]
        return self

    def _system_text(self, messages: list) -> str:
        for m in messages:
            if isinstance(m, SystemMessage):
                return m.content if isinstance(m.content, str) else str(m.content)
        return ""

    def _weeks_for(self, folder: str, total_km: float) -> dict:
        """Per-week hook subclasses override (e.g. taper inflation)."""
        return _clean_week_plan(folder, total_km=total_km)

    def invoke(self, messages: list) -> AIMessage:
        sys_text = self._system_text(messages)
        self.captured.append(sys_text)
        rows = _extract_week_rows(sys_text)
        weeks = [self._weeks_for(folder, km) for folder, km in rows]
        return AIMessage(
            content=json.dumps(
                {"schema": "phase-weeks/v1", "weeks": weeks}, ensure_ascii=False
            )
        )


def _extract_week_rows(prompt: str) -> list[tuple[str, float]]:
    """Parse the phase prompt's per-week table into ``(week_folder, target_km)``.

    The phase composer renders one row per week:
    ``… week_folder（原样回填）: <folder> | 目标周量: NN.N …``. We pair each
    folder token with the target km on the SAME row so the returned batch has
    one correctly-sized week per requested week. Falls back to a single default
    row if no rows match (keeps the fake robust to composer wording changes).
    """
    import re

    rows = re.findall(
        r"week_folder（原样回填）:\s*(\S+?)\s*\|\s*目标周量[:：]\s*(\d+(?:\.\d+)?)",
        prompt,
    )
    if rows:
        return [(folder, float(km)) for folder, km in rows]
    return [("2026-06-08_06-14(W1)", 55.0)]


# ---------------------------------------------------------------------------
# Fake reviewer LLM — scripted verdicts (per-call, last reused).
# ---------------------------------------------------------------------------


class _FakeReply:
    def __init__(self, content: str) -> None:
        self.content = content


class _FakeReviewerLLM:
    """Reviewer-role fake. ``verdicts`` is a list consumed per invoke (last
    reused once exhausted), so a phase regenerated N times can see N distinct
    verdicts (e.g. block then pass). Each entry is either a bare verdict string
    (commentary defaults to ``fake <verdict>``) or a ``(verdict, commentary)``
    tuple (a distinctive commentary so a test can prove it was threaded into the
    next regeneration prompt)."""

    def __init__(self, verdicts: list) -> None:
        self._verdicts = list(verdicts)
        self._idx = 0
        self.calls = 0

    def invoke(self, messages):  # noqa: ANN001
        self.calls += 1
        i = min(self._idx, len(self._verdicts) - 1)
        self._idx += 1
        entry = self._verdicts[i] if self._verdicts else "pass"
        if isinstance(entry, tuple):
            verdict, commentary = entry
        else:
            verdict, commentary = entry, f"fake {entry}"
        return _FakeReply(
            f"<review><verdict>{verdict}</verdict>"
            f"<commentary>{commentary}</commentary></review>"
        )


# ---------------------------------------------------------------------------
# Wiring fixture — patch generator LLM + DB + today on the week adapter, and
# the reviewer LLM on the review adapter.
# ---------------------------------------------------------------------------


def _wire(monkeypatch, db, *, reviewer: _FakeReviewerLLM, gen: _FakeGenLLM | None = None):
    gen = gen or _FakeGenLLM()
    # Phase-at-once generation lives in phase_specialist_adapter: patch its own
    # generator LLM + Database there. build_specialist_context (imported from
    # week_specialist_adapter) reads today_shanghai out of week_mod, so patch
    # that one on week_mod.
    monkeypatch.setattr(phase_mod, "get_generator_llm", lambda: gen)
    monkeypatch.setattr(phase_mod, "Database", lambda **kw: db)
    monkeypatch.setattr(week_mod, "today_shanghai", lambda: _AS_OF)
    monkeypatch.setattr(review_mod, "get_reviewer_llm", lambda: reviewer)
    # generated_by stamp: avoid reading real coach config.
    monkeypatch.setattr(orch_mod, "get_generator_model", lambda: "test-gen-model")
    return gen


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_happy_path_three_phases_clean(db, monkeypatch):
    _seed_calibration(db)
    reviewer = _FakeReviewerLLM(["pass"])
    _wire(monkeypatch, db, reviewer=reviewer)

    mp = _master_plan()
    bundle = generate_season(mp, _context(), injuries=[])

    assert bundle.master_plan_id == "mp-1"
    assert bundle.generated_by == "test-gen-model"
    assert len(bundle.phases) == 3

    for pw, phase in zip(bundle.phases, mp.phases):
        assert pw.phase_id == phase.id
        assert pw.phase_type == phase.phase_type
        assert pw.weeks, f"phase {pw.phase_id} produced no weeks"
        assert pw.review is not None
        assert pw.review.verdict == "pass"
        assert pw.blocked_week_count == 0

    # season rule filter is clean
    report = run_season_rule_filter(bundle, mp)
    assert report.ok, [v.message for v in report.errors()]


# ---------------------------------------------------------------------------
# Exit-volume threading — no phase-boundary spike
# ---------------------------------------------------------------------------


def test_exit_volume_threaded_no_boundary_spike(db, monkeypatch):
    _seed_calibration(db)
    reviewer = _FakeReviewerLLM(["pass"])
    _wire(monkeypatch, db, reviewer=reviewer)

    mp = _master_plan()
    bundle = generate_season(mp, _context(), injuries=[])

    from coach.graphs.generation.rule_filter import _total_run_distance_m
    from stride_core.plan_spec import WeeklyPlan

    def _km(week_dict: dict) -> float:
        return _total_run_distance_m(WeeklyPlan.from_dict(week_dict)) / 1000.0

    # phase 1 (base) last week → phase 2 (build) first week must not spike >1.10x
    base_pw, build_pw = bundle.phases[0], bundle.phases[1]
    assert base_pw.weeks and build_pw.weeks
    base_last = _km(base_pw.weeks[-1])
    build_first = _km(build_pw.weeks[0])
    assert build_first <= base_last * 1.10 + 1e-6, (
        f"phase boundary spike: build first {build_first:.1f} > "
        f"1.10 * base last {base_last:.1f}"
    )

    # and the season transition rule agrees there's no spike
    report = run_season_rule_filter(bundle, mp)
    transition_errors = [v for v in report.errors() if v.rule == "phase_transition"]
    assert not transition_errors, [v.message for v in transition_errors]


# ---------------------------------------------------------------------------
# Review-driven regen — block then pass, bounded
# ---------------------------------------------------------------------------


def test_review_driven_regen_carries_feedback(db, monkeypatch):
    """PA-T5 headline: a block→pass regen now THREADS the reviewer's critique
    into the regeneration prompt (the old blind regen carried nothing)."""
    _seed_calibration(db)
    # First review of the build phase blocks; the regen attempt passes.
    # base passes first; build: block (attempt 1) then pass (attempt 2); taper passes.
    # Sequence is consumed across phases AND regen attempts in call order.
    # A distinctive commentary lets us prove it was threaded into the regen.
    reviewer = _FakeReviewerLLM(
        [
            "pass",
            ("block", "BUILD-PHASE-NEEDS-MORE-THRESHOLD"),
            "pass",
            "pass",
        ]
    )
    gen = _wire(monkeypatch, db, reviewer=reviewer)

    mp = _master_plan()
    bundle = generate_season(mp, _context(), injuries=[], max_phase_attempts=2)

    # every phase ends on a pass (the blocked build phase was regenerated)
    for pw in bundle.phases:
        assert pw.review is not None
        assert pw.review.verdict == "pass", f"{pw.phase_id} verdict {pw.review.verdict}"

    # THE HEADLINE: the build phase's regeneration prompt carries the reviewer's
    # block commentary as feedback (productive regen, not a blind re-run). The
    # first generation prompt (and the base/taper prompts) must NOT carry it.
    fed_prompts = [p for p in gen.captured if "BUILD-PHASE-NEEDS-MORE-THRESHOLD" in p]
    assert fed_prompts, (
        "review-driven regen did not thread the reviewer's commentary into any "
        "generation prompt — the regen is not carrying feedback (PA-T5 regression)"
    )
    # the feedback header marks it as a review-driven regen
    assert any("上一轮阶段评审意见" in p for p in fed_prompts)

    # bounded: build phase reviewed at most max_phase_attempts (2) times for the
    # review-driven loop → total reviewer calls is small, never unbounded.
    # base(1) + build(2: block,pass) + taper(1) = 4 in the inline pass; a clean
    # season then needs no season-error regen.
    assert reviewer.calls <= 8, f"too many reviewer calls: {reviewer.calls}"


# ---------------------------------------------------------------------------
# Bounded failure degrades — always-block reviewer
# ---------------------------------------------------------------------------


def test_persistent_block_degrades_to_bundle(db, monkeypatch):
    _seed_calibration(db)
    reviewer = _FakeReviewerLLM(["block"])  # ALWAYS block
    _wire(monkeypatch, db, reviewer=reviewer)

    mp = _master_plan()
    # Must NOT raise, must NOT loop forever.
    bundle = generate_season(mp, _context(), injuries=[], max_phase_attempts=2)

    assert len(bundle.phases) == 3
    # the blocked verdict is visible in the returned bundle (not silently passed)
    assert any(
        pw.review is not None and pw.review.verdict == "block" for pw in bundle.phases
    )
    # bounded: each phase reviewed at most max_phase_attempts in the inline loop.
    # 3 phases * 2 attempts = 6 inline; season-error regen is also bounded. A
    # generous ceiling proves we didn't spin.
    assert reviewer.calls <= 24, f"reviewer call explosion: {reviewer.calls}"


# ---------------------------------------------------------------------------
# Season-rule-driven regen — taper spike on first assembly, clean on regen
# ---------------------------------------------------------------------------


class _TaperSpikeGenLLM(_FakeGenLLM):
    """Generator fake that inflates the FIRST generation of any TAPER-phase week
    so the assembled season trips ``taper_peak_sanity`` (taper total ≥ preceding
    phase). On the SECOND time it sees a given taper week_folder (i.e. the
    bounded season-error regen) it returns the honest, dropped volume — so the
    regen resolves the season error. Non-taper weeks always use the honest path.

    "Taper week" is detected by the folder month/day window of the master plan's
    taper phase (2026-07-06 … 2026-07-19). Inflation is per-week inside the
    batch (the phase generates all taper weeks in one call).
    """

    _TAPER_FOLDER_PREFIXES = ("2026-07-06", "2026-07-13")

    def __init__(self) -> None:
        super().__init__()
        self._seen_taper: set[str] = set()

    def _weeks_for(self, folder: str, total_km: float) -> dict:
        is_taper = folder[:10] in self._TAPER_FOLDER_PREFIXES
        if is_taper and folder not in self._seen_taper:
            # First sighting of this taper week → inflate above the build phase
            # so the season filter flags the taper-doesn't-drop error.
            self._seen_taper.add(folder)
            total_km = 95.0
        return _clean_week_plan(folder, total_km=total_km)


def test_season_rule_driven_regen(db, monkeypatch):
    _seed_calibration(db)
    reviewer = _FakeReviewerLLM(["pass"])  # reviews never block — only season rule fires
    gen = _TaperSpikeGenLLM()
    _wire(monkeypatch, db, reviewer=reviewer, gen=gen)

    mp = _master_plan()
    bundle = generate_season(mp, _context(), injuries=[], max_phase_attempts=2)

    # the bounded season-error regen replaced the inflated taper phase → the
    # final bundle is season-clean (taper drops below the build phase).
    report = run_season_rule_filter(bundle, mp)
    taper_errors = [v for v in report.errors() if v.rule == "taper_peak_sanity"]
    assert not taper_errors, [v.message for v in taper_errors]
    assert report.ok, [v.message for v in report.errors()]

    # taper phase volume actually dropped below the build phase in the end.
    from coach.graphs.generation.rule_filter import _total_run_distance_m
    from stride_core.plan_spec import WeeklyPlan

    def _phase_total(pw) -> float:
        return sum(
            _total_run_distance_m(WeeklyPlan.from_dict(w)) / 1000.0 for w in pw.weeks
        )

    build_total = _phase_total(bundle.phases[1])
    taper_total = _phase_total(bundle.phases[2])
    assert taper_total < build_total


# ---------------------------------------------------------------------------
# OPT-B: owned milestone threaded into the generation prompt
# ---------------------------------------------------------------------------


def test_owned_milestone_threaded_into_generation_prompt(db, monkeypatch):
    """The build phase owns ``ms-build`` (target "30K 节奏跑 4:45/km"); the
    orchestrator must thread it into that phase's generation prompt so the
    generator designs toward the SAME milestone the reviewer judges against."""
    _seed_calibration(db)
    reviewer = _FakeReviewerLLM(["pass"])
    gen = _wire(monkeypatch, db, reviewer=reviewer)

    mp = _master_plan()
    generate_season(mp, _context(), injuries=[])

    # at least one captured generation prompt (the build phase's) carries the
    # owned milestone block + the milestone's natural-language target.
    milestone_prompts = [p for p in gen.captured if "本阶段 milestone" in p]
    assert milestone_prompts, "no generation prompt carried the milestone block"
    assert any("30K 节奏跑 4:45/km" in p for p in milestone_prompts)
    # base + taper own no milestone → their prompts must NOT carry the block.
    no_ms = [p for p in gen.captured if "本阶段 milestone（生成时必须朝它设计）" not in p]
    assert no_ms, "expected base/taper prompts without a milestone block"


# ---------------------------------------------------------------------------
# generated_by override
# ---------------------------------------------------------------------------


def test_generated_by_override(db, monkeypatch):
    _seed_calibration(db)
    reviewer = _FakeReviewerLLM(["pass"])
    _wire(monkeypatch, db, reviewer=reviewer)

    bundle = generate_season(
        _master_plan(), _context(), injuries=[], generated_by="explicit-model"
    )
    assert bundle.generated_by == "explicit-model"
