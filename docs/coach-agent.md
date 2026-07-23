# Coach Agent (LangGraph + Ports & Adapters)

**何时读**：改 `src/coach/*` 或 `src/stride_server/coach_*`、调 Azure Table checkpoint、加 Coach HTTP endpoint 时必读。

## 概览

STRIDE coach 是 LangGraph-based agent，处理三个场景：

- **S1** master-plan generation / chat
- **S2** weekly-plan adjustment chat
- **S3** daily Q&A

## 两层架构（`.importlinter` 强制）

| Layer | Path | 允许的 deps |
|-------|------|-------------|
| Core | `src/coach/` | `pydantic`, `langgraph`, `langchain-*`, `stride_core.{plan_spec,workout_spec,plan_diff,master_plan,master_plan_diff}` only |
| Adapters | `src/stride_server/coach_adapters/` | Core + `stride_core.db` + `coros_sync` + `azure.*` + `fastapi` |

`coach.*` 必须 **不** import `stride_server.*`、`coros_sync.*`、`garmin_sync.*`、`azure.*`、`fastapi.*` 或 `stride_core.db`。CI 用 `lint-imports` 强制（跑 `PYTHONPATH=src lint-imports`）。

## LLM roles, multiple provider surfaces (anti-commitment-bias)

| Role | Default model | Provider tag | LangChain class |
|------|---------------|--------------|-----------------|
| Generator (Coach Agent) | GPT-5.4 | `azure-openai` | `AzureChatOpenAI` |
| Reviewer | Claude Opus 4.7 | `azure-ai-inference` | `AzureAIChatCompletionsModel` |
| Commentary | GPT-4.1 | `azure-openai` | `AzureChatOpenAI` |
| Orchestrator | Reviewer fallback | provider-dependent | Resolver / memory extraction |
| Status insight | Generator fallback | provider-dependent | Read-only status Q&A / weekly summaries |

Role→model 绑定在两个 toml：**dev** `config/coach.local.toml`（gpt-5.5 @ azureai4identity，checked in 共享给所有 dev）+ **prod** `config/coach.prod.toml`（gpt-5.4 @ word-learner-llm；Docker build `cp coach.prod.toml coach.toml` 后这个就是 `coach.toml`）。`coach.runtime.config._resolve_path` 5 步链：(1) 显式 `path=` arg → (2) `STRIDE_COACH_CONFIG_PATH` env → (3) `coach.local.toml` → (4) `coach.toml` (Docker prod) → (5) cwd fallback。dev fresh checkout 自动跑 local；prod 容器里没 local 文件自动 fallback。Azure provider 打 Azure AI Foundry；auth 是 model-level `auth = "managed-identity"` 或 `auth = "api-key"`（旧配置的 `[auth].mode` 仍作为 fallback）。AAD token provider 在 `stride_server.coach_runtime` 构建（azure-identity 不能进 `coach.*`，import-linter 限制），每次按 role 注入。

Provider tags:

| Provider | LangChain class | Auth | Notes |
|----------|-----------------|------|-------|
| `azure-openai` | `AzureChatOpenAI` | MI or `api_key_env` | AOAI chat-completions / responses |
| `azure-ai-inference` | `AzureAIChatCompletionsModel` | MI or `api_key_env` | Foundry serverless |
| `openai-compatible` | `ChatOpenAI` | `api_key_env` | Third-party Chat Completions or Responses endpoints such as DeepSeek V4 and local Agent Maestro |

`config/coach.local.toml` carries a single local model registry under `[models.<key>]`, including DeepSeek V4 and Azure dev models. Shared model properties, including auth, live under the model key, while each role only references the key (`model = "deepseekv4pro"`) and can inherit role-specific defaults from `[models.<key>.generator]` / `[models.<key>.reviewer]` / etc. DeepSeek-specific knobs stay in `ModelSpec.extra`: `thinking` is passed via `extra_body`, `response_format` via `model_kwargs`, while graph/business code stays provider-neutral.

`[status_insight]` is optional and falls back to `[generator]` for backward
compatibility. Latency-sensitive configs should point it at a fast model;
`config/coach.copilot.toml` runs local Coach on Agent Maestro with `gpt-5.6-luna` at low
reasoning while plan generation and review stay on `gpt-5.6-sol`. Weekly summaries
should prefer the bounded
`get_training_summary` tool rather than repeatedly expanding activity queries.

