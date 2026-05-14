"""Test-only fake chat model that supports ``bind_tools`` + canned responses.

Why this exists: ``langchain_core.language_models.fake_chat_models.FakeMessagesListChatModel``
does NOT implement ``bind_tools`` (raises ``NotImplementedError``), but our
conversation graph always calls ``llm.bind_tools(...)`` to register tools.
Subclassing here keeps the production graph clean: it can stay strict about
calling bind_tools, while tests get a model that satisfies the interface.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.runnables import Runnable


class FakeChatModelWithTools(FakeMessagesListChatModel):
    """``FakeMessagesListChatModel`` with a no-op ``bind_tools`` that records
    what was bound. Returns ``self`` so the runnable chain works."""

    bound_tools: list[Any] = []

    def bind_tools(  # type: ignore[override]
        self,
        tools: Sequence[Any],
        **_kwargs: Any,
    ) -> Runnable:
        # Pydantic-style assignment because FakeMessagesListChatModel is a Pydantic model
        object.__setattr__(self, "bound_tools", list(tools))
        return self
