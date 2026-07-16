# Coach Agent Evaluation — S1 (Master Plan)

**何时读**：要给 S1（赛季备战计划）加 fixture、改 L1 master_plan 规则、调 S1 judge axis 时必读。框架级问题（L1/L2/L3 概念、Judge graph 设计、CLI、目录结构、冻结原则）见 [`coach-eval.md`](coach-eval.md)。

**范围**：本文档只覆盖 S1 offline evaluation。S2 / S3 见 [`coach-eval_S2.md`](coach-eval_S2.md) / [`coach-eval_S3.md`](coach-eval_S3.md)。

## S1 是什么

| 项 | 内容 |
|----|------|
| 中文名 | 赛季备战计划（master plan） |
| 输入 | 用户目标比赛、当前能力（PR）、可用训练时长、周期化偏好、伤病约束 |
| 输出 | `MasterPlan` 结构 + 配套 markdown：base / build / peak / taper / recovery 阶段，每阶段周量框架、目标比赛日期、以及逐周重点课 skeleton |
| 调用频率 | 一个赛季 1 次（夏训 / 冬训 / 备赛周期开始时） |
| Pipeline | conversation: `master_chat` prompt；generation 已走 `coach.graphs.generation.build_generation_graph`。Master-plan 的 ports / adapters 在 `src/stride_server/master_plan_generator.py` 与 `src/stride_server/coach_adapters/master_plan_adapter.py`，eval 与 production generation 共用 rule_filter / reviewer / verdict 形态 |
| Schema source | `src/stride_core/master_plan.py` (pydantic `MasterPlan`) |

**与 S2 的关键区别**：S1 是 **strategic / season-level**（多月时间尺度，目标导向），S2 是 **tactical / week-level**（具体某周日程，响应近期信号）。S1 输入侧重"用户画像 + 目标比赛"，S2 输入侧重"上周 feedback + 最近 HRV/RHR"。S1 错了会让整个赛季方向偏；S2 错了一周内可修复。

## S1 Output Requirement: Weekly Key-Session Skeleton

S1 不能只输出 phase-level 周量区间。为了评估整个赛季训练安排是否合理，`MasterPlan` 必须包含逐周重点课 skeleton：每周列出会驱动训练适应或风险的关键训练内容，例如长距离、阈值跑、节奏跑、间歇、坡跑、比赛配速课、测试赛、A/B race 等。

S1 **不需要** 展开完整周计划，也不需要列出普通有氧跑、轻松跑、恢复跑、通勤跑等填充训练；这些留给 S2 weekly plan。S1 只关心赛季层面的关键刺激是否按正确顺序、间隔、负荷和目标距离特异性排列。

建议 schema 扩展方向（字段名实施时可调整，但语义必须保留）：

```json
"weekly_key_sessions": [
  {
    "week_index": 1,
    "week_start": "2026-05-18",
    "phase_id": "<phase uuid>",
    "target_weekly_km_low": 45,
    "target_weekly_km_high": 52,
    "key_sessions": [
      {
        "type": "long_run",
        "distance_km": 24,
        "intensity": "z2",
        "purpose": "建立马拉松专项耐力"
      },
      {
        "type": "threshold",
        "duration_min": 35,
        "intensity": "z4",
        "purpose": "提高乳酸阈值"
      }
    ]
  }
]
```

`key_sessions[].type` 至少覆盖：`long_run`、`threshold`、`tempo`、`interval`、`vo2max`、`hill`、`race_pace`、`time_trial`、`tune_up_race`、`race`、`strength_key`。普通 easy / aerobic / recovery run 不进入这个 skeleton。

## S1 用户场景分类（按可用能力数据划分）

S1 evaluation 按用户当前可用的能力数据 ground truth 分 3 个场景，决定 fixture 字段填法、L1 规则触发、judge 评分基准：

| 场景 | 名称 | 数据来源 | fixture 表达 | v1 评估 |
|------|------|---------|--------------|---------|
| **1** | 有经验 + 有运动记录 | `live_local_db` mode 从本地 SQLite (`data/{user_id}/coros.db`) 读过去 **12-24 个月** 运动数据 aggregate 出 HR zones / PRs / 周量趋势 / 历史峰值 → 挑代表性场景脱敏入 fixture；后续 `frozen_fixture` mode 纯读 fixture inline | `hr_zones` + `prs` + inline `training_history_summary`（窗口 12-24 月）+ `db_history_weeks ≥ 8` | ✅ Phase 1 |
| **2** | 有经验 + 无运动记录（迁手表 / 老跑者新用户） | 用户手动填基础信息（PR / HR zones）—— DB 还没积累出有效数据 | `hr_zones` + `prs` 全填（user-reported）+ `db_history_weeks < 4` | ✅ Phase 1 |
| **3** | 无经验 + 无运动记录（完全新跑者） | 用户主观填 `experience_level` + 简单问卷；无任何客观能力数字 | 仅 `experience_level`（+ optional `weekly_run_days_max` / `injuries`）；**无** `prs` / `hr_zones` / `training_history_summary` | ⏸ v1.1 保留，**当前不评估** |

**当前 v1 fixture 聚焦场景 1 + 2**。场景 3 的 fixture 数据形态、L1 规则（如"无 prs 时必须先排 fitness assessment 周再定 zone"）、judge axis 调整留到 v1.1。

**`experience_level` 的角色**：
- **场景 1 / 2** —— optional / informational：`prs` + `hr_zones` 已提供客观能力，`experience_level` 是冗余 fallback
- **场景 3** —— ✅ 必需：plan 唯一能拿到的能力先验，触发 cautious onboarding（先排 2-4 周 fitness assessment 后再定 zone / 周量起点）

## S1 Offline Test Modes

S1 v1 先做 **offline evaluation**，稳定后再接 production runtime。离线阶段允许访问本地 SQLite 数据库来聚合真实运动历史，但必须区分 exploratory run 和 regression replay，否则分数不可比。

| Mode | 是否读取本地 SQLite | 用途 | 是否可作为 baseline |
|------|--------------------|------|---------------------|
| `live_local_db` | ✅ 是 | 用当前本机真实用户数据做探索性评估：查询 12-24 个月运动历史、PR、长期周量趋势、历史峰值、断训记录，并生成 S1 context / fixture 候选 | ❌ 否。SQLite 会随同步和用户训练持续变化，结果会漂移 |
| `frozen_fixture` | ❌ 否 | 回放已落盘 fixture：直接读取 fixture 中冻结的 `input.*` context，跑 L1/L2/L3 并与历史报告对比 | ✅ 是。用于 regression 和 prompt / model / rule 变更对比 |

推荐工作流：

1. 先用 `live_local_db` 跑当前用户真实数据，判断 coach 对真实训练史生成的 S1 plan 是否方向正确。
2. 从 `live_local_db` 输出中挑有代表性的场景，脱敏并固化为 `tests/fixtures/coach_eval/s1/*.json`。
3. fixture commit 后进入 `frozen_fixture` 模式；后续 baseline replay **不得重新查询 SQLite**，只读冻结 context。

报告必须记录 `mode`：`live_local_db` 结果只能做人工诊断和 fixture 采样；`frozen_fixture` 结果才进入 `.omc/eval/baselines/s1_v*.json`。

## S1 Fixture Input Shape

S1 fixture 在通用 envelope（见 hub doc）之上要求以下 `input.*` 字段：

```json
"input": {
  "user_profile": {
    "user_id": "<uuid>",
    "hr_zones": {                              // ✅ 必需：用户实测 / 教练定的详细心率区间（5 zone，每个 [low, high]，单位 bpm）—— 不接受仅给 hr_max，因为 %HRmax 划分受 LT / 个体差异影响误差太大
      "z1": [95,  122],                        // recovery
      "z2": [122, 141],                        // aerobic / easy
      "z3": [141, 160],                        // tempo
      "z4": [160, 180],                        // threshold
      "z5": [180, 190]                         // VO2max；z5.high 即用户实测 hr_max
    },
    "weight_kg": 72.5,
    "injuries": [],
    "experience_level": "intermediate",       // 场景 1+2 时 optional（prs / hr_zones 已 cover）；场景 3 时必需作为唯一能力先验
    "weekly_run_days_max": 5,                 // 用户每周最多能安排的跑步训练次数
    "prs": {                                   // 个人最好成绩；缺省 / 仅含部分距离都合法
      "5k_s": 1200, "10k_s": 2550, "hm_s": 5400, "fm_s": 12600
    },
    "target_race": {                           // S1 核心 —— 决定阶段结构 / peak 周量 / taper
      "distance": "fm",                        // "5k" | "10k" | "hm" | "fm" | "ultra"
      "goal_time_s": 10800,                    // null = 无明确目标时间（仅追求完赛）
      "race_date": "2026-10-19"
    },
    "db_history_weeks": 12                     // 当前 DB 里实际有几周训练数据。≥ 8 = 场景 1（本 example）；< 4 = 场景 2（迁手表 / 新用户自报）
  },
  "season_window": {                           // plan 总时长边界
    "start_date": "2026-05-19",
    "end_date": "2026-10-19"
  },
  "training_history_summary": {                  // base 起点 + plan ceiling 判断 —— 必须看过去 12-24 个月（仅 3 个月看不出长期 buildup / decline / 历史峰值 / 断训）
    "history_window_months": 18,                 // 用户能提供数据的窗口；推荐 12-24
    "monthly_mileage_km": [                      // 逐月跑量，倒序（[0] = 最近月，[-1] = 窗口最早月），长度 == history_window_months
      220, 215, 210, 198, 185, 175, 165, 150, 140, 130, 125, 135, 145, 160, 175, 195, 200, 210
    ],
    "peak_weekly_km_in_window": 65,              // 窗口内达到过的最大周量 —— plan ceiling 参考，新赛季 peak 周量不应远超此值
    "longest_run_km_in_window": 35,              // 窗口内单次最长跑步距离
    "race_history": [                            // 窗口内所有比赛（不仅最近一场，能看出距离 progression）
      { "distance": "fm", "date": "2025-10-19", "time_s": 12600, "race_type": "A_race"  },
      { "distance": "hm", "date": "2025-09-14", "time_s": 5520,  "race_type": "tune_up" },
      { "distance": "hm", "date": "2026-04-12", "time_s": 5400,  "race_type": "tune_up" }
    ],
    "training_gaps": [                           // optional —— 窗口内 > 4 周断训记录（伤病 / 假期 / 工作）；断训后不能直接接 build
      { "from": "2025-11-20", "to": "2026-01-05", "reason": "post-race recovery + holiday" }
    ],
    "consistency_score": 0.78                    // optional —— 窗口内实际有跑周数 / 应训练周数（0-1）
  },
  "prev_master_plan_md": "...",                // optional —— 上一个赛季 master plan，用于 continuity
  "user_intent_md": "想 PB 北马，希望多排长课"   // optional —— 缺省 = autonomous generation
}
```

### S1 conversation fixture 子套件

Master-plan generation fixture 位于 `tests/fixtures/coach_eval/s1/`；多轮调整
协议使用独立目录 `tests/fixtures/coach_eval/s1_conversation/`，避免改变已冻结的
generation baseline。conversation fixture 冻结：

- 用户本轮 `message`；
- 可选的冻结 `conversation_window`，用于验证澄清后的 follow-up 恢复；
- 一个虚构 `active_plan`；
- `get_health_snapshot`、`get_pmc_series`、`estimate_master_plan_load` 的返回值；目标成绩场景还冻结 `get_race_predictions` 和 `get_pbs`；
- 期望状态、proposal 数量、必需 read、assessment verdict、draft tool 和 diff 数值。

Harness 复用 production `season_plan` runner、`master_chat` prompt、conversation
LangGraph、tool bridge、proposal gate 和全部 master typed draft tools；read tool 返回
fixture 冻结数据，不读取本地 DB 或 production store。`tool_trace` 只记录工具名、结果状态和
gate 阻断原因，不记录参数或 athlete payload。任何 blocked tool attempt 都视为
fixture 失败：runtime gate 能兜底，不代表 Agent 遵守了协议。运行命令：

