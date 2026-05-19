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
| Pipeline | conversation: `master_chat` prompt；generation: **当前** `src/stride_server/master_plan_generator.py:run_generate_job`（self-contained：query history → build prompt → LLM call → parse；**绕过** `build_generation_graph`）。**Phase 1 包含前置 refactor**：把 master_plan_generator 重写成走 `coach.graphs.generation.build_generation_graph(plan_type="master")`，让 S1 也享受 rule_filter / reviewer / verdict 通用 pipeline，eval framework 才能复用 |
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

S1 L1 不只是格式检查，而是 **可程序化的训练学合理性检查**。前提是 `MasterPlan` 输出逐周重点课 skeleton（见上文 `weekly_key_sessions`）。新增 `src/coach/graphs/generation/master_rule_filter.py`：

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
| `hard_session_spacing` | error | 同一周内 threshold / tempo / interval / vo2max / hill / race_pace 等高负荷重点课不得超过 2 个；不得连续多周无 recovery / deload 调整 |
| `season_window_fits` | error | plan 总时长 ≤ `season_window` 跨度，且 race_date 在 window 内 |
| `goal_realism` | warning | PB → goal improvement 超过阈值（10k+: 15%, hm: 12%, fm: 10%）→ warning（不是 error —— advanced 可能达成；判 fail 是 L2 + anti-pattern 的事） |

### S1 不在 L1 范围（交 L2 judge）

- 周期化策略选择是否适合用户（线性 vs polarized vs reverse periodization）
- 单个重点课设计细节是否最优（例如 6x1km vs 5x1200m 哪个更适合）
- 营养策略与阶段匹配
- `user_intent_md` 回应质量
- "pushback" 行为的得体程度

## S1 L2 Judge Axes (8)

S1 judge 用与 S2 不同的 axis 集 —— 因为 S1 是 strategic-level，HRV/RHR 等 daily signals 不是主要信号：

| Axis | 评什么 |
|------|--------|
| `schema_validity` | `MasterPlan.model_validate` 通过（与 L1 双保险） |
| `season_structure` | base / build / peak / taper / recovery 阶段是否齐全、顺序合理、时长平衡 |
| `goal_realism` | plan 路径能否合理通向 `goal_time_s`（考虑 PB 起点、phase 长度、peak 周量）；不现实时是否有显式说明 |
| `peak_timing` | peak phase 是否准确放在 race - 1..3 weeks，且 taper 长度与 race 距离匹配（fm 通常 2 周，hm 1 周，10k 3-5 天） |
| `weekly_key_session_progression` | 整个赛季逐周重点课安排是否合理：base 先打容量，build 引入阈值 / tempo，peak 转专项长课 / race pace，taper 降负荷保锐度 |
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

完整 prompt 在 `src/coach/graphs/evaluation/judge_s1.py`（实施时建）：

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

按 8 个 axis 打 1-5 分（5 = 完全满足；1 = 严重违反），每维必须给 rationale。
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

## S1 Implementation Roadmap（当前 Phase 1）

用户已 redirect 优先级到 S1，S1 是当前 Phase 1。**v1 fixture 覆盖场景 1 + 2（有 `prs` / `hr_zones` 的用户）；场景 3 留到 v1.1**。工作量估计 **6-7 天**（含 refactor）：

- [ ] **前置 refactor**：把 `stride_server/master_plan_generator.py:run_generate_job` 重写成走 `coach.graphs.generation.build_generation_graph(plan_type="master")` —— 把 `_query_history` / `_query_fitness_state` 拆成 ports & adapters 的 `load_context` 函数（adapter layer），把 `_build_master_plan` / `_build_system_prompt` 拆成 `generator` 函数。理由：当前 master_plan_generator self-contained 绕过 generation graph，eval framework 没法复用 generation pipeline；不 refactor 的话 S1 也享受不到 rule_filter / reviewer / verdict 这套通用机制
- [ ] 写 `coach/schemas/evaluation.py`（JudgeScore / EvalReport，通用 —— 框架级）
- [ ] 写 `coach/graphs/evaluation/graph.py`（最小骨架 + judge node）
- [ ] 写 `coach/graphs/evaluation/judge_s1.py`（S1 judge prompt v1，8 axes）
- [ ] 写 `coach/graphs/generation/master_rule_filter.py`（10 条 S1 L1 rules）
- [ ] 写 `stride_server/coach_adapters/eval_runner.py`（支持 `live_local_db` / `frozen_fixture` 两种 mode；fixture 加载、本地 SQLite context 聚合、LLM 注入、GPT-5.4 wiring）
- [ ] 写 `scripts/eval_coach.py` CLI
- [ ] 从 `data/zhaochaoyi/TRAINING_PLAN.md` + 历史 logs 抽 4-5 条真实 master plan fixture
- [ ] 手工构造 8-10 条 edge case fixture：
  - target_distance × 4 (fm / hm / 10k / 5k，同一 user_profile)
  - unrealistic_goal × 1
  - sparse_db_capable_user × 1
  - frequency_limit × 1（3 天 / 周）
  - injury_constraint × 1
  - goal_realism_boundary × 1
- [ ] 跑 baseline，记录 `per_axis_avg` 存档 `.omc/eval/baselines/s1_v1.json`

工作量比 S2 多 2-3 天的理由：(a) **前置 refactor**：master_plan_generator → build_generation_graph 整合，含 ports & adapters 拆分 + 兼容现有 `routes/master_plan.py:183` 调用方；(b) 多 4 条 L1 规则；(c) judge axis 与 S2 几乎不重叠，需独立 prompt 调优；(d) S1 真实数据稀少，手工 fixture 比例高。

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
