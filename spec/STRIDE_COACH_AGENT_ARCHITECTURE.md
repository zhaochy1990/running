# STRIDE Coach Agent — 系统架构（对话即入口 / 分层 Supervisor-Orchestrator）

> 状态：Draft · 架构设计 · 与 [`STRIDE_COACH_PRODUCT_VISION.md`](./STRIDE_COACH_PRODUCT_VISION.md) 配套
> 本文定义"对话即入口"的核心 AI Agent 架构、专家契约、**三层记忆（含跨会话长期记忆）**、状态模型与 MVP 落地清单。

---

## 1. 设计目标 & 非目标

**目标**

- **对话即入口、多会话并存**：用户表达任意跑步诉求，系统识别意图、动态路由；一个会话内上下文跨意图连续，用户可另开新会话聊不同话题。
- **三层记忆**：turn 工作记忆（本轮）/ session 会话记忆（追问、上下文连续）/ **athlete 长期记忆**（伤病/约束/偏好跨会话持久，注入后续规划）。
- **能撑到 11 个能力域不返工**：加"装备专家""营养专家"是插一个模块，不是改编排脑。
- **安全可控、可观测、可调试**：安全敏感意图（伤病）有横切闸，写操作先提案后确认。
- **省 token**：专家 context 隔离、只回压缩结果、prompt 角色分离命中缓存。

**非目标（本期不做）**

- 主动教练 push（需触发设施，后置）。
- **Safety Gate 安全闸 + `injury_safety` 专家**（pipeline 预留闸位；本期靠 Pattern Y 逐条确认 + 专家 prompt 保守条款 + Memory Writer 持久化伤病兜底）。
- 伤病**医学知识库**全量、营养/恢复/装备/比赛/酒店**导购**（P2–P4）。
- 跨 agent 的远程 A2A 互操作（本期全在进程内；契约设计为**可日后投影到 A2A** 而不重定义）。
- 长期记忆的**自动主题归类 / 多会话自动合并**（本期会话由用户显式新建；记忆是 athlete-global，不做 per-topic 分桶）。

---

## 2. 架构总览

分层 **Supervisor-Orchestrator**：一个编排脑坐在最前，下挂领域专家子图。**Supervisor 保持控制**（委派调用，非 handoff 转移）——专家返回数据，编排脑汇总成最终回复并独占安全与 iterate/stop 决策。

```
用户一句话（某个 session 线程）
  │
  ▼
⓪ 载入记忆 Memory Load        [确定性] session history（窗口化）+ athlete 长期记忆（active，预算内注入）
  │
  ▼
① 意图+目标解析 Resolver      [LLM 出结构化 intent] + [确定性解析 active_target]；不明确→clarify
  │
  ▼
② 编排规划 Supervisor         [LLM 出结构化 call plan] 复合意图拆成有序专家调用
  │
  ▼
③ 领域专家 Specialists        [subgraph，委派调用] 各自 scoped prompt + 工具子集，返回 SpecialistResult
  │     S1 master · S2 week · S3 qa · (后续 +装备/营养/比赛…)
  ▼
④ 汇总应答 Aggregator         [LLM] 多专家结果合成一条连贯回复 + 提案卡
  │
  ▼
⑤ 记忆萃取 Memory Writer      [LLM 结构化抽取，best-effort] 萃取持久事实（伤病/约束/偏好）→ 长期记忆 + 透明回执
  │
  ▼
状态更新：session 追加 + active_target + 待确认 diff + 长期记忆 upsert

（预留闸位：安全预筛 Safety Gate 横切闸 —— **本期不做**，见 §1 非目标；本期安全底线 = Pattern Y 逐条确认 + 专家 prompt 保守条款）
```

**agentic 边界（混合）**：LLM 只产出**结构化决策**（intent / plan / 文案），所有**执行 / 路由 / 安全 / 派发**是确定性代码。

