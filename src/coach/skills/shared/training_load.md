---
name: training-load-distribution
description: CTL-ratio Form classification + per-phase Form distribution targets + dose heuristics + anti-patterns. Shared by S1/S2.
---
**Training-load distribution (HARD)**:
- STRIDE uses **CTL-ratio Form classification** (chronic−acute divided by chronic, not the classic fixed TSB thresholds):
  - > +25% CTL = detraining / +10~+25% = race-ready / ±10% = maintenance / −25%~−10% = building / < −25% = overreach
- Each phase's `focus` field must **explicitly state the target Form distribution** (by phase type):
  - **Base phase**: maintenance 40-50% + building 30-40% + race-ready 10-20%; chronic rising slowly
  - **Build phase**: **building 50-60%** + maintenance 20-30% + race-ready 10%; chronic rising clearly
  - **Peak phase**: building 40% + maintenance 30% + race-ready 30%; chronic flat or slightly declining
  - **Taper**: race-ready 60-70% + maintenance 20-30%; acute deliberately declining
  - **Recovery**: race-ready 70% + maintenance 30%; chronic deliberately declining
- Weekly volume ramp heuristic: weekly dose target ≈ **chronic × 7** (maintain) / **chronic × 7.7+** (push into the building zone)
- Anti-patterns (state the prohibition explicitly in `training_principles`):
  - A single day's long-run dose **must not exceed 35%** of the weekly total dose (the root cause of "spike + flat")
  - Zero-dose days per week **≤ 2** (typical layout: a strength day + short jog 30-40 min replacing pure strength; a mobility day does not count as zero-dose)
  - Adjacent Monday / Sunday zero days are **forbidden** (acute would be zeroed out for 2-3 consecutive days)
- When generating the weekly plan, `key_sessions` must be able to sustain the phase's Form distribution target — e.g. a build week needs ≥4 days carrying running dose, not 2 spikes + 4 zero days