# adjust-master-plan 接线方案（实现说明）

本文档只描述如何把 `adjust-master-plan` SKILL 接入现有 Coach Agent 运行时。**本次交付不含 TS 代码改动**，以下为落地时的改动清单与关键点。

## 背景：现有架构回顾

- 赛季计划生成走 **deep-agent 子代理路径**（`src/agents/master_plan/agent.ts`），`generate_master_plan` 子代理持有 SKILL `generate-master-plan`、工具集与 `MasterPlanDirectResponseSchema`，通过 `{ disposition: "return_direct", content: MasterPlan }` 信封直出结构化计划。
- SKILL 文件放在 `src/coach_agent/src/skills/<name>/SKILL.md`，由 `scripts/copy-assets.mjs` 在 `npm run build` 时自动从 `src/` 拷贝到 `dist/`（非 `.ts` 文件全量复制），**新增 SKILL 无需改 copy 脚本**。子代理通过 `skills: ["/adjust-master-plan/"]` 引用（虚拟路径，根为 `src/skills/`）。
- `get_master_plan`（`src/tools/plan.ts`）已能读取当前激活计划，返回 opaque `MasterPlanDocument`（内含 `goal` / `phases[].is_completed` / `weeks[].week_start` / `milestones[].completed_actual` 等 schema 字段）；`get_master_plan_context`（`src/tools/masterPlanContext.ts`）已提供 `current_phase`、`active_plan`（含 revision）、`plan_start`、`as_of`、`fitness_state`、`recent_history`、`injuries`、`running_calibration` 等调整所需全部信号。
- 已完成的"draft → 人工 review → apply"门禁（见 `docs/working-model.md` / AGENTS.md）对调整结果同样适用：调整产出的是新 draft，未经 review 不写入 MySQL。

## 改动清单（按文件）

### 1. `src/coach_agent/src/agents/master_plan/agent.ts`

将 `createMasterPlanSubagent(store, config, generatesPlan: boolean)` 扩展为三态（`read` / `generate` / `adjust`），并新增工厂：

```ts
export function getMasterPlanAdjustSubagent(store: DataProvider, config: ModelConfig) {
  return createMasterPlanSubagent(store, config, "adjust");
}
```

`adjust` 态配置（与 `generate` 对齐，差异点标注）：

- `name`: `"adjust_master_plan"`
- `description`: `"调整既有赛季训练计划（伤病 / 目标赛事变化 / 目标成绩调整 / 时间约束 / 疲劳过度 / 中断复训），输出完整替换版 MasterPlan。"`
- `tools`：`get_master_plan`（从 `planTools` 过滤）+ `get_master_plan_context` + `ask_user_question`，**建议再加 `activities` + `trainingLoad`**（用于伤病/疲劳/复训分类时的"计划 vs 实际执行差距"分析）。
- `systemPrompt`: `ADJUST_MASTER_PLAN_PROMPT`（见下）。
- `responseFormat`: `MasterPlanDirectResponseSchema`（与 generate 相同）。
- `middleware`: `[createTurnScopeMiddleware(), createMasterPlanValidationMiddleware(), createLoggingMiddleware("agent:adjust_master_plan")]`。
- `skills`: `["/adjust-master-plan/"]`。

> 现有 `src/agents/master_plan/tools.ts`（mock `propose_master_adjustment`）未被引用，本方案以"完整替换版"取代"ops 草案"，该 mock 可保留或删除。

### 2. `src/coach_agent/src/agents/prompts.ts`

新增：

```ts
export const ADJUST_MASTER_PLAN_PROMPT = `你是 STRIDE 跑步教练的赛季计划调整专家。

当用户希望调整既有赛季训练计划时，使用 Skill "adjust-master-plan"。

调整必须严格分阶段：
1. 先调用 get_master_plan 检查是否有激活计划；无激活计划时说明并引导用户先创建新计划。
2. 调用一次 get_master_plan_context 获取当前能力、标定、负荷与 current_phase。
3. 依据 Skill 的调整原因分类确定策略，必要时调用 ask_user_question 追问（原因、严重程度、时长、约束）。
4. 冻结已完成阶段/周，只重排剩余赛季，通过结构化输出提交 { disposition: "return_direct", content: MasterPlan }；content 是完整替换版 MasterPlan，不要输出 Markdown。

依据工具查询数据进行分析和判断，不要凭空臆测。`;
```

更新 `ORCHESTRATOR_PROMPT`：新增路由"当用户要求调整既有赛季训练计划时，必须用 task 委派给 `adjust_master_plan`；该 task 成功返回后立即结束本轮"。

### 3. `src/coach_agent/src/agents/coachAgent.ts`

- import `getMasterPlanAdjustSubagent`；
- 实例化 `const masterPlanAdjuster = getMasterPlanAdjustSubagent(dataProvider, getAgentConfig(config, "master_plan"));`
- 加入 `subagents: [..., masterPlanAdjuster]`。

### 4. `src/coach_agent/src/agents/masterPlanPassthrough.ts`

`getPlanTaskResult` 的 `acceptedSubagents` 必须加入 `"adjust_master_plan"`，否则直出信封不会被 passthrough 中间件识别，orchestrator 会二次改写结构化计划：

```ts
export function getMasterPlanTaskResult(messages) {
  return getPlanTaskResult(messages, ["generate_master_plan", "adjust_master_plan"]);
}
// getDirectPlanTaskResult 同理：["generate_master_plan", "adjust_master_plan", "generate_weekly_plan"]
```

### 5. 路由与读/写分工（不新增文件）

- `orchestrator`（`src/agents/orchestrator.ts`）的 `master_plan` 意图当前落到 master_plan 读代理；`adjust_master_plan` 由 orchestrator 经 `task` 委派（与 `generate_master_plan` 同机制），无需改 orchestrator 的意图分类枚举。
- `master_plan` 读子代理继续负责"查看/解释/讨论既有计划"，`adjust_master_plan` 负责"实际调整并产出替换版计划"，二者不混用。

## 关键设计决策（已确认）

1. **产出形态 = 完整替换版 MasterPlan**（用户已确认）：冻结已完成阶段/周（原样透传 `summary`、`completed_actual`、`key_sessions`），只重排剩余赛季；复用 `MasterPlanSchema` + `return_direct` + 校验中间件 + 既有 draft→review→apply 门禁。
2. **调整原因驱动策略**：先分类（伤病 / 赛事变化 / 目标成绩 / 约束 / 疲劳 / 复训），再选策略——不同原因不同方案（见 SKILL.md Step 1.2 与 references/adjustment-playbook.md）。
3. **冻结原则（HARD）**：已完成阶段/周不得重写。

## 验证路径（实现后）

1. `npm run build`（确认 SKILL 与 references 被 copy 到 `dist/`）。
2. `npm run check`（biome）。
3. 复用 `test-output/master-plan/` 的既有 MasterPlan JSON 作为"当前激活计划"fixture，构造三种调整请求（伤病 / 赛事改期 / 目标下调）跑一次 `master_plan` 路径的 smoke，断言：冻结部分不变、`updated_at` 更新、`created_at` 保留、`total_weeks == weeks.length`、`version == 1`、`status == draft`。

## 后续可选加固（不在本次范围）

- `src/graph/master_plan/` 规划内核的 `requested_mode` 已预留 `replan_remaining_season` / `race_salvage` / `return_to_run` 等调整态（当前仅 `new_season` 落地，其余返回 `unsupported`）。若未来要把"调整"从 LLM 直出升级为内核级（deterministic simulation + rules + review），可在该内核补实现这些 mode，SKILL 语义不变。