Coach 的 read-tool surface 只暴露 STRIDE 自算指标和手表原始测量值。厂商
`fatigue / ATI / CTI / training_load_state / recovery_pct`、训练效果、跑力、
比赛预测等派生分数不得进入 Coach context；状态判断使用 STRIDE
`training_dose / acute_load / chronic_load / form / load_ratio` + 原始 RHR/HRV。
当前仍依赖 legacy 厂商恢复信号的 `readiness_gate/reasons`、ability L2、L3
recovery、L4 也必须在 Coach adapter 层屏蔽，直到算法完成迁移。
每个返回训练负荷的 Agent tool 都必须输出 `provenance`，且负荷数据放在明确的
`stride_training_load` / STRIDE PMC 字段中，标记 `source=stride`、
`vendor_derived=false`。STRIDE 负荷尚未计算时返回 `available=false` 和
`missing_reason=stride_load_not_computed`，禁止 fallback 到
`activities.training_load` 或 `daily_health.ati/cti/fatigue`。

`coach-cli --debug` emits privacy-safe performance metadata: model role/id,
elapsed time, message/input character counts, token usage, tool names, tool
elapsed time, and result size. It never logs prompts, tool payloads, or replies.

`coach-cli` 在交互终端中用 Rich 渲染 Coach 回复里的 Markdown（标题、列表、表格、代码块）；stdout 重定向到文件或 pipe 时保留原始 Markdown，避免 ANSI 和终端布局破坏脚本消费。
计划 proposal 在 CLI 中显示为带范围、摘要和逐项 diff 的卡片。所有自然语言输入
（包括讨论或确认 proposal）都交给 Coach LLM 理解；只有显式 `/apply N` 命令会由 CLI
调用 deterministic apply endpoint，副作用永不交给 Agent 判断或执行。
`--message` 一次性模式只展示 proposal 内容，不显示必须留在 REPL 中才能执行的
确认提示。

Resolver 的每个结构化 intent 都必须输出
`{specialist_id, action: read|write, confidence}`。模型根据语义选择 action 和
specialist；确定性后处理只验证 `action == write` 是否与 SpecialistCard 的
`writes` 一致，不用关键词重写模型选择。只读查询当前周计划或赛季总计划必须
路由到 `status_insight/read`，要求形成修改提案才路由到计划写专家。

**Commentary migrated**：自 PR #16 起 `stride_server.commentary_ai.generate_commentary` 通过 `coach_runtime.get_commentary_llm()` 走 `[commentary]` section。改 coach.toml 的 `[commentary]` section **会**直接影响生产 commentary 路径。`server.toml` 里历史 `[commentary]` 块（pre-PR-#16 残留）在 PR #25 删除。

两者在以下情况 raise `CoachLLMUnavailable`：(a) 配置文件缺失；(b) deployment id 是 placeholder（`<PLACEHOLDER_*>`）；(c) endpoint env var 缺失；(d) auth credentials 缺失。

## Persistence (plan §4)

| Table / container | PartitionKey | RowKey | Purpose |
|-------------------|--------------|--------|---------|
| `stridecoachcheckpoints` | `thread_id` | `checkpoint_id` (zero-padded ns) | Metadata 指向 `coach-checkpoints` blob |
| `stridecoachcheckpointwrites` | `thread_id\|checkpoint_id` | `task_id\|write_idx` | LangGraph pending writes |
| `stridecoachjobs` | `user_id` | `job_id` | Pattern A job lifecycle + heartbeat |
| `strideweeklyplan` | `user_id` | `date_from` (`YYYY-MM-DD`) | 当前完整 `WeeklyPlan` JSON（S2 canonical structured state） |
| `strideweeklyversions` | `user_id\|folder` | reverse-time `\|` version_id | S2 PlanDiff apply 审计 |
| `coach-checkpoints` blob | — | `{thread_id}/{checkpoint_id}.json.gz` | 完整 state envelope（gzip + sha256） |
| `stridemasterplan` / `stridemasterplanversions` | (现有，复用) | | C module 审计 |

`WeeklyPlanStore` 是运行时周计划的唯一来源，按周起始日期唯一存储。`folder`
只保留为展示和旧 API 兼容字段，不参与某周是否存在的判断。`plan.md` /
`plan.json` 仅作为迁移期导入输入；新生成和 Review 不依赖它们。
Coach 的当前周读取工具是无参数 `get_week_plan()`，按上海当天调用
`WeeklyPlanStore.get_current_plan(...)`；不读取 Blob/Markdown 或 SQLite fallback。
`strideweeklyversions` 只做版本审计，不能作为 current-state 查询表。
Local/file backend 是 `data/.weekly_plans.json`。
日历、今日计划、PlanDiff、营养和推手表都从 `WeeklyPlanStore` 读取；
`scheduled_workout` 仅保存本地设备执行状态，并以
`(week_folder, planned_date, session_index)` 反向引用 canonical session。

