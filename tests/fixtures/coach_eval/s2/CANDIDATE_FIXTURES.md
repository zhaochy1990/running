# S2 Weekly Plan Eval Candidate Fixtures

These candidate scenarios are for weekly-plan generation evaluation. The JSON
fixtures in this folder are seed candidates, not a final frozen baseline yet.

| Fixture | Tags | What It Should Prove |
|---|---|---|
| s2-hrv-drop-user-pushback | recovery_signal, user_pushback, build | HRV down / RHR up / sleep poor while user asks to keep 60 km and quality. A good plan caps hard sessions, preserves aerobic continuity, and explains the trade-off. |
| s2-base-to-build-transition | phase_transition, build, progression | First build week after base. A good plan adds one controlled quality stimulus without a jump in weekly volume or long-run share. |
| s2-travel-three-day-limit | edge_case, frequency_limit, travel | Only three trainable days. A good plan keeps load distributed across limited days, avoids stacking two hard workouts, and does not cram a normal six-day week into three days. |
| s2-achilles-niggle-peak-week | injury_constraint, peak, target_distance | Peak-specific week with Achilles or calf warning. A good plan keeps race specificity but avoids plyos and jumps, uses calf-safe strength, and includes monitoring triggers. |
| s2-race-recovery-week | recovery_signal, recovery, post_race | Week after a race or hard tune-up. A good plan reduces load, prioritizes sleep/carbs/protein, and avoids threshold or VO2. |
| s2-taper-anxiety-add-volume | taper, user_pushback, unrealistic_goal | Taper week where user wants extra mileage. A good plan refuses late load, keeps short activation, and explains freshness. |
| s2-data-gap-no-feedback | data_gap, base, safety | Missing feedback and incomplete recent signals. A good plan is conservative, avoids overfitting, and asks for monitoring notes in plan text. |
| s2-missed-two-runs-dont-make-up | progression, feedback_response, edge_case | Prior week missed two runs. A good plan does not make up mileage with a spike, but resumes planned progression. |
| s2-peak-long-run-specificity-hm | target_distance, peak, nutrition | HM peak week. A good plan has HM-specific work and long-run sizing, not FM-style 30 km volume. |
| s2-low-sleep-strength-shift | recovery_signal, strength_integration | Sleep poor but running signals okay. A good plan moves heavy strength away from quality/long-run days and keeps strength light. |
| s2-hot-weather-load-adjust | edge_case, environment, signal_response | Heat wave or high humidity. A good plan uses HR/RPE caps and shifts hard work to cooler times or effort targets. |
| s2-real-zhaochaoyi-canary | real_user, canary, multi_signal | Frozen real week from zhaochaoyi logs. A good plan should feel executable to the actual athlete, serving as human spot-check anchor. |

Suggested first baseline set: start with the first 6, then add data_gap,
missed-two-runs, target_distance, and the real-user canary after L2 judge
calibration is stable.
