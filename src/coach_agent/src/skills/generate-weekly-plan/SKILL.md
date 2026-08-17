---
name: generate-weekly-plan
description: Generate a structured weekly running plan from the athlete's active master plan, actual completed training, STRIDE load, recovery signals, phase milestones, and recent stimulus history.
---

# Generate a weekly training plan

## 1. Load the bounded evidence

Call `get_master_plan` once. If there is no active master plan, ask the athlete to create one first. Call `get_weekly_plan_context` once; it is the source for the authoritative `plan_start`, `week_name`, recent planned-versus-actual weeks, STRIDE load, recovery, injuries, calibration, current phase, stage, and phase milestones.

Use `absorbed_load.distance_anchor_km` as the deterministic median of the latest complete weeks and `absorbed_load.latest_complete_week` for recency. Use only `recent_training_weeks` entries with `complete: true` as any additional full-week evidence. A partial week is useful for the latest stimulus and recovery evidence, but it is not a low-volume completed week. Treat actual completed training as the exposure the athlete absorbed. Planned sessions that were skipped do not count as completed exposure.

Complete this step only after identifying:

- the provided `distance_anchor_km`, latest complete-week distance and training dose, and whether completion is rising, stable, or falling; do not recompute the median;
- whether the latest complete week was already materially under the anchor (below 90%), i.e. whether this week would be a second consecutive low-volume week;
- the latest STRIDE `load_ratio`, raw RHR/HRV trend, injuries, and any unusually costly recent session;
- the current phase/stage, recovery-week flag, nearest milestone inside the current phase, and `quality_stimulus_days`/`longest_run` evidence from the latest two weeks. Multiple activity records on one day are one stimulus day.

## 2. Set the load target from absorbed training

The actual complete-week median is the absolute-volume anchor. The master-plan range supplies periodization direction and key-session intent; it is not an instruction to jump back to an unabsorbed volume.

For an ordinary load week, use these starting bands and then apply recovery/injury evidence:

| Evidence | Target versus actual anchor |
| --- | --- |
| `load_ratio` 0.90-1.10 and stable recovery | maintain to +8% |
| `load_ratio` 1.10-1.25 or one unusually costly recent session | -5% to +3% |
| `load_ratio` >1.25, worsening recovery, active restriction, or repeated high-strain days | -10% to -20%; remove a quality stimulus |
| `load_ratio` <0.75 with stable recovery | rebuild by 5-10%, not an abrupt return to the master range |

Treat recovery as a veto, not an average. When recent raw RHR rises while HRV falls versus the preceding measured window, classify recovery as worsening even if the `load_ratio` row alone would allow maintenance. Select the most conservative applicable row: target 80-90% of the actual anchor and remove one formal quality stimulus. Use the upper half only when the change is small, the latest easy-run response is normal, and there is no injury, sleep, or high-strain warning. Preserve the phase-specific stimulus family inside the reduced dose; do not use milestone pressure or a master-plan volume range to raise the target.

Do not prescribe an ordinary-week increase above 10% from the larger of the latest complete week and the 2-3-week median. A stale master-plan lower bound never justifies a larger jump. When complete history is sparse, hold or reduce instead of inventing fitness.

For a week flagged `is_recovery_week`, first verify whether a deep cut is actually warranted. A recovery week is a tool to absorb load, not a standing instruction to cut volume. Decide the band from evidence before touching volume:

- **Deep cut is warranted (70-80% of the absorbed anchor, 0Q1L)**: the latest complete week executed at or above 90% of the anchor, or there is recent abnormal stress — an unusually costly session, repeated high-strain days, or worsening recovery (raw RHR rising while HRV falls versus the preceding measured window).
- **Maintain instead of cutting (85-95% of the anchor, 0Q1L or one light quality stimulus)**: the latest complete week was already materially under the anchor (below 90%) with stable recovery and `load_ratio` ≤ 1.0 and positive form. Stacking a second deep cut then slides into over-deloading (detraining); target the master plan's `target_weekly_km_low/high` range rather than applying another discount on top of it.
- **Moderate cut (80-90% of the anchor)**: the preceding complete week was materially under the anchor and `load_ratio < 0.90` with stable recovery — do not stack another deep cut.

The resulting target must never fall below the master plan recovery-week `target_weekly_km_low`. When the recovery week is upgraded to a maintenance week, allow one light quality stimulus (1Q1L) so the following build week does not jump more than 10% from this week's total. Taper and race weeks follow their phase reference.

Complete this step only after choosing one numeric weekly running-distance target and one load decision: increase, maintain, reduce, recovery, or taper.

## 3. Bridge the phase milestone

Read exactly one phase reference matching `training_position.phase`. Choose the most specific match first, so any phase containing `marathon` or `马拉松` uses the marathon reference even when its name also contains `build` or `建设`:

- base/aerobic/foundation/基础期 → `references/base.md`
- build/progression/threshold/提升期/进展期 → `references/build.md`
- speed/专项速度/专项速度周期/速度期 → `references/speed.md`
- marathon/马拉松专项/马拉松专项期 → `references/marathon.md`
- taper/赛前减量/赛前减量期 → `references/taper.md`
- recovery/赛后恢复/赛后恢复期 → `references/recovery.md`

