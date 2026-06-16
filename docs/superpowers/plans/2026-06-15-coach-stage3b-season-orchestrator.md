# Coach Stage-3b — Season Orchestrator (Design)

> Design-forward doc. Names modules, interfaces, decisions; code authored at execution.
> Builds on Stage-3a (`2026-06-11-coach-stage3a-phase-specialists.md`), now merged in PR #90.

**Goal:** turn a generated **master plan** (phases + milestones, from S1) into a **full season of weekly plans** by driving the Stage-3a per-phase specialist generator across every phase, assembling a `SeasonPlanBundle`, and gating it with a **real per-phase reviewer** + **season-aggregate rules**. Stage-3a stopped at "one phase, given week descriptors"; 3b is the structure→all-phases orchestrator that 3a explicitly deferred.

---

## 1. What 3a left for 3b (recap)

- `generate_phase_weeks(phase, weeks, context, injuries)` exists and is rule-clean per week, but **nobody builds the `weeks` descriptors** (target_weekly_km ramp, dates, phase_position) — that derivation is 3b.
- The per-phase **reviewer is a pass-stub** (`_week_stub_reviewer`); 3b adds a real one.
- No **cross-phase / cross-week** validation (overall ramp arc, phase transitions, milestone coverage, taper sanity) — 3b adds a season-aggregate rule layer.
- Sessions are **aspirational `spec=None`** (calendar-visible, not push-to-watch). Lowering to structured pushable `NormalizedRunWorkout` is a 3b sub-piece (possibly deferred again).

---

## 2. Components & layering

| Concern | Layer | Module |
|---|---|---|
| `SeasonPlanBundle` schema (aggregate output) | core | `coach/schemas/season_bundle.py` |
| Week-descriptor derivation (phase → ordered weeks w/ ramped km) | core | `coach/graphs/generation/week_schedule.py` |
| Season-aggregate rule filter (cross-phase/week checks) | core | `coach/graphs/generation/season_rule_filter.py` |
| Real per-phase reviewer | core (prompt/graph) + adapter (LLM call) | `coach/graphs/generation/phase_reviewer.py` + adapter |
| Orchestrator (master plan → all phases → bundle) | adapter | `coach_adapters/season_orchestrator.py` |
| Push-to-watch lowering (aspirational → NormalizedRunWorkout) | adapter | `coach_adapters/week_push_lowering.py` (sub-plan 3b-3) |

`coach.*` core import boundary unchanged. Orchestrator is adapter (drives DB + LLM + the Stage-3a adapter loop).

---

## 3. Week-descriptor derivation (the missing piece)

`derive_phase_weeks(phase, *, prev_phase_end_km) -> list[WeekMeta]` — pure core function:
- **Count weeks** from `phase.start_date`/`end_date` (Shanghai-week aligned via `timefmt`).
- **Ramp `target_weekly_km`** within `[weekly_distance_km_low, weekly_distance_km_high]` per the phase's ramp character (from CLAUDE.md training-load constraints): base/build ramp up ~5-8%/wk with a 3:1 deload; peak holds/micro-drops; taper steps down −25→−45%; recovery steps down. Respects the ≤1.10×-week cap that `run_rule_filter` enforces (so descriptors don't pre-bake a violation).
- **Continuity across phases**: first week of a phase starts from the previous phase's exit volume, not a reset.
- **phase_position** string ("build week 3/7") + `week_folder` (`YYYY-MM-DD_MM-DD(Wn)` per the repo convention).
- Emits `is_recovery_week`/`is_taper_week` hints where relevant.

