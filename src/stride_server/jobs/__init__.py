"""Async-job infra — server-side facade + worker package.

Resolves ``QueueStorageConfig`` from ``ServerConfig`` and exposes cached
``JobClient`` / ``JobWorker`` builders. Route handlers import ``enqueue`` here;
the worker process imports ``build_worker``.
"""

from __future__ import annotations

import logging
from functools import lru_cache
from typing import Any

from stride_storage.interfaces.config import ConfigError, QueueStorageConfig
from stride_storage.interfaces.jobs import GLOBAL_PARTITION
from stride_storage.jobs import JobClient, job_store_from_config, queue_from_config

from stride_server.config import clear_server_config_cache, load_server_config
from stride_server.config.loader import resolve_config_env
from stride_server.config.models import ServerConfig
from stride_server.config.sources import env_source

from .registry import get_handler, job_handler, register, registered_types
from .worker import JobWorker

logger = logging.getLogger(__name__)


def _is_auth_config_error(exc: ConfigError) -> bool:
    return "auth.public_key" in str(exc)


def _jobs_config_from_env() -> QueueStorageConfig:
    config = ServerConfig.default(env=resolve_config_env()).storage.jobs
    storage = env_source().get("storage", {})
    jobs = storage.get("jobs", {}) if isinstance(storage, dict) else {}
    if isinstance(jobs, dict):
        return config.with_updates(**jobs)
    return config


def jobs_config() -> QueueStorageConfig:
    try:
        return load_server_config().storage.jobs
    except ConfigError as exc:
        if not _is_auth_config_error(exc):
            raise
        return _jobs_config_from_env()


@lru_cache(maxsize=1)
def get_job_client() -> JobClient:
    """Cached ``JobClient`` (state store + main queue) for enqueue + status."""
    config = jobs_config()
    return JobClient(job_store_from_config(config), queue_from_config(config))


def enqueue(
    *,
    job_type: str,
    partition_key: str = GLOBAL_PARTITION,
    input_payload: dict[str, Any] | None = None,
    delay_s: int = 0,
) -> str:
    """Enqueue a job and return its job_id. The single event/chain entrypoint.

    ``partition_key`` is the owning scope — a user_id for user-scoped jobs, or
    ``GLOBAL_PARTITION`` (default) for global ones.
    """
    return get_job_client().enqueue(
        job_type=job_type,
        partition_key=partition_key,
        input_payload=input_payload,
        delay_s=delay_s,
    )


def build_worker() -> JobWorker:
    """Construct the worker from resolved config (used by the worker process)."""
    config = jobs_config()
    return JobWorker(
        store=job_store_from_config(config),
        queue=queue_from_config(config),
        poison_queue=queue_from_config(config, poison=True),
        config=config,
    )


def reset_jobs_cache_for_tests() -> None:
    get_job_client.cache_clear()
    clear_server_config_cache()


__all__ = [
    "GLOBAL_PARTITION",
    "JobWorker",
    "build_worker",
    "enqueue",
    "get_job_client",
    "get_handler",
    "job_handler",
    "jobs_config",
    "register",
    "registered_types",
    "reset_jobs_cache_for_tests",
]
