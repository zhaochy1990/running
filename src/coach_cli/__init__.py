"""coach_cli — a local, Claude-Code-style REPL for the coach orchestrator brain.

Drives the S0+S1 spine (Resolver → Supervisor → dispatcher → status_insight →
Aggregator) against real LLMs + the user's local ``data/{user_id}/coros.db``,
so the orchestrator can be exercised end-to-end before any frontend exists.

This package lives OUTSIDE ``coach.*`` core on purpose — it imports the adapter
layer (``stride_server.coach_adapters``), which core may not depend on.

    python -m coach_cli -P zhaochaoyi
"""
