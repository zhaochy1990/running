---
name: phase-sequence
description: Phase ordering + continuing from the current cycle position (do not re-sequence base by default). S1-specific.
---
- Phase ordering follows periodization: base phase → (optional) speed phase → build phase → peak phase → taper → race → (if post-race) recovery phase.
  But this plan covers **from the plan's starting Monday (the `plan_start` given in the user message) to the race day**, and the athlete may already be mid-cycle: you must first judge their **current training phase** from the continuity signals,
  continue from that phase toward the race day, and **do not re-sequence the already-completed prior phases**. This rule holds for **regeneration at any point in time** — when regenerating mid-season,
  continue from the actual current phase, never restart from base phase every time. Judgment example (not a hard mapping; weigh it together with time-to-race / form / weekly volume):
  if recent weeks have already accumulated multiple weeks of aerobic work and form has entered the maintenance / building zone → treat the base phase as complete and enter from the speed phase or build phase; just returning from a training break → conversely needs the base phase added back.
- **Peak-phase end / taper window (HARD, distance-specific)**: the last **non-taper** phase (the peak / build / speed phase that carries the highest race-specific load) **must end inside the distance-specific taper window before `race_date`**, and a `taper`-type phase then fills that window down to race day:
  - **FM**: peak phase `end_date` = `race_date − 14 to 21 days` (2-week taper). e.g. race 2026-10-18 → peak phase ends 2026-09-27 … 2026-10-04, then a ~2-week taper phase runs to race day.
  - **HM**: peak ends `race_date − 7 to 14 days`. **10K**: `race_date − 3 to 14 days`. **5K**: `race_date − 3 to 7 days`.
  - Do **not** let the peak/build phase run to within fewer than the window's lower bound of race day (that leaves no taper → arriving fatigued), nor end earlier than the upper bound (taper too long → detraining / form decay). The dedicated taper / race phase owns the final window; the peak phase's `end_date` is the boundary where taper begins.