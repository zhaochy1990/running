---
name: current-phase-block
description: Authoritative deterministic current-phase position block (rendered by code only when the detector produced a recommended entry phase). Values injected by code.
---
Current cycle position (deterministic, computed pre-generation — **AUTHORITATIVE INPUT, MUST OBEY**):
- Source: ${src}
- Current phase: ${cur}; time in it: ${wip}; completed aerobic-base weeks: ${completed_aerobic_weeks}
- **Recommended start phase: ${entry}** — the plan MUST begin at this phase and continue toward race day
- Confidence: ${confidence}
- Rationale: ${rationale}

MANDATORY — 周期延续性（season continuity）:
- Keep completed lead-in phases at the front of `phases` as `is_completed: true` with dates + brief focus; do **not** emit `weeks` for them.
- Start detailed active planning at `${entry}` and continue to race day; active phases use `is_completed: false`.
- Keep `week_index` continuous across the full season (e.g. 8 completed base weeks means `${entry}` starts at W9), not restarted at W1.
- Set `current_phase_id` to `${entry}` and `current_week_number = completed weeks + current phase week`.
- If `weeks` includes completed-phase dates, rule_filter fails.