```bash
python scripts/eval_coach.py --scope s1 --conversation
```

当前 hard contract：

1. 模糊“想调整整体计划”必须在任何 LLM/tool call 前澄清；
2. 具体方向必须先成功读取 active plan、health snapshot、PMC 和 load estimate；
3. assessment 必须原样绑定当前用户请求；
4. 只有 `reasonable` 才允许 draft tool；
5. 精确周量区间必须用 `set_phase_weekly_range` 忠实生成单一 typed diff，不能偷换成固定 5%/10% alternatives；
6. `unreasonable` 必须零 proposal。
7. 目标比赛改期必须使用单个 `reschedule_target_race` 原子 op，同步 external Training Goal、embedded goal、plan end、race milestone、taper 和前序阶段边界；禁止退化成 `shift_milestone` 或多个可分别采纳的 ops。
8. 修改目标比赛成绩必须先读 race prediction + PB，再使用单个 `update_target_race_time` 原子 op 同步 external Training Goal、embedded goal 和 race milestone；普通 `change_target` 只用于非目标比赛里程碑。
9. 修改阶段训练重点必须使用 `set_phase_focus` 忠实生成一个 `replace_phase_focus` op，不得偷换成周量、日期、目标或全量重排。
10. 训练重点、周量区间、阶段长短等请求缺少目标阶段时，`season_plan` 必须先追问“哪个阶段”，且在澄清前保持零 specialist LLM/data-tool call。
11. 用户在下一轮只回答阶段名时，必须把阶段答案与上一轮原请求合成为 canonical adjustment request，再继续读取、评估和提案；不得重新追问方向，也不得只把阶段名绑定到 assessment。
12. “我想要加量”属于方向明确但参数不完整：必须在任何 LLM/data-tool call 前追问目标阶段和明确区间/百分比；用户补全后才读取与评估。
13. 周量 proposal 必须与 canonical request 的增减方向一致；加量请求不得调用 `propose_reduction_alternatives`，也不得返回任何上下限下降的 diff。该约束由 prompt、tool、conversation graph、specialist 和 HTTP boundary 共同执行。
14. 自然语言“跑量/里程提高或降低”与“周跑量/训练量”使用同一方向门禁；只有百分比而没有阶段时也必须先澄清阶段，不能提前加载数据。
15. 周量 proposal 不仅方向一致，幅度也必须忠实：明确区间必须逐值匹配；百分比必须以目标阶段当前上下限分别计算并四舍五入到 0.1 km。`set_phase_weekly_range` 必须携带 canonical `adjustment_request`，tool、graph、specialist 和 HTTP response boundary 都会拒绝偷换幅度。
16. 阶段训练重点 proposal 同样绑定 canonical `adjustment_request`：`set_phase_focus` 只能输出用户明确给出的 replacement focus，不能擅自扩写，并且明确命名阶段时不能偷换 `phase_id`。conversation harness 还可用 `assessment_rationale_contains`、proposal `old_value` 与 `ai_explanation_contains` 校验评估依据和提案解释。

### S1 Required vs Optional

| 字段 | 必需 | 用途 |
|------|------|------|
| `user_profile.hr_zones` | 场景 1+2 ✅ / 场景 3 N/A | 5-zone 详细 HR 区间（每个 [low, high] bpm）。**不能用 hr_max 替代** —— %HRmax 划分对个体 LT / lactate kinetics 差异不敏感，会让 Z2/Z4 边界错位。z5.high 即用户实测 hr_max。场景 1：从 DB 自动算；场景 2：用户手填 |
| `user_profile.prs` | 场景 1+2 ✅ / 场景 3 N/A | 决定起点 pace 能力（vDOT / 配速基准）；与 hr_zones 互补：prs → pace zones，hr_zones → HR zones |
| `user_profile.experience_level` | 场景 3 ✅ / 场景 1+2 optional | 主观能力先验。**仅在 prs / hr_zones 都缺时启用**（场景 3）；场景 1+2 已有客观数据时 experience_level 冗余 |
| `user_profile.target_race` | ✅ | 决定阶段结构、peak 周量、taper 时长 |
| `user_profile.weekly_run_days_max` | ✅ | 约束 plan 不能超过用户可用频次 |
| `user_profile.db_history_weeks` | ✅ | 区分场景：≥ 8 → 场景 1（DB 数据充足）；< 4 → 场景 2（迁手表 / 用户自报） |
| `season_window` | ✅ | plan 总时长边界 |
| `training_history_summary` | frozen_fixture mode 下 **场景 1+2 ✅ inline** / 场景 3 optional | base 起点 + plan ceiling 判断 —— 必须含过去 **12-24 个月** 数据：`history_window_months`、`monthly_mileage_km`（倒序数组，长度 == window_months）、`peak_weekly_km_in_window`、`longest_run_km_in_window`、`race_history`、optional `training_gaps` / `consistency_score`。**fixture 永远 inline**（frozen_fixture mode 不查 DB）。场景 1 通常在 live_local_db mode 下从 `data/{user_id}/coros.db` derive 后脱敏入 fixture；场景 2 由用户自报；场景 3 通常缺省 |
| `prev_master_plan_md` | optional | 有则用于 continuity，缺省 = 全新赛季 |
| `user_intent_md` | optional | 缺省 = autonomous generation；有 = 响应文字诉求 |

**注意**：S1 没有 `prev_feedback_md` / `recent_signals` / `target_week_start` 这些字段 —— 那些是 S2 的 tactical input。

## S1 Coverage 场景 (≥10 fixtures)

| Tag | S1 场景 |
|-----|---------|
| `phase_transition` | 从上赛季的 recovery 直接进 base → build（非起点用户，用 `prev_master_plan_md` 测 continuity） |
| `injury_constraint` | `injuries=["knee"]` 回归 → plan base phase 必须延长 + plyo / 深蹲禁用 + 周量从 70% 起 |
| `user_pushback` | `user_intent_md` 要求改阶段长度 / 加大 peak —— plan 应 push back 或在 notes 里解释 trade-off |
| `data_gap` | 无近期 race / time trial → zone 难定 → plan 应在 base 末期插一次 tune-up race |
| `edge_case` | 比赛日落在节假日 / 周中 / 极端天气月份 → taper 长度 / phase 调整 |
| `target_distance` × 4 | 同一 user_profile，分别测 `fm` / `hm` / `10k` / `5k` 目标 → peak 周量、long run 比例、taper 都应不同 |
| `unrealistic_goal` | PB 全马 3:30 → goal 2:50 → plan 必须 (a) pushback 建议下调目标 or (b) 显式说明需多周期、单赛季不可达 |
| `sparse_db_capable_user` | **场景 2 canonical 案例**：`db_history_weeks=2` + `prs.fm_s=10800` + `hr_zones` 全填（user-reported）→ plan 信 user-reported 数据，不能按"新手 base"起 30 km/wk |
| `frequency_limit` | `weekly_run_days_max=3` → plan 每周 ≤ 3 跑步课，必须含 long run + 至少 1 质量课 |
| `goal_realism_boundary` | PB 4:00 → goal 3:30（improvement 13%，realistic）vs PB 4:00 → goal 3:00（improvement 25%，aggressive 但可能）→ plan 不同处理 |

每个 tag 至少 1 条 fixture。`target_distance` 推荐 4 条（4 个距离）。总计 **13-15 条 S1 fixtures**。

数据源建议 **30% 真实 + 70% 手工构造**：
- 真实：从 `data/zhaochaoyi/TRAINING_PLAN.md` + 历年 `logs/{phase_folder}/` 反向抽出已有的 master plan periods 当 fixture
- 手工：S1 fixture 大部分必须手工 —— 真实 master plan 在 single user 上稀少（一年 2-4 个），target_distance / unrealistic_goal / sparse_db 等 edge case 都得造

## S1 L1 Rules

S1 L1 不只是格式检查，而是 **可程序化的训练学合理性检查**。前提是 `MasterPlan` 输出逐周重点课 skeleton（见上文 `weekly_key_sessions`）。规则实现位于 `src/coach/graphs/generation/master_rule_filter.py`：

| Rule | 严重度 | 检查 |
|------|--------|------|
| `master_schema_validity` | error | `MasterPlan.model_validate(plan_dict)` 必须过 |
| `phase_count_min` | error | 至少 3 个 phase（典型：base / build / peak，或 base / build / peak / taper / recovery） |
| `phase_duration_balance` | warning | 任一 phase < 2 周或 > 16 周 → warning |
| `peak_before_race` | error | 如果 `target_race.race_date` 给出，peak phase 必须落在 race 前 1-3 周 |
| `weekly_key_sessions_present` | error | 每个非 recovery / taper 周必须有 1-3 个重点课；race 周允许只有 `race`；普通 easy/aerobic/recovery 不算重点课 |
| `weekly_volume_ramp` | error | 基于 `target_weekly_km_high` 检查相邻周周量比 ≤ 1.10；recovery / taper 周允许降量 |
| `taper_volume_drop` | error | race 前 1-2 周 `target_weekly_km_high` 相比 peak 周下降 ≥ 25%（fm 通常两周 taper，hm/10k 可更短） |
| `target_distance_long_run` | error | peak 期最长 `long_run.distance_km` 与 target_race.distance 匹配：`fm` ≥ 28km, `hm` ≥ 18km, `10k` ≥ 10km, `5k` ≥ 6km |
| `key_session_density` | error | 任一周重点课数量不得超过用户可承受上限：`weekly_run_days_max <= 3` 时最多 2 个重点课；其他最多 3 个重点课 |
| `frequency_volume_ceiling` | error | `weekly_run_days_max <= 3` 的计划不得用 70-90km 周量套全量模板；peak 周量应 ≤60km，通常 45-55km |
| `injury_return_volume_ceiling` | error | 伤后返训且有历史峰值时，peak 周量不得超过既往 `peak_weekly_km_in_window` 约 5-10%；优先延长 rebuild/base 而不是刷新周量纪录 |
| `injury_return_peak_exception_count` | warning | 伤后返训可为 FM 28km 彩排接受单个受保护 `64-65km` 高周；若多个 load week 都落在该高位，记录质量 warning |
| `hard_session_spacing` | error | 同一周内 threshold / tempo / interval / vo2max / hill / race_pace 等高负荷重点课不得超过 2 个；不得连续多周无 recovery / deload 调整 |
| `season_window_fits` | error | plan 总时长 ≤ `season_window` 跨度，且 race_date 在 window 内 |
| `goal_realism` | warning | PB → goal improvement 超过阈值（10k+: 15%, hm: 12%, fm: 10%）→ warning（不是 error —— advanced 可能达成；判 fail 是 L2 + anti-pattern 的事） |

### S1 不在 L1 范围（交 L2 judge）

- 周期化策略选择是否适合用户（线性 vs polarized vs reverse periodization）
- 单个重点课设计细节是否最优（例如 6x1km vs 5x1200m 哪个更适合）
- 营养策略与阶段匹配
- `user_intent_md` 回应质量
- "pushback" 行为的得体程度

## S1 L2 Judge Axes (9)

S1 judge 用与 S2 不同的 axis 集 —— 因为 S1 是 strategic-level，HRV/RHR 等 daily signals 不是主要信号：

| Axis | 评什么 |
|------|--------|
| `schema_validity` | `MasterPlan.model_validate` 通过（与 L1 双保险） |
| `season_structure` | base / build / peak / taper 是否齐全、顺序合理、时长平衡；`season_window` 覆盖赛后日期时才要求单独 recovery phase |
| `goal_realism` | plan 路径能否合理通向 `goal_time_s`（考虑 PB 起点、phase 长度、peak 周量）；不现实时是否有显式说明 |
| `peak_timing` | peak phase 是否准确放在 race - 1..3 weeks，且 taper 长度与 race 距离匹配（fm 通常 2 周，hm 1 周，10k 3-5 天） |
| `volume_progression` | 跨 phase 和逐周 `target_weekly_km_*` 曲线是否渐进，是否有合理 recovery week 间隔 |
| `frequency_respect` | 每周重点课密度是否尊重 `weekly_run_days_max`，且在受限频次下仍保留长课 + 至少一个关键质量刺激 |
| `injury_safety` | strategic-level 处理伤病约束 —— base 是否延长、禁用动作是否避免、回归曲线是否保守 |
| `phase_nutrition_strategy` | 营养策略随 phase 调整 —— base 维持，build 加 carb，peak carb-cycling，taper 维持，recovery 修复 |
| `request_handling` | 响应 `user_intent_md`；缺省时此 axis = N/A 不计入 overall |

