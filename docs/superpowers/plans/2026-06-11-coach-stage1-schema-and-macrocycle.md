# Coach Stage-1 Schema + Macro-Cycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the structure-layer schema (`PhaseType`, structured `Milestone` fields) and macro-cycle (夏训/冬训) prompt steering to the existing master-plan generator — all **additively / non-breaking** — plus the long-run distance-share rule (spec §8 design-consideration #1).

**Architecture:** This plan does NOT yet split generation into a separate structure-planner node or specialist sub-agents — that's Plan 3. Grounding finding: the existing `coach/graphs/generation/master_rule_filter.py` already implements 12 L1 rules on the `weekly_key_sessions` skeleton, and the single-shot `generate_master_plan` already emits phases + milestones + skeleton. So Plan 2 enriches that path: additive schema fields the generator populates, macro-cycle prompt composition (reusing the `ContinuitySignals.macro_cycle` already injected in Plan 1), and one new aggregate rule. `weekly_key_sessions` stays (Plan 3 removes it when full weekly plans replace it). Each task is independently shippable and keeps all existing tests green.

**Tech Stack:** Python 3.13, pydantic v2 (`stride_core.master_plan`), the S1 rule filter (`coach.graphs.generation.master_rule_filter`), the generator prompt (`stride_server.master_plan_generator`), pytest, import-linter.

**Scope:** Spec §6 (PhaseType registry keys — schema half), §7.1 (PhaseType + structured Milestone — additive, NOT the weekly_key_sessions drop), §5 (macro-cycle prompt steering), §8 design-consideration #1 (long-run share rule). **Deferred to Plan 3:** separate structure-planner node, phase specialists, full WeeklyPlan generation, dropping `weekly_key_sessions`, `milestone_feasibility` rule (needs milestones to drive Stage-2 first).

---

## File Structure

| File | Modify/Create | Responsibility |
|---|---|---|
| `src/stride_core/master_plan.py` | Modify | Add `PhaseType` enum; `Phase.phase_type` (optional); structured `Milestone` fields (optional) |
| `tests/stride_core/test_master_plan.py` | Modify | Schema round-trip + backcompat tests |
| `src/coach/graphs/generation/master_rule_filter.py` | Modify | Add `check_long_run_distance_share` + register it |
| `tests/coach/test_master_rule_filter.py` | Modify | Rule tests incl. volume-capped warning-not-error |
| `src/stride_server/master_plan_generator.py` | Modify | Macro-cycle prompt fragment; emit phase_type + structured milestone in prompt; map them in `_build_master_plan` |
| `tests/stride_server/test_master_plan_generator.py` | Modify | Prompt + builder mapping tests |

**Backcompat rule (HARD):** every new schema field is optional with a default, so existing fixtures, `MasterPlanVersion` snapshots, and the diff machinery (`_apply_review_diff`, `MasterPlanDiffOpKind.REPLACE_MILESTONE_TARGET` on the free-text `target`) keep working untouched. Run `PYTHONPATH=src lint-imports` after each schema/rule task.

---

## Task 1: `PhaseType` enum + `Phase.phase_type` (additive)

**Files:**
- Modify: `src/stride_core/master_plan.py`
- Test: `tests/stride_core/test_master_plan.py`

- [ ] **Step 1: Write the failing test**

```python
def test_phase_type_optional_and_roundtrips():
    from stride_core.master_plan import Phase, PhaseType
    # Backcompat: phase without phase_type still validates (default None).
    p_old = Phase(id="p1", name="基础期", start_date="2026-06-11", end_date="2026-07-12",
                  focus="f", weekly_distance_km_low=50, weekly_distance_km_high=64,
                  key_session_types=["长距离"], milestone_ids=[])
    assert p_old.phase_type is None
    # New: phase_type accepts the registry enum.
    p_new = p_old.model_copy(update={"phase_type": PhaseType.BASE})
    assert p_new.phase_type == PhaseType.BASE
    assert Phase.model_validate(p_new.model_dump()).phase_type == PhaseType.BASE
    # Registry membership is enforced by the enum.
    assert {pt.value for pt in PhaseType} == {"base", "build", "speed", "peak", "taper", "recovery"}
```

- [ ] **Step 2: Run → FAIL** (`ImportError: PhaseType` / no `phase_type`).
Run: `PYTHONPATH=src python -m pytest tests/stride_core/test_master_plan.py::test_phase_type_optional_and_roundtrips -v`

- [ ] **Step 3: Implement** in `src/stride_core/master_plan.py` — add enum after `MilestoneType`:

