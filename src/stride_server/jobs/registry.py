"""Handler registry for the async-job worker.

Maps a ``job_type`` string to a handler callable. The worker looks up the
handler for each dequeued job. Business logic lives in handlers; the infra only
dispatches. Handlers are registered at import time via ``@job_handler``.

A handler signature is ``handler(job, *, heartbeat) -> dict | None`` where
``job`` is the ``JobRecord`` and ``heartbeat`` is a callable
``heartbeat(*, stage=None, progress_pct=None)`` the handler should call
periodically so the worker's liveness tracking stays fresh. A returned dict is
persisted as ``result_json``.
"""

from __future__ import annotations

from typing import Any, Callable, Protocol

from stride_storage.interfaces.jobs import JobRecord


class Heartbeat(Protocol):
    def __call__(
        self, *, stage: str | None = None, progress_pct: int | None = None
    ) -> None: ...


JobHandler = Callable[..., "dict[str, Any] | None"]

_REGISTRY: dict[str, JobHandler] = {}


def job_handler(job_type: str) -> Callable[[JobHandler], JobHandler]:
    """Decorator: register ``fn`` as the handler for ``job_type``."""

    def _register(fn: JobHandler) -> JobHandler:
        if job_type in _REGISTRY:
            raise ValueError(f"handler already registered for job_type={job_type!r}")
        _REGISTRY[job_type] = fn
        return fn

    return _register


def register(job_type: str, fn: JobHandler) -> None:
    """Imperative registration (for handlers wired outside a decorator)."""
    if job_type in _REGISTRY:
        raise ValueError(f"handler already registered for job_type={job_type!r}")
    _REGISTRY[job_type] = fn


def ensure_registered(job_type: str, fn: JobHandler) -> None:
    """Idempotent registration — no-op if ``job_type`` is already registered.

    Import-time ``@job_handler`` only fires once per process, but tests wipe the
    registry via ``clear_registry_for_tests`` between cases while the handler
    modules stay import-cached (so a re-import won't re-run the decorator). App
    startup calls this to repopulate the registry regardless of import state.
    """
    _REGISTRY.setdefault(job_type, fn)


def get_handler(job_type: str) -> JobHandler | None:
    return _REGISTRY.get(job_type)


def registered_types() -> list[str]:
    return sorted(_REGISTRY)


def clear_registry_for_tests() -> None:
    _REGISTRY.clear()