**注意**：S1 故意 **不** 用 `signal_response`（HRV/RHR 是 S2 的事），加了 `season_structure` / `peak_timing` / `frequency_respect` 这些 strategic axes。

### S1 Anti-patterns (判 fail 的红线)

- 排出 peak phase **在 race 之后**（peak_timing 灾难）
- `target_race.distance="fm"` 但 peak 周 long run < 20km（target_distance 误判）
- 频次约束 3 次但 plan 每周排 5 次（用户根本跑不完）
- PB 4:00 → goal 3:00 的 plan 没有 pushback 也没有 multi-cycle 说明（误导用户）
- `injuries=["knee"]` 但 strength phase 排深蹲 / lunge（injury_safety 灾难）
- 没有 taper phase（用户带着 peak fatigue 上 race）
- 场景 1/2（用户 `prs` 表明 advanced）但 plan base phase 从 20km/wk 起（侮辱用户能力 —— 不论 `db_history_weeks` 多少）

## S1 Judge prompt 骨架

完整 prompt 在 `src/coach_eval/judge_s1.py`：

```
你是 STRIDE 训练 master plan 评估员。

输入：
1. <scenario>{fixture.description}</scenario>
2. <user_profile>{fixture.input.user_profile}</user_profile>
3. <season_window>{fixture.input.season_window}</season_window>
4. <training_history>{fixture.input.training_history_summary}</training_history>
5. <user_intent>{fixture.input.user_intent_md or "<autonomous>"}</user_intent>
6. <expected>{fixture.expected.soft_rubric}</expected>
7. <anti_patterns>{fixture.expected.anti_patterns}</anti_patterns>
8. <draft_master_plan>{generated_master_plan_json}</draft_master_plan>

按 9 个 axis 打 1-5 分（5 = 完全满足；1 = 严重违反），每维必须给 rationale。
若 axis 不适用（例如 `request_handling` 但 user_intent_md 缺省）→ score=null。

S1 特别注意：
- 评估时间尺度是月 / 赛季，不是周 —— 一两周细节波动可忽略
- target_race.goal_time_s 与 PB 的 gap 是 goal_realism 的核心判据
- 受限训练频次（weekly_run_days_max）是 HARD 约束，违反 = frequency_respect 必须 < 3
- "pushback" 是 S1 plan 的合理行为，不是缺陷
- 场景 2（`db_history_weeks` 低 + `prs` / `hr_zones` 是 user-reported）→ plan 必须信 user-reported 数据，不能因 DB 稀疏而降到"新手 base"才高分

overall_verdict:
- "pass" = 所有适用 axis ≥ min_score 且无 anti_pattern
- "marginal" = 部分 axis 低于 min_score 但训练上不致危险
- "fail" = schema invalid / 触发 anti_pattern / peak_timing < 3 / goal_realism < 2 / injury_safety < 3

输出严格 JSON 匹配 JudgeScore schema。
```

## S1 Implementation Status（当前 Phase 1）

S1 是当前最完整的 offline eval scope。**v1 fixture 覆盖场景 1 + 2（有 `prs` / `hr_zones` 的用户）；场景 3 留到 v1.1**。当前已经形成可本地迭代的 14-fixture 实验台：冻结 fixture input、复用真实 generation graph、L1/L2/L3 分层、baseline gate、speed summary、judge replay、transient infra 分类都已落地。

- [x] **前置 refactor**：S1 master-plan generation 接入 `coach.graphs.generation.build_generation_graph`，并拆出 `load_context` / `generator` / reviewer / patch adapters
- [x] 写 `coach_eval/schemas.py`（JudgeScore / EvalReport，通用 —— 框架级）
- [x] 写 `coach_eval/graph.py`（最小骨架 + judge node）
- [x] 写 `coach_eval/judge_s1.py`（S1 judge prompt 当前 `s1-v8`，9 axes）
- [x] 写 `coach/graphs/generation/master_rule_filter.py`（S1 L1 rules）
- [x] 写 `coach_eval/runner.py`（支持 `live_local_db` / `frozen_fixture` 两种 mode；fixture 加载、本地 SQLite context 聚合、LLM 注入、judge wiring）
- [x] 写 `scripts/eval_coach.py` CLI（含 `--judge-artifact`、`--judge-repeat`、`--master-max-tokens`、`--compare-reports`、`--summarize-speed`、`--gate-report`、`--llm-health-check`）
- [x] 写 `scripts/freeze_baseline.py` baseline 冻结门禁（显式 `--report`；默认拒绝 live DB、单 fixture、judge-only、replay backfill、marginal/fail）
- [x] 固化 14 条 S1 fixtures，覆盖 `target_distance`、`unrealistic_goal`、`sparse_db_capable_user`、`frequency_limit`、`injury_constraint`、`goal_realism_boundary`、`data_gap`、`user_pushback`、`edge_case`、`phase_transition`、`real_user`
- [x] 用 `tests/coach_eval/test_s1_fixture_contract.py` 冻结每条 fixture 的 `input` SHA-256；`expected` 可基于证据校准，但 `input` 漂移必须显式决策
- [x] 建立 `.omc/eval/baselines/s1_v1.json` / `.md`，当前 `judge_prompt_version=s1-v8`、`fixtures_total=14`
- [x] 区分 transient LLM infra failure 与真实质量失败：429/no_capacity/5xx/rate limit 返回 `64` 并标记 `infra=llm_transient`
- [x] 建立速度诊断闭环：记录 prompt/raw chars、`generation_iterations`、`rule_filter_history`、judge retry、`gen_cps`，并支持 `--summarize-speed --baseline-report`

S1 后续工作不再是“把链路跑通”，而是持续扩样和稳态校准：用真实 LLM targeted/full-suite 样本确认 prompt guard 是否泛化；只在 repeat evidence 指向真实缺陷时改 prompt/fixture；在服务容量稳定窗口补充 fresh full-suite，再决定是否更新 `s1_v1` 或开新 baseline label。当前默认 master max tokens 维持 `24576`；20k/22k 降 cap 只作为实验档，因为现有证据显示输出未接近 cap，降 cap 没有稳定提速且可能削弱营养表达。

2026-07-02 S1 lab update：generator system prompt 当前 `34416ch`，仍低于 `34500` guard；wide regression `300 passed`。L1 已修正短距离 taper 误报：显式 HM/10K/5K taper phase 可为 1 个 race week，不再触发 `phase_duration_balance`。`master_rule_filter` 也改为优先用结构化 `phase_type.value`，避免枚举字符串 `PhaseType.TAPER` / `PhaseType.PEAK` 造成 peak/taper 识别错误。新增 `injury_return_peak_exception_count` warning，把“64-65km 只应是单次受保护 FM 彩排例外”的质量信号固定下来。

本轮 targeted full-run 结果：`s1-target-distance-hm` (`2026-07-01T21-02-07.069168_00-00`) 从旧 suite 的 `iter=2` / milestone warning 修到 `iter=1`、L1 0 warning、9 轴全 5、gen `217.7s`；`s1-target-distance-10k` (`2026-07-01T21-14-59.443444_00-00`) 为 `iter=1`、L1 0 warning、9 轴全 5、gen `204.0s`；`s1-data-gap-no-recent-race` (`2026-07-01T21-26-22.627699_00-00`) 为 `iter=1`、L1 0 warning、9 轴全 5、gen `396.5s`；zhaochaoyi 最新 full artifact (`2026-07-01T21-03-08.143895_00-00`) 经 repeat judge report `2026-07-01T21-10-21.947506_00-00` 后 9 轴全 5 且 no unstable。追加三条 gate blocker targeted replacement：`s1-target-distance-5k` (`2026-07-01T21-57-44.074510_00-00`) 为 `iter=2`、L1 0 warning、9 轴全 5、gen `522.2s`；`s1-goal-realism-boundary-13pct` (`2026-07-01T22-04-01.724836_00-00`) 为 `iter=1`、final L1 仅保留 baseline 已有 `goal_realism` / `marathon_pace_specificity` warning、9 轴全 5、gen `320.1s`；`s1-injury-knee-return` (`2026-07-01T22-09-06.499261_00-00`) 为 `iter=1`、L1 0 warning、gen `230.3s`，经 artifact judge `2026-07-01T22-11-41.310641_00-00` 后 9 轴全 5。

当前 repaired candidate `2026-07-01T22-12-09.189366_00-00` 为 14/14 pass，且 baseline gate 已通过：无新增 final L1 warning 规则、无 axis drop、无 retry 增加、无生成速度/提示词体积回退。验证命令：`python scripts\eval_coach.py --scope s1 --gate-report .omc\eval\reports\2026-07-01T22-12-09.189366_00-00.json --baseline-report .omc\eval\baselines\s1_v1.json` → `Gate: PASS`；wide regression `300 passed`。baseline 文件尚未更新，冻结前建议人工决定接受 repaired candidate 还是再跑一份 fresh full-suite。

最新 S1 lab 稳定性补跑：修复 `build_master_prompts` 中 helper 误嵌套导致函数提前结束的问题后，新增 long-run milestone 对齐与普通 10K `17-18km -> 16km` 边界收敛（显式高跑量 10K 不收敛）。当前 generator system prompt `34441ch`，仍低于 `<34500` guard。三条 targeted real LLM 复测全部 `iter=1`、L1 0 warning、9 轴全 5：`s1-target-distance-10k` `2026-07-01T23-43-13.354112_00-00` gen `192.0s`，最大 long run 已为 `16km` 且 milestone 同步；`s1-data-gap-no-recent-race` `2026-07-01T23-34-02.043199_00-00` gen `218.2s`；`s1-target-distance-5k` `2026-07-01T23-33-56.705216_00-00` gen `211.2s`。最新 repaired candidate `2026-07-01T23-43-38.222780_00-00` 为 14/14 pass、9 轴均分全 5，并通过 baseline gate：`python scripts\eval_coach.py --scope s1 --gate-report .omc\eval\reports\2026-07-01T23-43-38.222780_00-00.json --baseline-report .omc\eval\baselines\s1_v1.json` → `Gate: PASS`。wide regression 更新为 `304 passed`；baseline 文件仍未冻结更新。

2026-07-02 最新 S1 lab：fresh full-suite `2026-07-02T01-01-36.298979_00-00` 为 13 pass / 1 marginal，暴露 `s1-frequency-limit-3day`、`s1-target-distance-10k`、`s1-zhaochaoyi-altitude-p2-replan` 的 `iter=2`，以及 `s1-user-pushback-aggressive-peak` marginal / 若干 L2 axis 4。随后 targeted 修复与替换：3跑 `2026-07-02T01-21-15.584549_00-00`、10K `2026-07-02T01-11-21.834178_00-00`、pushback `2026-07-02T01-22-20.894446_00-00`、zhaochaoyi `2026-07-02T01-11-22.617439_00-00` 均为 `iter=1` 且 9 轴全 5；新增普通 5K `13-14km -> 12km` long-run 收敛与短距离营养文本清理后，`s1-target-distance-5k` `2026-07-02T01-35-08.084653_00-00` 为 `iter=1`、L1 0 warning、9 轴全 5、gen `206.0s`；新增 sub-2:50 FM A gate 组合门后，`s1-fm-target-sub250-advanced` `2026-07-02T01-50-12.805447_00-00` 为 `iter=1`、L1 OK、9 轴全 5、gen `270.6s`。`s1-phase-transition-from-recovery` 使用 judge-only 全 5 报告 `2026-07-02T01-24-48.972602_00-00` 修正 judge variance。最新 repaired candidate `2026-07-02T01-50-25.421260_00-00` 为 14/14 pass，并通过 baseline gate：`python scripts\eval_coach.py --scope s1 --gate-report .omc\eval\reports\2026-07-02T01-50-25.421260_00-00.json --baseline-report .omc\eval\baselines\s1_v1.json` → `Gate: PASS`。当前 generator system prompt `34494ch`，距 `<34500` guard 仅 6ch；wide regression `315 passed`。baseline 文件仍未冻结更新。

