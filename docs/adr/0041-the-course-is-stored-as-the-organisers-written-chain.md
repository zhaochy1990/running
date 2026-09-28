# The course is stored as the organiser's written chain, not a track

Status: accepted

Extends [ADR 0039](0039-race-item-content-folds-onto-the-item-row.md) (item
content on the item row), which stands unchanged.

## Context

A runner deciding whether to enter a race wants to know what the course looks
like. Until now that question had no answer in the data: `start_point` and
`finish_point` name two places, and everything between them was empty. Across
the ten-race pilot, `finish_point` was filled 3/10 and `total_ascent_m` 1/10.

Two candidate sources were investigated before choosing a shape.

**A track (GPX/KML/polyline) is not obtainable.** Chinese races do not publish
one. A survey of the pilot's official sites, the 竞赛规程 documents, the 中国田协
catalogue and local-government releases found only text, images and regulations —
no route file, official or otherwise. Third-party sites (running.COACH, 爱汇跑)
carry user-uploaded tracks, but they are not the organiser's and carry no
guarantee of matching the measured course.

**The written chain is obtainable.** 7 of the 10 pilot races publish their course
as a `起点→路段→…→终点` chain, in the 竞赛规程 or in coverage of it:

| race | source | segments |
| --- | --- | --- |
| 东营 | the race's own site (`/document/7465`) | 全马 16 + 半马 15 |
| 桐庐 | 最酷's 规程 (text, not scanned) | 21 |
| 高邮 | 扬州晚报, corroborated by 搜狐 | 23 |
| 北马 | 北京本地宝 | 33 |
| 西安 | 西安本地宝 | 全马 29 + 半马 20 |
| 湘湖 | 杭州本地宝, corroborated by 搜狐 | 15 |
| 奉贤 | 上海本地宝, corroborated by 漫漫长跑 | 15 |

The remaining three do not: 成都's official 规程 gives only its two endpoints,
上海马拉松 states 详细路线以赛前公布的为准, and 杭州马拉松's 2026 route exists
only as an image (the text circulating online is the 2024/2025 edition).

That chain is richer than a track for this purpose. It names the streets, the
turn directions and the 折返 points with their distances, which is how a runner
actually pictures a course.

## Decision

**`route_description` is a nullable TEXT column on the item, holding the
organiser's chain verbatim.** Three choices are deliberate:

- **A written chain, not a geometry.** It is the form the data is actually
  published in. Storing a parsed structure would mean writing a parser for prose
  that varies by organiser — some use `→`, some `—`, some split the chain across
  paragraphs, and the 折返 annotations are free text (`赛道1.7KM处折返`). The
  consumer wanting structure can parse it later; nothing here forecloses that.
- **On the item, not the race.** A race's distances take different routes. 东营's
  全马 and 半马 share their first two kilometres and then diverge permanently;
  西安's finish in different districts. An event-level column could hold only one
  of them.
- **Admin-owned but not overrideable.** `route_description` joins the content
  block, so it counts for `HasContent()` (a row carrying only a route survives
  the stale-delete) and is carried by `MoveRaceContent`. It is *not* added to
  `RaceCalendarItemOverrideableFields`, for the same reason `start_time` and
  `entry_fee` are not: the sync never writes it, so there is nothing to override —
  an administrator simply owns it.

The API caps the value at 2000 runes, which is not a fit constraint (the longest
real chain is ~400 characters) but a guard against a pasted 竞赛规程 landing in
the column. The count is in runes, because every one of those characters is a
3-byte CJK codepoint.

## Consequences

- Provenance is uneven and cannot be flattened. 东营's chain comes from the race's
  own site and 桐庐's from the organiser's 规程 text; 北马's and 西安's are
  transcriptions on 本地宝, a local-info aggregator, of a 规程 that is itself an
  image. Where two independent sources existed (高邮, 湘湖, 奉贤) they agreed
  verbatim, which is the only cross-check available. A reviewer must be able to
  tell these apart, so `content_source` alone — a single row-level term — does not
  express it; the per-race detail lives in the research payload rather than in the
  database.
- The field is per-year by construction. A course changes between editions, and
  the row is keyed to one year, so last year's chain cannot leak into this year's
  race.
- `copyRaceItemAdminData` is enumerated by hand, and this change is the second
  column added to it. Writing its test as a reflection walk over the struct
  rather than a hand-written field list found that the *first* such column,
  `content_source`, was never being carried over — a move silently relabelled
  researched content as hand-typed. The walk now fails on any future column the
  function forgets, which is the failure mode this ADR's column would otherwise
  have repeated.
- Nothing reads the column yet. There is still no public race API
  ([ADR 0035](0035-race-calendar-admin-surface-and-sync-merge.md)), so this is
  data laid down ahead of the surface that will show it.