```python
class PhaseType(str, Enum):
    """Closed set of phase types = the Stage-2 specialist registry keys.
    Stage-1 may only emit these; each maps to one specialist (see spec §6)."""
    BASE     = "base"
    BUILD    = "build"
    SPEED    = "speed"
    PEAK     = "peak"
    TAPER    = "taper"
    RECOVERY = "recovery"
```

and add the field to `Phase` (keep all existing fields):

```python
    phase_type: PhaseType | None = None  # Stage-1↔Stage-2 routing key; optional for backcompat
```

- [ ] **Step 4: Run → PASS**, then the whole schema file + lint:
Run: `PYTHONPATH=src python -m pytest tests/stride_core/test_master_plan.py -q && PYTHONPATH=src lint-imports`
Expected: all pass; contracts kept.

- [ ] **Step 5: Commit**
```bash
git add src/stride_core/master_plan.py tests/stride_core/test_master_plan.py
git commit -m "feat(coach): add PhaseType enum + optional Phase.phase_type"
```
(append the Co-Authored-By trailer)

---

## Task 2: Structured `Milestone` fields (additive)

**Files:**
- Modify: `src/stride_core/master_plan.py`
- Test: `tests/stride_core/test_master_plan.py`

Add quantifiable exit-target fields alongside the existing `type`/`target` (which the diff machinery depends on — do NOT remove them).

- [ ] **Step 1: Write the failing test**

```python
def test_milestone_structured_fields_optional():
    from stride_core.master_plan import Milestone, MilestoneType
    # Backcompat: free-text-only milestone still validates.
    m_old = Milestone(id="m1", type=MilestoneType.RACE, date="2026-10-18",
                      phase_id="p1", target="A 2:50")
    assert m_old.metric is None and m_old.target_value is None and m_old.comparator is None
    # New structured exit target, e.g. speed cycle: 5k <= 1140s.
    m_new = Milestone(id="m2", type=MilestoneType.TEST_RUN, date="2026-08-09",
                      phase_id="p2", target="速度周期末 5k 跑进 19:00",
                      metric="race_time_s_5k", target_value=1140.0, comparator="<=")
    dumped = m_new.model_dump()
    assert Milestone.model_validate(dumped).target_value == 1140.0
    assert m_new.comparator == "<="
```

- [ ] **Step 2: Run → FAIL.**
Run: `PYTHONPATH=src python -m pytest tests/stride_core/test_master_plan.py::test_milestone_structured_fields_optional -v`

- [ ] **Step 3: Implement** — add to `Milestone` (keep `type`/`target`/`completed_actual`):

```python
    # Quantifiable phase exit-target (optional; additive so the diff machinery
    # and legacy snapshots keep working). e.g. metric="race_time_s_5k",
    # target_value=1140, comparator="<=" → "5k sub-19:00 by end of phase".
    metric: str | None = None
    target_value: float | None = None
    comparator: Literal["<=", ">=", "=="] | None = None
```

Add `from typing import Literal` to the imports if not present.

- [ ] **Step 4: Run → PASS**, full schema file + lint.
Run: `PYTHONPATH=src python -m pytest tests/stride_core/test_master_plan.py -q && PYTHONPATH=src lint-imports`

- [ ] **Step 5: Commit**
```bash
git add src/stride_core/master_plan.py tests/stride_core/test_master_plan.py
git commit -m "feat(coach): add optional structured exit-target fields to Milestone"
```

---

## Task 3: `long_run_distance_share` rule (spec design-consideration #1)

**Files:**
- Modify: `src/coach/graphs/generation/master_rule_filter.py`
- Test: `tests/coach/test_master_rule_filter.py`

A peak-phase long_run whose `distance_km` exceeds 35% of the week's `target_weekly_km_high` is the "spike" anti-pattern by **distance** (the existing dose-based rules miss it). Emit **warning** (not error): volume-capped marathoners legitimately exceed it, so the plan should *explain the trade-off* rather than be blocked.

- [ ] **Step 1: Write the failing test**

