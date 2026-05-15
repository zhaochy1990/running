"""LLM factory tests — provider dispatch + typed errors."""

from __future__ import annotations

from pathlib import Path

import pytest

from coach.runtime.config import CoachConfig
from coach.runtime.llm_factory import (
    AzureCredentials,
    CoachLLMUnavailable,
    build_chat_model,
    build_commentary_llm,
    build_generator_llm,
    build_reviewer_llm,
)
from coach.runtime.model_spec import ModelSpec


class _FakeTokenCredential:
    """Duck-typed TokenCredential for tests — never imports azure.core."""

    def get_token(self, *scopes, **kwargs):
        class _Tok:
            token = "test-token"
            expires_on = 9999999999

        return _Tok()


def _fake_creds() -> AzureCredentials:
    return AzureCredentials(
        bearer_token_provider=lambda: "test-token",
        token_credential=_FakeTokenCredential(),
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _spec(
    *,
    role="generator",
    provider="azure-openai",
    deployment="real-deployment",
    endpoint="https://example.openai.azure.com",
    api_key_env=None,
    api_kind="chat-completions",
) -> ModelSpec:
    return ModelSpec(
        role=role,
        provider=provider,
        model="gpt-5",
        deployment=deployment,
        endpoint=endpoint,
        api_version="2024-10-01-preview",
        temperature=0.0,
        max_tokens=1024,
        timeout_s=60,
        api_key_env=api_key_env,
        api_kind=api_kind,
    )


def _cfg(generator=None, reviewer=None, commentary=None) -> CoachConfig:
    return CoachConfig(
        generator=generator or _spec(role="generator"),
        reviewer=reviewer or _spec(role="reviewer", provider="azure-ai-inference"),
        commentary=commentary or _spec(role="commentary"),
        auth_mode="managed-identity",
    )


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def test_placeholder_deployment_raises():
    spec = _spec(deployment="<PLACEHOLDER_GPT_5_4_DEPLOYMENT>")
    with pytest.raises(CoachLLMUnavailable, match="placeholder"):
        build_chat_model(spec, credentials=_fake_creds())


def test_unknown_provider_raises():
    # ModelSpec.provider is typed Literal but Python doesn't enforce at runtime
    spec = _spec()
    bad = ModelSpec(**{**spec.__dict__, "provider": "wat"})  # type: ignore[arg-type]
    with pytest.raises(CoachLLMUnavailable, match="unknown provider"):
        build_chat_model(bad, credentials=_fake_creds())


def test_aoai_without_credentials_raises():
    with pytest.raises(CoachLLMUnavailable, match="api_key or credentials"):
        build_chat_model(_spec())  # no credentials, no api_key


# ---------------------------------------------------------------------------
# Happy paths (provider construction is mocked at the langchain import level)
# ---------------------------------------------------------------------------


def test_aoai_construction_uses_spec_fields(monkeypatch):
    captured: dict = {}

    class FakeAOAI:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    import langchain_openai

    monkeypatch.setattr(langchain_openai, "AzureChatOpenAI", FakeAOAI)
    build_chat_model(_spec(), credentials=_fake_creds())

    assert captured["azure_endpoint"] == "https://example.openai.azure.com"
    assert captured["azure_deployment"] == "real-deployment"
    assert captured["api_version"] == "2024-10-01-preview"
    assert captured["temperature"] == 0.0
    assert captured["max_tokens"] == 1024
    # AzureChatOpenAI gets the bearer-token *callable* from AzureCredentials,
    # not the raw TokenCredential.
    assert callable(captured["azure_ad_token_provider"])
    assert captured["azure_ad_token_provider"]() == "test-token"


def test_aoai_chat_completions_disables_responses_flag(monkeypatch):
    captured: dict = {}

    class FakeAOAI:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    import langchain_openai

    monkeypatch.setattr(langchain_openai, "AzureChatOpenAI", FakeAOAI)
    build_chat_model(_spec(api_kind="chat-completions"), credentials=_fake_creds())
    assert captured["use_responses_api"] is False


def test_aoai_responses_api_kind_routes_to_responses_endpoint(monkeypatch):
    """api_kind='responses' must propagate use_responses_api=True so
    AzureChatOpenAI hits /openai/responses, not /openai/chat/completions."""
    captured: dict = {}

    class FakeAOAI:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    import langchain_openai

    monkeypatch.setattr(langchain_openai, "AzureChatOpenAI", FakeAOAI)
    build_chat_model(_spec(api_kind="responses"), credentials=_fake_creds())
    assert captured["use_responses_api"] is True


def test_aoai_uses_api_key_when_provided(monkeypatch):
    captured: dict = {}

    class FakeAOAI:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    import langchain_openai

    monkeypatch.setattr(langchain_openai, "AzureChatOpenAI", FakeAOAI)
    build_chat_model(_spec(), api_key="sk-test")
    assert captured["api_key"] == "sk-test"
    assert "azure_ad_token_provider" not in captured


def test_api_key_can_come_from_env(monkeypatch):
    monkeypatch.setenv("MY_KEY", "sk-from-env")
    captured: dict = {}

    class FakeAOAI:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    import langchain_openai

    monkeypatch.setattr(langchain_openai, "AzureChatOpenAI", FakeAOAI)
    build_chat_model(_spec(api_key_env="MY_KEY"))
    assert captured["api_key"] == "sk-from-env"


# ---------------------------------------------------------------------------
# Role wrappers honour explicit config injection
# ---------------------------------------------------------------------------


def test_role_wrappers_dispatch_to_correct_spec(monkeypatch):
    captured: list[ModelSpec] = []

    import coach.runtime.llm_factory as factory_mod

    def fake_build(spec, *, credentials=None, api_key=None):
        captured.append(spec)
        return f"<fake-{spec.role}>"

    monkeypatch.setattr(factory_mod, "build_chat_model", fake_build)

    cfg = _cfg()
    assert build_generator_llm(config=cfg) == "<fake-generator>"
    assert build_reviewer_llm(config=cfg) == "<fake-reviewer>"
    assert build_commentary_llm(config=cfg) == "<fake-commentary>"
    assert [s.role for s in captured] == ["generator", "reviewer", "commentary"]


# ---------------------------------------------------------------------------
# azure-ai-inference provider — separate from AOAI because field shape differs
# ---------------------------------------------------------------------------


def test_azure_ai_inference_construction_uses_token_credential(monkeypatch):
    """AzureAIChatCompletionsModel must receive the TokenCredential object,
    not the bearer-token callable (regression for the latent bug found by
    architect review)."""
    captured: dict = {}

    class FakeAzureAI:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    from langchain_azure_ai.chat_models import AzureAIChatCompletionsModel  # noqa: F401
    import langchain_azure_ai.chat_models as mod

    monkeypatch.setattr(mod, "AzureAIChatCompletionsModel", FakeAzureAI)
    foundry_endpoint = "https://workspace.services.ai.azure.com/openai/v1"
    spec = _spec(role="reviewer", provider="azure-ai-inference", endpoint=foundry_endpoint)
    build_chat_model(spec, credentials=_fake_creds())

    # ``credential`` must be the TokenCredential, NOT the bearer-token callable
    assert isinstance(captured["credential"], _FakeTokenCredential)
    assert captured["endpoint"] == foundry_endpoint
    assert captured["model_name"] == "real-deployment"
    assert captured["api_version"] == "2024-10-01-preview"
    assert captured["temperature"] == 0.0
    assert captured["max_tokens"] == 1024
    assert captured["request_timeout"] == 60
    # The buggy keys must not leak through
    assert "client_kwargs" not in captured
    assert "azure_ad_token_provider" not in captured


def test_azure_ai_inference_api_key_path(monkeypatch):
    captured: dict = {}

    class FakeAzureAI:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    import langchain_azure_ai.chat_models as mod

    monkeypatch.setattr(mod, "AzureAIChatCompletionsModel", FakeAzureAI)
    spec = _spec(role="reviewer", provider="azure-ai-inference")
    build_chat_model(spec, api_key="sk-test")
    assert captured["credential"] == "sk-test"
