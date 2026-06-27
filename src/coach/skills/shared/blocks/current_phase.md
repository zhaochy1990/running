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

MANDATORY — 周期延续性（season continuity）。这份 master plan 是对既有训练的**迁移与更新**，必须呈现完整的赛季弧线，而不是只从当前阶段开始：

1. 把**已完成的前置阶段**（如已经完成的 base，约 ${completed_aerobic_weeks} 周有氧基础）作为 `is_completed: true` 的 phase **列在 `phases` 数组最前**：给出阶段名、起止日期、一句简要 focus；**不要**为它生成 `weekly_key_sessions`（已完成，不重排其内容）。它的 `start_date` ≈ 计划起点往前推 ${completed_aerobic_weeks} 周。
2. `week_index` 从这个已完成阶段的起点**连续编号**（base 是 W1…，`${entry}` 阶段紧接其后，例如 base 占 W1–8 则 `${entry}` 从 W9 起）—— **不要**把 `${entry}` 重新编号为 W1。
3. 从 `${entry}` 开始**详细**规划当前及之后的阶段（含完整 `weekly_key_sessions`），一直到比赛日。这些阶段 `is_completed: false`。
4. `current_phase_id` 指向 `${entry}` 阶段；`current_week_number` 指向运动员当前所在的那一周（= 已完成周数 + 当前阶段内已过的周）。
5. 已完成阶段**不重新规划内容**——只保留它在时间线上的位置以体现延续性。