`AzureTableCheckpointSaver.from_env()` 在 `STRIDE_COACH_TABLE_ACCOUNT_URL` set 时选 Azure backend，否则 fallback 到 `data/_coach_dev/checkpoints/` 下的 JSON-file backend。

## v1 architectural patterns

- **Pattern Y**：AI chat 草稿工具 emit typed `PlanDiff` / `MasterPlanDiff`。Server 在 propose 和 apply 之间是 stateless —— diff 通过 request body 回到 apply endpoint。没有内存中的 pending-diff dict。
- **Pattern A**：Long-running jobs 用 FastAPI `BackgroundTasks` + Azure Table job 行 + heartbeats。App startup 在 lifespan hook 里跑 `JobScheduler.reconcile_stale_jobs()`（`app.py`）；`heartbeat_at` 超过 120s 的 RUNNING 行翻成 `FAILED`，`error_code='interrupted_by_restart'`。ACA 单副本（`--max-replicas 1`）—— 多副本需要 Service Bus。
- **Pattern X**：AI 永远不调任何 execute 工具。所有副作用（push to watch / apply diff / sync 等）走 deterministic UI-chip endpoint。Agent 只做 (a) reads (b) draft proposals。
- **Pattern P**：Conversation graphs 按请求构造（toolkit 在构造时绑定 user_id）；checkpointer + LLMs 是 `stride_server.coach_runtime` 里的 module-level singleton，测试用 `set_*_for_tests` 注入。

## Coach HTTP endpoints (S3 + audit)

| Method + path | Purpose |
|---------------|---------|
| `POST /api/users/me/coach/chat` | 唯一公开 Coach 对话入口。Session-threaded orchestrator brain，server 派生 `thread_id = f"{user_id}:coach:{session_id}"`，状态问答经 `status_insight` 只读 specialist。 |
| `GET /api/users/me/coach/threads/{thread_id}/messages` | 跨 session chat history。解析 thread_id；owner 段必须 == JWT.sub 否则 403。malformed → 400。支持 `coach` session thread；内部 `qa` scope 只作为 `status_insight` implementation detail，不再是 public API。 |
| `GET /api/users/me/coach/plan-versions/week/{folder}` | 倒序列出某周的 plan versions，限定 JWT.sub user_id。 |
| `GET /api/users/me/coach/plan-versions/week/{folder}/{version_id}` | Version artifact + parent chain。`folder` 必传 —— 没有全表扫描 fallback。missing 或 cross-user → 404。 |

## Generation pipeline (plan §7)

`build_generation_graph(load_context, generator, reviewer, apply_patches, max_iterations=3)` 产出 StateGraph 路由 `load_context → generator → rule_filter → reviewer → verdict`。Verdict 分支：

- `pass` → finalize
- `auto_fix` → apply_patches → finalize
- `revise` → loop back to generator（上限 `max_iterations`，否则 fallback）
- `block` → fallback（job marked failed）

`coach.graphs.generation.rule_filter.run_rule_filter(plan_dict, ...)` 是 pure-Python 预过滤，跑 7 条安全规则（weekly progression ≤ 1.10×、long run ≤ 35%、Z4-Z5 ≤ 20%、≥ 1 rest day、`WeeklyPlan.from_dict` validity、injury-conflict keyword check、CTL ramp ≤ 6 TSS/wk）。HARD 违规直接回 generator，不调（贵的）reviewer。

当前周/下周的确定性创建路径会先读取最近两个**完整上海自然周**的实际跑量，
以其中位数作为已吸收训练基线，并结合最新 STRIDE `load_ratio` 校准目标。
Master plan 周目标只提供周期方向：普通周不得因 master 过时而相对近期基线骤降
超过 10%；高负荷时允许受控降量；明确 recovery 周使用基线的 70–80%；taper
周保留比赛减量意图。周中创建还会锁定已完成日期，只把剩余里程预算分配到未来
训练，禁止事后把已完成训练改写成休息或重复课程。

## HMAC signature — deliberately not v1

Pattern Y apply 完整性通过 path-match validation（`diff.folder == path_folder`、`accepted_op_ids ⊆ diff.ops.id`）+ post-apply rule_filter rerun + schema validation 保证。HMAC 签名讨论过但推迟 —— 产品语义是"trust + 用户对自己的 plan 有完全权威"，HTTPS 处理 MITM。出现真实滥用 pattern 再加 HMAC。
