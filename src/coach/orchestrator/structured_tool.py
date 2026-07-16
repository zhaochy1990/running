"""Portable small-schema output over ordinary model tool calling.

Some OpenAI-compatible providers reject ``response_format`` while still
supporting tools, and some thinking modes reject a forced ``tool_choice``.
Bind one Pydantic schema as an ordinary tool, instruct the model to call it,
then validate the returned arguments locally.
"""

from __future__ import annotations

from typing import Any, TypeVar

from langchain_core.exceptions import OutputParserException
from langchain_core.messages import HumanMessage, SystemMessage
from pydantic import BaseModel

SchemaT = TypeVar("SchemaT", bound=BaseModel)


class StructuredToolRunner:
    """Invoke one schema tool and validate exactly one matching call."""

    def __init__(self, model: object, schema: type[SchemaT]) -> None:
        self._schema = schema
        self._tool_name = schema.__name__
        self._bound = model.bind_tools(  # type: ignore[attr-defined]
            [schema], parallel_tool_calls=False
        )

    def invoke(self, system_prompt: str, user_prompt: str) -> SchemaT:
        instruction = (
            f"\n\n你必须且只能调用一次 `{self._tool_name}` 工具返回结构化结果；"
            "不要输出普通文本，也不要调用其它工具。"
        )
        message = self._bound.invoke(
            [
                SystemMessage(content=system_prompt + instruction),
                HumanMessage(content=user_prompt),
            ]
        )
        calls = [
            call
            for call in (getattr(message, "tool_calls", None) or [])
            if call.get("name") == self._tool_name
        ]
        if len(calls) != 1:
            raise OutputParserException(
                f"expected one {self._tool_name} tool call, got {len(calls)}"
            )
        args: Any = calls[0].get("args")
        return self._schema.model_validate(args)

