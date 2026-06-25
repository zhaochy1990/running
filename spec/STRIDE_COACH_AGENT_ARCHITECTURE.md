# STRIDE Coach Agent — 系统架构（对话即入口 / 分层 Supervisor-Orchestrator）

> 状态：Draft · 架构设计 · 与 [`STRIDE_COACH_PRODUCT_VISION.md`](./STRIDE_COACH_PRODUCT_VISION.md) 配套
> 本文定义"对话即入口"的核心 AI Agent 架构、专家契约、状态模型与 MVP 落地清单。

---

## 1. 设计目标 & 非目标

**目标**

- **一个对话框、一条滚动会话**：用户表达任意跑步诉求，系统识别意图、动态路由到能力，上下文跨意图连续。
- **能撑到 11 个能力域不返工**：加"装备专家""营养专家"是插一个模块，不是改编排脑。
- **安全可控、可观测、可调试**：安全敏感意图（伤病）有横切闸，写操作先提案后确认。
- **省 token**：专家 context 隔离、只回压缩结果、prompt 角色分离命中缓存。

**非目标（本期不做）**

- 主动教练 push（需触发设施，后置）。
- 伤病**医学知识库**全量、营养/恢复/装备/比赛/酒店**导购**（P2–P4，本期仅安全兜底）。
- 跨 agent 的远程 A2A 互操作（本期全在进程内；契约设计为**可日后投影到 A2A** 而不重定义）。

---

## 2. 架构总览

分层 **Supervisor-Orchestrator**：一个编排脑坐在最前，下挂领域专家子图。**Supervisor 保持控制**（委派调用，非 handoff 转移）——专家返回数据，编排脑汇总成最终回复并独占安全与 iterate/stop 决策。

```
用户一句话（单线程会话）
  │
  ▼
① 安全预筛 Safety Gate        [确定性 + 小模型] 伤病/医疗/情绪危机 → 安全道，锁写操作
  │
  ▼
② 意图+目标解析 Resolver      [LLM 出结构化 intent] + [确定性解析 active_target]；不明确→clarify
  │
  ▼
③ 编排规划 Supervisor         [LLM 出结构化 call plan] 复合意图拆成有序专家调用
  │
  ▼
④ 领域专家 Specialists        [subgraph，委派调用] 各自 scoped prompt + 工具子集，返回 SpecialistResult
  │     S1 master · S2 week · S3 qa · (后续 +装备/营养/比赛…)
  ▼
⑤ 汇总应答 Aggregator         [LLM] 多专家结果合成一条连贯回复 + 提案卡
  │
  ▼
状态更新：滚动会话 + active_target + 待确认 diff
```

**agentic 边界（混合）**：LLM 只产出**结构化决策**（intent / plan / 文案），所有**执行 / 路由 / 安全 / 派发**是确定性代码。

| 环节 | 谁做 | 理由 |
|---|---|---|
| 安全预筛 | 确定性规则 + 小模型 | 安全不赌 LLM，可强制、可观测 |
| 意图识别 | **LLM**（约束成 intent schema） | NLU 只能靠 LLM，但输出受 schema 约束 |
| active_target 解析 | 确定性（从会话状态推） | "哪周/哪个计划"是状态题非理解题 |
| 复合拆解 → call plan | **LLM** 产出结构化 plan | plan 是数据，由确定性 dispatcher 执行 |
| 派发执行 | 确定性 | 按 plan 调 subgraph，串/并行规则固定 |
| 汇总应答 | **LLM** | 多专家输出合成人话 |

---

## 3. 专家契约 SpecialistContract（核心）

> 综合业界共识（Anthropic 四字段任务、A2A AgentSkill/Task 生命周期、MCP typed I/O、LangGraph/OpenAI 委派调用、CrewAI Task/TaskOutput）。契约分三件：**Card（静态能力描述）/ Task（输入简报）/ Result（输出）**。

### 3.1 SpecialistCard — 静态能力描述符（注册一次，路由器读、不调用专家）

