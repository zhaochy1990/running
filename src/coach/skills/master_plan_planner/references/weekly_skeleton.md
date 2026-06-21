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
- **Goal-pace specificity inside the long run (HARD, fm/hm goals)**: an all-easy long run does not build race-specific endurance — embedded goal-pace volume under accumulated fatigue is what converts speed into a finish and pushes the late-race fade point out. So for fm/hm goals the build and peak phases must program **progressive goal-pace volume embedded in the long run**, not merely as separate short race_pace sessions:
  - The goal-pace block run inside / paired with the weekly long run must **escalate week-over-week** through build→peak. By the peak phase target an fm goal-pace (marathon-pace) block of **~22-25km at goal pace inside a 30-34km long run** (hm: ~12-16km at goal pace inside an 18-24km long run).
  - Represent each such week with BOTH a `long_run` (distance_km = total) and a `race_pace` key session (distance_km = the goal-pace volume) in that week — a peak-phase long run that is pure easy with **no** goal-pace block is not allowed for fm/hm.
  - When the fm goal time is **sub-3:00**, the longest peak-phase `long_run.distance_km` must reach **≥ 32km** (this overrides the ≥28km floor above), to rehearse goal pace past the 30km fade point.