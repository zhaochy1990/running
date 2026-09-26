# The race calendar gains an admin CRUD surface and a field-level sync merge

Status: accepted

> **Superseded in part by [ADR 0039](0039-race-item-content-folds-onto-the-item-row.md).**
> The item level no longer uses a separate content table or delete+insert
> regeneration. Everything below about the *event* level — provenance on the
> row, key-field edits detach, the per-field merge, stale protection — stands.

## Context

The daily pipelines mirror the World Athletics (国际田联) and China Athletics
(中国田协) calendars into the system-scoped `race_calendar` table. Until now the
table was a pure upstream mirror with no HTTP surface:

- Administrators could not see the fetch result, fix a mis-parsed city/label, or
  fill in a Chinese name the upstream does not provide.
- The write path was a whole-year replace (`ReplaceRaceCalendarYear`) plus a
  stale-delete that removed every row upstream no longer listed, so any manual
  correction was erased on the next sync and any manually created race was
  deleted outright.
- Identity was the business key `(source, name, race_date)` only; there was no
  surrogate key for a child table, and no per-distance detail (the 中国田协
  `raceItem` list was flattened into the event's `race_types`).

## Decisions

- **Provenance lives on the row.** `race_calendar` gains an `id`
  auto-increment primary key (needed as the item child's foreign key; the
  dashboard still navigates by the internal id while displaying the business
  key), an `origin` column (`sync` / `manual`) and an `admin_overrides` JSON
  array of the sync-managed field names an administrator has taken over. Per
  field provenance is derived as `origin` + `admin_overrides` rather than a
  column per field (too costly to migrate) or `origin` alone (cannot express a
  locally edited sync row).
- **Key-field edits detach; other edits override.** Editing `name` or
  `race_date` upgrades the row to `origin='manual'` so it leaves the mirror (and
  upstream re-inserts its original key rather than reviving/deleting the admin's
  row). Editing any other field records it in `admin_overrides`.
- **The sync becomes a per-field merge.** For an existing `origin='sync'` row,
  each field named in `admin_overrides` keeps its current value and every other
  sync-managed field takes the upstream value; `name_cn` is always preserved
  (existing semantics). Missing rows insert as `origin='sync'`. A manual row is
  never refreshed or deleted, and the stale-delete only removes `origin='sync'`
  rows with no overrides (together with their items).
- **Items are a child table.** `race_calendar_item` holds one row per upstream
  中国田协 `raceItem` segment (name, race-types token, plus admin-maintained
  start time, entry fee in fen and quota), unique on `(race_event_id, name)` and
  carrying its own `origin`. The 中国田协 handler regenerates the event's
  `origin='sync'` items each run and never touches manual items or manual
  events; the World Athletics handler, which has no item-level data, does not
  participate.
- **The admin surface is `/api/admin/races*` in the Go API.** Paged list
  (year / source / keyword / month filters), detail with items, create (forced
  `origin=manual`, `source=manual`), partial update (body field values +
  `overrides` + `reset_fields`), delete (cascades items) and item CRUD. Every
  handler re-checks `TierAdmin`, following the declaration-maintenance surface
  (ADR 0032). The DTO exposes each field's derived source
  (`sync` / `overridden` / `manual`) so the dashboard renders badges without
  decoding the override JSON, and a `reset_fields` write clears an overridden
  field and hands it back to the next sync.
- **Proxy layers route the prefix explicitly.** `/api/admin/races` must reach
  `stride-api` and not fall through to auth-backend in the Vite dev proxy, the
  production Caddyfile and the local nginx gateway; `tencent/test_caddy_contract.py`
  asserts all three.

## Consequences

- `name_cn` is always preserved by the merge; an administrator curating it
  records an override so the stale-delete protects the row. Resetting it clears
  the value (the World Athletics source has no upstream Chinese name to refill).
- `reset_fields` clears the value and removes the override; the fetched value
  returns on the next sync rather than immediately, because the pre-override
  upstream value is not retained.
- The 中国田协 sync's item ordering means the event merge commits before the
  item regeneration; a crash between them leaves the event updated and its sync
  items stale until the next run (the run is idempotent).
- Schema is owned by Go `AutoMigrate` (ADR 0006). Adding the auto-increment PK
  to the existing table is exercised by a storage test that creates the legacy
  table shape and migrates it in place.
- `competition_calendar`, the abandoned early-iteration table, still needs a
  manual `DROP` (see `docs/deployment.md`).
