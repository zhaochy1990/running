# Master Plan Rules

本文是 Master Plan Planning Kernel 确定性训练学规则的规范入口。具体规则将在实现前按 capability、planning mode 和 modifiers 逐项定义。

## 权威边界

- `src/coach_agent/src/graph/master_plan/rules/` 中的 TypeScript Rule Filter 是新运行时权威。
- 本文记录规则语义、适用条件、严重度和可修复信息，是实现与评测共同使用的规范。
- 现有 Python `master_rule_filter.py` 作为 legacy 参考逐步退役；TS 规则不追求行为等价，也不在运行时调用 Python。
- 同一生产 Master Plan 不能同时由 Python 与 TypeScript 两套规则给出独立最终 verdict。

## 首期规则集

首期只实现可确定计算的结构、负荷和用户约束规则。所有规则输出稳定 `rule_id`、适用条件、severity、message、evidence 和 suggested fix。除表中明确标记外，违反均为 `error`：

| Rule ID | 检查内容 |
|---|---|
| `schema_validity` | artifact 必须通过当前 TypeScript `MasterPlanSchema` |
| `natural_week_sequence` | active weeks 从计划起点按周一连续排列，`week_index` 连续 |
| `phase_timeline_coverage` | phases 日期连续、无重叠/缺口，并覆盖计划窗口 |
| `week_phase_alignment` | 每个 week 必须落在对应 phase 的日期范围内 |
| `volume_range_consistency` | 所有 low ≤ high，且 week 周量范围位于所属 phase 范围内 |
| `load_week_ramp` | 相邻 load weeks 的 high 增幅不得超过 10%；recovery/taper 不重置比较锚点 |
| `recovery_cadence` | `warning`：首个 active week 到 taper 前出现 4 个连续非-recovery load weeks；交 Reviewer 判断是否有合理例外 |
| `taper_volume_drop` | 取首 taper 前所有非-recovery 周的最高 high；首 taper high 必须 `<= peak_high * 75% + 1km` |
| `hard_stimulus_density` | 每周 hard stimuli 不得超过 2 个；带专项配速的长跑计 hard stimulus |
| `long_run_share` | 默认 `long_run <= weekly_high * 35% + 1km`；`frequency_limited` 使用 `50% + 1km`，其它伤病/返跑场景不自动放宽 |
| `race_week_volume` | race week high 必须包含目标比赛距离 |
| `availability_constraints` | 计划不得违反用户跑频上限和关键课最大单次时长 |

MP progression、最大专项彩排位置、A/B/C gate 质量、伤病处方、力量和营养等较难纯计算的质量首期由对应 Reviewer 负责；有稳定语义和证据后再升级为确定性规则。

### 当前 Schema 的可观测性限制

- 当前没有 `is_taper_week`，首期通过 week 的 `phase_name == "赛前减量期"` 推断 taper；无法可靠推断时由 Periodization Reviewer 判断。
- Master Plan 只列关键课，没有完整周跑日。`availability_constraints` 首期只能验证 `key_sessions.length <= weekly_run_days_max` 和每个关键课的时长上限；完整周跑频可执行性由 Constraint Grounding Reviewer 判断。
- 规则报告必须标注这些 checks 的观测范围，不能声称已验证不存在于 artifact 中的逐日安排。

### Session Duration

- `duration_min` 存在时直接与用户最大单次时长比较。
- 只有 `distance_km` 时，使用 running calibration 中该强度区间的保守慢端配速估算 duration，并记录 provenance/confidence。
- 缺少可用 calibration 时不凭空报 error，输出 `availability_duration_unverifiable` warning，由 Constraint Grounding Reviewer 判断。

### Hard Stimulus 分类

- `threshold`、`tempo`、`interval`、`vo2max`、`hill`、`race_pace`、`time_trial`、`tune_up_race` 和 `race` 均计一个 hard stimulus。
- `long_run` 默认不计 hard；当 `intensity`/`purpose` 明确包含 MP、HMP、RP 或目标配速专项段时计一个 hard stimulus。
- MP/HMP/RP 长跑在 artifact 中只能是一个 `long_run`，不得再用 `race_pace` 重复表达和重复计数。
- `strength_key` 不计入跑步 hard stimulus 上限，但由 Injury & Strength Reviewer 评估与关键跑课的冲突。

## 严重度语义

- `error`：不能进入 Reviewer/finalize，必须修订；预算耗尽则 `failed_quality_gate`。
- `warning`：可以进入 Reviewer，由 Adjudicator 判断是否需要修订或 `pass_with_warnings`。
- Rule Filter 不直接修改 artifact，只返回结构化 violations。
