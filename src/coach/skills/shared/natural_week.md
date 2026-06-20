---
name: natural-week-scheduling
description: Natural calendar week (Mon→Sun) scheduling alignment. S1 uses it for phase/week boundaries; S2 weekly plans likewise require Monday anchoring.
---
- **[Natural-week scheduling · HIGHEST PRIORITY HARD · satisfy this first before anything else] The entire plan is strictly chunked into natural calendar weeks (Mon→Sun); every date must fall on a week boundary:**
  1. `plan.start_date` **can only equal ${plan_start}** — this is the Monday already computed by the system; **copy this value verbatim**, do not change it yourself, do not swap in today's date, do not use any other date.
  2. **Each phase: `start_date` must be a Monday, `end_date` must be a Sunday.** Adjacent phases join seamlessly: the next phase's `start_date` = the day after the previous phase's `end_date` (i.e. the next Monday).
  3. The only exception: the final phase that contains the race, whose `end_date` = the race day ${race_date} (the race week may be shorter than 7 days). All other phase boundaries are strictly Monday↔Sunday.
  4. `weeks[]` covers start_date→end_date week by week; every `week_start` **must be a Monday**, aligned to the week boundaries of its phase, with `week_index` incrementing sequentially from 1.
  5. **Strictly forbid** any phase start or week_start from landing on Tuesday–Sunday (a mid-week date). Method: first anchor on ${plan_start}, mentally slice start_date→race day into consecutive 7-day week blocks, then align the phase boundaries to those week blocks.