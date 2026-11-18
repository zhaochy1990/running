# master plan 内容模块化：政策包 → 四存储模块 + 用户文案层

> 状态：设计稿（2026-11-18，#1024 详情页设计线产出，**未实施**）。
> 范围：master plan 产物（现 `master_plan.content` 单一 JSON blob）拆分为 M1–M4 四个存储模块；新增 kernel「用户文案」二段生成（M3）；周课表明细独立成行（M4）。
> 非目标：训练学规则本身（daniels.md 体系不动）；wire 契约变更（`plan-session/v1`、`weekly-plan/v1` 原样复用）；小程序页面实现（归 #1024 PR-3）。
> 数据样本：`prototypes/chat-plan-generation/wuxi-2027-plan.json`（真实 graph 产物：无锡 2027-03-07 · 2:50 · 15 周，185s，gates 8/8，audit ✅5⚠️4❌0）；设计稿参照 `~/.codex/visualizations/.../training-plan-prototype/wuxi-plan-detail.html`。

## 0. TL;DR

现产物是一整块 124KB JSON（`master_plan.content`），四类读写模式完全不同的数据挤在一起。拆成四模块：

| 模块 | 内容 | 生命周期 | 落点 |
|---|---|---|---|
| **M1 计划头** | 身份/状态/goal/周历 | 生成一次；启用时改状态 | 现 master_plan 表（瘦身） |
| **M2 策略包** | policy+skeleton+anchor+facts+goal_assessment+audit | 生成一次，调整引擎整包换版 | master_plan 新列 `strategy_json` |
| **M3 用户文案包** | 评估中文/阶段人话/原则人话/审计预期管理 | 策略定稿后 LLM 二段生成，fail-soft | master_plan 新列 `user_copy_json` |
| **M4 周课表** | weekly_docs 按周一行（plan-session/v1 原样） | **唯一被滚动/调整反复写的模块** | 新表 `plan_weekly_doc` |

生成顺序变为：**policy 先定稿 → 用户文案 pass**（用户 2026-11-18 拍板的方向）。

## 1. 背景与动机（四个缺口）

1. **详情页 payload 与视图模式**：#1024 详情页（概览/每周安排双视图）按视图取数——概览要策略包+周骨架，每周安排要逐周 session 明细。单 blob 只能整包下发（124KB，其中约 60% 是首批 4 周 session 明细），概览与周明细无法分离懒加载。
2. **#858 两引擎的写路径**：滚动引擎（边界自动出下一块）只**追加**周行；调整引擎只**改对应周**。周行是唯一高频写对象，埋在大 blob 里每次都要读改写整包，且与「weekly 行不可变、调整写新版本」的拍板语义相抵触。
3. **用户文案层不存在**（11-18 详情页 review P1 发现）：产物里 session 级有高质量用户文案（`spec.purpose`/`spec.note`，L4 契约约束），但**策略级（原则/阶段说明/评估摘要）全是教练文本**——黑话（E/T/strides、E份额≥75%、taper_weeks=2）、证据链括号、甚至评估 summary 是英文。旧聊天链路的用户文案是 deepagent 自己写的 markdown 正文，活在聊天信封里、从不进 kernel 产物；#1024 聊天切 kernel 后「说人话」层断了。
4. **聊天接线的正文依赖**（#1024 PR-1）：聊天回复正文、详情页叙述、结果卡摘要，都依赖一个不存在的 user-facing 叙述层。

现状证据：`master_plan.content` 单 longtext；生产样本 `prod-1116-schema-example.json`（content 23 键，v2 字段+policy/skeleton/anchor/audit/weekly_docs 平铺）；11-16 首单已实证全链可跑。

## 2. 模块总览与拆分原则

拆分按**读写模式**切，不按 JSON 原始顶层键切：

- 一次写永不改、整读的 → 一个 JSON 列（M2）
- LLM 二段产出、fail-soft 可缺 → 独立 JSON 列（M3）
- 随训练反复增改、按周取的 → 按周一行（M4）
- 身份/状态/热字段 → 表列（M1）

## 3. 各模块 Schema

字段全部对照 wuxi 真实产物核实（非臆造）。zod 风格示意，实施时落在 coach_contract（存储层 schema；进 wire 需同步 contract.md——铁律）。

### M1 plan_head（现 master_plan 表瘦身）

```ts
{
  plan_id: uuid, user_id, revision: int,
  status: "draft" | "active" | "superseded",
  apply_token?: uuid, candidate_job_id?: uuid,
  goal: { race_name, distance: "FM"|"HM"|..., race_date, target_time?, timezone },
  start_date, end_date, total_weeks: int,
  calendar: [ { week_index, week_start, phase_name,          // 展示带（瘦身后）
                km_low, km_high, is_recovery_week } ],
  created_at, updated_at
}
```