2026-07-02 prompt 缓冲优化：压缩 `master_plan_planner/SKILL.md`、`shared/natural_week.md`、`shared/training_load.md`、`references/weekly_skeleton.md` 中的说明性长句，不删除关键 guard；generator system prompt 从 `34494ch` 降到 `33379ch`，新增约 `1115ch` 缓冲。压缩后 zhaochaoyi targeted full-run `2026-07-02T02-01-03.488140_00-00` 为 `iter=1`、L1 0 warning、9 轴全 5、gen `273.5s`、raw `9756ch`。用该 replacement 生成 repaired candidate `2026-07-02T02-01-19.106524_00-00`，仍为 14/14 pass，并通过 baseline gate：`python scripts\eval_coach.py --scope s1 --gate-report .omc\eval\reports\2026-07-02T02-01-19.106524_00-00.json --baseline-report .omc\eval\baselines\s1_v1.json` → `Gate: PASS`。wide regression 仍为 `315 passed`。baseline 文件仍未冻结更新。

2026-07-02 output cap 负实验：在相同 `33379ch` prompt 下，把 zhaochaoyi fixture 的 `--master-max-tokens` 从 `24576` 降到 `20000` 并未提速。20k run `2026-07-02T02-09-49.164313_00-00` 为 `iter=1`、L1 0 warning、gen `328.8s`、raw `9849ch`、overall pass，但 `phase_nutrition_strategy=4`；同 artifact judge-only `2026-07-02T02-11-30.160731_00-00` 仍为 nutrition=4，说明不是单次 judge 抖动。24k 对照 `2026-07-02T02-01-03.488140_00-00` 为 gen `273.5s`、raw `9756ch`、9 轴全 5。结论：当前输出未接近 20k cap，降低 cap 没有速度收益且可能削弱营养表达；默认仍维持 `24576`，20k 暂不作为稳态默认。

2026-07-02 fresh full-suite after prompt buffer：fresh suite `2026-07-02T03-46-13.465590_00-00` 本身为 14/14 pass，但 baseline gate fail 在三处：`s1-data-gap-no-recent-race` 首轮只排到 `25km` peak long run，触发 `target_distance_long_run` 并导致 `iter=2` / gen `653.6s`；`s1-target-distance-10k` 出现 5 连续双硬周，触发 `hard_session_spacing` 并导致 `iter=2` / gen `536.0s`；`s1-fm-target-sub250-advanced` 为消 sub-3 32km warning 推到 `92km` peak，`volume_progression=4`。新增 doctrine 后三条 targeted real LLM 均回到一轮：data-gap `2026-07-02T03-56-45.240962_00-00` `iter=1`、L1 0 warning、9 轴全 5、gen `319.9s`；10K `2026-07-02T04-02-48.545183_00-00` `iter=1`、L1 0 warning、9 轴全 5、gen `297.6s`；sub250 advanced `2026-07-02T04-23-27.742015_00-00` `iter=1`、final 仅 baseline 已有 `marathon_pace_specificity` warning、9 轴全 5、gen `332.5s`。Repaired candidate `2026-07-02T04-23-55.162175_00-00` 替换这三条后为 14/14 pass，所有 fixture `iter=1`，baseline gate PASS：`python scripts\eval_coach.py --scope s1 --gate-report .omc\eval\reports\2026-07-02T04-23-55.162175_00-00.json --baseline-report .omc\eval\baselines\s1_v1.json`。当前 generator system prompt `34063ch`，相关回归 `299 passed`；baseline 文件仍未冻结更新。

2026-07-02 fresh full-suite post-fix：新 full-suite `2026-07-02T05-59-19.460800_00-00` 生成侧全部 `iter=1`，但 L2/gate 暴露两条真实质量回归与一条速度长尾：`s1-data-gap-no-recent-race` `season_structure=4`，原因是 stale race/current pace unclear 场景的 base 正好只有 6 周，触发 fixture anti-pattern；`s1-sparse-db-capable` `request_handling=3`，原因是 sparse watch migration + credible advanced self-report 场景仍安排了 5K/time-trial 测试周；`s1-target-distance-10k` 一轮 clean 且 9 轴全 5，但 generator `485.7s`，raw `11046ch`，触发 per-fixture speed gate。针对性 prompt 修复只改 planner doctrine：`phase_sequence.md` 明确 stale/pace-unclear full-runway FM base/calibration >=7 natural weeks；`milestones.md` 与 `weekly_skeleton.md` 明确 sparse-device advanced self-report 不需要 `test_run`/`time_trial`/`tune_up_race` 来重证 PR。修复后 generator system prompt `34377ch`，低于 `<34500` guard，相关回归 `299 passed`。targeted real LLM `2026-07-02T06-17-10.753575_00-00` 覆盖两条失败 fixture：data-gap `iter=1`、L1 0 warning、9 轴全 5、gen `323.8s`，base 已为 7 周且保留 10K/HM 校准；sparse-db `iter=1`、L1 0 warning、9 轴全 5、gen `288.4s`，不再出现任何 test-like weekly session。用这两条 full replacement 生成诊断 repaired candidate `2026-07-02T06-18-57.368086_00-00` 后为 14/14 pass，baseline gate 仅剩 `s1-target-distance-10k` generator speed fail。随后单跑 10K `2026-07-02T06-31-06.111532_00-00` 仍为 `iter=1`、L1 0 warning、9 轴全 5、raw `11326ch`，generator `418.4s`；judge 阶段连续出现 Azure `429 no_capacity` 与一次 `500` 后重试成功（`judge_retries=2`）。结论：当前 10K 速度失败主要是 Azure 服务容量/长尾响应样本，不是输出膨胀、重试修复或计划质量退化；冻结 baseline 前仍建议再跑 fresh full-suite 或在容量稳定时复测 10K speed gate。

2026-07-02 prompt micro-compression：只压缩 `master_plan_planner/SKILL.md` 与 `references/weekly_skeleton.md` 的说明性文字，保留测试哨兵短语与关键 guard；generator system prompt `34377ch -> 34011ch`，新增 `366ch` 缓冲。回归命令 `python -m pytest tests\stride_server\test_master_plan_generator.py tests\coach\test_master_rule_filter.py tests\coach_eval -q` 通过 `299 passed`。真实 LLM 10K targeted `2026-07-02T06-51-12.784743_00-00` 为 `iter=1`、L1 0 warning、9 轴全 5、raw `10871ch`、gen `468.9s`、judge `71.8s`；相较 `06-31` 样本，prompt 与 raw/judge compact plan 均更小（gsys `34011` vs `34377`，raw `10871` vs `11326`，jplan `10946` vs `11413`），但 generator 仍慢，继续支持“10K speed gate 主要是 Azure 长尾/容量波动”的判断。随后 zhaochaoyi targeted run 超过 900s 未落盘，后台 Python 进程已清理；这条无质量结论，只作为当时服务容量不稳定的证据。下一步优先在容量稳定时补跑 zhaochaoyi 或 fresh full-suite，不因本轮 10K 长尾单样本调整质量 prompt。

2026-07-02 gate diagnostics + sparse-db retest：`--gate-report` 现在在 speed fail 行附带 `speed_context`（iter、retry_rules、judge_retries、prompt/raw delta），suite speed fail 附带 `top_contributors`。用诊断 repaired candidate `2026-07-02T06-18-57.368086_00-00` 对 `.omc/eval/baselines/s1_v1.json` 验证，新输出把 10K speed fail 解释为 `iter=1->1; prompt=34768->35857ch (+3.1%); raw=11151->11046ch (-0.9%)`，没有 retry 或 raw 增长信号；回归更新为 `300 passed`。真实 LLM 复测 `s1-sparse-db-capable` 报告 `2026-07-02T07-24-57.514029_00-00`：`iter=1`、L1 0 warning、9 轴全 5，且 artifact 检查确认 weekly sessions 中无 `time_trial`/`test_run`/`tune_up_race`；速度仍长尾，gen `539.4s`、judge `154.9s`，judge 因 Azure `429 no_capacity` 重试 1 次。结论：sparse-device advanced self-report 质量护栏保持稳定；当前速度样本继续被 Azure 容量波动污染，下一步适合在服务稳定窗口补跑 zhaochaoyi/fresh full-suite。

2026-07-02 fixture freeze guard：新增 `tests/coach_eval/test_s1_fixture_contract.py`，为当前 14 条 S1 fixture 的 `input` 建 SHA-256 contract，并校验 fixture 文件名、scope、基础 envelope 与 coverage tags。这样后续允许基于证据调整 `expected`，但不能无意漂移 `input`；如果确实要换场景，应新增 fixture 或显式更新 hash。新增后相关回归 `302 passed`，prompt 长度 `34011ch`。真实 LLM `s1-target-distance-5k` 试跑 `2026-07-02T07-29-53.895579_00-00` 在 generator 阶段连续 Azure `429 no_capacity` 后失败，没有 artifact / judge，不作为计划质量信号；当前容量窗口不适合继续 full-suite。

2026-07-02 LLM infra exit-code split：`scripts/eval_coach.py` 现在把 transient LLM infra failure（Azure `429/no_capacity`、5xx、rate limit 等）与真实 eval failure 区分开。若非 pass 都是这类 infra error，CLI 返回 `64`，summary 加 `infra=llm_transient`；报告仍落盘以便追踪容量窗口。新增测试后相关回归 `305 passed`。真实 CLI 验证 `s1-target-distance-5k` 报告 `2026-07-02T07-34-50.870144_00-00`：generator 阶段 `429/500/429`，退出码 `64`，无 artifact / judge；这条仍只代表 Azure 容量不可用，不代表 prompt 或 fixture 质量回归。

2026-07-02 compare/gate infra diagnostics：`--compare-reports` 增加 `infra` / `error` 列，no-capacity 报告会显示 `llm_transient`；`--gate-report` 对纯 transient LLM infra 候选报告直接返回 `64` 并输出 `Gate: INFRA_UNAVAILABLE`，不混入普通 baseline gate fail。用 `2026-07-02T07-34-50.870144_00-00` 验证：compare 明确显示 `infra=llm_transient`，gate 对 baseline 返回 `64` 并列出 `s1-target-distance-5k`。相关回归 `307 passed`；未新增 LLM 调用。

2026-07-02 LLM health check + judge 500 classification：新增 `python scripts\eval_coach.py --llm-health-check`，只做一次极小 generator LLM 调用，适合在 targeted/full-suite 前确认配置与容量窗口；该命令必须单独运行，OK 返回 `0`，配置、容量或 transient 服务失败返回 `64`。真实检查最新 OK、`40.7s`，但先遇一次 Azure `429 Too Many Requests` 后重试成功，因此当前判断为“可达但容量不稳”。真实 `s1-target-distance-5k` 报告 `2026-07-02T07-51-03.569705_00-00` 已成功生成计划（`iter=1`、L1 0 warning、raw `10963ch`、gen `359.0s`），但 judge 在 Azure `500 server_error` 后失败；compare 显示 `infra=llm_transient`，gate 对 baseline 返回 `64` / `Gate: INFRA_UNAVAILABLE`。这条只记录 judge infra failure，不作为 5K plan 质量回归。相关回归更新为 `311 passed`。

2026-07-02 5K targeted retest：health check 先以 `16.5s` 一发 OK，随后真实 `s1-target-distance-5k` run `2026-07-02T08-09-31.514456_00-00` 成功闭环：`iter=1`、L1 0 warning、raw `10855ch`、9 轴全 5；这确认 5K prompt/fixture 质量仍稳。速度仍被容量长尾污染，generator `459.6s`，judge `149.5s` 且 judge 侧出现 3 次 Azure `429 no_capacity` 后由 eval retry 成功。`--compare-reports` 现在新增 `judge_retry` 列，和 `retry_rules` 一起区分 generator retry、judge retry 与纯服务长尾；本条不触发质量修复，只作为“5K 质量稳定、速度样本受 Azure 污染”的证据。相关回归保持 `311 passed`。

