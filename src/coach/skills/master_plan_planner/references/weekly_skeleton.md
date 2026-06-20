---
name: weekly-key-session-skeleton
description: Per-week key-session skeleton rules for the S1 master plan (including the long-vs-short-cycle taper rule).
---
**Weekly key-session skeleton (HARD)**:
- `weeks` must list **every week** between plan.start_date and plan.end_date, **week by week** (week_index incrementing sequentially from 1, week_start written as that week's Monday in ISO date)
- Each entry links to the corresponding phase's `phase_name` and states that week's `target_weekly_km_low` / `target_weekly_km_high` (which should fall within that phase's weekly-volume range; a recovery week takes 70-80% of the phase lower bound)
- `key_sessions[]` lists **only** the key sessions that drive training adaptation or load (long_run / threshold / tempo / interval / vo2max / hill / race_pace / time_trial / tune_up_race / race / strength_key); ordinary easy / aerobic / recovery / commute runs **must not** be listed
- Every non-recovery / non-taper week must have **1-3** key sessions; a race week may list only a single `race` type; a recovery week is allowed 0-1
- Distance-anchored sessions (long_run / race_pace / tune_up_race / race) write `distance_km`; time-anchored sessions (threshold / interval / tempo) write `duration_min`
- Within one week, high-load sessions like threshold / tempo / interval / vo2max / hill / race_pace **must not exceed 2**
- When `profile.weekly_run_days_max <= 3`, key sessions per week **must not exceed 2**; otherwise no more than 3
- **Taper length is set by overall training-cycle length (HARD)**: long cycles (plan total weeks ≥ 12) use a **2-week** taper; short cycles / cup races (plan total weeks < 12) **taper only the race week** (1 week). For those weeks set `is_taper_week=true`, and `target_weekly_km_high` drops ≥ 25% relative to the peak week. (When this conflicts with the per-distance taper length above, this "cycle length" rule takes precedence)
- For a recovery week every 4 weeks set `is_recovery_week=true`, with the corresponding `target_weekly_km_*` taking 70-80% of the phase lower bound
- The longest `long_run.distance_km` in the peak phase must match the target race distance: fm ≥ 28km, hm ≥ 18km, 10k ≥ 10km, 5k ≥ 6km