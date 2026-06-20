# Coach — Current-Phase Detector (S1 pre-generation)

> Before generating a master plan, deterministically establish **what training phase the
> athlete is currently in and how many weeks they've been in it**, and inject that as an
> authoritative parameter into the planner prompt. The planner then designs the remaining
> periodization **forward from the current position to race day** — it no longer defaults to
> a fresh `base` start.

## Problem (evidence)

The athlete (`f10bc353…`, 1014 activities, CTL ~63, recent 23km threshold work) had already
completed ~8 weeks of aerobic base. The S1 planner still prescribed a (shortened) `base`
phase. A **prompt-only** change ("design from current position, don't repeat completed
phases") was tried and **failed** — the regenerated plan still opened with a shortened base.
Conclusion: the LLM won't reliably infer cycle position from raw signals; the position must
be **computed deterministically and fed in as an authoritative input** (front-loading, the
same principle as the rule_filter hard-rule injection).

## Decisions (confirmed with user)

1. **Form = a deterministic parameter**, computed by a pre-generation adapter and injected
   into the prompt context (like `continuity` signals). NOT an LLM-callable tool — the phase
   position is authoritative and must always run, not optionally invoked.
2. **Two-case dispatch**:
   - **Existing STRIDE user (has an active master plan)** → read current phase + weeks-in-phase
     **deterministically** from the prior plan (phase whose [start,end] contains today;
     weeks elapsed), optionally refined by adherence (planned_session vs activities).
   - **No prior plan but has history (the test user)** → infer current phase from recent
     activities via **both** a deterministic heuristic **and** an LLM analysis, **cross-validate**:
     deterministic wins on disagreement; the divergence is recorded in the rationale.
3. **Must be robust to mid-cycle re-runs** — re-running after the speed phase ends should
   continue from build, never restart at base. Skipping base is an *emergent consequence* of
   "design forward from current position," not a hard-coded rule.

## Layering (.importlinter)

| Concern | Layer | Module |
|---|---|---|
| `CurrentPhaseContext` schema (PhaseType + weeks_in_phase + confidence + rationale) | core | `src/coach/schemas/current_phase.py` |
| Deterministic phase classifier (pure: signals → phase) | core | `src/coach/graphs/generation/phase_detection.py` |
| Detector orchestration (store lookup, DB features, LLM cross-val, dispatch) | adapter | `src/stride_server/coach_adapters/phase_detector.py` |
| Inject `current_phase` into prompt context | adapter | `master_plan_adapter.py::load_master_context` |
| Render the `current_phase` prompt block | adapter | `master_plan_generator.py::_build_system_prompt` |

## CurrentPhaseContext (schema)

```
source: Literal["existing_plan", "inferred", "unknown"]
current_phase_type: PhaseType | None        # the phase the athlete is functionally in NOW
weeks_in_phase: int | None                  # weeks already spent in current_phase_type
completed_aerobic_weeks: int                # recent_aerobic_weeks passthrough (base evidence)
recommended_entry_phase: PhaseType | None   # where the NEW plan should begin (== current, or next if current is "done")
confidence: Literal["high", "medium", "low"]
method_agreement: bool | None               # deterministic vs LLM agreed (inferred case only)
rationale: str                              # human-readable; includes any divergence note
```

## Deterministic heuristic (inferred case) — tunable constants

Operates on `ContinuitySignals` + recent-quality features (count of threshold/interval/vo2/
race activities in last 28d, from `activities.train_kind`) + `weeks_to_race` + `macro_cycle`.

```
BASE_MIN_WEEKS      = 4   # < this (or layoff) → still in base
BASE_COMPLETE_WEEKS = 6   # ≥ this aerobic weeks → base block satisfied
QUALITY_LOOKBACK_D  = 28

if layoff or aerobic_weeks < BASE_MIN_WEEKS:        current = base
elif aerobic_weeks < BASE_COMPLETE_WEEKS:           current = base               # mid-base
else:  # base satisfied
    if marathon_specific (long_run near race dist AND threshold/MP-dominant AND CTL high):
        current = build (or peak if very near race + volume falling)
    elif has_recent_quality:                        current = speed (summer) / build (winter)
    else:                                            current = base-complete → entry = speed (summer)/build (winter)
```

`recommended_entry_phase` = `current_phase_type` (or the next phase when current is judged
"complete"). `weeks_in_phase` for the inferred case is best-effort (weeks since quality work
began, else 0). Constants live at module top, documented, easy to tune after the first test.

## LLM cross-validation (inferred case)

A reviewer-role single-shot call: feed a compact recent-activity summary (per-week volume,
intensity mix, longest run, CTL trend) + the canonical phase definitions; ask it to return
`{phase, weeks_in_phase, rationale}` as JSON. Compare to the deterministic result:
`method_agreement = (llm_phase == deterministic_phase)`; on disagreement keep deterministic,
append both to `rationale`. Safe-degrade: any LLM failure → deterministic result, confidence
capped at "medium".

## Prompt injection

Add a `current_phase_block` rendered before the 规则 section:

```
当前周期定位（确定性，生成前计算 — 权威输入，须遵从）：
- 来源: {source}（existing_plan=读历史计划 / inferred=分析近期运动记录）
- 当前阶段: {current_phase_type}；已进行约 {weeks_in_phase} 周
- 已完成有氧基础周数: {completed_aerobic_weeks}
- 建议起始阶段: {recommended_entry_phase}（本计划应从此阶段开始，向比赛日续接）
- 置信度: {confidence}{；方法分歧说明 if any}
本计划必须从「建议起始阶段」开始排，已完成的前置阶段不得重排。
```

This *supersedes* the softer "judge current position" prose added in the prompt-only attempt
(keep that prose as supporting context, but the authoritative instruction is this block).

## Tasks (TDD)

1. `CurrentPhaseContext` schema + export. Test: construct/validate; enum round-trips.
2. Core deterministic `classify_current_phase(signals, quality_features, weeks_to_race) -> (PhaseType, weeks_in_phase, recommended_entry, confidence, rationale)`. Tests: layoff→base; <BASE_MIN→base; ≥BASE_COMPLETE + quality + summer→speed; marathon-specific→build; winter→build.
3. Adapter `detect_current_phase(db, user_id, goal, profile, as_of)`: dispatch on `get_active_plan`; existing-plan path (phase-containing-today + weeks); inferred path (deterministic + LLM cross-val); compute quality features from DB. Tests with fakes: existing plan → existing_plan source; no plan → inferred + agreement flag; LLM failure → safe-degrade.
4. Wire into `load_master_context` (context["current_phase"]) + render block in `_build_system_prompt`. Test: block carries recommended_entry_phase; planner context includes it.
5. **Isolated test on real data**: regenerate the master plan only (`gen_my_master_plan.py`) for `f10bc353…`; assert phases now START at `speed` (base skipped). Inspect + iterate constants with the user.

## Out of scope (this pass)

- Stage-3b weekly generation (deferred — test phases only, per user).
- `check_phase_count_min` relaxation — only needed if the entry phase is late enough to yield
  <3 phases; for this athlete (speed→build→peak→taper = 4) it isn't triggered. Revisit when a
  mid-cycle re-run produces a 2-phase remainder.