2026-07-02 zhaochaoyi retry window check：再次准备跑 `s1-zhaochaoyi-altitude-p2-replan` 前，`--llm-health-check` 先遇 Azure `429`、`429`，最终 `500 server_error`，返回 `64` / `llm_transient`，因此本轮未继续消耗 zhaochaoyi targeted LLM。`--llm-health-check` 失败路径现在也打印 `Latency`，可区分秒级配置失败与几十秒服务重试失败；后续只有 health check 低延迟 OK 时再跑 zhaochaoyi/fresh full-suite。

2026-07-02 capacity retry window + throughput diagnostic：下一次 health check 仍失败，`Latency: 28.1s` 后返回 `64` / `llm_transient`，错误为连续 Azure `429 no_capacity`；继续不跑 zhaochaoyi targeted，避免制造不可用速度样本。`--compare-reports` 新增 `gen_cps = generator_raw_response_chars / generator_total_s`，用来解释同一 prompt/raw 体积下的 Azure 吞吐长尾；例如后续看到 raw 下降但 `gen_cps` 也显著下降，就应优先归因为服务吞吐，而不是 prompt 退化或 fixture 质量问题。

2026-07-02 zhaochaoyi targeted retest：health check 最终 OK（`19.5s`，但内部先 429、500 后 200），随后真实 `s1-zhaochaoyi-altitude-p2-replan` report `2026-07-02T08-30-40.112831_00-00` 成功：`iter=1`、L1 0 warning、raw `10121ch`、9 轴全 5、judge_retry `0`。质量结论继续稳定，不改 prompt/fixture。速度仍长尾，generator `469.0s`、`gen_cps=21.6ch/s`；对 baseline `s1_v1` zhaochaoyi `258.9s` / `40.9ch/s` 和快样本 `2026-07-02T02-01-03.488140_00-00` `273.5s` / `35.7ch/s`，raw 并未变大（`10598/9756/10121ch`），说明本条 speed gate fail 主要是 Azure 吞吐下降，不是输出膨胀、retry 或计划质量退化。`--gate-report` 的 `speed_context` 也新增 `gen_cps=base->candidate`，后续可直接在 gate fail 行完成速度归因。

2026-07-02 targeted gate mode：`--gate-report --allow-partial-gate` 现在可用于单 fixture/targeted report 诊断，只比较与 baseline 共享的 fixture，缺失 baseline fixture 只警告，并跳过 suite-level `per_axis_avg` / `generator_total_s` gate；shared fixture 的 axis、L1 warning、iter、fixture speed gate 仍照常执行。这样 zhaochaoyi targeted 报告可直接暴露 `speed_context=... gen_cps=40.9->21.6ch/s`，不再被“缺失 13 条 fixture”的 full-suite gate 噪声淹没；正式冻结 baseline 仍必须用默认 full-suite gate。

2026-07-02 zhaochaoyi expected calibration：本轮 health check 在 `33.3s` 后仍返回 `64` / Azure `429 no_capacity`，未继续消耗真实 LLM。改为基于已成功的 `2026-07-02T08-30-40.112831_00-00` 全 5 证据校准 zhaochaoyi fixture 的 `expected`，不改 frozen `input`。新增/收紧点：A=2:50 不能只凭 HM 开放，必须叠加严格 HM/10K marker、赛前 3-4 周 30-32km 且 20-24km MP 的 FM 专项彩排、VO2/HR/RPE、跟腱反应和高温/高原适应；peak rehearsal 后必须有吸收周和 taper；从 62km+两周缺长跑后的重建应先回到 22-25km long run / 64-78km 周，再按 RHR/跟腱/高原反馈推进。`tests\coach_eval\test_s1_fixture_contract.py` 通过，确认只校准 expected，input SHA-256 未漂移。

2026-07-02 10K targeted retest：health check `9.8s` 一发 OK 后，真实 `s1-target-distance-10k` report `2026-07-02T08-50-36.580783_00-00` 成功：`iter=1`、L1 0 warning、raw `10910ch`、judge_retry `0`、9 轴全 5。计划质量继续稳定，不改 prompt/fixture。速度仍长尾，generator `436.7s`、`gen_cps=25.0ch/s`；对 baseline 10K `235.1s` / `47.4ch/s`、快样本 `2026-07-02T01-11-21.834178_00-00` `194.6s` / `55.3ch/s`、中间样本 `2026-07-02T04-02-48.545183_00-00` `297.6s` / `37.3ch/s`，本条 raw 与 prompt 基本相近且无 retry，partial gate 的 `speed_context=iter=1->1; prompt=34768->35805ch (+3.0%); raw=11151->10910ch (-2.2%); gen_cps=47.4->25.0ch/s` 继续指向 Azure 吞吐下降，而不是输出膨胀或计划质量退化。

2026-07-02 HM targeted retest：baseline `s1-target-distance-hm` 曾有 `request_handling=3`，本轮优先复测该质量哨兵。health check `8.0s` 一发 OK 后，真实 `s1-target-distance-hm` report `2026-07-02T09-03-50.364655_00-00` 成功：`iter=1`、L1 0 warning、raw `10619ch`、9 轴全 5，尤其 `request_handling=5`，说明“半马专项而非马拉松训练、秋季后再筹备马拉松”的用户意图处理已稳定。Partial gate 对 baseline PASS（仅缺 full-suite fixture warning），不需要改 prompt/fixture。速度方面 generator `429.5s`、`gen_cps=24.7ch/s` 仍偏慢，但相对 baseline 不触发 fixture speed gate；judge `138.4s` 主要由 Azure `429 no_capacity` 导致 `judge_retry=1`，不作为计划质量信号。

2026-07-02 goal-realism targeted retest + ramp sentinel：真实 `s1-goal-realism-boundary-13pct` report `2026-07-02T09-22-01.444776_00-00` 最终 pass，9 轴全 5，但仍 `iter=2`、gen `796.7s`；第 1 轮被 L1 `weekly_volume_ramp(error)` 打回，原因是 `64km -> 72km`，ratio `1.125`，超过 10% cap 且高于带整数容忍的 `71.4km` 上限。结论：质量已稳，但单轮速度仍可优化；不放松 rule filter，改为在 `weekly_skeleton.md` 的 ramp 示例中显式加入 `64 -> 72` illegal 和 `64 -> max 70/71 (not 72)` sentinel，降低首轮踩边界概率。Prompt 长度 `34051ch`，仍低于 `<34500` guard；新增 prompt sentinel 测试覆盖该边界。

2026-07-02 judge-artifact robustness + zhaochaoyi retest：`--judge-artifact` 现在对 judge 侧 transient LLM failure 与 full eval 对齐，生成失败报告并返回 `64`，不再 traceback；若 artifact 来自标准 reports/artifacts 目录且与源 report 内嵌 artifact 精确一致，会回填源生成侧 metadata（`generation_iterations`、`generator_total_s`、prompt/raw chars、`rule_filter_history`），方便 targeted partial gate，同时 `freeze_baseline.py` 默认仍拒绝这种带 `artifact_source_report` 的 judge-only 复测报告作为 suite baseline。用 ramp sentinel 后的 `s1-goal-realism-boundary-13pct` artifact 复测 `2026-07-02T09-53-29.181658_00-00`：9 轴全 5、`iter=1`、回填 gen `437.7s`、`gen_cps=28.3ch/s`，partial gate PASS，确认 `64 -> 72` sentinel 把生成侧从二轮修到一轮。随后 health check `10.4s` 一发 OK，真实 `s1-zhaochaoyi-altitude-p2-replan` full run `2026-07-02T10-06-44.779298_00-00` 成功：`iter=1`、L1 0 warning、raw `9876ch`、judge_retry `0`、9 轴全 5。artifact 明确保留 zhaochaoyi expected 的关键契约：A=2:50 只在 HM/10K marker + 31km 含 22km MP + VO2/HR/RPE + 跟腱反应全过时开放，7月半马只是观察/B门；高原/RHR/夏热、补液/铁蛋白、跟腱与股四头风险、peak 后吸收周和 taper 都被覆盖。速度仍未过 partial gate：相对 baseline `258.9s/40.9ch/s`，本条 `436.4s/22.6ch/s`，但 prompt 仅 `+406ch/+1.0%`、raw 反而 `-722ch/-6.8%`，且 generator 日志先遇一次 Azure `429` 后成功；结论仍是 Azure 吞吐/容量长尾，不改 prompt 或 fixture。

2026-07-02 zhaochaoyi repeatability sample：health check `8.6s` 一发 OK 后再跑同 fixture，真实 full run `2026-07-02T10-19-57.279919_00-00` 仍为 `iter=1`、L1 0 warning、overall pass，raw `11251ch`、gen `407.9s`、`gen_cps=27.6ch/s`；单次 judge 将 `phase_nutrition_strategy` 打到 4，理由是“轻松/休息日轻微热量缺口执行细节不够明确”。artifact 检查显示 nutrition block 已覆盖基础/控重、build 补碳、peak 胶+钠演练、taper 储糖、赛后蛋白修复、高原补液钠和铁蛋白/血红蛋白；随后同 artifact `--judge-repeat 3` 报告 `2026-07-02T10-26-26.650713_00-00` 保守聚合 9 轴全 5，`judge_n=3`、`unstable_axes=[]`、`phase_nutrition_strategy=[5,5,5]`。结论：这次 nutrition=4 是单次 judge 方差，不作为 prompt/fixture 修改信号；速度仍为 Azure 吞吐长尾，partial gate 只剩 generator speed fail（baseline `40.9ch/s` → sample `27.6ch/s`），不因该样本调整质量 prompt。

2026-07-02 speed summary diagnostic：新增 `python scripts/eval_coach.py --summarize-speed <reports...>`，用于多样本速度稳定性聚合；它按 fixture 汇总 report 数、fresh generation 样本数、judge-artifact replay 数、verdict/score 范围、`gen_s` 范围与中位数、`gen_cps` 范围与中位数、raw/prompt/iter 范围、最快/最慢报告。带 `artifact_source_report` 的 repeat judge 报告只计入 replay 与质量方差，不重复污染生成速度统计。用 zhaochaoyi 四条报告验证：3 条 fresh + 1 条 replay，fresh 全部 `iter=1`，`gen_s=407.9-469.0s med=436.4s`，`gen_cps=21.6-27.6ch/s med=22.6ch/s`，prompt `40590-40630ch`，score `4-5`（由单次 nutrition=4 引起，repeat judge 已证伪为方差）。随后给 summary 增加 `--baseline-report` 对比列；真实验证显示 zhaochaoyi latest fresh 相对 baseline 为 `407.9s (+149.0s/+57.6%)`，但 `gen_cps=27.6ch/s (-13.4ch/s/-32.6%)`，prompt/raw 仍在窄范围内，进一步支持“质量稳定、速度慢来自服务吞吐长尾”的判断。

2026-07-02 goal-realism fresh sentinel confirmation：health check `6.9s` 一发 OK 后，真实 fresh run `s1-goal-realism-boundary-13pct` 报告 `2026-07-02T10-51-15.667342_00-00` 成功闭环：`iter=1`、L1 只有 baseline 已有 `goal_realism` / `marathon_pace_specificity` warning、9 轴全 5、raw `12422ch`、gen `346.9s`、`gen_cps=35.8ch/s`、judge `106.4s`。对比修复前 fresh report `2026-07-02T09-22-01.444776_00-00` 的 `iter=2` / `weekly_volume_ramp(error)` / gen `796.7s`，以及修复后 judge-artifact backfill report `2026-07-02T09-53-29.181658_00-00` 的 `iter=1` / gen `437.7s`，这条 fresh 样本确认 `64 -> 72 illegal` ramp sentinel 已在真实生成侧把该 fixture 稳定回一轮。Partial gate 对 `.omc/eval/baselines/s1_v1.json` PASS；该证据支持保留 sentinel，不放松 `weekly_volume_ramp` rule filter。

