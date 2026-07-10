---
name: distance-specificity
description: Distance-specific structure, volume, long runs, taper.
---

**Distance specificity (HARD Rule)**:
- Adjust phase length, peak volume, long_run distance, and key-session mix to `target_race.distance`; **do not** apply an FM template to HM/10K/5K, or vice versa.
- Derive peak high from the `Training-load estimator tool` anchor + race distance: recent active-week km/dose is the start/reference, historical peak is only an upper-risk reference, and weekly ramp <=10%. Do not use fixed race-distance volume caps; a high-history HM/FM/10K/5K runner may need volume above ordinary templates, while a low-history runner may need less.
- Distance changes allocation, not an absolute cap: shorter races shift surplus capacity toward threshold/VO2/speed freshness; HM/FM preserve enough aerobic load to match the athlete's actual history unless injury/recovery/frequency constraints say otherwise.
- Long_run + emphasis by distance, progressing only +1-3km at a time from recent longest run:
  - **FM (full marathon)**: long_run ~28-35km; emphasize MP long runs + tempo; peak phase 3-4 weeks.
  - **HM (half marathon)**: long_run ~18-22km (max 25km); threshold + HMP; peak 2-3 weeks.
  - **10K**: long_run 14-16km; 17-18km only for explicit high-volume 10K; interval/vo2max/threshold dominate; peak 1-2 weeks. Do not create a 4-week 10K peak phase.
  - **5K**: long_run ~8-12km (max 14km); vo2max/short intervals/speed dominate; peak 1-2 weeks. Do not create a 4-week 5K peak; put spare runway in speed/build.
- Taper length is distance-specific: FM 14-21 days; HM ~7 days; 10K 3-7; 5K 3-5. Do not use a 2-week FM taper for HM/10K/5K.
- 5K nutrition/taper specificity: no marathon-style carb-loading (8-10g/kg/day for 3 days); use familiar meals, modest carbs, and final 3-5 days fresh.
- Reflect derived volume/long_run in `weeks[].target_weekly_km_high` and `key_sessions[].distance_km`.