```python
class SpecialistCard(BaseModel):
    id: str                       # 稳定路由句柄: "weekly_plan" / "status_insight" / "injury_safety"
    description: str              # 「何时路由到我」—— router 读，≠ 执行 prompt
    tags: list[str]              # 意图关键词
    examples: list[str]          # 样例 utterance，锚定路由判断（A2A/ADK 共识：examples 提升路由准确度）
    input_schema: type[BaseModel]   # 该专家的 SpecialistTask 子类型
    output_schema: type[BaseModel]  # 该专家的 SpecialistResult 子类型
    writes: bool                 # 是否产出 proposal/diff —— 安全/权限闸据此判断
    data_needs: list[str]        # 消费哪些 read-tool（编排可预取，省往返）
```

**路由 = router 只读 Card（description + tags + examples），不调用专家。** 加新专家 = 注册一个 Card，supervisor 的 routing tool 从 Card 自动派生，**不改编排脑一行**。

### 3.2 SpecialistTask — 输入契约（Supervisor 每轮合成的富简报）

> Anthropic 实证：瘦任务（一句话目标）必致专家重复劳动/留空白。任务必须是富简报。

```python
class SpecialistTask(BaseModel):
    objective: str               # 本轮要达成什么（明确目标）
    active_target: TargetRef     # 哪个 plan/week/session（Resolver 解析，out-of-band）
    context: ScopedContext       # 专家要的那点 scoped 数据（NOT 全量 history）
    boundaries: str             # 边界 / 不要做什么
    conversation_window: list[Turn]  # 过滤后的近 N 轮（input 投影，不灌全量）
    # output_format 由 output_schema 隐含
```

`TargetRef`：`{kind: "master"|"week"|"session", plan_id?, folder?, date?, session_index?}`。

### 3.3 SpecialistResult — 输出契约（每个专家都返回）

```python
class SpecialistResult(BaseModel):
    status: Literal["completed", "needs_clarification", "failed", "rejected"]  # A2A 式生命周期
    reply_fragment: str          # 给用户的话（压缩，NOT 回原始数据）
    proposal: PlanDiff | MasterPlanDiff | None   # typed 写提案（Pattern Y，不落地）
    clarification: str | None    # needs_clarification 时反问什么（A2A input-required）
    artifacts: list[ArtifactRef] | None          # 重输出走引用（大数据不进编排脑 context）
    handoff_hint: str | None     # "这事该转给 XX 专家"
    usage: UsageStats | None     # token/tool 计量（可选）
```

**设计要点（落自研究共识）**：

- **context 隔离**：专家中间过程（read-tool 原始返回、推理）不回流编排脑，只回 `reply_fragment` + `proposal`。重数据走 `artifacts` 引用。省 token 的核心杠杆。
- **needs_clarification 是一等态**：专家可暂停反问（A2A 可中断态），Resolver/Aggregator 把反问透传给用户，下一轮续上。
- **proposal 复用现有 `PlanDiff`/`MasterPlanDiff`**：Pattern Y，专家**永不落地**，diff 随 HTTP 回包，用户确认走 `/apply`。
- **typed 两端**：input/output 都是 Pydantic，supervisor 可校验 handoff（MCP 下限）。

---

## 4. 编排脑节点详解

### 4.1 ① 安全预筛 Safety Gate（横切闸）

- **不是与"改课"并列的意图，而是优先级最高、能否决写操作的闸。**
- 确定性关键词/正则 + 小模型分类：识别伤病、医疗、情绪危机。
- 命中 → 走**安全道**（路由到 `injury_safety` 专家或 qa + 安全 prompt），**锁掉本轮所有写操作**（不允许任何 proposal 落地），只给保守建议（愿景不变量 #2）。
- 本期不做医学知识库，安全道 = "保守建议 + 不改计划 + 必要时建议线下就医"。

### 4.2 ② Resolver（意图 + 目标解析）

- **LLM 出结构化 intent**：`{intents: [{specialist_id, confidence}], is_compound, ambiguous}`，受 SpecialistCard 全集约束。
- **确定性解析 active_target**：从会话状态推当前 plan/week/session；缺失或多义 → 触发 clarify（不猜）。
- 输出喂给 Supervisor。

