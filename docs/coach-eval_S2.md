# Coach Agent Evaluation — S2 (Weekly Plan)

**何时读**：要给 S2（周训练计划）加 fixture、改 L1 rule_filter、调 S2 judge axis 时必读。框架级问题（L1/L2/L3 概念、Judge graph 设计、CLI、目录结构、冻结原则）见 [`coach-eval.md`](coach-eval.md)。

**范围**：本文档只覆盖 S2 offline evaluation。S1 / S3 见 [`coach-eval_S1.md`](coach-eval_S1.md) / [`coach-eval_S3.md`](coach-eval_S3.md)。

> **当前优先级**：用户已 redirect 到 S1，S2 进 Phase 2，待 S1 baseline 跑稳后开工。本文保留 schema / rules / axes 设计供后续参考。

## S2 是什么

| 项 | 内容 |
|----|------|
| 中文名 | 周训练计划（weekly plan） |
| 输入 | 当前 master plan 阶段、上周 feedback.md、最近身体信号（HRV/RHR/sleep/PMC）、用户文字 request |
| 输出 | `WeeklyPlan` 结构 + `plan.md` + `plan.json` |
| 调用频率 | 每周 1 次（下周开始前） |
| Pipeline | conversation: `week_chat` prompt；generation: `build_generation_graph` with `plan_type="week"` |
| Schema source | `src/stride_core/plan_spec.py` (`WeeklyPlan.from_dict`) |

## S2 Fixture Input Shape

```json
"input": {
  "user_profile": {
    "user_id": "<uuid>",
    "hr_zones": {                   // ✅ 必需 —— 5-zone 详细 HR 区间，不能用 hr_max 替代；详见 [`coach-eval_S1.md`](coach-eval_S1.md)
      "z1": [95, 122], "z2": [122, 141], "z3": [141, 160], "z4": [160, 180], "z5": [180, 190]
    },
    "weight_kg": 72.5,
    "phase": "base_build",          // 当前 master plan 的所在阶段
    "injuries": []
    // S2 不需要 target_race / prs / db_history_weeks 等 strategic 字段
  },
  "prev_plans_md": ["..."],          // 最近 2 周的 plan.md 全文
  "prev_feedback_md": ["..."],       // 最近 2 周的 feedback.md 全文
  "recent_signals": {                // 冻结的 DB snapshot
    "hrv_7d": [62, 60, 58, 56, 55, 54, 54],
    "rhr_7d": [48, 50, 51, 53, 54, 54, 54],
    "sleep_score_7d": [78, 72, 70, 65, 62, 60, 58],
    "ctl": 48.2,
    "atl": 62.1,
    "tsb": -13.9,
    "as_of_date": "2026-05-17"
  },
  "user_request_md": "下周想保持周量 60 km，质量课不要少",  // optional
  "target_week_start": "2026-05-18"                       // 目标周的周一日期（ISO）
}
```

### S2 Required vs Optional

| 字段 | 必需 | 用途 |
|------|------|------|
| `user_profile.phase` | ✅ | 决定本周强度 / 量结构 |
| `prev_plans_md` | ✅ | 与上周衔接 |
| `prev_feedback_md` | ✅ | 上周 RPE / 感受响应 |
| `recent_signals` | ✅ | HRV/RHR/sleep/PMC 触发降量逻辑 |
| `target_week_start` | ✅ | 目标周的时间锚点（ISO 周一日期，跟存储无关） |
| `user_request_md` | optional | 缺省 = autonomous generation，judge 跳过 `request_handling` axis |

## S2 Coverage 场景 (≥10 fixtures)

