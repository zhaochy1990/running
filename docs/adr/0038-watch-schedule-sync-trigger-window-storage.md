# Watch schedule sync: trigger, pull window, storage, and the COROS pull adapter

Status: accepted

> Implements zhaochy1990/stride-devops#327. ADR 0036 fixed the canonical
> `watch-schedule/v1` envelope and ADR 0037 the intensity dimensions; this ADR
> lands the sync mechanics those two deliberately deferred.

## Context

Athletes author training calendars on COROS and Garmin. ADR 0036 made the pulled
content a separate, one-way domain (watch → STRIDE, never merged into
`weekly_plan`/`master_plan`) with a provider-agnostic `watch-schedule/v1`
envelope whose sessions carry `(provider, entity_id)` source ids for idempotency.
What remained open: *when* a pull runs, *which* dates it covers, *where* the
envelope lands in MySQL, and how the two platform adapters produce it.

## Decisions

1. **Trigger reuses the existing sync axis and credentials.** `SyncContent` gains
   a `ContentSchedule` bit; `ContentAll` becomes `activities | health |
   schedule`. `POST /api/{user}/sync` already threads `{mode, content, limit}`
   into the `watch_sync` job, so no new endpoint or credential plumbing is
   needed. The `watch_sync` handler pulls the schedule only when the bit is set,
   through the same provider resolution and `IsLoggedIn` guard as activities and
   health.

2. **Pull window is Shanghai-today −7 → +90 days.** `provider.SchedulePullWindow()`
   computes `[today−7, today+90]` in ISO `YYYY-MM-DD` from `timefmt.ShanghaiToday()`,
   balancing COROS/Garmin request quotas against practical usefulness. The window
   bounds are recorded in the envelope's `fetch` metadata.

3. **Storage is one row per schedule session.** New table `watch_schedule`
   (owned by Go `AutoMigrate`, ADR 0006) with the idempotency key
   `(user_id, provider, entity_id)` as a unique index. Each row stores the date,
   kind, name, the full `run-workout/v1` spec JSON, and fetch metadata
   (`fetched_at`, `window_from`, `window_to`). Sync upserts by that key
   (`clause.OnConflict`), so re-pulling the same watch session updates rather than
   duplicates it. v1 is upsert-only: a session deleted on the watch is not yet
   tombstoned here (follow-up).

4. **Skipped content is surfaced in sync metadata.** `provider.SyncResult` gains
   `ScheduleSessions`, `ScheduleSkippedStrength`, `ScheduleSkippedStride`
   (`[STRIDE]` self-loop, ADR 0036) and `ScheduleSkippedInvalid` (a running
   program that failed to decode). The puller drops strength sessions and
   `[STRIDE]`-named sessions before validation and counts them; the `watch_sync`
   handler returns the counts in its result JSON.

5. **The pull contract is `provider.PullWatchSchedule`.** A new capability-gated
   method (reusing `CapQuerySchedule`) returns a `provider.WatchSchedulePull`:
   the canonical envelope plus the three skip counts. COROS implements it by
   decoding the step-level `schedule/query` payload (programs → exercises) into
   `run-workout/v1` blocks; Garmin is a later adapter (`BaseProvider` returns
   `FeatureNotSupported` for now).

## Consequences

- A default (`full` + `all`) or `content:"schedule"` sync now also refreshes the
  watch schedule, including during onboarding's `full` sync.
- COROS pace targets are decoded absolutely (`intensityValue`/`Extend`, ms/km →
  s/km). HR-based COROS steps (`intensityType=2`) are also decoded absolutely:
  `intensityValue`/`intensityValueExtend` are bare bpm (`intensityMultiplier`
  stays 0, unlike pace's ×1000), confirmed on 2026-09-23 against real-account
  samples (134–150 bpm at `intensityPercent` 80000, 170–176 bpm at 103000 for an
  athlete with LT HR ≈166) and decoded into the canonical `hr_bpm` target family
  from ADR 0037 (Low = easier/lower bpm). Absolute values win over
  `intensityPercent`; percent-only HR steps (zero absolute value) still degrade
  to `open` — relative targets are not modelled on the pull side.
- The unique `(user_id, provider, entity_id)` index is the only idempotency
  guarantee; the same `entity_id` never yields two live rows for a user+provider.
- Garmin pull, within-window stale deletion, and HR-step decoding are explicit
  follow-ups, not part of this change.