注意：现 `plan.weeks`（含 key_sessions 截断）与 `skeleton.weeks` 是双源（km 重复）。去重：**M1.calendar 只留展示带（km_low/high），引擎值（km/lr/q）归 M2 skeleton 唯一所有**；`plan.weeks.key_sessions` 首批粗摘要删除（真明细在 M4，粗摘要在概览图里无用）。

### M2 plan_strategy（策略包，`master_plan.strategy_json` 新列）

现 v3 富字段合集，**整包一列**（读写随计划整体，无独立生命周期，不拆表）：

```ts
{
  policy: {
    phases: [ { canonical, name, start_week, end_week,
                primary_goal, training_goal, block_mode, rationale } ],   // 策略层 4 段
    milestones: [ { phase, signal, criterion } ],
    gates: [ { phase, signal, criterion, action_if_missed } ],
    volume_bands: [ { phase, weekly_km_min, weekly_km_max } ],
    taper_weeks: int
  },
  skeleton: {
    weeks: [ { week, canonical, block, role, km, lr, q } ],               // 周骨架唯一源
    blocks: [ { block, canonical, start_week, end_week, absorb_weeks, boundary } ],
    recovery_policy: [...], strength_policy: [...],
    checks: [ {check, pass, ...} ]
  },
  anchor: { as_of, vdot, vdot_source, seed, coefficient_version, projection },
  facts: { schema_version, as_of, facts: [ {fact_id, value, unit, source, confidence} ] },
  goal_assessment: { schema_version, level, summary /*en，用户读 M3.assessment*/,
                     material_conclusions, abc_gates, conflicts, multi_cycle_path },
  audit: { items: [ {item, verdict: "pass"|"warn"|"fail", expectation, actual} ],
           summary: { pass, warn, fail } },
  warnings: [ ... ]
}
```

消费：节奏图（km/LR 切换）、阶段 tabs+里程碑门、力量/恢复、审计明细、**滚动引擎**（生成下一块必读 policy+skeleton）、admin。

### M3 plan_user_copy（用户文案包，`master_plan.user_copy_json` 新列）——新模块

**生成顺序（2026-11-18 用户拍板）：先 policy 定稿，再生成用户文案。** kernel 在 `snapshot_plan` 后新增 `user_copy` 节点：deepseek-flash 低温单次调用，输入=M2 骨架（policy/skeleton/plan.calendar/audit.items），输出=本包。架构内现成模式（danielsAudit 同为后处理节点）；fail-soft：节点失败计划照常落库，UI 回退现状行为。

```ts
{
  schema: "plan-user-copy/v1", generated_by, created_at,
  assessment: {
    level_zh,                      // 「有挑战，具备冲击基础」
    summary_zh,                    // 「目标 2:50:00，相比最佳 2:57:11 需提升约 4.06%…」
    abc_zh: { A, B, C }            // 各档目标中文一句话
  },
  phases: { [phase_name]: { goal_short,   // 「先把有氧底子重建起来：跑量稳步回到 85-90 公里…」
                            focus_user } },// 人话说明：无黑话、无证据链括号
  principles_user: [ ... ],              // training_principles 人话版
  audit_user: {
    headline: "9 项检查 · 5 达标 · 4 提示 · 0 不符",
    notes: [ { item_ref, user_text } ]   // 预期管理：「报 7 天≠排 7 天，多出的日子留给恢复是刻意安排」
  },
  rolling_note: "后续课表随训练推进逐块生成，提前约一周到位",
  weekly: { [week_index]: { headline_user? } }   // 可选；首批才有
}
```

措辞纪律（沿用训练画像线拍板）：对用户说「运动能力/运动习惯」；E/T/strides 缩写允许保留在课表语境（配合 spec.purpose 展开），**原则与阶段说明必须成句**；评估不得出英文。

### M4 plan_weekly_doc（周课表，新表）

`weekly_docs` 出 blob，一周一行——**滚动/调整两引擎唯一高频写对象**：

```ts
// 表 plan_weekly_doc，PK (plan_id, week_index)
{
  plan_id, week_index, week_start, week_name,
  phase_name, block_id, role,
  km_low, km_high, is_recovery_week, planned_dose,
  source: "initial_block" | "rolling_block" | "adjustment",   // 溯源（#858 两引擎）
  doc: {                                                       // weekly-plan/v1 原样
    sessions: [ /* plan-session/v1：date/session_index/summary/kind/
                   total_distance_m/total_duration_s/estimated_dose/notes_md/
                   spec{schema,name,type,purpose,note,
                        blocks[{repeat,steps[{step_kind,duration,target,note,hr_cap_bpm,rest}]}]} */ ],
    nutrition, notes_md, milestone_note, key_sessions
  },
  created_at, updated_at
}
```

写路径纪律：滚动引擎**追加**新块行（source=rolling_block）；调整引擎改周=**写新版本行**（旧行留审计，遵守 #858「weekly 行不可变」拍板语义）；`plan-session/v1`、`weekly-plan/v1` wire 契约零变更。

