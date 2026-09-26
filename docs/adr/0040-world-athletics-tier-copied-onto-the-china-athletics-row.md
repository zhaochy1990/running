# The World Athletics tier is copied onto the 中国田协 row by a third pass

Status: accepted

Extends [ADR 0035](0035-race-calendar-admin-surface-and-sync-merge.md) (the
race-calendar admin surface and sync merge) and
[ADR 0039](0039-race-item-content-folds-onto-the-item-row.md) (item content on
the item row). Both stand unchanged.

## Context

A race has two grades and they arrive from two calendars. The 中国田协 mirror
writes 中国田协's certification grade (A / B / C（属地办赛）/ 系列赛) into
`race_calendar.label` on the rows of source `中国田协`; the World Athletics
mirror writes the WA road-race label (Platinum / Gold / Elite / Label) into
`label` on its own rows. A runner looking at one race should see both — 厦门马拉松
is 中国田协 A *and* World Athletics Platinum — and neither mirror can produce
that, because both are scoped to their own source: `ReplaceRaceCalendarYear`
takes the source as a parameter and its stale-delete is
`WHERE source = ? AND race_date BETWEEN ? AND ?`.

In 2026 the two calendars overlap on 50 Chinese races. The overlap is only
partial in both directions, and that shape decides the design:

- 38 World Athletics rows have a 中国田协 counterpart. They must end up carrying
  the WA tier.
- 12 do not. Six of those are races 中国田协's catalogue simply lacks
  (上海马拉松, 北京马拉松, 桂林, 黄石, 义乌, 深圳…), and one is a date
  disagreement: 中国田协 has 2026南昌马拉松 on 11-15, which is the organiser's
  announced date, while the World Athletics listing still says 11-08.

## Decision

**A third pass owns the tier column.** `race_calendar.wa_label` is written by a
new step, `race_calendar_wa_label`, which runs after both mirrors and copies the
tier from each WA row onto its matching 中国田协 row. It is its own single-step
pipeline rather than a step of either mirror, because the two mirrors run as
parallel jobs of the daily workflow — a step needing both calendars' output
cannot be part of either one.

**Nothing is deleted and no row is merged.** The World Athletics rows stay exactly
as they are. The earlier shape of this problem — deduplicate the calendar to one
row per race — was rejected because the daily sync undoes deletion: the WA
upstream still lists those races, so `ReplaceRaceCalendarYear` re-inserts any row
that was removed, with a new id, every night at 00:00 Shanghai. Suppressing that
would need its own tombstone mechanism. Copying a column needs none, because
`wa_label` is absent from `raceCalendarUpsertCols` and therefore survives both
mirrors' OnConflict merges. It also keeps the World Athletics row's provenance
available if the 中国田协 catalogue ever drops the race.

**The match is `(race_date, city)`, exact, unique, and refuses ambiguity.** Three
consequences are deliberate:

- **Names are not used.** The two sources name races in different languages, and
  the upstream is not even self-consistent — the WA listing for 福州马拉松 is
  spelled `Fuzhou Marathona`. A name heuristic would be a second guess stacked on
  the first.
- **`race_types` may only refute, never confirm.** WA derives its types from the
  `GW`/`GL` ranking categories alone, so 31 of the 38 Chinese matches carry
  `["Unknown"]`. The check therefore runs one way: when WA *does* state a concrete
  type the 中国田协 row must list it, and otherwise WA is treated as having no
  opinion. This is what catches a stale WA date landing on a different race in the
  same city — a marathon's tier on a half marathon.
- **A date disagreement is left unmatched.** 南昌马拉松 keeps no tier rather than
  risking the tier being attached to whatever else 南昌 ran that day. One race in
  fifty loses a label; the failure direction is a gap, never a wrong value.

**`wa_label` is admin-overrideable.** The match is a heuristic, so an
administrator who corrects a tier must outrank it. `wa_label` joins
`RaceCalendarOverrideableFields`, `ApplyRaceCalendarWALabels` skips any row
naming it in `admin_overrides`, and `reset_fields` hands the field back.

**`chinaCity` becomes prefecture-level without exception.** The match above is
only sound if both sources agree on a race's city, and they did not: the WA
venues for 高淳, 镇宁, 西昌 and 杨陵 resolve through `chinaCity` to a district
or county-level city, while the 中国田协 mirror discards its address's third
segment and so always produces the prefecture. Four of the 50 matches were lost
to that single mismatch. Fixing the table rather than adding a normalisation step
at match time makes the two sources agree by construction and keeps
`(race_date, city)` a legitimate join key. (`义乌` is left county-level: no 金华
race exists in the 中国田协 catalogue to join against.)

## Consequences

- The tier is a derived column, so the step is idempotent and writes only rows
  whose value changes — a routine night writes nothing. Re-running a day is a
  no-op.
- A race that loses its World Athletics listing is *cleared*, not left stale: the
  step reconciles every 中国田协 row in scope, not only the matched ones.
- The step is not required for correctness of anything else. Its failure leaves
  the calendar intact and only the tiers missing, so the pipeline can be re-run
  by hand.
- A year's worth of matching is `LoadRaceCalendarLabelScope`'s two queries plus
  one UPDATE per changed row. At 337 中国田协 rows that is comfortably a
  single-row-at-a-time loop; it would want a bulk statement long before it wanted
  a redesign.
- `Source` on the two mirrors now aliases the storage constants
  (`RaceSourceChinaAth` / `RaceSourceWorldAth`) rather than repeating the strings,
  so the third pass can address a source without importing a handler.
