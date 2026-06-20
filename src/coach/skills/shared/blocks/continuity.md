---
name: continuity-signals-block
description: Deterministic continuity-signal context block (rendered by calling code only when continuity signals exist). Values injected by code; prose is English.
---
Continuity signals (deterministic, from training data / structured profile):
- macro_cycle: ${macro_cycle}${season}
- Days since last race: ${days}; post-race status: ${post_race_recovery_status}
- Recent aerobic weeks: ${recent_aerobic_weeks}; volume trend: ${recent_volume_trend}; recent longest run: ${longest}
- Current STRIDE CTL (chronic): ${ctl}; Form zone: ${form_zone}
- Returning from layoff: ${return_from_layoff}
- Injuries (soft constraint — weigh it yourself, do not mechanically ban sessions): ${injuries}

Use this to judge **which point of the training cycle the athlete is currently at**, and design the phase sequence from the plan's start Monday (${plan_start}) to race day (see the "phase sequence" rule below): the core idea is to continue forward from the current position, not to default to re-running base from scratch. If recovered and the race is far off, do not schedule a leading recovery phase; if returning from a layoff, rebuild base and slow the ramp; in a summer block a dedicated speed phase may be inserted before the specific phase.