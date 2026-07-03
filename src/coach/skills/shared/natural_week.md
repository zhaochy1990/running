---
name: natural-week-scheduling
description: Natural calendar week (Mon→Sun) scheduling alignment. S1 uses it for phase/week boundaries; S2 weekly plans likewise require Monday anchoring.
---
- **[Natural-week scheduling · HIGHEST PRIORITY HARD] Use natural weeks (Mon→Sun):**
  1. `plan.start_date` **can only equal the `plan_start` value given in the user message**; copy it verbatim, never today's date or another date.
  2. **Each phase: `start_date` Monday, `end_date` Sunday.** Adjacent phases join: next `start_date` = previous `end_date` + 1 day.
  3. Only race phase may end on the given `race_date` (race week may be <7 days). All other phase boundaries are Monday↔Sunday.
  4. `weeks[]` covers start_date→end_date week by week; every `week_start` **must be a Monday**, phase-aligned, with sequential `week_index` from 1.
  5. **Strictly forbid** Tuesday–Sunday phase starts or week_start dates. Anchor on user-message `plan_start`, slice start_date→race day into 7-day blocks, then align phases to those blocks.
