"""LLM-driven markdown → ``WeeklyPlan`` reverse parser.

Pure transform: takes an already-authored ``plan.md``, asks the configured
chat model to emit the equivalent structured JSON, then validates it through
``parse_structured``. Carries no coach persona — see ``PARSE_SYSTEM_PROMPT``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from stride_core.plan_spec import WeeklyPlan

from .model_identity import configured_generator_id
from .parser import parse_structured
from .prompts import PARSE_PROMPT, PARSE_SYSTEM_PROMPT, STRUCTURED_SCHEMA_HINT


@dataclass(frozen=True)
class PlanParseResult:
    """Result of an LLM-driven reverse parse.

    ``structured`` is ``None`` when no JSON code block was emitted or schema
    validation failed; ``parse_error`` then carries a human-readable reason.
    """

    structured: WeeklyPlan | None
    parse_error: str | None
    model: str


def _message_content(response: Any) -> str:
    content = getattr(response, "content", response)
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                parts.append(str(item.get("text") or item.get("content") or ""))
            else:
                parts.append(str(item))
        return "\n".join(p for p in parts if p).strip()
    return str(content or "").strip()


def _default_chat_model() -> Any:
    from stride_server.coach_runtime import get_generator_llm

    return get_generator_llm()


def _model_id_for(chat_model: Any) -> str:
    for attr in ("model_name", "model", "deployment_name", "azure_deployment", "deployment"):
        value = getattr(chat_model, attr, None)
        if isinstance(value, str) and value:
            return value
    return configured_generator_id()


def parse_plan_md(
    *,
    folder: str,
    md_text: str,
    chat_model: Any | None = None,
) -> PlanParseResult:
    """Reverse-parse ``md_text`` (an authored plan.md) into a ``WeeklyPlan``.

    Args:
        folder: Week folder name (e.g. ``"2026-04-20_04-26(W0)"``). Used for
            schema validation (session dates must fall within the week's range)
            and passed to the model as context.
        md_text: The full markdown content to parse.
        chat_model: Optional pre-built chat model instance. When ``None`` the
            configured coach generator model is used.

    Returns:
        ``PlanParseResult`` with the validated ``WeeklyPlan`` or a parse error.
    """
    if not folder:
        raise ValueError("parse_plan_md requires a non-empty folder")
    if md_text is None:
        raise ValueError("parse_plan_md requires md_text")

    if chat_model is None:
        # Lazy import — keeps non-LLM callers (e.g. parse_structured-only tests)
        # off the azure-identity / langchain import path.
        chat_model = _default_chat_model()
    model_id = _model_id_for(chat_model)

    messages = [
        ("system", PARSE_SYSTEM_PROMPT),
        (
            "user",
            "\n\n".join(
                [
                    f"# 周文件夹\n{folder}",
                    f"# 指令\n{PARSE_PROMPT}",
                    f"# 结构化要求\n{STRUCTURED_SCHEMA_HINT}",
                    f"# 待解析的 markdown\n{md_text}",
                ]
            ),
        ),
    ]
    response = chat_model.invoke(messages)
    raw = _message_content(response)
    plan, parse_error = parse_structured(raw, folder=folder)
    return PlanParseResult(structured=plan, parse_error=parse_error, model=model_id)