**Decision D1:** does the ramp shape live here (deterministic), or do we let the specialist LLM choose weekly volume within the band? → Recommend **deterministic ramp here** (volume arc is a planning/periodization concern with HARD rules; the specialist fills the *content* of each week's budget, not the volume target). Keeps it testable and rule-safe.

---

## 4. `SeasonPlanBundle`

```
SeasonPlanBundle:
  master_plan_id: str
  generated_by: str
  phases: list[PhaseWeeks]        # one per master-plan phase, in order
PhaseWeeks:
  phase_id: str
  phase_type: PhaseType
  weeks: list[WeeklyPlan dict]    # from generate_phase_weeks
  review: PhaseReview | None      # §6
  blocked_week_count: int         # weeks that couldn't pass rule_filter
```
Core schema; serializable; round-trips. Carries enough for an endpoint/persistence layer (out of scope here) to store + render the season calendar.

---

## 5. Season-aggregate rule filter

`run_season_rule_filter(bundle, master_plan) -> SeasonRuleReport` — deterministic cross-cutting checks the per-week `run_rule_filter` can't see:
1. **Overall volume arc**: weekly km is monotone-sane across phase boundaries (no silent cliff/spike between phases beyond the ramp rules).
2. **Phase transition continuity**: last week of phase N → first week of phase N+1 respects the ≤1.10× (or planned deload) cap.
3. **Milestone coverage**: each phase with a quantifiable milestone (perf/body-comp) actually schedules sessions consistent with it (e.g. a speed phase with a 5k-target milestone has VO2max/interval weeks; a peak with an MP milestone has MP long runs). Warning-level where fuzzy.
4. **Taper/peak sanity**: taper total volume drops vs peak; no big new stimulus in taper/peak (matches the specialist doctrine).
5. **Blocked-week budget**: if >X% of weeks were rule-blocked, the season is flagged (the orchestrator surfaces it rather than silently shipping a sparse season).

Errors route back to the offending phase's regeneration (bounded retries); warnings annotate the bundle.

---

## 6. Real per-phase reviewer (replace the stub)

Replace `_week_stub_reviewer` with a real reviewer that judges a phase's generated weeks against (a) the specialist doctrine for that `phase_type` and (b) the phase's master-plan focus + milestone. Two options:

- **6a deterministic-only**: extend the season rule filter to the per-phase level — no LLM. Cheapest, fully reproducible.
- **6b LLM reviewer**: an Opus reviewer (reuse the generation graph's reviewer slot, which 3a wired as a stub) emitting `pass|revise|block` + issues, so a doctrine-violating-but-rule-clean phase (e.g. a "speed" phase with no real Z5 work) gets caught. Reuses `parse_reviewer_xml` + the graph's revise loop.

**Decision D2:** 6a, 6b, or hybrid (deterministic gate + LLM doctrine check)? → Recommend **hybrid**: deterministic season rules are the hard gate; one LLM doctrine review per phase catches the "rule-clean but wrong-character" failure that rules can't express. Matches the spec's two-tier philosophy (rule_filter + reviewer).

---

## 7. Orchestrator

`generate_season(master_plan, context, injuries) -> SeasonPlanBundle` (adapter):
1. For each `phase` in `master_plan.phases` (ordered): `weeks = derive_phase_weeks(phase, prev_phase_end_km=...)`; `plans = generate_phase_weeks(phase, weeks, context, injuries)`; optional per-phase reviewer (§6); collect `PhaseWeeks`.
2. Thread exit volume + (optionally) prior-phase tail across phase boundaries.
3. `run_season_rule_filter(bundle, master_plan)` → on error, regenerate the offending phase (bounded); annotate warnings.
4. Return the assembled `SeasonPlanBundle`.

Sequential across phases (each phase already loops weeks sequentially). Emits stage updates like the S1 generator.

---

## 8. `weekly_key_sessions` — DON'T blindly drop (decision)

3a's deferral list said "drop `weekly_key_sessions`." Investigation shows it's **load-bearing for S1**: consumed by `master_rule_filter` (Batch-B L1 rules), `master_plan_diff`, and `master_plan_generator`. It is the **S1 strategic skeleton** the eval framework checks before full expansion.

**Decision D3:** Recommend **KEEP it as the S1 strategic layer** and re-frame: 3a/3b weekly plans are the **S2 expansion** of that skeleton, not a replacement. 3b's orchestrator may *read* the skeleton as a hint (which weeks carry which key stimulus) but the full weeks come from the specialists. "Dropping" it would mean migrating the S1 eval rules — out of scope and probably wrong. Confirm before any removal.

---

## 9. Push-to-watch (sub-plan 3b-3, defer-able)

Lower aspirational `spec=None` sessions → structured `NormalizedRunWorkout` (warmup/intervals/targets) so weeks can sync to COROS. Reuses the existing S2 push pipeline (`coros_sync/adapter.py`, `routes/weeks.py`/`workouts.py`). This is a **separate, deterministic lowering step** (pace-table + session-summary → structured blocks) that should NOT be entangled with the specialist LLM call (keeps generation/eval clean; lowering is a format transform).

**Decision D4:** include 3b-3 now, or defer push-to-watch to a later plan? → Recommend **defer**: the season bundle is valuable calendar-visible without push; lowering is a cohesive separate effort with its own eval (round-trip a structured week through the COROS push schema).

---

## 10. Proposed decomposition

- **3b-1** — orchestrator core: `SeasonPlanBundle`, `derive_phase_weeks`, `generate_season`, `run_season_rule_filter`. (Largest; the assembly.)
- **3b-2** — real per-phase reviewer (replace stub) per Decision D2.
- **3b-3** — push-to-watch lowering (defer-able per D4).
- **3b-4** — eval: season-level fixtures + judge axes (cross-phase coherence, milestone alignment, ramp sanity) on the committed real DB.

---

## 11. Decisions (CONFIRMED 2026-06-15)

- **D1** ✅ ramp shape **deterministic** (in `derive_phase_weeks`); specialist fills content within the budget, not the volume target.
- **D2** ✅ per-phase reviewer = **hybrid**: deterministic season-aggregate rules are the hard gate + one LLM doctrine reviewer per phase (replaces the 3a pass-stub) catching "rule-clean but wrong-character" phases.
- **D3** ✅ **KEEP** `weekly_key_sessions` as the S1 strategic skeleton — do NOT drop. 3a/3b weeks are its S2 expansion. Orchestrator may read it as a hint.
- **D4** ✅ **defer** push-to-watch (3b-3) and season eval (3b-4) to later plans.
- **Scope** ✅ execute **3b-1 + 3b-2** now (orchestrator core + hybrid reviewer).
- **Persistence/endpoints** — out of scope here (like 3a); the bundle is in-memory/serializable, wiring to storage + routes is a later increment.

---

## 12. Implementation tasks (3b-1 + 3b-2; code-light, TDD per task)

1. **`SeasonPlanBundle` + `PhaseWeeks` schema** — `coach/schemas/season_bundle.py` (core pydantic), re-exported from `coach.schemas`. Round-trip test. (§4)
2. **`derive_phase_weeks`** — `coach/graphs/generation/week_schedule.py` (core, pure): phase → ordered `WeekMeta` with deterministic ramped `target_weekly_km`, Shanghai-week aligned, cross-phase exit-volume continuity, ≤1.10×-safe, recovery/taper deload shapes. Tests: week count from dates; ramp within band + ≤1.10×; taper steps down; recovery deload; first-week continuity from `prev_phase_end_km`. (§3, D1)
3. **`run_season_rule_filter`** — `coach/graphs/generation/season_rule_filter.py` (core, deterministic): volume arc, phase-transition ≤1.10×/deload, milestone coverage (warn), taper/peak sanity, blocked-week budget. Returns a `SeasonRuleReport` (errors/warnings). Tests per rule. (§5)
4. **Hybrid per-phase reviewer** — replace `_week_stub_reviewer`. Core: `phase_reviewer` prompt + `parse_reviewer_xml` reuse emitting `pass|revise|block` against the specialist doctrine + phase focus/milestone. Adapter: the LLM call wiring (mirror the generation reviewer slot). Test with fake LLM: doctrine-violating phase → `revise`/`block`; clean phase → `pass`. (§6, D2)
5. **`generate_season` orchestrator** — `coach_adapters/season_orchestrator.py` (adapter): per phase `derive_phase_weeks` → `generate_phase_weeks` (injecting the real reviewer) → collect `PhaseWeeks`; thread exit volume; `run_season_rule_filter`; regenerate the offending phase on season-error (bounded); assemble `SeasonPlanBundle`. Test with fake LLM: a 3-phase master plan → full bundle; a season-rule violation triggers one bounded phase regen. (§7)
6. **Integration smoke** (fake LLM): a realistic multi-phase master plan → `generate_season` → every week `run_rule_filter`-clean, `run_season_rule_filter` passes, the real reviewer is in the loop. (§7)

**Layering:** new core modules + one new adapter module; reuse Stage-3a `generate_phase_weeks` + `build_week_specialist_graph` unchanged (just inject the real reviewer instead of the stub). `lint-imports` after each task.

---

## 13. Execution status (DONE 2026-06-15)

3b-1 + 3b-2 executed via subagent-driven-development (TDD per task; each passed spec + code-quality review + a final holistic integration review). **Full suite 863 passed; `lint-imports` 0 broken.** All six tasks committed on `feat/coach-stage3b-orchestrator`.

| Task | Module | Status |
|---|---|---|
| T1 | `coach/schemas/season_bundle.py` | ✅ |
| T2 | `coach/graphs/generation/week_schedule.py` | ✅ (≤1.10× continuity cap verified across a 2730-pt grid; recovery/taper high-clamp) |
| T3 | `coach/graphs/generation/season_rule_filter.py` | ✅ |
| T4 | `coach/graphs/generation/phase_reviewer.py` + `coach_adapters/phase_review_adapter.py` | ✅ (uses reviewer-role LLM) |
| T5 | `coach_adapters/season_orchestrator.py` | ✅ (two-pass bounded regen; degrade-not-crash) |
| T6 | `tests/stride_server/test_season_integration_smoke.py` | ✅ (mutation-verified non-vacuous) |

### Tracked follow-ups (non-blocking; surfaced by the holistic review)

- **[I1 — periodization realism]** Exit-volume threading uses the literal last generated week's km, which is often a **deload trough** or a still-sub-band climbing week. Combined with the HARD ≤1.10× cap, this compounds across phases so a short **peak phase cannot reach its prescribed band** (smoke plan: peak band [70-85] derives to ~[52, 57, 62]). This is a **modeling conservatism, NOT a wiring bug** — every week stays rule-clean/safe; the season is just volume-conservative. **Fix:** thread a *representative working volume* (the phase's max non-deload week, or a clamp toward band-midpoint) into the next phase's `prev_phase_end_km` instead of `weeks[-1]`. Natural home: **3b-4** (season eval can measure "phases reach their bands"), or a dedicated tuning pass.
- **[M1 — cap drift]** The ≤1.10× cap is a local constant in T2 (`_MAX_RAMP_RATIO`), T3 (`UP_STEP_RATIO_CAP`), and the Stage-3a `rule_filter` (bare literal). Each is documented as deliberately matching the per-week gate, but they could drift. Optional: import the cap from `rule_filter` (the canonical per-week authority).
- **[M2 — non-self-healing attribution]** `taper_peak_sanity` errors attribute to the taper phase, but the taper is deterministic (steps down from entry) so its regen yields the identical result; the real cause is usually a volume-suppressed peak (see I1). Reconsider attributing to the upstream loaded phase, or comment the limitation.
- **[bundle report]** The final `SeasonRuleReport` is logged, not attached to `SeasonPlanBundle` (T1 schema has no field). `blocked_week_budget` season errors are season-wide (no owning phase) and thus log-only. If a future API/UI needs post-hoc season diagnostics, add an optional `season_report` field to the bundle.

### Still deferred (per §11 decisions, genuinely not gaps)
3b-3 push-to-watch lowering; 3b-4 season eval; persistence/endpoints for the bundle.