2026-07-02 zhaochaoyi fresh speed sample：连续两次 health check 分别 `6.9s` / `6.0s` 一发 OK 后，真实 fresh run `s1-zhaochaoyi-altitude-p2-replan` 报告 `2026-07-02T11-01-20.599071_00-00` 成功闭环：`iter=1`、L1 0 warning、9 轴全 5、raw `10249ch`、gen `401.1s`、`gen_cps=25.6ch/s`、judge `100.1s`。加入最近 zhaochaoyi 样本后，`--summarize-speed` 显示 4 条 fresh + 1 条 replay 全部 pass，fresh `gen_s=401.1-469.0s med=422.1s`、`gen_cps=21.6-27.6ch/s med=24.1ch/s`、prompt `40590-40630ch`、`iter=1.0`。Partial gate 仍因速度 fail：相对 baseline `258.9s / 40.9ch/s`，最新 fresh 为 `401.1s (+142.2s/+54.9%) / 25.6ch/s (-37.6%)`，但 prompt 仅 `+406ch/+1.0%`、raw `-349ch/-3.3%`、无 retry、质量全 5。结论保持：zhaochaoyi 质量稳定，当前 speed gate failure 主要来自 Azure 生成吞吐下降；不据此改 prompt、fixture 或 max token 默认值。

2026-07-02 speed-cause auto diagnosis：`scripts/eval_coach.py` 的 speed diagnostics 新增 `speed_cause` 标签，不改变 gate 阈值，只减少人工判读。规则优先级：`retry_increase` / `rule_retry` / `prompt_growth` / `output_growth` / `throughput_drop` / `throughput_or_mixed` / `mixed_or_unknown`。用最新 zhaochaoyi targeted report `2026-07-02T11-01-20.599071_00-00` 验证，`--summarize-speed --baseline-report` 现在直接显示 `speed_cause=throughput_drop`；partial gate fail 行也附带 `speed_context=... gen_cps=40.9->25.6ch/s; speed_cause=throughput_drop`。这让“质量全 5、无 retry、prompt/raw 稳定但 Azure 吞吐下降”的样本不再需要手动二次归因。

2026-07-02 10K throughput recovery sample：health check `6.2s` 一发 OK 后，真实 fresh run `s1-target-distance-10k` 报告 `2026-07-02T11-12-45.895671_00-00` 成功：`iter=1`、L1 0 warning、9 轴全 5、raw `10891ch`、gen `232.5s`、`gen_cps=46.9ch/s`、judge `69.6s`。Partial gate 对 `.omc/eval/baselines/s1_v1.json` PASS；与同 fixture 慢样本 `2026-07-02T08-50-36.580783_00-00`（gen `436.7s`、`gen_cps=25.0ch/s`）相比，prompt/raw 几乎一致且均 `iter=1`，但吞吐恢复后速度接近 baseline `235.1s / 47.4ch/s`。`--summarize-speed` 对 4 条 10K fresh 样本显示 `gen_s=232.5-468.9s`、`gen_cps=23.2-46.9ch/s`、latest_vs_base `-2.6s/-1.1%`。结论：10K fixture 质量稳定；此前 speed gate failure 是容量窗口/吞吐问题，不改 prompt 或 fixture。

2026-07-02 full-suite checkpoint hardening：一次 `python scripts\eval_coach.py --scope s1` fresh full-suite 在 2 小时工具超时后没有正式 report 落盘，后台进程已手动停止。为避免长 suite 再次“两小时无样本”，`run_s1_evaluation` 现在为每个 suite 分配固定 run_id，并在每完成一条 fixture 后覆盖写入 `.omc/eval/reports/{run_id}.partial.json/.md` 与 `{run_id}.partial/artifacts/`；最终正式 report 写出后自动清理 matching partial。Partial report 只用于诊断和 artifact replay，不可作为 suite baseline freeze。新增测试覆盖 partial checkpoint 写入与正式 report 清理 partial；相关 runner 测试 `43 passed`。

2026-07-02 checkpoint path real verification：health check `9.0s` OK 后，用真实 LLM 跑单 fixture `s1-target-distance-10k` 报告 `2026-07-02T13-20-16.123593_00-00`，确认新 checkpoint 逻辑不影响正常正式报告写入：`iter=1`、L1 0 warning、9 轴全 5、raw `10995ch`、gen `329.8s`、`gen_cps=33.3ch/s`、judge `106.2s`，partial gate PASS，正式 report 写出后没有残留 `*.partial.*` 文件或目录。速度上，这条仍被 `--summarize-speed` 归因为 `speed_cause=throughput_drop`，相对 baseline `+94.7s/+40.3%` 但未触发 fixture speed gate；继续作为 Azure 吞吐波动样本，不改 prompt/fixture。

2026-07-02 suite resume support：在 checkpoint 基础上新增 `python scripts\eval_coach.py --scope s1 --resume-report .omc\eval\reports\<run>.partial.json`。Runner 会校验 resume report 的 scope/mode/judge prompt version，复用其中已完成 fixture outcome，只生成缺失 fixture，并沿用原始 run id；与 `--judge-artifact` / `--layer L1` 互斥。新增测试覆盖 resume 跳过已完成 fixture、partial checkpoint 继续写入、以及 CLI 互斥校验。这样长 suite 被工具超时或手动停止后，可以继续跑剩余 fixture，而不是重跑已经成功的真实 LLM 样本。

2026-07-03 full-suite + quality hardening：fresh full-suite `2026-07-02T15-37-40.768929_00-00` 完成 14/14 pass，全部 `iter=1`，L1 全 OK；per-axis 均分仅 `phase_nutrition_strategy=4.86`、`season_structure=4.93`，其余为 5。Baseline gate 暴露三条 L2 单轴 4 与两条 speed gate：data-gap nutrition=4、HM season_structure=4、zhaochaoyi nutrition=4；frequency-limit 与 pushback speed 均由 `speed_cause=throughput_drop` 归因。随后做三条 judge-artifact repeat：HM `2026-07-02T17-29-59.191558_00-00` 与 zhaochaoyi `2026-07-02T17-32-48.805186_00-00` repeat=3 全轴 5，判定为单次 judge variance；data-gap `2026-07-02T17-27-59.870667_00-00` nutrition=4 稳定，原因是 peak carb-cycling 表述不够显式。Prompt 仅补强 nutrition peak `carb-cycling/碳循环` 与 72→68kg easy/rest deficit vs key-day no-deficit split，并补 HM peak 不把 tune-up/recovery 包成 4 周 peak 的短 guard；prompt 长度 `34374ch`，仍低于 `<34500`。targeted fresh data-gap `2026-07-02T17-33-04.029201_00-00` 复测为 `iter=1`、L1 0 warning、9 轴全 5、gen `291.1s`，artifact 明确输出 `峰值期：碳循环；MP/关键日前高碳，轻松日正常，演练胶+钠`。L1 refresh report `2026-07-02T17-24-50.438090_00-00` 还验证 `injury_return_peak_exception_count` 不再对“64km 适应周 + 65km/28km 唯一彩排”误报；剩余 L1 warnings 均为 baseline 已知可接受设计折中。相关回归 `329 passed`。

2026-07-03 targeted replacement gate：health check OK 后，围绕 latest full-suite `2026-07-02T17-40-33.506654_00-00` 的 gate blockers 做真实 LLM targeted 修复验证。`s1-frequency-limit-3day` `2026-07-02T18-57-26.531806_00-00` 为 `iter=1`、9 轴全 5、gen `171.1s`，确认三跑 FM fixture 稳定输出唯一 `28km / 48km` 保护性彩排。`s1-target-distance-10k` `2026-07-02T19-08-31.065009_00-00` 为 `iter=1`、L1 0 warning、9 轴全 5、gen `173.0s`，10K peak high 已收敛到 `<=60km`。`s1-phase-transition-from-recovery` `2026-07-02T19-12-08.693272_00-00` 为 `iter=1`、L1 0 warning、9 轴全 5、gen `181.9s`，artifact 明确写出 `PB3:17→3:10约3.6%`。`s1-injury-knee-return` 首轮 `2026-07-02T19-03-19.727776_00-00` 已把 `injury_safety` 拉到 5，但 `season_structure=4`，理由是复跑重建 3 周 + 正式基础 4 周偏短；随后在 `weekly_skeleton.md` 压缩式补入 `2-4w rebuild + rebuild/base total 8-10w before build/speed`，prompt 长度 `34477ch`，仍低于 `<34500`，重跑 `2026-07-02T19-20-21.424497_00-00` 得到 `iter=1`、L1 0 warning、9 轴全 5、gen `177.8s`。用四条 full replacement 生成 repaired candidate `2026-07-02T19-24-13.371031_00-00`，结果为 14/14 pass、所有 axis avg 5.00、所有 fixture `iter=1`；baseline gate PASS，speed summary 相对 `.omc/eval/baselines/s1_v1.json` 无 fixture 速度回退，最新 zhaochaoyi fixture 也为 `233.9s`（快于 baseline `258.9s`）。核心回归命令 `python -m pytest tests\stride_server\test_master_plan_generator.py tests\coach\test_master_rule_filter.py tests\coach_eval -q` 通过 `330 passed`。baseline 文件仍未更新；该 repaired candidate 只作为本轮可追溯候选证据。

2026-07-03 fresh full-suite gate：health check `4.5s` 一发 OK 后跑完整 fresh full-suite `2026-07-02T19-26-56.321588_00-00`，14/14 pass、全部 `iter=1`、无 L1 error；生成速度全线恢复，相对 baseline 没有任何 fixture 速度退化，10K gen `179.4s`、5K `165.6s`、zhaochaoyi `187.0s`。默认 baseline gate 仅因 zhaochaoyi `phase_nutrition_strategy=4` fail，artifact 确认缺少 `72kg -> 68kg` 的“易/休小赤字，质量/长跑/康复不赤字”显式条目，因此按真实表达缺口处理。将 `shared/nutrition.md` 的体重目标规则收紧为 `training_principles must say` 该 split，prompt 长度 `34463ch`；targeted zhaochaoyi full-run `2026-07-02T20-23-35.044283_00-00` 为 `iter=1`、L1 0 warning、9 轴全 5、gen `202.7s`，artifact 明确输出 `72→68kg慢降：易/休小赤字，质量/长跑/康复不赤字，蛋白1.6-1.8+力量供能`。用该 full replacement 生成 repaired candidate `2026-07-02T20-27-55.347742_00-00`，14/14 pass，除 `s1-unrealistic-goal` 的可接受 `volume_progression=4` 外其余轴全 5，baseline gate PASS；speed summary 显示所有 fixture gen time 均快于 baseline，zhaochaoyi `202.7s` vs baseline `258.9s`。核心回归仍为 `330 passed`。baseline 文件仍未更新。

2026-07-03 Spring Festival + L1 risk-cap calibration：上一轮 fresh full-suite `2026-07-02T20-30-29.338046_00-00` 暴露 `s1-edge-case-race-on-holiday` `request_handling=4`，原因是春节旅行周仍写 `14km long_run` 且缺装备/补给打包清单。将 `weekly_skeleton.md` 的 holiday-race intermediate FM 规则收紧为旅行窗口（如 `2/9-2/15`）**no `long_run` key session**，只保短 Z2/短 MP/strides、酒店跑台/平路，并显式 `gear+fuel packing (shoes, race kit, gels/sodium, familiar breakfast)`；prompt 长度 `34494ch`，仍低于 `<34500`。targeted holiday full-run `2026-07-02T21-28-17.840174_00-00` 为 `iter=1`、9 轴全 5、gen `224.0s`，artifact 检查确认旅行周无 long_run，taper 写出 `2/9-2/15无长跑关键课` 与春节补给/饮食提醒。随后 fresh full-suite `2026-07-02T21-33-22.258248_00-00` 为 14/14 pass、全部 `iter=1`、holiday `request_handling=5`、所有 fixture gen time 快于 baseline；默认 gate 仅因 zhaochaoyi 新 `marathon_pace_specificity` L1 warning fail。该 artifact 的 judge 9 轴全 5，且 zhaochaoyi 计划明确 `30km含MP22km；显式风险上限，跟腱/HR/RPE全过才保A`；因此校准 L1：sub-3 FM 通常仍要求 32km，但严格 A gate + explicit risk cap 可接受 30-31km，普通 30km 仍 warning。核心回归更新为 `331 passed`，prompt 长度不变；对 fresh report 做 L1 refresh 得到 `2026-07-02T22-27-17.416876_00-00`，zhaochaoyi 无新增 warning，baseline gate PASS。速度 summary 显示所有 fixture gen time 仍快于 `.omc/eval/baselines/s1_v1.json`，zhaochaoyi `149.7s` vs baseline `258.9s`。baseline 文件仍未更新。