## 4. 设计稿视图 × 模块矩阵

| 设计稿视图（wuxi-plan-detail.html） | 读什么 |
|---|---|
| 标题/概览头/聊天结果卡 | M1（+M3 命名可选） |
| 目标评估卡 | M3.assessment（缺失回退 M2.goal_assessment 模板） |
| 15 周训练节奏（周跑量/长距离切换、峰值） | M2.skeleton.weeks（km/lr）+ M1.calendar |
| 阶段 tabs → 阶段面板/里程碑门/力量/恢复 | M2.policy + skeleton.blocks/strength/recovery + **M3.phases** |
| 总体训练原则 | **M3.principles_user**（缺失=不渲染或标「教练视角」） |
| 审计折叠（#859 符合性报告落点） | M2.audit + **M3.audit_user** |
| 每周安排 · 已生成周 | M4.doc |
| 每周安排 · 未生成周 | M2.skeleton(lr/q) + **M3.rolling_note** |
| 聊天回复正文（#1024 PR-1） | **M3**（+M2.audit 供引用） |

## 5. 写路径

| 事件 | 动作 |
|---|---|
| kernel 生成完成 | 写 M1 + M2 + 首批块 M4 行（source=initial_block）→ `user_copy` 节点 → 写 M3（fail-soft） |
| #858 滚动引擎（进入末周夜检） | 读 M2(policy+skeleton) + M4 已生成周 → 生成下一块 → **追加** M4 行 |
| #858 调整引擎（同意制） | 改对应 M4 周=写新版本行；涉及重排时整包换 M2（revision 绑定） |
| 启用（apply/activate） | 只改 M1.status（draft→active，旧 active→superseded） |
| 退役/清理 | M4 随 M1 级联 |

## 6. 存储与 API 落点

- **DDL 极小**：master_plan 加两列（`strategy_json`、`user_copy_json`）+ 新表 `plan_weekly_doc`。时间列一律 DATETIME（CynosDB 约束）。存量 active 3 行一把搬迁脚本（#859 先例：无真实用户直接 breaking，不做版本兼容层）。
- **API**：
  - `GET /master-plan/current` → M1+M2+M3+M4 骨架（周行不含 doc 明细）——概览一次到位，payload 预期从 ~124KB 瘦到 ~40KB 级；
  - `GET /master-plan/current/weeks/{week_index}` → M4 单周 doc——详情懒加载 + 训练 tab 与 **#582 P4 日计划统一读端点**合流；
  - admin/worker 内部端点沿用（strategy/user_copy 随 content 域返回）。
- **契约纪律**：M1–M4 schema 先落 coach_contract（internal）；`GET` 响应形状定稿当轮必须同步 `contract.md`+总览+层分文档（铁律）。

## 7. fail-soft 与回退

| 缺失 | 回退行为 |
|---|---|
| M3 整包 | 评估卡=英文 summary+模板；阶段目标=concise 裁剪；原则/审计折叠不渲染；rolling_note=前端常量 |
| M3.phases 某阶段 | 该阶段回退 concise |
| M4 某周行 | 每周安排显示「周目标框架」（skeleton lr/q）+ rolling_note |
| M2 损坏 | 生成侧问题，M1.status 不得置 active |

## 8. 待拍板

1. **M4 落新表 vs 复用已就绪的 weekly_plan 表**（后者现列：master_plan_id/week_start/status_slot/revision——需加 doc 列与 source 溯源列，且 #858 PR-C 语义是「提案表」，两用途是否合表待定）。
2. **user_copy 节点模型与成本**：deepseek-flash 低温单次（与 danielsAudit 同模式）预期 ~10-20s/~2 万 token/单，是否接受；失败重试策略。
3. **M3.weekly 周级一句话要不要**（首批 4 周的 headline）——详情页每周安排头部可只用 skeleton+phase 信息，非必需。
4. **评估 summary 英文保留位置**：M2.goal_assessment.summary 保留英文（引擎/审计用）还是同步中文化（迁移成本 vs 单源）。
5. **plan.weeks 去重确认**：M1.calendar+M2.skeleton 替代后，v2 兼容字段里的 weeks 不再保留（#859 已拍 breaking 先例）。

## 9. 关联

- #1024 聊天创建训练计划（M3=聊天正文与详情页叙述的家；PR-1 后端接线、PR-3 详情页实施消费本设计）
- #803 接入 spec（content v3 现状=本设计的拆分起点；803-integration-spec.md §2）
- #858 两引擎（M4 写路径语义；两引擎设计记录在票）
- #859 产物全量落库（content 富字段现状）+「符合性报告」mp 欠账（M2.audit+M3.audit_user=详情页落点）
- #582 P4 日计划统一读端点（M4 单周端点合流点）
- 设计输入：`prototypes/chat-plan-generation/wuxi-2027-plan.json`（真产物）、`wuxi-plan-detail.html`（设计稿）、prod-1116-schema-example.json（生产 wire 对照）