```python
from stride_core.master_plan import MasterPlan
from coach.graphs.generation.master_rule_filter import check_long_run_distance_share

def _peak_plan(long_km, week_high):
    return MasterPlan.model_validate({
        "plan_id": "x", "user_id": "u", "status": "draft", "goal_id": "g",
        "start_date": "2026-06-11", "end_date": "2026-10-18",
        "phases": [{"id": "peak1", "name": "赛前期", "start_date": "2026-09-07",
                    "end_date": "2026-10-04", "focus": "peak",
                    "weekly_distance_km_low": 70, "weekly_distance_km_high": week_high,
                    "key_session_types": ["长距离"], "milestone_ids": []}],
        "milestones": [],
        "weekly_key_sessions": [{
            "week_index": 1, "week_start": "2026-09-21", "phase_id": "peak1",
            "target_weekly_km_low": week_high - 4, "target_weekly_km_high": week_high,
            "key_sessions": [{"type": "long_run", "distance_km": long_km, "intensity": "z2"}],
            "is_recovery_week": False, "is_taper_week": False,
        }],
        "training_principles": [], "generated_by": "t", "version": 1,
        "created_at": "t", "updated_at": "t",
    })

def test_long_run_share_over_35pct_warns():
    v = check_long_run_distance_share(_peak_plan(long_km=32, week_high=80))  # 40%
    assert len(v) == 1
    assert v[0].rule == "long_run_distance_share"
    assert v[0].severity == "warning"

def test_long_run_share_under_35pct_ok():
    assert check_long_run_distance_share(_peak_plan(long_km=27, week_high=80)) == []  # 33.75%

def test_long_run_share_empty_skeleton_noop():
    plan = _peak_plan(long_km=32, week_high=80).model_copy(update={"weekly_key_sessions": []})
    assert check_long_run_distance_share(plan) == []
```

