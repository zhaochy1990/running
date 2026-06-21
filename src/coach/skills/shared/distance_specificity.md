---
name: distance-specificity
description: Adjust training structure by target race distance (long_run / key_session emphasis / peak phase weeks). Peak weekly volume is derived from the user's actual data, never hard-coded.
---

**Distance specificity (HARD Rule)**:
- The training structure (peak phase weeks, long_run distance, key_session types and the interval / MP ratio) must all be adjusted to target_race.distance. **Do not** apply an FM-style plan to HM / 10K / 5K, or vice versa.
- **Peak weekly volume must never be hard-coded; it must be derived from the user's actual data** (the data is already in the "History training summary" above + the continuity signals):
  - Use "the largest historical single-week mileage" as a safe upper-bound reference and "recent weekly average" as the starting point, ramping ≤ 10% per week toward peak;
  - Align with the dose heuristics in [Training-load distribution] (weekly dose ≈ chronic × 7 to maintain / × 7.7+ to push into the building zone);
  - **Use no fixed km range** — even for the same FM target, a 40 km/week runner and a 100 km/week runner have vastly different peak volumes; a fixed range will inevitably overload some and under-train others.
- Per-distance **long_run targets** and **key_session emphasis** (push long_run toward the race-specific requirement, but only +1-3km each time, **not exceeding a reasonable ramp from the user's recent longest run**):
  - **FM (full marathon)**: push long_run to ~28-35km (specific-endurance requirement); in the race-specific phase emphasize marathon-pace long runs + tempo; peak phase 3-4 weeks
  - **HM (half marathon)**: long_run ~18-22km (no more than 25km); emphasize threshold + some MP; peak phase 2-3 weeks
  - **10K**: long_run ~14-16km (no more than 18km); key_sessions emphasize interval / vo2max / threshold (far more than long_run / race_pace); peak phase 1-2 weeks
  - **5K**: long_run ~8-12km (no more than 14km); key_sessions emphasize vo2max / short intervals (200m-1k repeats) + speed; peak phase 1-2 weeks
- For taper length see the "taper length is set by overall training-cycle length" rule in [Weekly key-session skeleton]; **do not hard-code it here**.
- Reflect the derived weekly volume and long_run into `weeks[].target_weekly_km_high` / `key_sessions[].distance_km`.