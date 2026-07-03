---
name: phase-sequence
description: Compact S1 phase order, current-position continuation, and taper windows.
---
- Phase order: base → optional speed → build → peak → taper → race → optional recovery. The plan covers the given `plan_start` Monday through race day and may start mid-cycle: infer the current phase from continuity signals, continue forward, and **do not re-sequence completed prior phases** or restart base on regeneration. Multiple recent aerobic weeks + maintenance/building form means base is likely complete; post-break/low continuity needs rebuild/base.
- **Peak-phase end / taper window (HARD, distance-specific)**: the last **non-taper** phase carrying the highest race-specific load must end inside the distance-specific taper window before `race_date`; a `taper` phase fills the window down to race day:
  - **FM**: default peak phase `end_date` is about `race_date − 14 days` for a ~2-week taper. `race_date − 21 days` is the outer safety bound, not the default; use it only for extra freshness/travel/injury flare/unusually heavy peak. Healthy advanced/sub-3 + “peak phase 在 race 前约 2 周结束” chooses the 14-day boundary, not 3 weeks. Example: race 2026-10-18 → prefer peak end 2026-10-04; 2026-09-27 needs an explicit extra-taper reason.
  - **HM**: peak ends `race_date − 7 to 10 days`; use ~1-week taper, not FM 2 weeks. **10K**: `race_date − 3 to 7 days`. **5K**: `race_date − 3 to 5 days`.
  - Do not let peak/build run closer than the lower bound (no taper → fatigue), nor end earlier than the upper bound (too long → detraining). The taper/race phase owns the final window.
- **5K**: Sunday race week may be `taper` only if `focus` says final taper is 3-5 days; never start taper the previous Monday (14d). Peak/sharpening is 1-2 weeks, not 4.
- **HM**: peak 2-3 load/sharpening weeks; don't label 4w HM `peak` just because it contains tune-up/recovery. Keep those in build or split short HM peak before 1w taper.
- **10K**: final peak is normally 1-2 load weeks ending 3-7 days before race week. Do not label a 4-week block as `peak` just because it contains recovery; put recovery at build end or inside short taper/race-sharpening so season_structure stays 10K-specific.
- Full-runway FM (>=16w, intermediate/advanced): real base normally >=4w. If race data is stale or pace unclear, base/calibration >=7 natural weeks before speed/build; never split after exactly 6.
- Injury return: recent knee/patellar/Achilles injury, PT rehab, stop-training, or return-to-run requires an explicit 2-4 week `rebuild`/复跑重建 micro-phase (`phase_type":"base`) before longer base/build; do not hide it in a generic base.
