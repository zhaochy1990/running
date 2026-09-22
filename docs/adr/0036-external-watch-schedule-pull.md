# Pull third-party watch schedules into a separate, canonical domain

Status: accepted

> Renumbered from the `0035` referenced by issue #329: ADR 0035 is
> `0035-race-calendar-admin-surface-and-sync-merge.md`.

## Context

Athletes author training calendars inside COROS and Garmin. Those calendars are
already synced into STRIDE for *executed* activities, but the *planned* content
on the watch — the schedule with steps and intensity — has no home here. The
only planned-content domain STRIDE owns is the coach-generated weekly plan, and
third-party watch content must never overwrite or pollute it: a watch's schedule
is not a coaching decision, and merging the two would make "who wrote this
workout?" unanswerable and idempotency impossible.

The COROS `schedule/query` channel returns step-complete structures and was
verified against a real account on 2026-09-21. Garmin's expressible set was
derived from the existing push DTO reverse-engineering. Both can be mapped into
one provider-agnostic shape so a third platform only needs a new adapter.

## Decisions

1. **Watch Schedule is its own domain.** Pulled entries are stored apart from
   `weekly_plan` / `master_plan` and are never written into either. The
   direction is one-way (watch → STRIDE) in v1; push of watch content back to
   the platform is not part of this domain.

2. **The canonical shape is the `watch-schedule/v1` envelope** (Go type
   `provider.WatchSchedule`):
   - `provider` tags the envelope;
   - `fetch` carries fetch metadata (instant + pull window);
   - `sessions` mirror the planned-session content shape `date` / `kind` /
     `spec`, reusing `run-workout/v1` for `spec`.

3. **Each session carries per-session `source_ids` (`provider`, `entity_id`).**
   This is the idempotency key for a later sync, so sync can be built without a
   schema change. `provider` may be inherited from the envelope.

4. **v1 models run content only.** Strength sessions are skipped by the puller
   and counted in sync metadata; the schema does not model strength in v1.

5. **STRIDE-authored entries are excluded from the pull** to avoid a self-loop:
   sessions whose name carries the `[STRIDE]` marker are not ingested.

6. **Sync trigger, pull window, storage, and the COROS/Garmin pull adapters are
   out of scope here** (#327). This ADR fixes only the canonical structure so
   those choices can land independently.

## Consequences

- Third-party watch content and coach content have separate lifecycles and
  storage; neither can overwrite the other.
- Adding a platform is an adapter, not a schema change, as long as it maps into
  `watch-schedule/v1`.
- The puller must decide what to do with a session whose intensity is only
  relative to the platform's own threshold estimate; that rule is ADR 0037
  (absolute wins; relative-only intake is allowed but marked in sync metadata).
- Skipped strength sessions must be surfaced as a count so an athlete can see
  that content was intentionally not pulled.
