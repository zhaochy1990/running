"""Tool registry — maps tool name → spec for graph node dispatch.

LangGraph's ``bind_tools`` needs JSON-schema descriptions of every tool so the
LLM can produce structured tool calls. ``ToolSpec`` packages that schema plus
the callable itself. The registry is a thin wrapper around a dict so impls can
be looked up by name during ``tool_router`` execution.

We deliberately avoid pulling in ``langchain_core.tools`` here — keeping the
registry framework-agnostic lets us drive the same tools from CLI tests or
alternative orchestrators without rewriting the spec data.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from coach.schemas import ToolResult


@dataclass(frozen=True)
class ToolSpec:
    """Self-describing tool record.

    Attributes:
        name: Stable identifier the LLM emits in ``tool_calls``.
        description: One-line natural-language summary shown to the LLM.
        parameters_schema: JSON-schema fragment for the tool arguments.
        scope: Which conversation scope(s) may bind this tool — one of
            ``"read"`` / ``"week_draft"`` / ``"master_draft"``.
        callable_ref: The actual function/object implementing the tool.
        returns_schema_name: Optional name of the typed return shape (e.g.
            ``"PlanDiff"`` for week-draft tools) used by the apply node.
    """

    name: str
    description: str
    parameters_schema: dict
    scope: str
    callable_ref: Callable[..., ToolResult]
    returns_schema_name: str | None = None
    metadata: dict = field(default_factory=dict)


class ToolNotFoundError(KeyError):
    """Raised when ``ToolRegistry.get`` is asked for an unregistered name."""


class ToolRegistry:
    """In-memory tool dispatch table.

    Not thread-safe for concurrent registration; one-shot registration during
    application startup is the intended use.
    """

    def __init__(self) -> None:
        self._specs: dict[str, ToolSpec] = {}

    def register(self, spec: ToolSpec) -> None:
        if spec.name in self._specs:
            raise ValueError(f"tool {spec.name!r} already registered")
        self._specs[spec.name] = spec

    def get(self, name: str) -> ToolSpec:
        try:
            return self._specs[name]
        except KeyError as exc:
            raise ToolNotFoundError(f"no tool registered as {name!r}") from exc

    def names(self) -> list[str]:
        return list(self._specs.keys())

    def list_by_scope(self, scope: str) -> list[ToolSpec]:
        return [s for s in self._specs.values() if s.scope == scope]

    def invoke(self, name: str, /, **kwargs: Any) -> ToolResult:
        """Convenience wrapper: look up + call + return result."""
        return self.get(name).callable_ref(**kwargs)
