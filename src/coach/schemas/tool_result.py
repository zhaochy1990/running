"""Result envelope returned by every coach tool.

Tool impls MUST NOT raise: they return ``ToolResult(ok=False, errors=[...])``
on any failure path so the graph can stay deterministic. See plan §5.4.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class ToolResult(BaseModel):
    ok: bool
    data: dict | None = None
    errors: list[str] = Field(default_factory=list)