### 4.3 ③ Supervisor（编排规划）

- **LLM 产出结构化 call plan**：`[{specialist_id, task: SpecialistTask, depends_on: [...]}]`。
- **默认串行**（尤其涉及写）；**只读专家可并行**。
- plan 是数据，由确定性 dispatcher 执行（不让 LLM inline 调专家）。

### 4.4 ④ Specialists（领域专家，subgraph）

- 复用现有 conversation 图的 scope 设计，**每个 scope 降为一个 subgraph 专家**：
  - `master_plan`（S1 调整）· `weekly_plan`（S2 调整）· `status_insight`（S3 问答/诊断）· `plan_generation`（S1 建计划，包现有 `master_plan_generator`）· `injury_safety`（安全道）。
- 每个专家 = 自己的 scoped prompt + 自己那撮工具（read 子集 + draft 子集）。
- **委派调用**：dispatcher 调 subgraph，专家返回 `SpecialistResult`，控制权回编排脑。

### 4.5 ⑤ Aggregator（汇总应答）

- **LLM** 把多个 `SpecialistResult.reply_fragment` 合成一条连贯回复。
- 收集所有 `proposal` → 组装提案卡（前端确认 UI）。
- 若任一专家 `needs_clarification` → 优先把反问透传用户。

---

## 5. 状态模型 & 单线程会话

### 5.1 单线程滚动会话（地基改造）

| 现在 | 改成 |
|---|---|
| `thread_id = {user}:{scope}:{key}`（每 scope/每天一条线程）| `thread_id = {user}:coach`（一个用户一条滚动会话）|
| `scope` 是线程键一部分（绑死）| `scope` 降为 **turn 级字段**，Resolver 每轮设 |
| qa 每天新开线程 | qa/week/master **共用一条线程** → 上下文跨意图连续 |
| active target 藏线程键 | `active_target` 升为**会话状态显式字段**，随对话切换 |

`ConversationState` 新增/调整字段：`active_target: TargetRef`、`turn_scope`（本轮路由结果）、`pending_proposals`、`safety_locked: bool`。

### 5.2 History 窗口化（单线程的必付成本）

- 会话只增不减 → 必须 **近 N 轮全文 + 更早压缩成滚动摘要**。
- checkpointer（`AzureTableCheckpointSaver`）keying 简化为一个用户一 partition。
- 摘要触发：turn 数 / token 阈值；摘要本身是一次受控 LLM 调用（system=摘要规则，user=待压缩轮次）。

### 5.3 状态分离（model-visible vs out-of-band）

- **model-visible**：对话 messages（喂 LLM）。
- **out-of-band typed context**（不进 LLM 消息流）：`active_target`、`user_id`、预取数据、`SpecialistResult.artifacts`。对齐 OpenAI `RunContextWrapper[T]` / LangGraph 私有 channel。

---

## 6. 专家注册与扩展

加一个新专家（如"装备专家"）的完整步骤：

1. 写一个 `SpecialistCard`（id/description/tags/examples/schemas/writes/data_needs）。
2. 实现 `Task → Result`（一个 subgraph 或纯算法函数——契约不关心内部是不是 LLM）。
3. 注册进 `SpecialistRegistry`。

**Supervisor / Resolver / Aggregator 全部不改**：routing 从 Card 自动派生，dispatcher 按契约调用。这是契约设计的核心兑现点。

---

## 7. MVP 功能边界

**MVP 收录**（编排脑 + 复用已建能力）：

| 能力 | 专家 | 现状 | MVP 工作 |
|---|---|---|---|
| 🧠 编排脑（安全/Resolver/Supervisor/Aggregator） | — | 🔴 无 | **新建（核心增量）** |
| 状态查询/诊断 | `status_insight` | ✅ LIVE（qa） | 降为专家接契约 |
| 周计划调整 | `weekly_plan` | ⚠️ 80%（5/7 工具，无 endpoint）| 接契约 + 补 2 占位工具 |
| 建赛季计划 | `plan_generation` | ✅ LIVE（generator）| 对话触发 |
| **改赛季计划** | `master_plan` | 🔴 6 工具全占位 | **实现 6 个 master draft 工具**（US-009）|
| 安全兜底 | `injury_safety` | 🔴 无 | 新建（保守建议，不接知识库）|
| 单线程 + history 窗口化 | — | 🔴 每-scope 线程 | 地基改造 |

