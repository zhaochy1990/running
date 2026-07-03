---
name: goal-realism-pushback
description: Compute improvement margin against the actual PB (not the COROS prediction) + push back when over threshold. Shared by S1/S2.
---
**Goal realism and pushback (HARD)**:
- Compute improvement margin vs user's **actual PB** (profile.prs or the "actual personal best (PB)" line in history_summary). **Do not** use "COROS fitness prediction"; it is a current fitness ceiling and often underestimates goal difficulty.
- Examples: FM 3:17 -> 3:10 is about 3.6%, not 1.8%; 3:35 -> 3:30 is about 2.3%.
- Single-cycle improvement upper thresholds (above this is considered unrealistic):
  - Full marathon (fm_s): > 10%
  - Half marathon (hm_s): > 12%
  - 10K (10k_s): > 15%
- If the goal's improvement margin **exceeds the threshold by a large margin** (typical example: FM PB 3:45 → goal 2:50 is a 24% improvement):
  - The 1st training_principles entry must push back explicitly, e.g.: "User FM PB 3:45 → goal 2:50 is a 24% single-cycle improvement (> 10% ceiling), unrealistic. This cycle 3:25-3:30; attack sub-3:00 next cycle"
  - Set training intensity to the recommended realistic target_time; **do not** schedule training at the user's original goal pace
  - The race milestone's target field states the recommended time for this cycle + the long-term A goal, e.g.: "This cycle target 3:30; 2:50 is the A goal for the next cycle"
  - Low-volume severe FM mismatch guard: if `peak_weekly_km_in_window` is around 38km and goal asks ~24% FM improvement, cap this cycle near `40-44km`, use a `22-24km` maximum long run (not 28km), MP `6-10km`, and make sub-3/sub-2:50 is multi-cycle. Do **not** chase generic FM `28km` floor or sub-3 `32km` advisory.
- If the goal is **borderline-aggressive but not impossible** (roughly 10-15% FM improvement for an advanced runner with strong consistency):
  - Do not silently accept it and do not fully reject it. Keep the requested time as gated A, train day-to-day pacing by a safer B goal, and state strict gates in training_principles[0] and the race milestone.
  - Use conservative A/B/C stratification: A=requested time only if gates pass; B=realistic single-cycle target; C=PB/no-regression finish. Do **not** set C to another aggressive threshold such as sub-3 when PB is 3:10.
  - A gates must be strict, not rounded easier: for PB 3:10 → FM 2:45, use HM <=1:18:00 or 10K <=36:00 plus the largest legal MP rehearsal with normal HR/RPE. Do not loosen this to HM 1:18:30 or slower.
  - Add a mid-cycle `test_run` A-gate milestone with the strict HM<=1:18:00 or 10K<=36:00 target; an easier 10K/HM tune-up can be observation only, not the sole A validator.
  - Example: "PB 3:10 → 2:45 is ~13% (>10%); A=2:45 only if mid-cycle HM<=1:18:00 or 10K<=36:00 plus 30-32km MP rehearsal with normal HR/RPE; train by B=2:50 pace; C=PB/no-regression finish."
  - The goal-realism cap overrides generic sub-3 volume templates. If `training_history_summary.peak_weekly_km_in_window` is known, peak high <= smaller of `historical_peak * 1.10 + 2km` and `historical_peak + 7km`; for 75km peak this means `<=80-82km` by default, not `84-85km` or `92km`. Use legal load-high steps (after 64km, next load max 70/71; not 72). If that cap cannot support a 30-32km rehearsal under long-run-share, use 28-29km max, train by B pace, and make A conditional on stricter tune-up gates instead of chasing `32/92`.
- If HM goal is aggressive but inside HM threshold (roughly 8-12% faster than HM PB, e.g. HM 1:27:42 → 1:20): state margin, keep A gated. A 10K tune-up around `<=39:00` is only a B/observation gate; use `10K<=37:00` as A-opening gate, while `10K<=37:45` is only an observation/B+ gate. Still require 20-22km long run with 12-16km HMP plus normal HR/RPE.
- If the goal's improvement margin is within the threshold: schedule training normally, and suggest tiered A / B / C goals (A-goal conditions / B goal / floor)