| 环节 | 谁做 | 理由 |
|---|---|---|
| 记忆载入 / 注入 | 确定性（按 salience 取 active 记忆） | 注入预算与排序是策略题，非理解题 |
| 意图识别 | **LLM**（约束成 intent schema） | NLU 只能靠 LLM，但输出受 schema 约束 |
| active_target 解析 | 确定性（从会话状态推） | "哪周/哪个计划"是状态题非理解题 |
| 复合拆解 → call plan | **LLM** 产出结构化 plan | plan 是数据，由确定性 dispatcher 执行 |
| 派发执行 | 确定性 | 按 plan 调 subgraph，串/并行规则固定 |
| 汇总应答 | **LLM** | 多专家输出合成人话 |
| 记忆萃取 | **LLM**（约束成 memory schema） | 从自然语言抽持久事实只能靠 LLM，输出受 schema 约束、写入确定性去重 |

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

> Safety Gate 安全闸本期不做，pipeline 预留闸位（⓪ 与 ① 之间）；本期安全底线见 §1 非目标 / §7。

### 4.1 ① Resolver（意图 + 目标解析）

Resolver 干两件性质不同的事——**意图识别（理解题，LLM）** + **目标解析（状态题，确定性）**——合成**一次 LLM 调用 + 确定性后处理**，不多花 LLM 跳。

**内部流程**：

```
入参: utterance + conversation_window(近几轮) + 上一轮 active_target(session 带来) + SpecialistRegistry(全部 Card)
  │
  ▼ ① 一次 LLM, structured output, specialist_id 受 Card 全集 enum 约束
  ResolverDraft {
    intents: [{specialist_id, confidence}],        # 锁在已注册专家里，不能瞎编
    is_compound: bool,                             # 一句话多诉求
    target_hint: {kind, ref_phrase, is_anaphora},  # "第3周" / "明天那节间歇" / "它"
    self_ambiguity: bool
  }
  │
  ▼ ② 确定性: target_hint → TargetRef
     is_anaphora("它/这个")  → 复用上一轮 active_target
     显式("第3周")           → 查 active plan 的 week 索引解析成 plan_id/date
     缺省                    → 当前周 / active master
  │
  ▼ ③ 确定性: 仲裁是否 clarify（不猜）
     intent 置信度低 / 平票        → clarify(intent)
     target 多义 且 本轮含写       → clarify(target)
     target 多义 但只读           → 默认最近 + 继续（不反问）
  │
  ▼ 出 ResolverOutput → Supervisor   (或短路: clarify 直接回用户，下一轮续上)
```

**设计要点**：

- **意图识别只能 LLM，但锁死 Card enum**：`specialist_id` 约束在 `SpecialistRegistry` 全集（constrained decoding / 校验重试），不能编不存在的专家。Card 的 `description/tags/examples` 即路由菜单 → **加新专家=加张 Card，Resolver 一行不改**。
- **target 是状态题非理解题 → 确定性**：LLM 只抽**指代短语**（`target_hint`），把短语解析成具体 `TargetRef` 是确定性代码（查会话状态 + DB 索引）。指代消解靠上一轮提升来的 `active_target`（§5.4）。
- **compound 由 Resolver 识别、Supervisor 排序**：Resolver 只标 `is_compound` + 列意图；**串/并、谁先谁后**是 Supervisor 的活（§4.2）。
- **clarify 只在"歧义会改变结果"时触发**：只读 QA 的 target 不清就默认最近直接答；**写操作**的 target 不清才必须澄清——否则每句都反问很烦。

**Prompt 角色分离（HARD）**：

| Turn | 装什么 | 缓存 |
|---|---|---|
| **System** | 分类器人设 + 输出 schema + **Card catalog**(id/description/tags/examples) + 决策规则(置信度阈值 / 何时 clarify / compound 上限) | catalog 跨用户跨轮**字节稳定**(仅加专家时变) → 命中缓存 |
| **User** | 本轮 utterance + conversation_window | 每轮变 |

**输出契约**（`coach.contracts` 内）：

```python
class IntentHit(BaseModel):
    specialist_id: str           # 锁在 Registry 全集
    confidence: float

class Ambiguity(BaseModel):
    kind: Literal["intent", "target"]
    clarification: str           # 反问什么

class ResolverOutput(BaseModel):
    intents: list[IntentHit]
    is_compound: bool
    active_target: TargetRef | None
    ambiguity: Ambiguity | None  # 非 None → 短路 clarify，不派发专家
    resolved_from: str           # 留痕: "anaphora" | "explicit" | "default"
```

