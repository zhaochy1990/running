# Capture watch-native zones in a dedicated `activity_watch_zones` table

The Python pipeline deliberately **drops** COROS's per-activity `zoneList`
(watch-reported zone buckets) because it depends on watch config and its
encoding churns (COROS silently moved the pace group's `zoneType` 1→0); the
SQLite `zones` table is instead filled post-sync with **calibrated** time-in-zone
from STRIDE's own model. We are choosing to **keep** the watch-native zones as
well, in a separate greenfield MySQL table `activity_watch_zones`, storing the
**raw `zoneType` integer** alongside the decoded value so encoding drift is
observable rather than silent.

## Consequences

- Watch zones and calibrated zones are distinct concepts and never collide: a
  future Python/Go post-sync can still populate calibrated `zones` independently.
- `activity_watch_zones` is **Go-only** (no SQLite counterpart), so it is
  **excluded from the row-for-row reconcile** and validated by self-consistency
  instead (percentages ≈ 100%, zone durations ≈ moving time).
- This is a deliberate deviation from the Python behaviour — do not "fix" it by
  dropping `zoneList` to match Python.
