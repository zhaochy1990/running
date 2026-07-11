"""Generic async-job infra — state store + queue + client facade.

Layering: this package (Tier B/C) depends on ``interfaces.jobs`` (Tier A) and
the shared azure factories. It has NO coach coupling and is not imported by
``coach.*`` or the pure ``stride_core`` formula modules.
"""

from __future__ import annotations

from stride_storage.jobs.client import JobClient, enqueue_job
from stride_storage.jobs.pipeline_store import (
    AzureTablePipelineRunStore,
    FilePipelineRunStore,
    pipeline_run_store_from_config,
)
from stride_storage.jobs.queue import (
    InMemoryJobQueue,
    queue_from_config,
    reset_dev_queues,
)
from stride_storage.jobs.store import (
    AzureTableJobStore,
    FileJobStore,
    job_store_from_config,
)

__all__ = [
    "AzureTableJobStore",
    "AzureTablePipelineRunStore",
    "FileJobStore",
    "FilePipelineRunStore",
    "InMemoryJobQueue",
    "JobClient",
    "enqueue_job",
    "job_store_from_config",
    "pipeline_run_store_from_config",
    "queue_from_config",
    "reset_dev_queues",
]
