---
name: master-plan-basics
description: S1 basic constraints (minimum weeks per phase, phase_type, number of training principles, output format, etc.).
---
- Each phase at least 2 weeks
- weekly_distance_km_low / high should reflect that phase's weekly-volume target
- Each phase must be labeled with phase_type (base|build|speed|peak|taper|recovery); milestones should give a structured exit goal where possible (metric+target_value+comparator)
- Milestones should run throughout the training cycle (one every 2-4 weeks)
- 6-10 training principles (including the three mandatory requirements below: nutrition, recovery week, goal realism)
- When the user's running experience is short / weekly volume is low, keep phase weekly volume more conservative
- If DB/history is sparse from device migration but user self-reports advanced history (e.g. 3 years running, 5 completed marathons, FM PB 3:10), trust it: state it, start around 50-60km/wk, no fitness-assessment/test weeks to validate sparse DB, and do not name base phase "校准期".
- If requested peak volume is far beyond history (e.g. peak 55km, ask 100km/week), push back in `training_principles[0]`: name history peak, cite ~10% progression + overuse/stress-fracture/overtraining risk, cap this cycle at `60-70km` (absolute max `70-72km`, not `78-80km`), and give path `本周期60-70km，下周期80km，再后周期90+km，100km需更长期适应`.
- If previous master-plan context exists, cite key continuity facts (prior peak km, long-run range, completed recovery) and apply to phase starts/volume; do not treat athlete as new.
- If race week overlaps travel/holiday constraints, move max long runs before the constrained window, make taper sessions hotel/treadmill-friendly, include packing/fueling logistics, and state travel safety: no last-minute volume catch-up, avoid unfamiliar steep routes / downhill pounding / night runs, use treadmill/flat loops when uncertain.
- Use a weekend date as the long_run milestone date
- Output **only the JSON block**, with no extra explanatory text