**MVP 推迟**：伤病医学知识库（全量）· 营养/恢复/装备/比赛/酒店导购 · 主动 push · 社区 · 远程 A2A。

---

## 8. 改动清单（文件级）

**新增**

- `src/coach/contracts/specialist.py` — `SpecialistCard` / `SpecialistTask` / `SpecialistResult` / `TargetRef`（core 层，纯 pydantic）。
- `src/coach/graphs/orchestrator/` — 编排图：`safety_gate.py` · `resolver.py` · `supervisor.py` · `aggregator.py` · `dispatcher.py` · `registry.py`。
- `src/coach/graphs/orchestrator/prompts/` — 各节点 system/user 分离 prompt（遵守 prompt role discipline）。
- 新 endpoint `POST /api/users/me/coach/conversations/messages`（统一入口）于 `routes/coach.py`。
- `injury_safety` 专家 + 安全道 prompt。

**修改**

- `src/coach/graphs/conversation/` — 现有 scope 图降为专家 subgraph，接 `SpecialistContract`。
- `ConversationState`（`schemas/conversation.py`）— 加 `active_target` / `turn_scope` / `pending_proposals` / `safety_locked`；thread_id 方案改单线程。
- `persistence/checkpointer.py` — 单线程 keying；加 history 窗口化/摘要。
- 实现占位工具：week 的 `change_pace_target` / `regenerate_week`（US-007）；master 的 6 个（US-009）。

**删除**

- `src/stride_server/routes/plan_chat.py` + 其路由注册（与 `weekly_plan` 专家功能重复，收敛到 LangGraph 专家）。

---

## 9. 分阶段落地

- **A0 地基**：单线程会话 + history 窗口化 + `SpecialistContract` 类型 + Registry 脚手架。
- **A1 编排脑**：Safety Gate + Resolver + Supervisor + Aggregator + dispatcher；接入 `status_insight`（已 LIVE，最易验证端到端）。新 endpoint 上线。
- **A2 周计划专家**：`weekly_plan` 接契约 + 补 2 占位工具；**删 plan_chat**。
- **A3 赛季专家**：`plan_generation`（建）+ `master_plan`（改，实现 6 工具）。
- **A4 安全道**：`injury_safety` 专家 + 全链路写锁验证。

每阶段以"端到端对话可跑 + 回归不变量通过"为完成线。

---

## 10. 与现有架构约束的关系

- **两层架构（`.importlinter`）**：契约类型、编排图、专家图放 `coach.*` core（纯 pydantic/langgraph/stride_core 纯模块）；碰 DB/sync/azure 的专家 impl 放 `coach_adapters`。
- **Pattern X/Y**：专家 `proposal` 是 diff、永不落地；服务端无状态，diff 随回包，`/apply` 确认后落。
- **Prompt role discipline**：编排脑每个 LLM 调用（Resolver/Supervisor/Aggregator/摘要）都 **system=不变规则/schema，user=本轮数据**，命中缓存。
- **不重复造轮子**：read/draft 工具复用现有 `StrideToolkit`；负荷/基线复用 `training_load` / `running_calibration` 纯模块。

---

## 11. 开放问题

1. Resolver 与 Safety Gate 能否合并成一次 LLM 调用（省一跳延迟），还是安全必须独立确定性先行？
2. History 摘要的粒度与触发阈值（轮数 vs token）。
3. `active_target` 多义时的 disambiguation UX（反问 vs 默认最近）。
4. 并行只读专家的结果合并顺序对 Aggregator 文案的影响。
5. SpecialistResult.artifacts 的存储后端（复用 checkpointer vs 独立）。
6. master draft 6 工具（US-009）的 diff 语义与校验 gate。

---

*本文为 Agent 架构总纲，后续每个专家 / 编排节点 / 单线程迁移拆独立设计 doc。*
