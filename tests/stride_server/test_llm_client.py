"""Unit tests for stride_server.llm_client.

Uses monkeypatching to mock the underlying AzureOpenAI client so no real HTTP
calls are made. Follows the same pattern as other stride_server tests.
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_completion(text: str) -> MagicMock:
    """Fake openai ChatCompletion response."""
    choice = MagicMock()
    choice.message.content = text
    resp = MagicMock()
    resp.choices = [choice]
    return resp


def _env_with_endpoint(monkeypatch) -> None:
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://fake-aoai.openai.azure.com/")
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "fake-key")
    monkeypatch.setenv("LLM_ENABLED", "true")


# ---------------------------------------------------------------------------
# LLMClient construction
# ---------------------------------------------------------------------------


def test_llm_client_raises_unavailable_when_endpoint_missing(monkeypatch):
    """LLMClient() must raise LLMUnavailable when AZURE_OPENAI_ENDPOINT is absent."""
    monkeypatch.delenv("AZURE_OPENAI_ENDPOINT", raising=False)
    monkeypatch.delenv("LLM_ENABLED", raising=False)

    from stride_server.llm_client import LLMClient, LLMUnavailable

    with pytest.raises(LLMUnavailable):
        LLMClient()


def test_llm_client_raises_unavailable_when_llm_disabled(monkeypatch):
    """LLMClient() must raise LLMUnavailable when LLM_ENABLED=false."""
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://fake.openai.azure.com/")
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "fake-key")
    monkeypatch.setenv("LLM_ENABLED", "false")

    from stride_server.llm_client import LLMClient, LLMUnavailable

    with pytest.raises(LLMUnavailable):
        LLMClient()


def _make_client_with_fake_inner(fake_inner, monkeypatch) -> "Any":
    """Construct an LLMClient whose underlying AOAI client is replaced with
    ``fake_inner``.  Works without the openai package installed by patching
    ``_build_aoai_client`` at the module level *before* construction."""
    import importlib
    import stride_server.llm_client as mod
    importlib.reload(mod)  # pick up fresh env-var state from monkeypatch

    # Now patch the module-level function so LLMClient.__init__ gets our fake.
    with patch.object(mod, "_build_aoai_client", return_value=fake_inner):
        client = mod.LLMClient()
    # Restore: inject the fake directly so subsequent calls on the live
    # client object work (the patch context has already exited).
    client._client = fake_inner
    return client


def test_llm_client_constructs_with_api_key(monkeypatch):
    """LLMClient() succeeds when endpoint + api key are both set."""
    _env_with_endpoint(monkeypatch)
    fake_aoai = MagicMock()
    client = _make_client_with_fake_inner(fake_aoai, monkeypatch)
    assert client is not None


# ---------------------------------------------------------------------------
# chat_sync
# ---------------------------------------------------------------------------


def test_chat_sync_returns_string(monkeypatch):
    """chat_sync should return the assistant text stripped of whitespace."""
    _env_with_endpoint(monkeypatch)

    fake_inner = MagicMock()
    fake_inner.chat.completions.create.return_value = _make_completion("  Hello world  ")

    client = _make_client_with_fake_inner(fake_inner, monkeypatch)
    result = client.chat_sync(
        system="You are a coach.",
        messages=[{"role": "user", "content": "How's my run?"}],
    )
    assert result == "Hello world"


def test_chat_sync_includes_system_message(monkeypatch):
    """chat_sync must prepend a system message to the messages list."""
    _env_with_endpoint(monkeypatch)

    captured: list = []

    def _create(**kwargs):
        captured.append(kwargs["messages"])
        return _make_completion("ok")

    fake_inner = MagicMock()
    fake_inner.chat.completions.create.side_effect = _create

    client = _make_client_with_fake_inner(fake_inner, monkeypatch)
    client.chat_sync(
        system="Be concise.",
        messages=[{"role": "user", "content": "Hi"}],
    )

    assert captured[0][0]["role"] == "system"
    assert captured[0][0]["content"] == "Be concise."
    assert captured[0][1]["role"] == "user"


# ---------------------------------------------------------------------------
# Error mapping — rate limit → retryable
# ---------------------------------------------------------------------------


def test_chat_sync_rate_limit_raises_llm_error_retryable(monkeypatch):
    """RateLimitError from the SDK should map to LLMError(retryable=True)."""
    _env_with_endpoint(monkeypatch)

    class FakeRateLimitError(Exception):
        pass
    FakeRateLimitError.__name__ = "RateLimitError"
    FakeRateLimitError.__module__ = "openai"

    fake_inner = MagicMock()
    fake_inner.chat.completions.create.side_effect = FakeRateLimitError("rate limited")

    client = _make_client_with_fake_inner(fake_inner, monkeypatch)

    import stride_server.llm_client as mod
    with pytest.raises(mod.LLMError) as exc_info:
        client.chat_sync(system="s", messages=[{"role": "user", "content": "hi"}])
    assert exc_info.value.retryable is True


def test_chat_sync_connection_error_raises_llm_error_retryable(monkeypatch):
    """APIConnectionError → LLMError(retryable=True)."""
    _env_with_endpoint(monkeypatch)

    class FakeConnectionError(Exception):
        pass
    FakeConnectionError.__name__ = "APIConnectionError"
    FakeConnectionError.__module__ = "openai"

    fake_inner = MagicMock()
    fake_inner.chat.completions.create.side_effect = FakeConnectionError("timeout")

    client = _make_client_with_fake_inner(fake_inner, monkeypatch)

    import stride_server.llm_client as mod
    with pytest.raises(mod.LLMError) as exc_info:
        client.chat_sync(system="s", messages=[{"role": "user", "content": "hi"}])
    assert exc_info.value.retryable is True


def test_chat_sync_auth_error_raises_llm_error_not_retryable(monkeypatch):
    """AuthenticationError → LLMError(retryable=False)."""
    _env_with_endpoint(monkeypatch)

    class FakeAuthError(Exception):
        pass
    FakeAuthError.__name__ = "AuthenticationError"
    FakeAuthError.__module__ = "openai"

    fake_inner = MagicMock()
    fake_inner.chat.completions.create.side_effect = FakeAuthError("invalid key")

    client = _make_client_with_fake_inner(fake_inner, monkeypatch)

    import stride_server.llm_client as mod
    with pytest.raises(mod.LLMError) as exc_info:
        client.chat_sync(system="s", messages=[{"role": "user", "content": "hi"}])
    assert exc_info.value.retryable is False


# ---------------------------------------------------------------------------
# chat_async_job
# ---------------------------------------------------------------------------


def test_chat_async_job_calls_callback_with_result(monkeypatch):
    """chat_async_job should call callback(result, None) on success."""
    import threading

    _env_with_endpoint(monkeypatch)

    fake_inner = MagicMock()
    fake_inner.chat.completions.create.return_value = _make_completion("async result")

    client = _make_client_with_fake_inner(fake_inner, monkeypatch)

    results: list = []
    done = threading.Event()

    def cb(text, exc):
        results.append((text, exc))
        done.set()

    client.chat_async_job(
        job_id="test-job-1",
        system="Coach",
        messages=[{"role": "user", "content": "review"}],
        callback=cb,
    )
    done.wait(timeout=5)

    assert len(results) == 1
    assert results[0] == ("async result", None)


def test_chat_async_job_calls_callback_with_exception_on_failure(monkeypatch):
    """chat_async_job should call callback(None, exc) on SDK error."""
    import threading

    _env_with_endpoint(monkeypatch)

    class FakeRateLimitError(Exception):
        pass
    FakeRateLimitError.__name__ = "RateLimitError"
    FakeRateLimitError.__module__ = "openai"

    fake_inner = MagicMock()
    fake_inner.chat.completions.create.side_effect = FakeRateLimitError("rate limited")

    client = _make_client_with_fake_inner(fake_inner, monkeypatch)

    results: list = []
    done = threading.Event()

    def cb(text, exc):
        results.append((text, exc))
        done.set()

    client.chat_async_job(
        job_id="test-job-2",
        system="Coach",
        messages=[{"role": "user", "content": "review"}],
        callback=cb,
    )
    done.wait(timeout=5)

    assert len(results) == 1
    text, exc = results[0]
    assert text is None
    import stride_server.llm_client as mod
    assert isinstance(exc, mod.LLMError)
    assert exc.retryable is True
