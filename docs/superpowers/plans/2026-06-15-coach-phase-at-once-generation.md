# Coach — Phase-at-once Generation (Optimization Design)

> Replaces the per-week sequential generator with **one LLM call per phase** that emits all
> weeks of the phase at once. Faster (≈19 week-calls → 5 phase-calls) AND higher quality
> (the model designs the whole phase's progression — deload placement, long-run ramp,
> milestone build-up — instead of greedily week-by-week with only prior-week context).

Builds on the merged Stage-3a + Stage-3b stack. Confirmed decisions (2026-06-15):
- **Output budget** → generator `max_tokens` 131072 → **524288 (512k)** (local + prod).
- **Phases stay SERIAL** (no cross-phase parallelism yet — simpler, clearer logs).
- **Tools stay tools** — `strength_library` / `recent_training` remain LLM-callable (now once per phase, not per week).
- **Regeneration carries feedback** — both the rule_filter violations AND the phase reviewer's issues are fed back into a phase regeneration, so a regen actually fixes the problem (the current blind whole-phase regen changed nothing — see §1).

---

## 1. Why (the real-data evidence)

A real 5-phase / 19-week run took ~40 min / 85 LLM calls. Two root causes:
1. **Sequential per-week generation** — each week is its own generator call (+ tool rounds + rule_filter retries), threaded one-by-one.
2. **Wasteful blind regen** — 4/5 phases got reviewer `revise` → each **regenerated the entire phase**, but all 4 stayed `revise` after regen, because `_best_phase_attempt` re-ran with **identical inputs** (the reviewer's issues were never fed back). ≈30-40% of calls burned for zero improvement.

Phase-at-once fixes both: 1 call per phase, and the regen now carries the reviewer/rule feedback.

It also targets the *quality* gaps the reviewer flagged — all phase-level ("long run didn't progress to the milestone", "recovery week kept quality sessions") — exactly the things a holistic per-phase generation can get right and a greedy per-week one can't.

---

## 2. Architecture change

```
BEFORE (per-week):
  derive_phase_weeks → for each week: [build_week_specialist_graph: generate 1 week →
      run_rule_filter → retry≤3] threading prev_week_km → N generator calls → phase review

AFTER (phase-at-once):
  derive_phase_weeks (unchanged — gives every week's deterministic target_weekly_km)
    → 1 generator call: inject the whole phase (N weeks' targets + pace + per-week volume
      budget + milestone + doctrine + injuries + continuity); tools bindable
      → emits { "weeks": [WeeklyPlan × N] }
    → run_rule_filter per week (prev_week_km = prior week's deterministic target)
      → any week violates? regenerate the phase WITH per-week violation feedback (≤max)
      → after max: drop still-violating weeks (→ blocked_week_count), keep the clean ones
    → phase review (unchanged — already phase-level)
    → review=revise/block? regenerate the phase WITH the reviewer's issues fed back (≤max)
```

**Safety is unchanged**: `run_rule_filter` still runs per-week (≤1.10×, long-run ≤35%, 80/20, rest day, injuries) on the batch output. Only generation *granularity* changes; the deterministic gate is identical.

---

## 3. Layering & modules

| Concern | Layer | Module |
|---|---|---|
| Phase JSON contract + prompt composer (N-week batch) | core | `coach/graphs/generation/phase_prompt.py` |
| Batch parse (`{"weeks":[...]}` → list, validate each) | core | same / reuse `_parse_llm_output` |
| Phase generator (compose → tools → LLM → parse) + rule_filter+feedback loop | adapter | `coach_adapters/phase_specialist_adapter.py` |
| Orchestrator wiring + review-feedback regen | adapter | `coach_adapters/season_orchestrator.py` |
| Token budget | config | `config/coach.local.toml` + `coach.prod.toml` |

Reuse: the WeeklyPlan field contract + `_parse_llm_output` (3-tier), `build_specialist_context` (pace/volume per week), `run_tool_loop` + the specialist tool wrappers, `run_rule_filter`, `phase_specialists` guidance, `review_phase`.

**Dead code:** the per-week `generate_specialist_week`, `build_week_specialist_graph`, `_week_stub_reviewer`, and the per-week loop in `generate_phase_weeks` become unused by the season path. Remove them (or, if a future S2 single-week path is foreseen, keep only what's reused — decide at execution; default to removing to honor no-dead-code).

---

## 4. The phase prompt contract

`build_phase_system_prompt(*, phase_type, week_specs, pace_targets, context_block, feedback=None) -> str`:
- **week_specs**: ordered list, one per week — `{week_index (i/N), week_folder, target_weekly_km, volume_budget (long_run_km / quality_km / easy_km), is_deload}`. The composer renders a per-week table so the LLM knows exactly how many weeks, each week's volume target + budget, and which weeks are deloads.
- **pace_targets**: the one athlete pace table (shared across weeks).
- **specialist guidance** for `phase_type` (the §3 doctrine) + the phase's milestone(s).
- **Output contract**: emit `{"schema":"phase-weeks/v1","weeks":[<WeeklyPlan>, …]}` with **exactly N** weeks, week i matching week_spec i (folder + ~target km), aspirational `spec=null` sessions. Reuse the exact WeeklyPlan field contract from the weekly composer (drift-guarded the same way).
- **feedback** (regen only): a block listing what to fix — either rule_filter violations ("week 4 violates rest_days: …") or the reviewer's issues ("长跑未推进到 milestone 21km；recovery 周保留了质量课"). The LLM must address these in the regenerated phase.

---

## 5. Implementation tasks (TDD per task)

1. **Config: bump generator max_tokens → 524288** (`coach.local.toml` + `coach.prod.toml`), with a comment noting the model's actual output ceiling may be lower but a phase of aspirational weeks stays well under it. Test: config loads; `ModelSpec.max_tokens == 524288`.
2. **Phase prompt composer + batch contract** (core `phase_prompt.py`): `build_phase_system_prompt(...)` + a `parse_phase_batch(raw) -> list[dict]` (reuse `_parse_llm_output`, extract `weeks`, return the per-week dicts). Tests: prompt carries N week specs + pace table + doctrine + (optional) feedback; parse extracts N weeks; malformed/short batch handled.
3. **Phase generator adapter** (`phase_specialist_adapter.py`): `generate_specialist_phase(phase, week_metas, context, injuries, *, feedback=None) -> list[dict]` — per-week `build_specialist_context` (pace once + volume per week), compose phase prompt, bind `get_specialist(pt).tools`, `run_tool_loop`, `parse_phase_batch`, validate each via `WeeklyPlan.from_dict`. 512k budget. Test (fake LLM): valid batch → N week dicts; tool fires once; garbage → parse error.
4. **Phase rule_filter + feedback-regen loop** (replace `generate_phase_weeks`): generate phase → `run_rule_filter` each week (prev = prior week target) → violations? regen phase with violation feedback (≤max) → drop persistently-violating weeks → return clean weeks + blocked count. Test: a clean phase → N weeks; an injected always-violating week → regen attempted with feedback in the prompt, then dropped (blocked_week_count).
5. **Orchestrator wiring + review-feedback regen**: `generate_season` / `_best_phase_attempt` call the phase generator; on `revise`/`block`, regenerate the phase passing the reviewer's issues as `feedback`. Test: a fake reviewer that returns revise-then-pass → the 2nd attempt's prompt carries the reviewer feedback; bounded; degrades.
6. **Remove dead per-week path** + update all touched tests/smoke (the fake LLM now returns a phase batch). Re-run the full Stage-3a/3b surface; `lint-imports` 0 broken.

**Progress logging** (already added) adapts: "phase X: generating N weeks (one call)" instead of per-week lines; keep the per-phase + season-level narrative.

---

## 6. Expected impact

- Calls: ~85 → ~12-18 (5 phase-calls + 5 reviews + a few feedback regens). ~5-7× fewer.
- Wall-clock: ~40 min → ~3-6 min (serial phases; each call larger but far fewer).
- Quality: phase-holistic generation + productive feedback-regen should lift the milestone-progression / deload-week issues the reviewer flagged.

## 7. Risks / notes

- **Output size**: a 7-week phase of aspirational weeks is well under even 128k output; 512k is just a removed ceiling. If the API rejects 512k as > model max_completion, fall back to the model's documented max (still ample). Verify on the first real run.
- **One bad week regenerates the whole phase** (vs one week before). Cheaper now (1 call), and feedback makes the regen targeted in content.
- **Coherence vs granularity**: lose per-week independent salvage, but phase review already treats the phase as the unit, so this matches the real validation boundary.
