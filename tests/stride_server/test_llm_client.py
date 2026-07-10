"""Unit tests for ``stride_server.llm_client.LLMClient.chat_sync``.

The public API keeps the historical ``max_tokens`` argument, but recent
``langchain-openai`` normalizes constructor token caps to the internal
``max_completion_tokens`` default for both Chat Completions and Responses.
Per-call overrides must bind that same key so they replace the default instead
of adding a second, conflicting request-body parameter. ``reasoning_effort``
must reach the SDK only when the caller explicitly opts in.
"""

from __future__ import annotations

from typing import Any

from stride_server import llm_client as llm_client_mod


class _FakeResponse:
    def __init__(self, content: str) -> None:
        self.content = content


class _FakeLangChainModel:
    """Stand-in for the langchain ``AzureChatOpenAI`` instance held by
    :class:`LLMClient`. Records the kwargs ``bind()`` was called with so
    tests can assert the right names propagated."""

    def __init__(self, *, use_responses_api: bool) -> None:
        self.use_responses_api = use_responses_api
        self.bind_calls: list[dict[str, Any]] = []
        self.invoke_messages: list[Any] = []

    def bind(self, **kwargs: Any) -> "_FakeLangChainModel":
        self.bind_calls.append(dict(kwargs))
        return self

    def invoke(self, messages: list[Any]) -> _FakeResponse:
        self.invoke_messages = list(messages)
        return _FakeResponse("ok")


def _make_client(fake: _FakeLangChainModel) -> llm_client_mod.LLMClient:
    """Construct an LLMClient with the langchain model pre-injected,
    bypassing :func:`get_generator_llm` and the Azure-identity dance
    that would otherwise run at ``LLMClient.__init__``."""
    client = llm_client_mod.LLMClient.__new__(llm_client_mod.LLMClient)
    client._llm = fake  # type: ignore[attr-defined]
    return client


# ---------------------------------------------------------------------------
# max_tokens binding — overrides the langchain-openai normalized default
# ---------------------------------------------------------------------------


def test_chat_sync_responses_api_binds_max_completion_tokens():
    """Responses API overrides must use langchain-openai's normalized
    ``max_completion_tokens`` key; ``max_output_tokens`` would not replace the
    constructor default in current SDK versions."""
    fake = _FakeLangChainModel(use_responses_api=True)
    client = _make_client(fake)
    client.chat_sync("sys", [{"role": "user", "content": "hi"}], max_tokens=32768)
    assert len(fake.bind_calls) == 1
    kwargs = fake.bind_calls[0]
    assert kwargs == {"max_completion_tokens": 32768}
    assert "max_tokens" not in kwargs
    assert "max_output_tokens" not in kwargs


def test_chat_sync_chat_completions_binds_max_completion_tokens():
    """Chat Completions overrides also use ``max_completion_tokens`` so they
    replace the constructor default instead of adding an incompatible
    ``max_tokens`` request parameter."""
    fake = _FakeLangChainModel(use_responses_api=False)
    client = _make_client(fake)
    client.chat_sync("sys", [{"role": "user", "content": "hi"}], max_tokens=4096)
    assert len(fake.bind_calls) == 1
    kwargs = fake.bind_calls[0]
    assert kwargs == {"max_completion_tokens": 4096}
    assert "max_tokens" not in kwargs
    assert "max_output_tokens" not in kwargs


def test_chat_sync_no_max_tokens_skips_bind():
    """When the caller passes ``max_tokens=None`` (the default) and no
    other override, bind() must NOT be called — the model's
    construction-time defaults from ``[generator]`` config apply."""
    fake = _FakeLangChainModel(use_responses_api=True)
    client = _make_client(fake)
    client.chat_sync("sys", [{"role": "user", "content": "hi"}])
    assert fake.bind_calls == []


# ---------------------------------------------------------------------------
# reasoning_effort binding
# ---------------------------------------------------------------------------


def test_chat_sync_reasoning_effort_propagates_when_set():
    """``reasoning_effort=low`` must bind as ``reasoning_effort="low"``
    regardless of api_kind — the kwarg name is the same for both."""
    fake = _FakeLangChainModel(use_responses_api=True)
    client = _make_client(fake)
    client.chat_sync(
        "sys", [{"role": "user", "content": "hi"}], reasoning_effort="low",
    )
    assert fake.bind_calls == [{"reasoning_effort": "low"}]


def test_chat_sync_reasoning_effort_none_omitted():
    """``reasoning_effort=None`` (default) must NOT appear in the bind
    kwargs — passing ``None`` through could trigger a 400 depending on
    SDK version. Explicit omission is the safe path."""
    fake = _FakeLangChainModel(use_responses_api=True)
    client = _make_client(fake)
    client.chat_sync(
        "sys", [{"role": "user", "content": "hi"}],
        max_tokens=1024, reasoning_effort=None,
    )
    assert len(fake.bind_calls) == 1
    assert "reasoning_effort" not in fake.bind_calls[0]


def test_chat_sync_max_tokens_and_reasoning_effort_combined():
    """Both kwargs can be set together. Token cap overrides use
    ``max_completion_tokens``; reasoning keeps its direct kwarg."""
    fake = _FakeLangChainModel(use_responses_api=True)
    client = _make_client(fake)
    client.chat_sync(
        "sys", [{"role": "user", "content": "hi"}],
        max_tokens=65536, reasoning_effort="high",
    )
    assert fake.bind_calls == [
        {"max_completion_tokens": 65536, "reasoning_effort": "high"},
    ]


# ---------------------------------------------------------------------------
# Sanity — message roles map correctly
# ---------------------------------------------------------------------------


def test_chat_sync_returns_response_content_stripped():
    """End-to-end smoke: ``invoke`` returns a response whose content
    becomes the chat_sync return value, stripped of surrounding
    whitespace."""
    fake = _FakeLangChainModel(use_responses_api=False)
    client = _make_client(fake)
    # Override invoke to return whitespace-padded content
    fake.invoke = lambda messages: _FakeResponse("  hello world  ")  # type: ignore[assignment]
    result = client.chat_sync("sys", [{"role": "user", "content": "hi"}])
    assert result == "hello world"


def test_chat_sync_invoke_called_with_system_and_user_messages():
    """System prompt + user message must reach the bound model's
    ``invoke`` as proper langchain ``BaseMessage`` instances."""
    fake = _FakeLangChainModel(use_responses_api=False)
    client = _make_client(fake)
    client.chat_sync("the system", [{"role": "user", "content": "hello"}])
    msgs = fake.invoke_messages
    assert len(msgs) == 2
    assert msgs[0].content == "the system"
    assert msgs[1].content == "hello"
