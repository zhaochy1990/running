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
MANDATORY: sequence the phases starting from `${entry}`; **already-completed leading phases (e.g. a finished base phase) must NOT be re-scheduled**.