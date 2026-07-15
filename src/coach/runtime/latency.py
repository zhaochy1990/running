"""Privacy-safe LLM latency metadata for Coach debug traces.

Only timings, counts, model ids, token usage, and tool names are logged. Prompt
or response content is never recorded.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler

from .model_spec import ModelSpec

logger = logging.getLogger(__name__)


class CoachLatencyCallback(BaseCallbackHandler):
    """Emit one compact metadata-only line per LLM call."""

    def __init__(self, spec: ModelSpec) -> None:
        self._role = spec.role
        self._model = spec.model
        self._starts: dict[UUID, tuple[float, int, int]] = {}
        self._lock = threading.Lock()

    def on_chat_model_start(
        self,
        serialized: dict[str, Any],
        messages: list[list[Any]],
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        batch = messages[0] if messages else []
        message_count = len(batch)
        input_chars = sum(len(str(getattr(message, "content", ""))) for message in batch)
        with self._lock:
            self._starts[run_id] = (time.perf_counter(), message_count, input_chars)

    def on_llm_end(self, response: Any, *, run_id: UUID, **kwargs: Any) -> None:
        started, message_count, input_chars = self._pop(run_id)
        message = None
        generations = getattr(response, "generations", None) or []
        if generations and generations[0]:
            message = getattr(generations[0][0], "message", None)
        usage = getattr(message, "usage_metadata", None) or {}
        tool_calls = getattr(message, "tool_calls", None) or []
        logger.debug(
            "llm call | role=%s model=%s elapsed=%.0fms messages=%d "
            "input_chars=%d input_tokens=%s output_tokens=%s tool_calls=%s",
            self._role,
            self._model,
            (time.perf_counter() - started) * 1000.0,
            message_count,
            input_chars,
            usage.get("input_tokens"),
            usage.get("output_tokens"),
            [call.get("name") for call in tool_calls],
        )

    def on_llm_error(
        self, error: BaseException, *, run_id: UUID, **kwargs: Any
    ) -> None:
        started, message_count, input_chars = self._pop(run_id)
        logger.debug(
            "llm error | role=%s model=%s elapsed=%.0fms messages=%d "
            "input_chars=%d error_type=%s",
            self._role,
            self._model,
            (time.perf_counter() - started) * 1000.0,
            message_count,
            input_chars,
            type(error).__name__,
        )

    def _pop(self, run_id: UUID) -> tuple[float, int, int]:
        with self._lock:
            return self._starts.pop(run_id, (time.perf_counter(), 0, 0))


def latency_callbacks(spec: ModelSpec) -> list[BaseCallbackHandler]:
    return [CoachLatencyCallback(spec)]
