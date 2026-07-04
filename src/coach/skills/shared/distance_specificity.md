---
name: distance-specificity
description: Distance-specific structure, volume, long runs, taper.
---

**Distance specificity (HARD Rule)**:
- Adjust phase length, peak volume, long_run distance, and key-session mix to `target_race.distance`; **do not** apply an FM template to HM/10K/5K, or vice versa.
- Derive peak high from actual history + race distance: use historical max as a ceiling reference, recent average as the start, and weekly ramp <=10%. Historical FM volume is not a target for shorter races; keep aerobic support but shift surplus capacity to speed/threshold freshness.
- Advanced profile guardrails (history peak ~75-80km, weekly_run_days_max 6):
  - **5K**: 40-55km; default to <=55km for a normal sub-18 5K block; 60km+ only if explicitly high-volume 5K. Taper 3-5 days.
  - **10K**: 50-60km; normal sub-40/sub-39:30 defaults <=60km, not 62-64; 64km+ only if explicitly high-volume.
  - **HM (half marathon)**: 60-70km; for a normal sub-1:20 HM block, default to `68-70km` (not 72km) and avoid 71-75km unless user asks for HM with FM-like volume. Taper about 1 week.
  - **FM (full marathon)**: advanced sub-3 or aggressive PB goals may reach 75-85km when history/ramp allow; with 16+ weeks do not compress base below 4 weeks.
- Long_run + emphasis by distance, progressing only +1-3km at a time from recent longest run:
  - **FM (full marathon)**: long_run ~28-35km; emphasize MP long runs + tempo; peak phase 3-4 weeks.
  - **HM (half marathon)**: long_run ~18-22km (max 25km); threshold + HMP; peak 2-3 weeks.
  - **10K**: long_run 14-16km; 17-18km only for explicit high-volume 10K; interval/vo2max/threshold dominate; peak 1-2 weeks. Do not create a 4-week 10K peak phase.
  - **5K**: long_run ~8-12km (max 14km); vo2max/short intervals/speed dominate; peak 1-2 weeks. Do not create a 4-week 5K peak; put spare runway in speed/build.
- Taper length is distance-specific: FM 14-21 days; HM ~7 days; 10K 3-7; 5K 3-5. Do not use a 2-week FM taper for HM/10K/5K.
- 5K nutrition/taper specificity: no marathon-style carb-loading (8-10g/kg/day for 3 days); use familiar meals, modest carbs, and final 3-5 days fresh.
- Reflect derived volume/long_run in `weeks[].target_weekly_km_high` and `key_sessions[].distance_km`.