**硬化**：非法 `specialist_id` → 校验重试 / 兜底 `status_insight`；彻底跑题（无 Card 过阈值）→ 简短礼貌拒答，不硬塞专家；幻觉式 compound → intent 数上限 + 置信度地板。首批 Card 直接从现有 qa/week/master 三 scope 派生（`specialist_id` ≈ 现 `scope`）。

### 4.2 ② Supervisor（编排规划）

- **LLM 产出结构化 call plan**：`[{specialist_id, task: SpecialistTask, depends_on: [...]}]`。
- **默认串行**（尤其涉及写）；**只读专家可并行**。
- plan 是数据，由确定性 dispatcher 执行（不让 LLM inline 调专家）。

### 4.3 ③ Specialists（领域专家，subgraph）

- 复用现有 conversation 图的 scope 设计，**每个 scope 降为一个 subgraph 专家**：
  - `season_plan`（S1 赛季计划，**generate / amend 两种 typed 操作**）· `weekly_plan`（S2 调整）· `status_insight`（S3 问答/诊断）。（`injury_safety` 安全道本期不做，见 §1 非目标）
- **`season_plan` 合二为一**：建/改是同一能力的两种操作（CRUD-split 反模式规避），Resolver 路由到这一个专家，专家拿全上下文内部判定 generate（无计划/用户要重做）vs amend（局部改）。`regenerate` **委派到同一条生成 pipeline，不复制**（单源，CLAUDE.md 不重复造轮子）。其 `SpecialistResult.proposal` 支持两种形态：全量计划草稿 OR `MasterPlanDiff`。
- 每个专家 = 自己的 scoped prompt + 自己那撮工具（read 子集 + draft 子集）。
- **委派调用**：dispatcher 调 subgraph，专家返回 `SpecialistResult`，控制权回编排脑。

### 4.4 ④ Aggregator（汇总应答）

- **LLM** 把多个 `SpecialistResult.reply_fragment` 合成一条连贯回复。
- 收集所有 `proposal` → 组装提案卡（前端确认 UI）。
- 若任一专家 `needs_clarification` → 优先把反问透传用户。

### 4.5 ⑤ Memory Writer（长期记忆萃取，post-turn）

- 回复已生成后运行，**best-effort 不阻塞用户应答**（失败只丢日志，不影响本轮）。
- **LLM 结构化抽取**：扫本轮对话，产出 `MemoryWrite[]`（add/update/resolve），受 `AthleteMemory` schema 约束。
- **确定性去重 / 合并**：与现有 active 记忆比对，重复不写、矛盾走 update（如"跟腱已恢复"→ 把旧伤 `status=resolved`）。
- **透明回执**：写入伤病/约束类记忆时，Aggregator 在回复尾部带一句"已记住：…，后续计划会据此调整"，用户可纠正（下一轮"删掉这条"→ resolve）。
- **本期是伤病的主要承接点**：Safety Gate 本期不做（§1 非目标），所以伤病信息主要靠 Writer 持久化 + 专家 prompt 保守条款兜底，而非硬闸。

---

## 5. 状态模型 & 三层记忆

### 5.0 三层记忆（总览）

| 层 | 生命周期 | 存储 | 用途 |
|---|---|---|---|
| **Turn 工作记忆** | 1 个 request | out-of-band typed channel（内存） | `active_target` / `safety_locked` / 预取数据 / 本轮 `SpecialistResult` |
| **Session 会话记忆**（短期） | 1 个会话线程 | checkpointer thread `{user}:coach:{session_id}` | 追问、上下文跨意图连续；history 窗口化 |
| **Athlete 长期记忆** | 跨会话永久 | **Azure Table（dev JSON）** | 伤病/约束/偏好/目标 → 注入 QA context + 规划（S1/S2） |

### 5.1 多会话（修正"单线程"）

> 原 spec 定"单线程"是为修 per-scope/per-day 线程碎片化导致的**上下文断裂**。但把所有对话塞进一条全局线程是**过度修正**——用户会像用 ChatGPT 一样开多个会话聊不同话题。正确解：**按 session 分线程**，跨会话连续性靠长期记忆，不靠串线程。

