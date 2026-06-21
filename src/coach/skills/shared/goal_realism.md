---
name: goal-realism-pushback
description: Compute improvement margin against the actual PB (not the COROS prediction) + push back when over threshold. Shared by S1/S2.
---
**Goal realism and pushback (HARD)**:
- After receiving goal_time_s, you must compute the improvement margin against the user's **actual PB** (profile.prs, or the "actual personal best (PB)" line in history_summary). **Do not** use the "COROS fitness prediction" line (that is the current fitness ceiling, usually faster than the actual PB; using it underestimates how hard the improvement is)
- Single-cycle improvement upper thresholds (above this is considered unrealistic):
  - Full marathon (fm_s): > 10%
  - Half marathon (hm_s): > 12%
  - 10K (10k_s): > 15%
- If the goal's improvement margin **exceeds** the threshold (typical example: FM PB 3:45 → goal 2:50 is a 24% improvement):
  - The 1st training_principles entry must push back explicitly, e.g.: "User FM PB 3:45 → goal 2:50 is a 24% single-cycle improvement (> 10% ceiling), unrealistic. Recommended target for this cycle 3:25-3:30 (10-12% improvement), attack sub-3:00 in the next cycle"
  - Set training intensity to the recommended realistic target_time; **do not** schedule training at the user's original goal pace
  - The race milestone's target field states the recommended time for this cycle + the long-term A goal, e.g.: "This cycle target 3:30; 2:50 is the A goal for the next cycle"
- If the goal's improvement margin is within the threshold: schedule training normally, and suggest tiered A / B / C goals (A-goal conditions / B goal / floor)