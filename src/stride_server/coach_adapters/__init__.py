"""Coach adapters — bridges the pure `coach` core to STRIDE infrastructure.

DEPRECATED: this whole package is part of the legacy **Python** Coach Agent
(`src/coach/` + `src/stride_server/coach_*`), which is no longer used. The
current Coach Agent is TypeScript (`src/coach_agent/` + `src/coach_agent_api/`
+ `src/coach_agent_worker/`). Kept for historical reference only — do not add
features or new callers.

This is the integration layer:
- `tool_impls/`: concrete read + draft tool implementations
- `persistence/`: AzureTableCheckpointSaver, JobsStore, WeeklyVersionStore
- `toolkit.py`: assembles a Toolkit instance with all 32 tools
- `job_scheduler.py`: BackgroundTasks-driven job runner (Pattern A)
- `notifier.py`: JPush completion / failure callbacks

`coach_adapters` may freely import `coach.*` (reverse direction OK).
"""