| Tag | S2 场景 |
|-----|---------|
| `phase_transition` | 阶段切换那一周（base→build 第一周） |
| `recovery_signal` | HRV 连续 5 天下行 8% / RHR +6 bpm → plan 应降强度或换 Z2 |
| `injury_constraint` | `injuries=["knee"]` → plan 周内动作避雷 |
| `user_pushback` | 用户拒绝降量、要求加质量课 |
| `data_gap` | 缺上周 feedback（用户没填）→ plan 应保守 |
| `edge_case` | 长假 / 出差，可训练天数受限 |
| `target_distance` | peak 周 long run / quality 强度与目标距离一致（fm/hm/10k） |
| `unrealistic_goal` | 用户要求按"目标配速"练但 PB 远低 → 安全降配 + notes 解释 |
| `frequency_limit` | 同样约束下的周课排布（具体哪 3 天、强度分配） |

数据源建议 **70% 真实 + 30% 手工**：
- 真实：从 `data/zhaochaoyi/logs/` 取过去半年 weekly folders 反向构造
- 手工：边角 case（伤后第一周、HRV 极端下行、阶段切换）

## S2 L1 Rules（现有 7 条）

S2 L1 已实现在 `src/coach/graphs/generation/rule_filter.py`：

| Rule | 严重度 | 检查 |
|------|--------|------|
| `schema_validity` | error | `WeeklyPlan.from_dict` 必须过 |
| `weekly_progression` | error | 周量 ≤ 上周 × 1.10 |
| `long_run_share` | error | 最长课 ≤ 35% 周量 |
| `intensity_distribution` | error | Z4-Z5 ≤ 20% 周时长（80/20） |
| `rest_days` | error | 每周 ≥ 1 全休 |
| `injury_conflict` | error | injury list 关键词 vs strength exercise 名匹配 |
| `ctl_ramp` | error | 估算 CTL 增长 ≤ 6 TSS/wk |

详见 [`rule_filter.py`](../src/coach/graphs/generation/rule_filter.py)。

## S2 L2 Judge Axes (8)

| Axis | 评什么 |
|------|--------|
| `schema_validity` | `WeeklyPlan.from_dict` 通过（与 L1 双保险） |
| `safety_load` | 周量与上周一致性 / phase 一致性 |
| `progression` | 与上周衔接，不突跳 |
| `phase_fit` | 与 master plan 阶段对齐（base / build / peak 各有强度结构） |
| `signal_response` | 是否响应了 HRV/RHR/sleep（HRV 下行 → 降量 / 换 Z2） |
| `injury_safety` | injury 处理（避雷动作 + 监控） |
| `nutrition_alignment` | 营养与训练匹配（跑步日加 carb / 力量后蛋白时机） |
| `request_handling` | 响应用户文字 request；缺省时 N/A |

## S2 Anti-patterns

- 排两个 threshold 或 VO2max 课在同一周
- 把 long run 排在 HRV 最低那天
- ignore 用户文字 request 不在 notes 里回应
- HRV 连续 5 天下行 8% 仍排 peak intensity week

## S2 Implementation Roadmap（Phase 2）

S1 baseline 跑稳后再启动。预计 3-4 天：

- [ ] 写 `coach/graphs/evaluation/judge_s2.py`（S2 judge prompt v1，复用 framework 模块）
- [ ] 从 `data/zhaochaoyi/logs/` 抽 7 个真实周构造 fixture + 3 个手工 edge case
- [ ] 跑 baseline，存档 `.omc/eval/baselines/s2_v1.json`

S2 L1 不需新写 —— `rule_filter.py` 已经有 7 条。`schema_validity` 是 L1 已 cover 的，L2 重复仅作双保险。

## 跟其他 doc 的关系

- [`coach-eval.md`](coach-eval.md) —— framework 级 doc
- [`coach-eval_S1.md`](coach-eval_S1.md) —— S1 master plan evaluation
- [`coach-eval_S3.md`](coach-eval_S3.md) —— S3 daily Q&A evaluation
- [`plan-json-schema.md`](plan-json-schema.md) —— S2 plan.json HARD schema gate
- `src/stride_core/plan_spec.py` —— S2 schema source of truth
- `src/coach/graphs/generation/rule_filter.py` —— S2 L1 现有 7 条规则