| 现在 | 改成 |
|---|---|
| `thread_id = {user}:{scope}:{key}`（每 scope/每天一条线程）| `thread_id = {user}:coach:{session_id}`（按用户显式新建的会话分线程）|
| `scope` 是线程键一部分（绑死）| `scope` 降为 **turn 级字段**，Resolver 每轮设 → **会话内**跨意图连续 |
| qa 每天新开线程 | 同一 session 内 qa/week/master 共用线程；新话题用户**另开 session** |
| active target 藏线程键 | `active_target` 升为**会话状态显式字段**，随对话切换 |
| 跨会话无记忆 | **长期记忆**承载跨会话的伤病/约束/偏好/目标 |

`ConversationState` 新增/调整字段：`session_id`、`active_target: TargetRef`、`turn_scope`（本轮路由结果）、`pending_proposals`、`safety_locked: bool`、`injected_memories: list[str]`（本轮注入的记忆 id，便于追溯）。

**Session 管理**：session 由用户显式新建（前端"新会话"）。MVP 仅需 `session_id` 入参 + 一个会话列表 endpoint；不做自动主题切分/合并。

### 5.2 History 窗口化（per session · summarization buffer）

单会话只增不减 → **滚动摘要缓冲**：`[会话滚动摘要] + [近 N 轮全文] + [本轮]`，按 session 维护。复用 LangGraph 既有件（`langmem.SummarizationNode` / `trim_messages`），不自造。

```
[会话滚动摘要]  ← 更早轮次，压成一段（主题线 / 未决问题 / 用户口吻偏好）
[近 N 轮全文]   ← 最近对话，逐字保留
[本轮 user]
```

**约束 1 — 批量摘要保缓存（HARD）**：摘要与 prompt caching 直接冲突——缓存命中靠前缀逐字节相同，**逐轮重摘**会让会话前缀每轮变 → 缓存全 miss，省的被烧的抵消。因此**批量摘要、不逐轮**：

- 近 N 轮窗口内只 append、前缀不动 → 这 N 轮持续命中缓存。
- 触阈值才**一次性**把最老一批压进摘要 → 前缀仅那一刻变一次，之后又稳定 N 轮。

**约束 2 — 摘要可 lossy（因为事实另有可靠归宿）**：STRIDE 比通用 chatbot 好压，重要信息不靠 history 扛：

| 信息 | 归宿 | 压缩时 |
|---|---|---|
| `active_target` / `pending_proposals` / `safety_locked` | out-of-band typed state（§5.4） | 不进 message history，**零损失不用压** |
| 伤病/约束/偏好等持久事实 | 已被 Memory Writer 抽进**长期记忆**（§5.3） | 摘要**可 lossy** —— 丢了 store 里还在 |

→ 摘要只需保"对话语义脉络"，不需无损保事实 → 能用**更激进、更便宜**的摘要。

**推荐参数**：

- **窗口**：近 ~12–16 轮全文（覆盖一次完整"提案→确认→追问"）。
- **触发**：窗口外累计 token > ~6–8k 时压最老一批（按 token，非按轮数硬切）。
- **摘要模型**：廉价档（如 gpt-4.1-mini）；system=摘要规则，user=待压缩轮次。
- **摘要只留**：主题线 / 未决问题 / 用户偏好口吻；**不留**可被长期记忆或结构化 state 覆盖的内容。

checkpointer（`AzureTableCheckpointSaver`）keying 含 `session_id`（PartitionKey=user_id，RowKey 含 session）。

### 5.3 长期记忆系统（Athlete Memory）

**存储边界（HARD）**：长期记忆是用户口述、**非手表 sync** → 按 CLAUDE.md 存储规则**禁止进 `coros.db`**。落 **Azure Table Storage**（PartitionKey=user_id，RowKey=memory_id），复用 `likes_store.py` 的 two-backend pattern（dev JSON / prod Azure Table + `DefaultAzureCredential`），**不发明新后端**。

**记忆项 schema**（`coach.contracts.memory.AthleteMemory`，core 层纯 pydantic）：

