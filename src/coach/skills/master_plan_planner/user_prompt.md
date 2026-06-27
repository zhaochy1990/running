Today's date: ${today}
Plan start Monday (`plan_start` — `plan.start_date` MUST equal this value verbatim): ${plan_start}
Race day (`race_date`): ${race_date}

User goal:
${goal_json}

Running background:
${profile_json}

History training summary:
${history_summary}

Current fitness state:
${fitness_summary}
${current_phase_block}${continuity_block}${known_constraints_block}${macro_block}${body_comp_block}
请基于以上信息，严格按 system 指定的 JSON 格式与规则（natural-week 对齐、phase 续接、距离专项化等）生成训练总纲。
