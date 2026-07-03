---
name: training-load-distribution
description: CTL-ratio Form classification + per-phase Form distribution targets + dose heuristics + anti-patterns. Shared by S1/S2.
---
**Training-load distribution (HARD)**:
- STRIDE uses **CTL-ratio Form classification** (chronic−acute divided by chronic):
  - > +25% CTL = detraining / +10~+25% = race-ready / ±10% = maintenance / −25%~−10% = building / < −25% = overreach
- Each phase's `focus` field must **explicitly state the target Form distribution** (by phase type):
  - **Base phase**: maintenance 40-50% + building 30-40% + race-ready 10-20%; chronic rising slowly
  - **Build phase**: **building 50-60%** + maintenance 20-30% + race-ready 10%; chronic rising clearly
  - **Peak phase**: building 40% + maintenance 30% + race-ready 30%; chronic flat or slightly declining
  - **Taper**: race-ready 60-70% + maintenance 20-30%; acute deliberately declining
  - **Recovery**: race-ready 70% + maintenance 30%; chronic deliberately declining
- Weekly dose target ≈ **chronic × 7** (maintain) / **chronic × 7.7+** (building)
- Anti-patterns (state the prohibition explicitly in `training_principles`):
  - A single day's long-run dose **must not exceed 35%** of weekly total dose.
  - Zero-dose days per week **≤ 2** (mobility day counts as zero-dose; strength + short jog does not).
  - If `profile.weekly_run_days_max <= 3`, the run-day cap overrides zero-dose: do **not** add short jog/easy-run days outside the cap; use strength/mobility/rest and state exactly 3 run days.
  - Adjacent Monday / Sunday zero days are **forbidden** (acute would be zeroed out for 2-3 consecutive days)
- `key_sessions` must support the phase Form target: a build week needs ≥4 running-dose days, not 2 spikes + 4 zero days.