```python
class AthleteMemory(BaseModel):
    id: str
    kind: Literal["injury", "constraint", "preference", "goal", "life_event", "equipment"]
    content: str                 # 规范化事实: "右跟腱不适，落地痛"
    status: Literal["active", "resolved", "expired"]
    salience: float              # 注入预算排序权重
    affects: list[str]           # 影响哪些规划维度: ["training_load","session_type"]
    evidence: str                # 原话引用（可追溯）
    source_session: str
    created_at: str; updated_at: str
    expires_at: str | None       # 软约束类记忆可设过期
```

**写路径**：§4.5 Memory Writer 萃取 → 去重/合并 → `AthleteMemoryStore.upsert`。透明回执让用户可纠正。

**读路径（注入）**——两个消费点，都进 **user prompt**（prompt-role-discipline：per-athlete 数据不进 system，否则毁缓存）：

1. **对话**：Memory Load（⓪）按 `salience` × 与本轮 intent 相关度排序，预算内注入 Resolver/专家的 user context。
2. **规划**：S1/S2 生成时，`AthleteMemoryStore.fetch_active()` 的伤病/约束注入 planner user prompt 的"已知约束"段 → **训练自动规避**（兑现"跟腱受伤 → 后续计划针对性调整"）。这是 chat 记忆 → 训练适配的桥。

**与现有 `constraints` 的关系**：长期记忆是 `ConversationState.constraints` 的持久化上位来源；现有 inline constraints 收敛为"从 store 注入"，不再各处临时拼。

### 5.4 状态分离 & Turn 工作记忆生命周期

**两类状态（按是否喂给 LLM 分）**：

- **model-visible**：对话 messages（喂 LLM）—— 即 session 会话记忆的自然语言轮次。
- **out-of-band typed context**（结构化、节点间传、**不进 LLM 消息流**）：`active_target`、`session_id`、`user_id`、预取数据、注入的 `AthleteMemory`、各 `SpecialistResult`、`safety_locked`、正在攒的 `pending_proposals`。对齐 OpenAI `RunContextWrapper[T]` / LangGraph graph State / 私有 channel。

**为什么分**：① 系统句柄（`user_id`/`plan_id`）是给代码用的，不污染 prompt；结构化数据走 typed channel 不 stringify。② out-of-band 不在 message history 里 → §5.2 摘要**永远碰不到它**，`active_target` 这类零损失（这是"摘要可 lossy"成立的一半，另一半是事实进了长期记忆）。

**Turn 工作记忆生命周期**：Turn 工作记忆 = 处理"这一条用户消息"时的草稿台，生命周期 = 一次 pipeline（⓪→⑤）。**大部分临时、用完即弃；少数字段 turn 末提升进 session（`ConversationState`）带往下一轮。**

| 字段 | turn 末 | 理由 |
|---|---|---|
| `active_target` | **提升** | 下一轮"它/这个"指代消解要用（指代消解） |
| `pending_proposals` | **提升** | 用户下一轮才确认/拒；横跨多轮 |
| `injected_memories`（本轮注入的记忆 id） | **提升** | 留痕/可追溯（这条建议依据哪些记忆） |
| `safety_locked` | **提升**（按需） | 安全态可能需续到澄清完成 |
| 预取的 read-tool 数据 | 丢弃 | 下一轮按需重取；缓存在 toolkit 层 |
| 各 `SpecialistResult`（reply_fragment/中间过程） | 丢弃 | 已被 Aggregator 合进 model-visible 回复 |
| `SpecialistResult.artifacts` 大数据 | 丢弃（引用） | 重数据走外部引用，不进会话状态 |
| 本轮 intent / call plan | 丢弃 | 派生量，下一轮重算 |

口诀：**工作记忆是本轮的全部临时杂物，收尾只挑"下一轮还要用的"塞进 session，其余清空。**

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
| 赛季计划（建+改） | `season_plan` | 建 ✅ LIVE（generator）/ 改 🔴 6 工具全占位 | 合二为一接契约（generate/amend）+ **实现 6 个 master draft 工具**（US-009）；regenerate 委派生成 pipeline |
| 多会话 + history 窗口化 | — | 🔴 每-scope 线程 | 地基改造（session 分线程）|
| **长期记忆**（写萃取 + 读注入） | Memory Writer + Store | 🔴 无 | **新建**（Azure Table，注入 QA + 规划）|