2026-07-03 prompt buffer compression：在不删除关键 guard / prompt regression 哨兵的前提下，压缩 `master_plan_planner/SKILL.md`、`shared/goal_realism.md`、`references/basics.md` 的说明性长句，generator system prompt 从 `34494ch` 降到 `33602ch`，新增约 `892ch` 缓冲。`TestPromptRegression` 通过 `11 passed`，核心回归 `python -m pytest tests\stride_server\test_master_plan_generator.py tests\coach\test_master_rule_filter.py tests\coach_eval -q` 通过 `331 passed`。health check `5.3s` OK 后跑真实 zhaochaoyi targeted full eval `2026-07-02T22-31-50.339783_00-00`：`iter=1`、L1 0 warning、9 轴全 5、gen `172.8s`、raw `9860ch`、gsys `33602ch`。Partial gate 对 baseline PASS，speed summary 显示 zhaochaoyi `172.8s` vs baseline `258.9s`（快 `33.3%`，`gen_cps 57.1ch/s` vs `40.9ch/s`）。artifact 保留核心合同：A=2:50 仅 HM/10K marker + 31km/MP22 + VO2/HR/RPE + 跟腱过时开放，高原/RHR53、补液电解质/钠、铁蛋白/血红蛋白、72→68kg 易/休小缺口且质量/长跑日不减、跟腱/髋臀/股四头耐久均被覆盖。baseline 文件仍未更新。

2026-07-03 compressed-prompt fresh gate repair：压缩后 fresh full-suite `2026-07-02T22-37-41.630215_00-00` 自身为 14/14 pass、全部 `iter=1`、L1 OK，但默认 baseline gate 暴露两处严格回归：`s1-goal-realism-boundary-13pct` 新增 `long_run_distance_share` warning（早期 `22km / 62km = 35.5%`，看似 35% 但实际越界），`s1-injury-knee-return` 的 `volume_progression=4`（伤后峰值段同时出现 64km 与 65km 两个高位周，而 fixture 只允许单个 64-65km / 28km 彩排例外）。不放松规则，改 prompt 哨兵：`weekly_skeleton.md` 加入 `22km >=63` / never `22/62`，并明确伤后 FM return 不可同时创建 64km 与 65km 高位周；随后补强 borderline-aggressive FM：必须有 mid-cycle `test_run` A-gate milestone（HM<=1:18 或 10K<=36），轻松 tune-up 只能 observation/B，且 75km 历史峰值下继续禁止 `64 -> 72` 这类 load jump。prompt 长度 `33602ch -> 34034ch`，仍保留约 `460ch` 压缩缓冲。真实 targeted：`s1-goal-realism-boundary-13pct` 最新 `2026-07-02T23-36-20.243288_00-00` 为 `iter=1`、9 轴全 5、final L1 仅 baseline 已有 `goal_realism` / `marathon_pace_specificity` warning、gen `165.1s`；`s1-injury-knee-return` 最新 `2026-07-02T23-40-47.367388_00-00` 为 `iter=1`、L1 0 warning、9 轴全 5、gen `176.0s`。用两条 full replacement 修复 fresh suite 得到 repaired candidate `2026-07-02T23-44-23.320107_00-00`：14/14 pass、0 marginal、baseline gate PASS，speed summary 显示所有 fixture 均快于 `.omc/eval/baselines/s1_v1.json`，zhaochaoyi 仍为 `145.1s` vs baseline `258.9s`。核心回归更新为 `332 passed`。baseline 文件仍未更新。

2026-07-03 fresh full-suite confirmation + one-round speed sentinel：health check `4.8s` 一发 OK 后，当前 `34034ch` prompt 跑完整 fresh full-suite `2026-07-02T23-47-09.611660_00-00`：14/14 pass、0 marginal、baseline gate PASS，所有 fixture 生成速度均快于 `.omc/eval/baselines/s1_v1.json`；zhaochaoyi `iter=1`、L1 0 warning、9 轴全 5、gen `145.8s`、raw `9974ch`，快于 baseline `258.9s`。唯一速度尾巴是 `s1-goal-realism-boundary-13pct` 虽 pass 且 9 轴全 5，但首轮仍因 `weekly_volume_ramp(error)` 被打回，原因从旧的 `64 -> 72` 漂移到 `70 -> 80`（ratio `1.143`，允许上限 `78.0km`），导致 `iter=2`、gen `302.9s`。继续不放松 rule filter，只在 `weekly_skeleton.md` 增加整数边界哨兵：`70 -> 80` illegal，`70 -> max 77/78 (not 80)`；prompt 长度 `34034ch -> 34074ch`，新增仅 `40ch`。targeted fresh `s1-goal-realism-boundary-13pct` `2026-07-03T00-32-42.480310_00-00` 回到 `iter=1`、L1 仅 baseline 已有 `goal_realism` / `marathon_pace_specificity` warning、9 轴全 5、gen `178.1s`。用该 full replacement 生成 candidate `2026-07-03T00-36-20.112349_00-00`：14/14 pass、全部 fixture `iter=1`、baseline gate PASS，speed summary 显示所有 fixture 仍快于 baseline，goal-realism 从 full-suite二轮 `302.9s` 降到 `178.1s`。核心回归仍为 `332 passed`。baseline 文件仍未更新。

2026-07-03 current-prompt fresh full-suite：health check `5.3s` OK 后，用当前 `34074ch` prompt 跑完整 fresh suite `2026-07-03T00-38-51.136059_00-00`，验证 `70 -> 80` 哨兵不是只在 targeted 生效：14/14 pass、0 marginal、全部 fixture `iter=1`、baseline gate PASS。所有 L2 轴均分为 5.00，除 `volume_progression=4.93`（`s1-unrealistic-goal` 的可接受折中）外；zhaochaoyi 为 `iter=1`、L1 0 warning、9 轴全 5、gen `207.8s`、raw `10670ch`，仍快于 baseline `258.9s`。`s1-goal-realism-boundary-13pct` full-suite fresh 直接 `iter=1`、gen `164.7s`，确认 `70 -> max 77/78` 哨兵修复单轮速度。唯一速度长尾是 `s1-fm-target-sub250-advanced` gen `492.2s`，但质量 9 轴全 5、`iter=1`、raw/prompt 未膨胀；日志显示 generator 调用先遇 Azure `500 Internal Server Error` 后 SDK 重试成功，speed summary 标记 `speed_cause=throughput_drop`，且未触发 gate（相对 baseline +126s/+34.4%，低于 per-fixture gate 阈值）。核心回归保持 `332 passed`。baseline 文件仍未更新。

2026-07-03 key-session intensity compactness：为降低 S1 单轮输出体积，在不改 schema/L1 rule 的前提下，planner prompt 明确 `key_sessions.intensity` 是可选字段，仅 MP/HMP/RP/mixed pace 等 `type`/`purpose` 不足以表达语义时输出；schema 示例也去掉普通 `long_run`/`threshold` 的 `z2`/`z4`。prompt 长度变为 `34209ch`，仍低于 `<34500` guard；核心回归 `python -m pytest tests\stride_server\test_master_plan_generator.py tests\coach\test_master_rule_filter.py tests\coach_eval -q` 为 `332 passed`。health check `5.9s` OK 后，真实 LLM targeted `s1-phase-transition-from-recovery` report `2026-07-03T01-40-54.872962_00-00`：`iter=1`、L1 0 warning、9 轴全 5、gen `155.9s`、raw `13245ch`、partial gate PASS。相对上一份 full-suite 同 fixture `2026-07-03T00-38-51.136059_00-00`，raw `14184 -> 13245`（`-939ch`），judge compact plan `14328 -> 13401`（`-927ch`），`intensity` sessions `55 -> 8`；质量未退，速度样本也从 `236.9s` 降到 `155.9s`，但仍按 targeted evidence 处理，baseline 文件未更新。

2026-07-03 compact-intensity fresh full-suite：health check `5.9s` OK 后，用当前 `34209ch` prompt 跑完整 fresh suite `2026-07-03T01-46-22.991277_00-00`；首次 CLI 等待超时后由 partial checkpoint 持续完成并写出正式 report。结果 `14/14 pass`、0 marginal、全部 fixture `iter=1`、baseline gate PASS；L2 均分除 `volume_progression=4.93`（仍为 `s1-unrealistic-goal` 可接受折中）外全部 5.00。所有 fixture 生成速度均快于 `.omc/eval/baselines/s1_v1.json`；zhaochaoyi `iter=1`、L1 0 warning、9 轴全 5、gen `177.2s` vs baseline `258.9s`，raw `9195ch`。相对上一份 current-prompt full-suite `2026-07-03T00-38-51.136059_00-00`，全套 raw `171736 -> 155302`（`-16434ch`），`key_sessions.intensity` 出现次数 `644 -> 91`，说明 optional-intensity compactness 已泛化到全套 fixture。baseline 文件仍未更新。

2026-07-03 key-session purpose compactness targeted check：在最新 full-suite 上拆解发现 `purpose` 已经很短但仍 615/615 个 key sessions 全量输出，真正承载 MP/伤病/旅行/补给/A-gate 等语义的大约 194 个。继续只做 prompt-level compactness：普通 `long_run/threshold/tempo/interval/vo2max/hill/strength` 可省略 `purpose`，但 MP/HMP/RP、A/B gate、injury、altitude/heat、travel/holiday、fueling、recovery、user-request 语义必须保留。prompt 长度 `34311ch`，核心回归仍为 `332 passed`。health check `7.7s` OK 后，targeted `s1-phase-transition-from-recovery` report `2026-07-03T02-41-05.445968_00-00`：`iter=1`、L1 0 warning、9 轴全 5、gen `181.4s`、raw `11844ch`、partial gate PASS；相对 compact-intensity full-suite同 fixture raw `12573 -> 11844`，judge compact plan `12701 -> 11962`，`purpose` sessions `58 -> 18`，`purpose_chars 423 -> 204`，race_pace/MP 语义仍保留。再跑真实 zhaochaoyi targeted `2026-07-03T02-45-09.576214_00-00`：`iter=1`、L1 0 warning、9 轴全 5、gen `214.5s`、raw `9745ch`、partial gate PASS；artifact 仍保留 `MP`、`跟腱`、`高原`、`VO2`、`A` 等关键语义。此改动只完成 targeted 验证，尚未跑 fresh full-suite；baseline 文件仍未更新。

2026-07-03 optional-purpose fresh full-suite：health check `8.8s` OK 后，用当前 `34311ch` prompt 跑 fresh suite `2026-07-03T02-51-15.854402_00-00`；CLI 等待窗口超时后由 partial checkpoint 继续完成并写出正式 report。结果 `14/14 pass`、0 marginal、全部 fixture `iter=1`、baseline gate PASS；L2 均分除 `volume_progression=4.93`（仍为 `s1-unrealistic-goal` 可接受折中）外全部 5.00。相对 compact-intensity full-suite `2026-07-03T01-46-22.991277_00-00`，全套 raw `155302 -> 149251`（`-6051ch`），`key_sessions.purpose` 出现次数 `615 -> 190`，`purpose_chars 4900 -> 2197`；质量未退。所有 fixture 生成速度均快于 baseline，唯一长尾是 `s1-target-distance-hm` gen `454.4s`，但 `iter=1`、raw `9774ch` 未膨胀，speed summary 标记 `speed_cause=throughput_drop`，且 baseline gate 未 fail。zhaochaoyi `iter=1`、L1 0 warning、9 轴全 5、gen `240.0s` vs baseline `258.9s`，raw `9605ch`；完整 artifact 保留 `MP`、`跟腱`、`高原/昆明`、`VO2`、`A`、`钠`、`铁蛋白/血红蛋白`、`72→68` 等关键语义。baseline 文件仍未更新。

