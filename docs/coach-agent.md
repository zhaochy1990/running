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

## Three LLM roles, multiple provider surfaces (anti-commitment-bias)

| Role | Default model | Provider tag | LangChain class |
|------|---------------|--------------|-----------------|
| Generator (Coach Agent) | GPT-5.4 | `azure-openai` | `AzureChatOpenAI` |
| Reviewer | Claude Opus 4.7 | `azure-ai-inference` | `AzureAIChatCompletionsModel` |
| Commentary | GPT-4.1 | `azure-openai` | `AzureChatOpenAI` |

Role→model 绑定在两个 toml：**dev** `config/coach.local.toml`（gpt-5.5 @ azureai4identity，checked in 共享给所有 dev）+ **prod** `config/coach.prod.toml`（gpt-5.4 @ word-learner-llm；Docker build `cp coach.prod.toml coach.toml` 后这个就是 `coach.toml`）。`coach.runtime.config._resolve_path` 5 步链：(1) 显式 `path=` arg → (2) `STRIDE_COACH_CONFIG_PATH` env → (3) `coach.local.toml` → (4) `coach.toml` (Docker prod) → (5) cwd fallback。dev fresh checkout 自动跑 local；prod 容器里没 local 文件自动 fallback。Azure provider 打 Azure AI Foundry；auth 是 Managed Identity（`mode = "managed-identity"`）或 role 级 `api_key_env`。AAD token provider 在 `stride_server.coach_runtime` 构建（azure-identity 不能进 `coach.*`，import-linter 限制），每次按 role 注入。

Provider tags:

| Provider | LangChain class | Auth | Notes |
|----------|-----------------|------|-------|
| `azure-openai` | `AzureChatOpenAI` | MI or `api_key_env` | AOAI chat-completions / responses |
| `azure-ai-inference` | `AzureAIChatCompletionsModel` | MI or `api_key_env` | Foundry serverless |
| `openai-compatible` | `ChatOpenAI` | `api_key_env` | Third-party OpenAI-compatible chat endpoints such as DeepSeek V4 |

DeepSeek V4 local A/B configs live in `config/coach.deepseek-v4-flash.toml` and `config/coach.deepseek-v4-pro.toml`; run with `STRIDE_COACH_CONFIG_PATH=...` and `DEEPSEEK_API_KEY`. DeepSeek-specific knobs stay in `ModelSpec.extra`: `thinking` is passed via `extra_body`, `response_format` via `model_kwargs`, while graph/business code stays provider-neutral.

**Commentary migrated**：自 PR #16 起 `stride_server.commentary_ai.generate_commentary` 通过 `coach_runtime.get_commentary_llm()` 走 `[commentary]` section。改 coach.toml 的 `[commentary]` section **会**直接影响生产 commentary 路径。`server.toml` 里历史 `[commentary]` 块（pre-PR-#16 残留）在 PR #25 删除。

两者在以下情况 raise `CoachLLMUnavailable`：(a) 配置文件缺失；(b) deployment id 是 placeholder（`<PLACEHOLDER_*>`）；(c) endpoint env var 缺失；(d) auth credentials 缺失。

## Persistence (plan §4)

| Table / container | PartitionKey | RowKey | Purpose |
|-------------------|--------------|--------|---------|
| `stridecoachcheckpoints` | `thread_id` | `checkpoint_id` (zero-padded ns) | Metadata 指向 `coach-checkpoints` blob |
| `stridecoachcheckpointwrites` | `thread_id\|checkpoint_id` | `task_id\|write_idx` | LangGraph pending writes |
| `stridecoachjobs` | `user_id` | `job_id` | Pattern A job lifecycle + heartbeat |
| `strideweeklyversions` | `user_id\|folder` | reverse-time `\|` version_id | S2 PlanDiff apply 审计 |
| `coach-checkpoints` blob | — | `{thread_id}/{checkpoint_id}.json.gz` | 完整 state envelope（gzip + sha256） |
| `stridemasterplan` / `stridemasterplanversions` | (现有，复用) | | C module 审计 |

