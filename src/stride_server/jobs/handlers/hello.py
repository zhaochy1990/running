"""Hello-world job handler — a trivial handler used to smoke-test the async-job
infra end to end (enqueue → worker consume → DONE) in a real deployment.

Registered via ``@job_handler`` so importing ``stride_server.jobs.handlers``
(the worker's startup import) picks it up.
"""

from __future__ import annotations

import json
from typing import Any

from stride_storage.interfaces.jobs import JobRecord

from stride_server.jobs.registry import job_handler

HELLO_JOB_TYPE = "hello_world"


@job_handler(HELLO_JOB_TYPE)
def handle_hello(job: JobRecord, *, heartbeat: Any) -> dict[str, Any]:
    """Echo the job's input back as the result. No side effects.

    Emits one heartbeat with a stage so the smoke test can observe progress
    tracking, then returns a small result dict persisted as ``result_json``.
    """
    heartbeat(stage="greeting", progress_pct=50)
    payload: dict[str, Any] = {}
    if job.input_json:
        try:
            payload = json.loads(job.input_json)
        except json.JSONDecodeError:
            payload = {"raw": job.input_json}
    return {"message": "hello", "echo": payload}