Select the nearest upcoming milestone with `completed_actual: null` inside the current phase. If none is upcoming, use the latest unmet phase milestone as diagnostic evidence rather than blindly rescheduling it. Choose this week's key stimulus as a conservative bridge from the athlete's most recent completed stimulus toward the selected milestone. The bridge must be smaller than or equal to the milestone demand; do not rehearse the full milestone early. If no phase milestone is present, use the stage `key_sessions` and phase focus.

Phase specificity decides the stimulus family. For example, marathon-specific work uses marathon pace, threshold/cruise work, and specific long runs. Standalone hard 200 m or 400 m repetitions for maximal speed belong to a speed phase, not a marathon-specific phase; relaxed strides with full recovery remain neuromuscular maintenance rather than a quality session.

## 4. Rotate quality stimuli

Build a stimulus signature from the latest two weeks of actual quality sessions: energy system, work-repetition duration or distance, session shape, and whether the long run contained a quality segment. Avoid repeating the same signature in consecutive weeks. A recent `5×1 km` session, for example, should rotate to threshold time blocks, longer cruise repetitions, hills, or phase-appropriate race-pace work rather than another 1 km repetition session.

Use 1Q1L when load is high, recovery is uncertain, the prior long run was unusually costly, or the phase milestone can be served inside the long run. Use 2Q1L only when recovery is stable, recent load is controlled, and both quality sessions have distinct phase-specific purposes. A long run with a sustained MP/HMP/threshold segment counts as both L and one Q. Recovery weeks use 0Q1L; a recovery week upgraded to maintenance under Step 2 may use one light quality stimulus.

Separate quality stimuli by at least 48 hours. Place at least one explicit `kind: rest` day in every plan. Never schedule a quality session immediately after a costly long run.

Protect a key long run that contains MP/HMP/threshold work: normally make the preceding day rest or a short recovery run no longer than 10% of the weekly distance target. A 10-12% preceding run is acceptable only when recent consecutive-day history shows it is well tolerated. Exceed 12% only for an explicit back-to-back endurance milestone with established tolerance; otherwise move that easy volume earlier in the week. Do not create an accidental weekend load spike merely to reach the weekly total.

## 5. Build and audit the structured plan

Distribute easy running around the selected key sessions so the sum of every run session's `total_distance_m` matches the numeric weekly target. Prefer trimming easy filler before changing the milestone bridge. Keep the long run proportionate to the established long-run history; avoid creating a single-session load spike merely to hit a distance target.

Use running calibration for pace/HR targets. When calibration is missing or low-confidence, prescribe effort/HR conservatively and leave unsupported numeric targets open instead of estimating them. Respect every injury restriction.

The target week is exactly `plan_start` through six days later. Set top-level `week_name` exactly to the context `week_name`. Every session and nutrition date must be inside that week, and nutrition must cover all seven dates.

For catalogued strength exercises, set `canonical_id` and `provider_id` to the same verified COROS T-code. Verified mappings: squat `T1061`, single-leg deadlift `T1187`, side plank `T1185`, dead bug `T1243`, single-leg calf raise `T1275`, step-up `T1296`, goblet squat `T1301`, and dumbbell Romanian deadlift `T1305`. For other movements, use a stable descriptive `canonical_id` and `provider_id: null`.

Before returning, audit all of these conditions:

1. weekly distance equals the chosen actual-load target;
2. phase focus and nearest milestone are served by the key stimulus;
3. stimulus signature differs from the latest completed comparable quality session;
4. Q/L count, 48-hour separation, explicit rest day, and injury constraints pass;
5. the day before a quality long run passes the back-to-back exposure rule;
6. every workout block, session total, date, nutrition day, schema stamp, and strength ID is internally consistent.

In `coach_notes`, concisely record the actual complete-week anchor, chosen weekly target and load decision, phase/milestone bridge, rotation decision, and the recovery trigger that would reduce or cancel quality. For a recovery week, state which evidence justified a deep cut versus a maintenance band (latest complete week vs anchor, `load_ratio`, form, recovery trend).

## 6. Simulate the final candidate

Call `simulate_weekly_plan_load` with the complete candidate after its sessions, nutrition, and `coach_notes` are final. Use the report as the authoritative planned-dose and PMC projection; do not manually approximate dose, CTL, ATL, Form, or load ratio.

When `available: true`, inspect total dose, every daily load-ratio/Form transition, maximum session share, and `safety_issues`. Revise unsafe scheduling or dose, then simulate the complete revised candidate again. Treat `preexisting_overreach_persists_without_planned_load` as a recovery constraint rather than a candidate-plan error: choose the most conservative recovery schedule, document it in `coach_notes`, and do not add load that prolongs the overreach. When the only missing reason is unavailable athlete calibration or initial PMC state, preserve conservative targets and record that limitation in `coach_notes`. Any missing workout structure, uncomputable planned session, structured-distance mismatch, or safety issue requires a corrected candidate and another simulation.

Complete this step only when the candidate has been simulated after its last edit. The returned `content` must be byte-for-byte the same logical WeeklyPlan object passed to the final simulation call.

## 7. Return the WeeklyPlan

Return `{ "disposition": "return_direct", "content": WeeklyPlan }`. Do not return Markdown. Use Chinese for athlete-facing text and English/ASCII for field names and enum values.
