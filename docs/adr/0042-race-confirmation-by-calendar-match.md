# Race confirmation by calendar match, with recalibrated scoring

Status: accepted

Extends [ADR 0029](0029-independent-race-history-detection.md) (independent
race-history detection), which stands unchanged in its architecture; this
decision adds a deterministic confirmation path in front of the model and
recalibrates the weights ADR 0029 introduced.

## Context

A full audit of production `races` on 2026-09-28 (274 rows, every user,
race-by-race against public race calendars, cross-user same-day corroboration
and GPS start-point locations) found roughly 40 confirmed false positives —
about 15% — with a single dominant profile: habitual long runs at exactly
21.1 km or 42.2 km from a fixed home-route start, in non-gun-time windows,
at heart rates well below race effort. The scoring pipeline ADR 0029 defined
confirmed them because its threshold (20) let one weak positive dimension
(a big-city loop `route_shape` +20, or `travel` +25 for any out-of-town start)
cross the line on its own whenever the model answered 信息不足 for a generic
`<城市> 跑步` name — which its own prompt instructs it to do.

At the same time the system already holds a real race calendar: `race_calendar`
(2,552 events, 2,228 from 中国田协) and `race_calendar_item` with `type`,
`race_date`, `start_time` and a `start_point` that ADR 0039's content work
populates with venue names. The missing piece is coordinates: today only a
handful of items carry a venue name and none carry lat/lng.

## Decision

**A deterministic calendar matcher runs before the model.** For each
candidate, when any same-date calendar item of the matching distance band has
start coordinates within 1.5 km of the activity's cached start GPS fix, and
the activity's local start falls within [gun −15 min, gun +120 min] (rear
corrals cross the arch up to an hour-plus after the elite gun), the activity
IS that race: it is confirmed without any model call, and the races row
records the link (`race_calendar_item_id`) plus `evidence='calendar_match'`.
When no gun time is published the matcher accepts only 05:30–11:30 starts —
morning road-race windows — and anything else falls through to scoring.
Spatial verification is mandatory: items or candidates without usable
coordinates never match, so the matcher cannot confirm a same-city training
run that merely shares a date.

**Start-point coordinates are crowd-sourced from the users' own watches.**
Each calendar-matched race contributes its activity-level start fix; once at
least 3 distinct users' starts on one item agree within 300 m, the centroid is
written back into that item's `start_point` (preserving the venue name). An
optional Amap (高德) geocoder fills coordinates from venue names as item
content is written through the admin API — Amap's GCJ-02 output is converted
to WGS84 before storage, since activity GPS and `RacePoint` are WGS84. An
empty `amap.api-key` disables geocoding without breaking anything.

**Existing races are rematched, not rescored.** The backfill job additionally
tries to link already-confirmed races that carry no calendar mapping; it never
deletes a previously confirmed row. Confirmed false positives are removed by
an explicit, human-approved cleanup (see
`docs/race-detection-fp-cleanup-2026-09-28.md`), not by automatic re-runs.

**Scoring is recalibrated for the cases the matcher cannot reach** (training
runs, time trials, unlisted races):

- The threshold rises 20 → 40: no single dimension can confirm a race alone;
  the model's event intent (+35) by itself no longer crosses.
- A new Go dimension `hr_intensity` (±20) scores avg/max heart rate
  (≥0.90 race, ≤0.86 training): the strongest single discriminator in the
  production audit, previously invisible to Go because only the model saw HR
  without any baseline context.
- Weak positives are demoted: `route_shape` +20 → +10 (a big-city loop is a
  normal training route), `travel` +25 → +10 (out-of-town is true of every
  vacation hike that fooled the old scorer), marathon `distance_prior`
  +25 → +15 (full-distance training runs exist). Their training-side weights
  are unchanged.

An explicit personal time trial (model intent + intensity both race) now
needs physiological corroboration to clear the threshold — every verified
time trial in the audit carried HR ratio ≥0.90, so this costs nothing real
and closes the E60-shaped hole where a model-only confirmation passed.

## Consequences

- Calendar-matched races cost zero model tokens and come with a factual,
  auditable reason (item id, start distance, gun offset) instead of a model
  opinion.
- The matcher's coverage starts near zero (few geo-enriched items) and grows
  as the Amap key is configured and as users race: every three matching users
  pin one more venue. Coverage is therefore expected to lead the scoring
  path on prestigious races (enriched first) and lag on small ones.
- Timezone handling stays as ADR 0029 left it: activity timestamps are UTC,
  wall-clock comparisons run on Asia/Shanghai local components, and the audit
  verified recorded starts matching official gun times to the minute.
- The rematch pass makes the one-time backfill job idempotent and worth
  re-running after geo-enrichment lands; it is still one job per user.

## Rejected options

- **Match on city + date + distance without coordinates.** Rejected: in a
  city hosting a race every weekend, a habitual same-distance long run on
  race morning would match by construction — the exact false positive this
  decision exists to remove.
- **Auto-delete previously confirmed races that no longer pass scoring.**
  Rejected: silent deletion of user-visible history is not the system's call;
  the cleanup list is human-approved per row.
- **Raising only the threshold, without the HR dimension.** Rejected: it
  would also reject the audit's low-effort true positives (paced marathons at
  HR ratio 0.83–0.87 with a named race), which the HR dimension cannot save
  but the calendar matcher now confirms outright.
