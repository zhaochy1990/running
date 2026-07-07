---
name: nutrition-strategy
description: Compact phase nutrition rules with concrete protein/carb numbers.
---
**Nutrition strategy (HARD)**:
- `training_principles` needs >=3 separate nutrition principles. S1: phase-name base maintenance, build fueling, peak carb-cycling/fuel rehearsal, taper glycogen, post-race repair; do not merge build+peak into one `建设/峰值` nutrition line. Even if `season_window.end_date` is race day/no recovery phase, include a post-race repair nutrition principle.
  - Base: caloric balance; protein 1.4-1.6 g/kg/day; refuel within 30 min with carbs+protein 3:1.
  - Build: carbs 5-7 g/kg/day around quality/long sessions; 30-60 g carbs 30-60 min pre-run and 30-60 g/hour during long sessions.
  - Peak: say `carb-cycling`/`碳循环`: high-carb before MP/HMP/key days, normal/easy-day intake or mild easy/rest deficit, race gels + sodium; not only "long-run high carb".
  - Race taper for FM: preserve glycogen stores, carb-loading 8-10 g/kg/day in the 3 days before race.
  - Race taper for HM: preserve glycogen but do not use marathon-style 3-day 8-10 g/kg/day carb-loading; use familiar higher-carb meals for 24-36h / 1-2 days, avoid heavy/fibrous/new foods, keep race breakfast/gels familiar.
  - Race taper for 5K/10K: no marathon-style carb-loading; familiar meals, adequate carbs around race, avoid heavy/fibrous/new foods.
  - Post-race: protein 1.8-2.0 g/kg/day for repair, hydration + electrolytes.
- Target weight/body-fat intent must be explicit. For `72kg -> 68kg`, `training_principles` must say: slow path, small deficit on easy/rest days, **no deficit** on quality/long-run/rehab days, protein 1.6-1.8 g/kg/day + strength fueling.
- Recent knee/patellar/Achilles return overrides Base: rebuild/base nutrition line must say protein 1.6-1.8 g/kg/day + calcium + vitamin D; no 1.4-1.6, no deficit on rehab/quality/long-run days.
- Altitude, heat, high RHR, or heavy sweating: include hydration + electrolytes/sodium and iron-status check (ferritin or hemoglobin; 铁蛋白/血红蛋白). Altitude + RHR-yellow fixtures need one visible `training_principles` entry with those words; not only "补钠", "drink more", or generic recovery nutrition.
- Spring Festival / holiday travel race week: taper nutrition must mention race-distance fueling, gels/sodium/electrolytes + familiar breakfast in luggage, and final 3 carb-loading days (e.g. `2/14-2/16` before `2/17`) with familiar low-fat high-carb foods while avoiding oily/high-fat/high-sugar banquet foods and new foods. Chinese output must include `避开油腻/高脂/高糖宴席和新食物`; do not reduce the holiday note to only carrying gels/sodium/breakfast.
- Do not write a single vague "focus on nutrition"; give concrete numbers per phase.
