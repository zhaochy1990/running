Today's date: ${today}
Plan start Monday (`plan_start`): ${plan_start}
Race day (`race_date`): ${race_date}

Scheduling anchors (HARD, copy exactly):
- `plan.start_date` MUST equal `${plan_start}` verbatim.
- Unless an explicit current-phase block says a previous phase is already completed, the first active phase `start_date` MUST equal `${plan_start}`.
- A `prev_master_plan_md` / previous-plan text is evidence only: cite its key facts, but it does **not** authorize `is_completed:true` phases or any phase before `${plan_start}`. Only a rendered "Current cycle position" block may authorize completed lead-in phases.
- `weeks[0].week_start` MUST equal `${plan_start}`; do not skip early weeks or substitute today's wall-clock date.
- The final plan MUST cover every natural week from `${plan_start}` through `${race_date}`.

User goal:
${goal_json}

Running background:
${profile_json}

History training summary:
${history_summary}

Current fitness state:
${fitness_summary}
${current_phase_block}${continuity_block}${known_constraints_block}${macro_block}${body_comp_block}${previous_plan_block}
请基于以上信息，严格按 system 指定的 JSON 格式与规则（natural-week 对齐、phase 续接、距离专项化等）生成训练总纲。