**MVP 推迟**：**Safety Gate 安全闸 + `injury_safety` 专家**（本期靠 Pattern Y 确认 + 专家 prompt 保守条款兜底）· 伤病医学知识库（全量）· 营养/恢复/装备/比赛/酒店导购 · 主动 push · 社区 · 远程 A2A · 长期记忆的自动主题分桶/多会话合并。

---

## 8. 分阶段落地

- **A0 地基**：session 分线程会话 + history 窗口化 + `SpecialistContract`/`AthleteMemory` 类型 + Registry 脚手架。
- **A1 编排脑**：Memory Load + Resolver + Supervisor + Aggregator + dispatcher；接入 `status_insight`（已 LIVE，最易验证端到端）。新 endpoint 上线。
- **A2 周计划专家**：`weekly_plan` 接契约 + 补 2 占位工具；**删 plan_chat**。
- **A3 赛季专家**：`season_plan`（generate 接现有 generator + amend 实现 6 工具；regenerate 委派生成 pipeline）。
- **A4 长期记忆**：Memory Writer + `AthleteMemoryStore` + 注入规划（S1/S2 user prompt）+ 透明回执。
- **（后置，非本期）安全道**：Safety Gate 横切闸 + `injury_safety` 专家 + 全链路写锁验证（见 §1 非目标）。

每阶段以"端到端对话可跑 + 回归不变量通过"为完成线。

---

## 9. 与现有架构约束的关系

- **两层架构（`.importlinter`）**：契约类型、编排图、专家图放 `coach.*` core（纯 pydantic/langgraph/stride_core 纯模块）；碰 DB/sync/azure 的专家 impl 放 `coach_adapters`。
- **Pattern X/Y**：专家 `proposal` 是 diff、永不落地；服务端无状态，diff 随回包，`/apply` 确认后落。
- **Prompt role discipline**：编排脑每个 LLM 调用（Resolver/Supervisor/Aggregator/Memory Writer/摘要）都 **system=不变规则/schema，user=本轮数据 + 注入记忆**，命中缓存。
- **存储边界（HARD）**：长期记忆是口述、非手表 sync → **禁止进 `coros.db`**，落 Azure Table（复用 `likes_store.py` two-backend pattern）；session 会话记忆走 checkpointer。
- **不重复造轮子**：read/draft 工具复用现有 `StrideToolkit`；负荷/基线复用 `training_load` / `running_calibration` 纯模块；伤病/约束类记忆与 `running_calibration` baseline 分工（口述 vs 算法）。

---

## 10. 开放问题

1. Resolver 与 Safety Gate 能否合并成一次 LLM 调用（省一跳延迟），还是安全必须独立确定性先行？
2. ~~History 摘要的粒度与触发阈值~~ → **已定**（§5.2）：summarization buffer，批量摘要保缓存，按 token(~6–8k)触发，窗口近 12–16 轮，摘要可 lossy（事实已被长期记忆/结构化 state 接走）。剩余可调：N 与阈值的实测标定。
3. `active_target` 多义时的 disambiguation UX（反问 vs 默认最近）。
4. 并行只读专家的结果合并顺序对 Aggregator 文案的影响。
5. SpecialistResult.artifacts 的存储后端（复用 checkpointer vs 独立）。
6. master draft 6 工具（US-009）的 diff 语义与校验 gate。
7. 长期记忆写入是否需要用户确认门槛（伤病高 salience 自动写 vs 一律先回执后写）；纠正/遗忘的 UX。
8. 记忆注入预算与相关度打分函数（salience × recency × intent 匹配）；冲突记忆（"恢复了" vs 旧伤）的合并裁决。
9. 长期记忆与 onboarding profile / `running_calibration` baseline 的边界（口述事实 vs 算法基线，避免双源）。

---

*本文为 Agent 架构总纲，后续每个专家 / 编排节点 / 单线程迁移拆独立设计 doc。*