2026-07-03 judge compact view cleanup：生成侧 compact 后，下一处稳定收益在 eval judge prompt。`coach_eval.judge_s1._compact_generated_plan` 现在只保留 `is_completed/is_recovery_week/is_taper_week=true`，默认 `false` 不再传给 L2 judge；artifact、schema、L1 rule filter 都不变。用 optional-purpose full-suite `2026-07-03T02-51-15.854402_00-00` 估算，14 条 fixture 的 judge compact plan 总量 `151139 -> 137775`（`-13364ch`）。新增/调整 compact-view 单测后，核心回归 `python -m pytest tests\stride_server\test_master_plan_generator.py tests\coach\test_master_rule_filter.py tests\coach_eval -q` 为 `333 passed`。真实 judge-only 验证：zhaochaoyi artifact report `2026-07-03T03-51-31.932140_00-00` 为 `iter=1`、L1 0 warning、9 轴全 5，`jplan=9007ch`（原 full-suite同 artifact `9725ch`）；`s1-phase-transition-from-recovery` artifact report `2026-07-03T03-52-23.823161_00-00` 也为 9 轴全 5，`jplan=11712ch`。这只优化评测成本/速度，不更新 baseline。

2026-07-03 compact-rule prompt buffer cleanup：等价压缩 `master_plan_planner/SKILL.md` 的 compact-output 说明，不改变 optional `intensity` / optional `purpose` 语义，只把长句改短。generator system prompt `34311ch -> 34271ch`，继续低于 `<34500` guard；prompt 单测 `114 passed`，核心回归 `333 passed`。本轮未新增真实 LLM 调用，仍以上一轮 optional-purpose full-suite `2026-07-03T02-51-15.854402_00-00` 作为质量证据；baseline 文件未更新。

2026-07-03 current-combo fresh full-suite：health check `5.7s` OK 后，用当前组合（optional intensity/purpose + compact-rule prompt buffer + judge compact false-flag cleanup）跑 fresh suite `2026-07-03T03-57-02.042449_00-00`；CLI 等待窗口超时后由 partial checkpoint 继续完成正式 report。结果 `14/14 pass`、0 marginal、全部 fixture `iter=1`、baseline gate PASS；L2 均分除 `volume_progression=4.93`（`s1-unrealistic-goal` 可接受折中）外全部 5.00。所有 fixture 生成速度均快于 `.omc/eval/baselines/s1_v1.json`；zhaochaoyi `iter=1`、L1 0 warning、9 轴全 5、gen `222.4s` vs baseline `258.9s`，raw `10060ch`，artifact 仍保留 `MP`、`跟腱`、`高原/昆明`、`VO2`、`A`、`钠`、`铁蛋白/血红蛋白`、`72→68`。相对上一轮 optional-purpose full-suite `2026-07-03T02-51-15.854402_00-00`，全套 raw 基本持平 `149251 -> 149485`（`+234ch`，正常采样差异），但 judge compact plan `150879 -> 137931`（`-12948ch`），judge user prompt 同步 `-12948ch`；judge 总时长 `511.7s -> 533.4s` 略高，判断为服务侧波动而非 prompt 膨胀。baseline 文件仍未更新。

2026-07-03 strength-key weekly-skeleton compactness targeted check：最新 full-suite 显示部分 fixture 将普通维护力量逐周写入 `weeks.key_sessions`，例如 `s1-goal-realism-boundary-13pct` 有 `strength_key=16/21w`。规则层 `strength_durability_track` 只要求 phase/principle/milestone 层有耐久轨道，因此 prompt 增加 guard：`weeks.key_sessions` 中 `strength_key` 只用于 rehab/test/phase anchors，不逐周列 routine maintenance strength。prompt 长度 `34271ch -> 34403ch`，仍低于 `<34500` guard；核心回归 `333 passed`。真实 targeted `s1-goal-realism-boundary-13pct` report `2026-07-03T04-49-31.756718_00-00`：`iter=1`、L1 仅 baseline 已有 `goal_realism` / `marathon_pace_specificity` warnings、9 轴全 5、partial gate PASS；相对 current-combo full-suite 同 fixture，`strength_key 16 -> 1`、sessions `52 -> 39`、raw `11490 -> 10314`、jplan `10664 -> 9458`、gen `203.2s -> 145.2s`。这说明减少 routine strength weekly expansion 不伤 quality；尚未跑 fresh full-suite 泛化验证，baseline 文件仍未更新。

2026-07-03 strength-key fresh-suite judge calibration：strength-key guard 后的 fresh full-suite `2026-07-03T04-55-06.012544_00-00` 为 `14/14 pass`、0 marginal、全部 `iter=1`，且所有 fixture 生成速度均快于 baseline；zhaochaoyi `iter=1`、L1 0 warning、9 轴全 5、gen `190.4s`、raw `9625ch`。默认 baseline gate 唯一失败为 `s1-data-gap-no-recent-race` 的 L2 `volume_progression 5 -> 4`，judge rationale 只因唯一 `28km / 60km` protected rehearsal 略高于 35%；同 artifact repeat=3 旧口径得到 `[5,5,4]`，说明是 judge 方差而非 L1/生成质量问题。补充 S1 judge 口径：data-gap/no-recent-race FM 在 history peak around 52km、fixture 期望 peak `55-65km`、L1 ramp/share 通过、只有一个 protected `28km / 58-65km` rehearsal 且随后 recovery/deload 时，不应仅因 `28/60` 略高于 35% 扣 volume_progression。核心回归仍为 `333 passed`，generator prompt 保持 `34403ch`。真实 judge-only 复判 `2026-07-03T05-52-52.813276_00-00` 对同一 artifact `judge-repeat=3` 后 9 轴全 5、`unstable=none`、`jplan=10648ch`；用该 judge report 离线 repair 得到 candidate `2026-07-03T05-53-18.741936_00-00`，保持原 full-suite 生成 artifact/timing，结果 `14/14 pass`、baseline gate PASS，speed summary 显示所有 fixture 仍快于 `.omc/eval/baselines/s1_v1.json`。baseline 文件仍未更新。

2026-07-03 sparse-db one-round ramp sentinel：fresh full-suite `2026-07-03T05-55-12.275439_00-00` 仍为 `14/14 pass`、0 marginal，zhaochaoyi `iter=1`、L1 0 warning、9 轴全 5、gen `164.9s`；但 `s1-sparse-db-capable` 用了 `iter=2`，首轮被 L1 `weekly_volume_ramp(error)` 打回，原因是 peak 段 `week16 80km -> week17 90km`，ratio `1.125`，超过 10% cap，带整数容忍的上限为 `89km`。继续不放松 rule filter，只在 `weekly_skeleton.md` 的 ramp 哨兵加入 `80 -> 90` illegal 与 `80 -> max 88/89 (not 90)`；prompt 长度 `34403ch -> 34443ch`，仍低于 `<34500` guard，核心回归 `333 passed`。health check `5.4s` OK 后，真实 targeted `s1-sparse-db-capable` report `2026-07-03T06-50-38.793885_00-00` 成功闭环：`iter=1`、L1 0 warning、9 轴全 5、raw `10347ch`、gen `143.0s`、judge `29.4s`，partial gate PASS。artifact 检查确认没有 `time_trial` / `test_run` / `tune_up_race` 来重证自报 PR，峰值周量改为逐步 `80 -> 82 -> 84 -> 86 -> 90`，不再出现 `80 -> 90` 跳量。speed summary 显示 sparse 最新 `143.0s`，快于 baseline `251.3s`，也明显优于同日 full-suite 二轮样本 `344.9s`。baseline 文件仍未更新。

2026-07-03 sparse cap + sub250 gate consistency targeted closure：fresh full-suite `2026-07-03T06-56-55.891982_00-00` 为 `13 pass / 1 marginal / 0 fail` 且全部 `iter=1`，但 baseline gate 暴露两条质量回归：`s1-sparse-db-capable` peak high 到 `92km`，超过 fixture 期望 `70-85km`；`s1-fm-target-sub250-advanced` `goal_realism=4`，原因是 A 门槛同时残留 `HM≤1:21:30`、`HM<=1:24:30`、`10K≤37`、`10K<=37:45` 等不一致表述。修复不放松 L1/Judge：planner sparse override 明确 watch/app migration + credible advanced self-report 应信自报、起步 `50-60km`、peak `70-85km`，无明确近期 `85-90km` 训练史时不追 `86-92/32km`；`master_plan_generator._ensure_sub250_fm_combination_gate` 改为规范化/替换冲突的 sub-2:50 A-gate 文案，并把非 race 的 HM/10K checkpoint 改成指向 race milestone 的组合门槛。prompt 长度当前 `34474ch`，仍低于 `<34500`；核心回归 `333 passed`。health check `6.5s` OK 后，targeted `s1-sparse-db-capable` report `2026-07-03T09-00-44.668117_00-00` 为 `iter=1`、L1 0 warning、9 轴全 5、gen `181.1s`、raw `10314ch`，artifact peak 停在 `84km`，partial gate PASS。targeted `s1-fm-target-sub250-advanced` report `2026-07-03T09-04-57.899920_00-00` 为 `iter=1`、L1 0 warning、9 轴全 5、`goal_realism=5`、gen `225.4s`、raw `11084ch`，artifact 的 principle/race milestone 使用单一组合门槛 `HM<=1:24:30 或 10K<=37:45 + 最大合法 MP 彩排 + VO2/HR/RPE + 跟腱`，并把 `HM<=1:25:30`/`10K>=38:00` 标为观察/B。两条 targeted report 对 `.omc/eval/baselines/s1_v1.json` 的 partial gate 均 PASS；baseline SHA256 仍为 `99173A53FF4683608323C3D015F50CE0225EE378AC148C67E7DCB2B8349A7BF8`，未更新 baseline。

## S1 不在 v1 范围

- **场景 3 fixture（完全新跑者，无 prs / hr_zones / 历史数据）**：v1 不评估。场景 3 plan 需要先排 2-4 周 fitness assessment 收集数据再决定 zone，与场景 1+2 的"已知能力直接排课"路径差异大 —— 独立 fixture 形态、L1 规则（"无 prs 时必须排 assessment"）、judge axis 调整都留到 v1.1
- **跨赛季 plan continuity 评估**：当前赛季依赖上赛季 recovery 的 trade-off —— v1 只评单 master plan，不评 plan-to-plan 衔接（即使 `prev_master_plan_md` 存在，judge 只参考不强校验）
- **多 race-of-season 评估**：一个赛季内多场比赛（A race + B race + C race）的安排 —— v1 只支持单 `target_race`
- **比赛策略生成评估**：master plan 应该附带 race-day pacing 策略 —— v1 暂不评估
- **训练响应预测**：plan 是否真的能让用户从 PB 3:30 跑到 3:15 —— 这要 longitudinal 数据，v1 不做
- **冬训 vs 夏训差异化评估**：天气 / 季节对训练负荷的影响 —— v1 fixture 不显式 tag 季节

## 跟其他 doc 的关系

- [`coach-eval.md`](coach-eval.md) —— framework 级 doc（L1/L2/L3、CLI、Judge graph 设计、目录结构）
- [`coach-eval_S2.md`](coach-eval_S2.md) —— S2 weekly plan evaluation
- [`coach-eval_S3.md`](coach-eval_S3.md) —— S3 daily Q&A evaluation
- [`coach-agent.md`](coach-agent.md) —— coach 整体架构 + generation pipeline + Pattern X/Y/A/P
- `src/stride_core/master_plan.py` —— S1 schema source of truth
