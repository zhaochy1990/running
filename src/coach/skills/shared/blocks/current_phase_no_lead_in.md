---
name: current-phase-no-lead-in-block
description: Current phase signal for explicit season_start replays. Values injected by code.
---
Current cycle position (deterministic, computed pre-generation — **AUTHORITATIVE INPUT, MUST OBEY**):
- Source: ${src}
- Current phase: ${cur}; time in it: ${wip}; completed aerobic-base weeks: ${completed_aerobic_weeks}
- **Recommended start phase: ${entry}** — begin the fixed-window plan at this phase and continue toward race day
- Confidence: ${confidence}
- Rationale: ${rationale}

MANDATORY — explicit season window:
- Do NOT emit completed lead-in phases before `plan_start`; the caller provided an explicit `season_start`, so the plan starts at `plan_start`.
- `plan.start_date`, the first active phase `start_date`, and `weeks[0].week_start` MUST equal the `plan_start` above.
- Use completed aerobic weeks/history only as evidence for choosing the entry phase, starting volume, and phase focus.
- All phases in this fixed-window output use `is_completed: false` unless they occur after `plan_start` and are explicitly marked by the task input.
