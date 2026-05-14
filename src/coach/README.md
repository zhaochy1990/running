# `coach` — Pure LangGraph Core

The STRIDE coach agent's pure runtime. Has zero coupling to STRIDE
infrastructure — no Azure SDKs, no FastAPI, no SQLite, no COROS API. All
integration concerns live in `stride_server.coach_adapters`.

## Why split?

The split is enforced by `.importlinter` (see repo root). It lets us:

1. unit-test graph behaviour with `FakeToolkit` + `FakeChatModelWithTools`
   without spinning up an HTTP layer, a real DB, or hitting any cloud SDK.
2. swap deployment targets (Azure Container Apps today, a different
   provider tomorrow) without touching the LangGraph wiring.
3. keep the LLM prompt + tool surface area auditable in one place.

The reverse direction (`stride_server.coach_adapters → coach`) is
intentionally allowed and is how adapters bridge the two layers.

## Layout

```
coach/
├── schemas/                      Pydantic + TypedDict models
│   ├── conversation.py           ConversationState + Message
│   ├── job.py                    CoachJob + JobType/JobStage/JobStatus
│   ├── review.py                 ReviewReport + ReviewIssue + Verdict
│   └── tool_result.py            ToolResult envelope
├── tools/
│   ├── protocols.py              24 callable Protocols (11 read + 13 draft)
│   └── registry.py               ToolSpec + ToolRegistry
├── runtime/
│   ├── llm_factory.py            AOAI + Anthropic factories (CoachLLMUnavailable)
│   └── toolkit.py                Toolkit Protocol — adapter contract
├── graphs/
│   ├── conversation/             S1 / S2 / S3 chat StateGraph
│   │   ├── graph.py              build_conversation_graph(toolkit, llm, ...)
│   │   ├── scope.py              Scope enum, thread_id_for, parse_short_thread_id
│   │   ├── tool_bridge.py        Toolkit callable → langchain StructuredTool
│   │   └── prompts/{shared,qa,week_chat,master_chat}.py
│   └── generation/               Generation pipeline subgraph
│       ├── graph.py              build_generation_graph(loader, generator, reviewer)
│       ├── state.py              GenState TypedDict
│       └── rule_filter.py        7 pure-Python safety rules (plan §7.3)
└── cli/                          (placeholder — local test CLI)
```

## Entry points

| Function | Purpose |
|----------|---------|
| `coach.graphs.conversation.graph.build_conversation_graph` | Compile the S1/S2/S3 chat StateGraph |
| `coach.graphs.generation.graph.build_generation_graph` | Compile the gen→rule_filter→reviewer→verdict pipeline |
| `coach.graphs.generation.rule_filter.run_rule_filter` | Pure-Python plan safety check |
| `coach.runtime.config.load_config` | Read `config/coach.toml` → `CoachConfig` (3 role-specs + auth mode) |
| `coach.runtime.llm_factory.build_chat_model` | Provider-dispatched constructor (raises CoachLLMUnavailable) |
| `coach.runtime.llm_factory.build_generator_llm` / `build_reviewer_llm` / `build_commentary_llm` | Role wrappers reading the relevant `ModelSpec` from config |

## Forbidden imports (enforced by import-linter)

`coach.*` MUST NOT import:
- `stride_server.*`, `coros_sync.*`, `garmin_sync.*` — infra/sync adapters
- `stride_core.db` — SQLite layer (data primitives are fine; the DB is not)
- `fastapi`, `azure` — HTTP / cloud SDKs

Adapters live in `stride_server.coach_adapters.*` and bridge `coach.*` to
the FastAPI app, Azure Table/Blob persistence, and the per-user SQLite DB.

## Patterns at a glance

- **Pattern Y**: chat draft tools emit a `PlanDiff` / `MasterPlanDiff`; the
  server stays stateless between propose and apply (the diff travels back
  in the apply request body).
- **Pattern A**: long-running jobs use `BackgroundTasks` + Azure-Table
  job rows + heartbeats; a startup lifespan reconcile (`app.py`) sweeps
  stale RUNNING jobs to FAILED.
- **Pattern X**: AI never calls any execute tool. Side effects (push to
  watch, apply diff, sync) only happen via deterministic UI-chip endpoints.
- **Pattern P**: graphs are constructed per request (toolkit is per-user);
  the checkpointer + LLMs are module-level singletons in
  `stride_server.coach_runtime`.