`AzureTableCheckpointSaver.from_env()` 在 `STRIDE_COACH_TABLE_ACCOUNT_URL` set 时选 Azure backend，否则 fallback 到 `data/_coach_dev/checkpoints/` 下的 JSON-file backend。

## v1 architectural patterns

- **Pattern Y**：AI chat 草稿工具 emit typed `PlanDiff` / `MasterPlanDiff`。Server 在 propose 和 apply 之间是 stateless —— diff 通过 request body 回到 apply endpoint。没有内存中的 pending-diff dict。
- **Pattern A**：Long-running jobs 用 FastAPI `BackgroundTasks` + Azure Table job 行 + heartbeats。App startup 在 lifespan hook 里跑 `JobScheduler.reconcile_stale_jobs()`（`app.py`）；`heartbeat_at` 超过 120s 的 RUNNING 行翻成 `FAILED`，`error_code='interrupted_by_restart'`。ACA 单副本（`--max-replicas 1`）—— 多副本需要 Service Bus。
- **Pattern X**：AI 永远不调任何 execute 工具。所有副作用（push to watch / apply diff / sync 等）走 deterministic UI-chip endpoint。Agent 只做 (a) reads (b) draft proposals。
- **Pattern P**：Conversation graphs 按请求构造（toolkit 在构造时绑定 user_id）；checkpointer + LLMs 是 `stride_server.coach_runtime` 里的 module-level singleton，测试用 `set_*_for_tests` 注入。

## Coach HTTP endpoints (S3 + audit)

| Method + path | Purpose |
|---------------|---------|
| `POST /api/users/me/coach/conversations/qa/messages` | S3 daily Q&A。Server 自己生 `thread_id = f"{user_id}:qa:{today_shanghai().isoformat()}"`。Body 的 `thread_id` 静默忽略（pydantic `extra=ignore`）。 |
| `GET /api/users/me/coach/threads/{thread_id}/messages` | 跨 session chat history。解析 thread_id；owner 段必须 == JWT.sub 否则 403。malformed → 400。 |
| `GET /api/users/me/coach/plan-versions/week/{folder}` | 倒序列出某周的 plan versions，限定 JWT.sub user_id。 |
| `GET /api/users/me/coach/plan-versions/week/{folder}/{version_id}` | Version artifact + parent chain。`folder` 必传 —— 没有全表扫描 fallback。missing 或 cross-user → 404。 |

## Generation pipeline (plan §7)

`build_generation_graph(load_context, generator, reviewer, apply_patches, max_iterations=3)` 产出 StateGraph 路由 `load_context → generator → rule_filter → reviewer → verdict`。Verdict 分支：

- `pass` → finalize
- `auto_fix` → apply_patches → finalize
- `revise` → loop back to generator（上限 `max_iterations`，否则 fallback）
- `block` → fallback（job marked failed）

`coach.graphs.generation.rule_filter.run_rule_filter(plan_dict, ...)` 是 pure-Python 预过滤，跑 7 条安全规则（weekly progression ≤ 1.10×、long run ≤ 35%、Z4-Z5 ≤ 20%、≥ 1 rest day、`WeeklyPlan.from_dict` validity、injury-conflict keyword check、CTL ramp ≤ 6 TSS/wk）。HARD 违规直接回 generator，不调（贵的）reviewer。

## HMAC signature — deliberately not v1

Pattern Y apply 完整性通过 path-match validation（`diff.folder == path_folder`、`accepted_op_ids ⊆ diff.ops.id`）+ post-apply rule_filter rerun + schema validation 保证。HMAC 签名讨论过但推迟 —— 产品语义是"trust + 用户对自己的 plan 有完全权威"，HTTPS 处理 MITM。出现真实滥用 pattern 再加 HMAC。