- [ ] **Step 2: Run → FAIL** (function doesn't exist).
Run: `PYTHONPATH=src python -m pytest tests/coach/test_master_rule_filter.py -k long_run_share -v`

- [ ] **Step 3: Implement** — add to `master_rule_filter.py` (reuse `_week_is_deload`, the `0.35` constant):

```python
_LONG_RUN_MAX_WEEK_SHARE: float = 0.35


def check_long_run_distance_share(plan: MasterPlan) -> list[RuleViolation]:
    """Warn when a non-deload week's longest long_run distance exceeds 35% of
    that week's target_weekly_km_high (the spike anti-pattern by DISTANCE; the
    dose-based rules miss easy long runs). Warning, not error: volume-capped
    runners legitimately exceed it for FM-specific endurance — the plan should
    explain the trade-off in its principles (spec §8 design-consideration #1)."""
    if not plan.weekly_key_sessions:
        return []
    violations: list[RuleViolation] = []
    for week in plan.weekly_key_sessions:
        if _week_is_deload(week):
            continue
        if not week.target_weekly_km_high or week.target_weekly_km_high <= 0:
            continue
        longest = max(
            (s.distance_km for s in week.key_sessions
             if s.type == "long_run" and s.distance_km is not None),
            default=0.0,
        )
        if longest <= 0:
            continue
        share = longest / week.target_weekly_km_high
        if share > _LONG_RUN_MAX_WEEK_SHARE:
            violations.append(RuleViolation(
                rule="long_run_distance_share",
                severity="warning",
                message=(
                    f"week {week.week_index} long_run {longest:.0f}km is "
                    f"{share * 100:.0f}% of weekly {week.target_weekly_km_high:.0f}km "
                    f"(> {_LONG_RUN_MAX_WEEK_SHARE * 100:.0f}%); for a volume-capped "
                    f"runner this can be acceptable but the plan must justify it"
                ),
                details={
                    "week_index": week.week_index,
                    "long_run_km": longest,
                    "weekly_km_high": week.target_weekly_km_high,
                    "share_pct": round(share * 100, 1),
                },
            ))
    return violations
```

- [ ] **Step 4: Register** it in `run_master_rule_filter` (after `check_hard_session_spacing(plan)`):
```python
    violations.extend(check_long_run_distance_share(plan))
```

- [ ] **Step 5: Run → PASS**, full rule-filter file + lint.
Run: `PYTHONPATH=src python -m pytest tests/coach/test_master_rule_filter.py -q && PYTHONPATH=src lint-imports`

- [ ] **Step 6: Commit**
```bash
git add src/coach/graphs/generation/master_rule_filter.py tests/coach/test_master_rule_filter.py
git commit -m "feat(coach): warn on long-run distance share >35% of weekly volume"
```

---

## Task 4: Macro-cycle (夏训/冬训) prompt steering

**Files:**
- Modify: `src/stride_server/master_plan_generator.py` (`_build_system_prompt`)
- Test: `tests/stride_server/test_master_plan_generator.py`

`ContinuitySignals.macro_cycle` (summer/winter/unknown) is already injected into the continuity block (Plan 1). Now add a dedicated **macro-cycle guidance fragment** so the generator periodizes per the spec §5 templates (summer = long block, speed cycle, heat-managed long runs; winter = compressed, aerobic-volume-heavy, speed folded into build).

- [ ] **Step 1: Write the failing test**

```python
class TestMacroCycleGuidance:
    def _prompt(self, mc):
        from stride_server.master_plan_generator import _build_system_prompt
        from coach.schemas import ContinuitySignals
        return _build_system_prompt(
            goal={"race_distance": "FM", "race_date": "2026-10-18"}, profile=None,
            history_summary="h", fitness_state={"summary": "s"}, today="2026-06-11",
            continuity=ContinuitySignals(macro_cycle=mc),
        )
    def test_summer_guidance(self):
        p = self._prompt("summer")
        assert "夏训" in p and ("速度周期" in p or "speed" in p.lower())
    def test_winter_guidance(self):
        p = self._prompt("winter")
        assert "冬训" in p and "有氧" in p
    def test_unknown_no_macro_block(self):
        # macro_cycle unknown → no macro-cycle guidance fragment emitted
        p = self._prompt("unknown")
        assert "夏训块周期化指导" not in p
```

- [ ] **Step 2: Run → FAIL.**
Run: `PYTHONPATH=src python -m pytest tests/stride_server/test_master_plan_generator.py::TestMacroCycleGuidance -v`

- [ ] **Step 3: Implement** — in `_build_system_prompt`, after the `continuity_block` is built, add a macro-cycle fragment and inject it adjacent to the continuity block:

```python
    macro_block = ""
    if continuity is not None and continuity.macro_cycle == "summer":
        macro_block = """
夏训块周期化指导（macro_cycle=summer）：长块（赛季备战 ~7-8 个月感），气温高、适合发展速度。
- phase 序列倾向：基础期 → 速度周期(speed) → 进展期(build) → 赛前期(peak) → taper；中段排一个独立速度周期。
- 长课避开正午高温，质量课优先清晨/傍晚；base 可铺得开。
"""
    elif continuity is not None and continuity.macro_cycle == "winter":
        macro_block = """
冬训块周期化指导（macro_cycle=winter）：压缩块（~4-5 个月），低温、消耗小、适合堆大量有氧。
- phase 序列倾向：基础期(长、堆有氧) → 进展期(build，速度并入) → 赛前期(peak) → taper；不排独立速度周期。
- base 偏长、尽快进专项；速度训练融进 build 而非单独成块。
"""
```

Then inject `{macro_block}` into the returned f-string right after `{continuity_block}`. (Note the `test_unknown_no_macro_block` sentinel string "夏训块周期化指导" only appears in the summer fragment, so unknown/winter won't contain it.)

- [ ] **Step 4: Run → PASS**, full generator file.
Run: `PYTHONPATH=src python -m pytest tests/stride_server/test_master_plan_generator.py -q`

- [ ] **Step 5: Commit**
```bash
git add src/stride_server/master_plan_generator.py tests/stride_server/test_master_plan_generator.py
git commit -m "feat(coach): macro-cycle (summer/winter) periodization steering in prompt"
```

---

## Task 5: Generator emits `phase_type` + structured milestone

**Files:**
- Modify: `src/stride_server/master_plan_generator.py` (prompt output contract + `_build_master_plan`)
- Test: `tests/stride_server/test_master_plan_generator.py`

Make the generator populate the new schema fields: add them to the prompt's JSON template, and map them in `_build_master_plan` (graceful when absent — backcompat).

- [ ] **Step 1: Write the failing test**

```python
class TestBuildMapsNewFields:
    def test_phase_type_and_structured_milestone_mapped(self):
        from stride_server.master_plan_generator import _build_master_plan
        from stride_core.master_plan import PhaseType
        data = {
            "schema": "weekly-plan/master/v1",
            "plan": {
                "start_date": "2026-06-11", "end_date": "2026-10-18",
                "training_principles": ["p"],
                "phases": [{"name": "基础期", "phase_type": "base",
                            "start_date": "2026-06-11", "end_date": "2026-07-12",
                            "focus": "f", "weekly_distance_km_low": 50,
                            "weekly_distance_km_high": 64, "key_session_types": ["长距离"]}],
                "milestones": [{"type": "test_run", "date": "2026-08-09",
                                "phase_name": "基础期", "target": "5k sub-19",
                                "metric": "race_time_s_5k", "target_value": 1140,
                                "comparator": "<="}],
            },
        }
        plan = _build_master_plan(data, "u", "g")
        assert plan.phases[0].phase_type == PhaseType.BASE
        assert plan.milestones[0].metric == "race_time_s_5k"
        assert plan.milestones[0].target_value == 1140.0
        assert plan.milestones[0].comparator == "<="

    def test_missing_new_fields_still_builds(self):
        # Backcompat: omitting phase_type / structured milestone fields is fine.
        from stride_server.master_plan_generator import _build_master_plan
        data = {"schema": "weekly-plan/master/v1", "plan": {
            "start_date": "2026-06-11", "end_date": "2026-10-18",
            "training_principles": ["p"],
            "phases": [{"name": "基础期", "start_date": "2026-06-11", "end_date": "2026-07-12",
                        "focus": "f", "weekly_distance_km_low": 50, "weekly_distance_km_high": 64,
                        "key_session_types": ["长距离"]}],
            "milestones": [{"type": "long_run", "date": "2026-06-28", "phase_name": "基础期",
                            "target": "22km"}]}}
        plan = _build_master_plan(data, "u", "g")
        assert plan.phases[0].phase_type is None
        assert plan.milestones[0].metric is None
```

- [ ] **Step 2: Run → FAIL** (builder ignores the new fields).
Run: `PYTHONPATH=src python -m pytest tests/stride_server/test_master_plan_generator.py::TestBuildMapsNewFields -v`

- [ ] **Step 3: Implement** in `_build_master_plan`:
  - In the phase-construction loop, parse `phase_type`:
    ```python
        from stride_core.master_plan import PhaseType
        raw_pt = p.get("phase_type")
        try:
            phase_type = PhaseType(raw_pt) if raw_pt else None
        except ValueError:
            logger.warning("unknown phase_type %r; leaving None", raw_pt)
            phase_type = None
    ```
    and pass `phase_type=phase_type` to the `Phase(...)` constructor.
  - In the milestone-construction loop, pass the structured fields:
    ```python
        metric=m.get("metric"),
        target_value=_to_optional_float(m.get("target_value")),
        comparator=m.get("comparator"),
    ```
    to the `Milestone(...)` constructor (`_to_optional_float` already exists in this module).

- [ ] **Step 4: Update the prompt output contract** in `_build_system_prompt` — add `"phase_type"` to the phases JSON example (with a note listing the 6 allowed values) and `metric`/`target_value`/`comparator` to the milestones JSON example, plus one rule line: "每个 phase 必须标注 phase_type（base|build|speed|peak|taper|recovery）；milestone 尽量给结构化出口目标（metric+target_value+comparator）". Keep the example minimal — don't bloat the prompt.

- [ ] **Step 5: Run → PASS**, full generator file + the schema + rule-filter suites.
Run: `PYTHONPATH=src python -m pytest tests/stride_server/test_master_plan_generator.py tests/stride_core/test_master_plan.py tests/coach/test_master_rule_filter.py -q && PYTHONPATH=src lint-imports`

- [ ] **Step 6: Commit**
```bash
git add src/stride_server/master_plan_generator.py tests/stride_server/test_master_plan_generator.py
git commit -m "feat(coach): generator emits phase_type + structured milestone fields"
```

---

## Task 6: Smoke against real DB (manual)

- [ ] **Step 1:** `! az login`, then `$env:COACH_DEBUG="1"; $env:PYTHONIOENCODING="utf-8"; python scripts/gen_my_master_plan.py`. Confirm: phases carry `phase_type`; the summer macro-cycle guidance appears in the prompt and the plan inserts a speed block; structured milestones appear where natural; no new rule_filter errors (the long-run-share warning may appear — that's expected and the plan should justify it in principles).

---

## Self-Review

- **Spec coverage:** §6 PhaseType registry keys (schema) → Task 1; §7.1 structured Milestone (additive) → Task 2; §8 #1 long-run share → Task 3; §5 macro-cycle steering → Task 4; generator wiring → Task 5.
- **Backcompat:** every schema field optional+defaulted (Tasks 1-2); builder maps absent fields gracefully (Task 5 `test_missing_new_fields_still_builds`); diff machinery + `MasterPlanVersion` snapshots untouched. New rule is warning-only.
- **Deferred (Plan 3, explicitly):** separate structure-planner node, phase specialists, full WeeklyPlan generation, dropping `weekly_key_sessions`, `milestone_feasibility` rule, `phase_type_has_specialist` coverage rule (meaningful only once specialists exist).
- **Type consistency:** `PhaseType` values `{base,build,speed,peak,taper,recovery}` used identically in enum (Task 1), builder (Task 5), prompt (Task 5). `comparator` Literal `<=|>=|==` consistent (Task 2, Task 5 test).
