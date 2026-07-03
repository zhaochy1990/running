---
fixture_id: s1-fm-target-sub250-advanced
scope: s1
run_at: 2026-06-30T14:41:03.791162+00:00
git_sha: b42bc46
judge_prompt_version: s1-v1
human_verdict: pending  # accept | reject | mixed
human_notes: |
  
---

## L1 result

- l1_passed: **True**
- generation_iterations: `1`
- timings: `{'load_context_s': 1.300126314163208e-06, 'generator_attempt_s': [224.38900250010192], 'generator_total_s': 224.38900250010192, 'rule_filter_s': [0.0009255001787096262], 'reviewer_s': 1.819990575313568e-05, 'generation_total_s': 224.4000397999771, 'judge_s': 56.29285959992558, 'total_s': 280.69289939990267}`
- generated_artifact: embedded in EvalReport JSON and written under `.omc/eval/reports/<run>/artifacts/`
- violations:
  - `long_run_distance_share` (warning): week 13 long_run 30km is 37% of weekly 82km (> 35%); for a volume-capped runner this can be acceptable but the plan must justify it
  - `long_run_distance_share` (warning): week 14 long_run 30km is 38% of weekly 78km (> 35%); for a volume-capped runner this can be acceptable but the plan must justify it
  - `long_run_distance_share` (warning): week 17 long_run 34km is 40% of weekly 84km (> 35%); for a volume-capped runner this can be acceptable but the plan must justify it
  - `long_run_distance_share` (warning): week 19 long_run 28km is 40% of weekly 70km (> 35%); for a volume-capped runner this can be acceptable but the plan must justify it

## L2 judge

- model: `gpt-5.5`
- prompt_version: `s1-v1`
- overall_verdict: **pass**
- overall_rationale: 该计划结构完整，峰值与 taper 时间精准，周量和专项长课能合理通向 sub-2:50 目标，并充分回应用户提出的三项问题。主要不足只是营养中的减重/碳循环和股四头肌离心训练细节不够具体，但不影响整体通过。

| Axis | Score | Matches expected | Rationale |
|------|-------|------------------|-----------|
| `schema_validity` | 5 | OK | MasterPlan 顶层字段、phases、milestones、weeks、training_principles 等结构完整，字段类型整体一致；weekly_key_sessions 与 weeks 重复但不破坏结构有效性。goal.target_time 为空字符串属于内容小瑕疵，不影响 schema 可用性。 |
| `season_structure` | 4 | OK | 包含 base、speed、build、peak、taper，顺序合理且 21 周分配符合全马周期；base 4 周、speed 4 周、build 6 周、peak 5 周、taper 2 周整体平衡。唯一小缺口是没有单独赛后 recovery phase，但赛季窗口到比赛日结束，因此影响有限。 |
| `goal_realism` | 5 | OK | PB 2:59:22 到 2:50:00 约 5.2% 提升，对有 18 个月稳定训练、历史峰值 78 km、计划峰值 84 km 的 advanced runner 在 5 个月内具备现实性。计划明确给出 A/B/C 目标，并通过半马、10K、马配长课设置验证条件。 |
| `peak_timing` | 5 | OK | peak phase 于 2026-10-04 结束，距离 10-18 比赛正好 14 天，随后进入 2 周 taper，时间点匹配。最大 34 km/24 km MP 演练安排在 race - 4 weeks，且下一周强制降量吸收，符合 FM 峰值安排。 |
| `volume_progression` | 4 | OK | 周量从约 54-60 km 起步，逐步推进到 78-84 km 峰值，并设置约每 4 周一次 recovery week，整体符合渐进和吸收逻辑。小问题是从恢复周回到下一阶段高量周的表面跳幅较大，但相对于前一训练块峰值并非失控。 |
| `frequency_respect` | 5 | OK | 计划多次明确每周 5-6 跑，未超过 weekly_run_days_max=6，并充分利用 6 天上限来分散周量、保留长课和质量课。还强调避免周末尖峰和平日空洞，符合受限频次下的结构要求。 |
| `injury_safety` | 4 | OK | 右跟腱风险被持续纳入监控，包含晨起痛、热身痛、24 小时僵硬、马配后疼痛等降级触发，并避免连续 32+ km 最大长课。力量训练提到跟腱离心提踵、股四头肌耐力和单腿稳定，但对股四头肌偏心/离心训练动作本身描述不够具体。 |
| `phase_nutrition_strategy` | 4 | OK | 营养策略随阶段变化：基础期维持能量平衡，build/peak 提高碳水并练习长课补给，taper 赛前碳水加载，赛后提高蛋白修复。缺少更明确的 peak carb-cycling 和 72 kg 到目标 68 kg 的减重赤字安排，因此未满分。 |
| `request_handling` | 5 | OK | 计划显式回应 VO2max 停滞，设置速度与效率期、VO2max/间歇和 5K/10K 测试；也明确处理轻松跑过快，要求 Z2 心率纪律。股四头肌耐力通过长距离后程、坡跑、力量/康复和监控触发多处覆盖。 |
