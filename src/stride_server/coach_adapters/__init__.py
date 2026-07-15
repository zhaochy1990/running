"""Coach adapters — bridges the pure `coach` core to STRIDE infrastructure.

This is the integration layer:
- `tool_impls/`: concrete read + draft tool implementations
- `persistence/`: AzureTableCheckpointSaver, JobsStore, WeeklyVersionStore
- `toolkit.py`: assembles a Toolkit instance with all 29 tools
- `job_scheduler.py`: BackgroundTasks-driven job runner (Pattern A)
- `notifier.py`: JPush completion / failure callbacks

`coach_adapters` may freely import `coach.*` (reverse direction OK).
"""
