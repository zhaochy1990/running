"""Coach — pure LangGraph core for the STRIDE training agent.

DEPRECATED: this is the legacy **Python** Coach Agent and is no longer used.
The current Coach Agent is TypeScript: ``src/coach_agent`` (core) plus
``src/coach_agent_api`` / ``src/coach_agent_worker``. Do not add features or
new imports here; see ``src/coach_agent/AGENTS.md``.

This package contains the agent runtime (graphs, schemas, tool protocols,
LLM factory) with NO integration code. All Azure / FastAPI / DB / COROS
integration lives in `stride_server.coach_adapters`.

The dependency direction is enforced by `.importlinter`:
    coach.*  →  stride_core.{plan_spec, workout_spec, plan_diff, master_plan, master_plan_diff}
    coach.*  →  langchain, langgraph, pydantic
    coach.*  ✗  stride_server.*, coros_sync.*, garmin_sync.*, azure.*, fastapi.*, stride_core.db
"""
