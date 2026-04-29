"""Tests for the LangChain coach model configuration layer."""

from __future__ import annotations

import json

import pytest

from stride_server.aoai_client import AOAIUnavailable
from stride_server.coach_agent.model import (
    COGNITIVE_SERVICES_SCOPE,
    build_azure_token_provider,
    get_generated_by,
    get_model_config,
)


def _clear_model_env(monkeypatch):
    for key in (
        "STRIDE_COACH_LLM_PROVIDER",
        "STRIDE_COACH_AZURE_OPENAI_ENDPOINT",
        "STRIDE_COACH_AZURE_OPENAI_RESPONSES_URL",
        "STRIDE_COACH_AZURE_OPENAI_DEPLOYMENT",
        "STRIDE_COACH_AZURE_OPENAI_API_VERSION",
        "STRIDE_COACH_AZURE_OPENAI_API_KIND",
        "STRIDE_COACH_AZURE_OPENAI_API_KEY",
        "STRIDE_COACH_AUTH_MODE",
        "STRIDE_COACH_AZURE_TENANT_ID",
        "STRIDE_COACH_AZURE_USERNAME",
        "STRIDE_COACH_TEMPERATURE",
        "STRIDE_COACH_MAX_TOKENS",
        "STRIDE_COACH_TIMEOUT_SECONDS",
        "AZURE_OPENAI_ENDPOINT",
        "AZURE_OPENAI_DEPLOYMENT",
        "AZURE_OPENAI_API_VERSION",
        "AZURE_OPENAI_API_KEY",
        "AZURE_USERNAME",
    ):
        monkeypatch.delenv(key, raising=False)


def test_model_config_requires_endpoint(monkeypatch):
    _clear_model_env(monkeypatch)
    monkeypatch.setenv("STRIDE_COACH_AZURE_OPENAI_DEPLOYMENT", "test-deployment")

    with pytest.raises(AOAIUnavailable, match="Missing Azure OpenAI endpoint"):
        get_model_config()


def test_model_config_requires_deployment(monkeypatch):
    _clear_model_env(monkeypatch)
    monkeypatch.setenv("STRIDE_COACH_AZURE_OPENAI_RESPONSES_URL", "https://example.cognitiveservices.azure.com/openai/responses?api-version=2025-04-01-preview")

    with pytest.raises(AOAIUnavailable, match="Missing coach deployment"):
        get_model_config()


def test_model_config_with_explicit_values(monkeypatch):
    _clear_model_env(monkeypatch)
    monkeypatch.setenv("STRIDE_COACH_AZURE_OPENAI_ENDPOINT", "https://example.cognitiveservices.azure.com")
    monkeypatch.setenv("STRIDE_COACH_AZURE_OPENAI_DEPLOYMENT", "test-deployment")
    monkeypatch.setenv("STRIDE_COACH_AZURE_OPENAI_API_VERSION", "2025-04-01-preview")

    config = get_model_config()

    assert config.provider == "azure-openai"
    assert config.deployment == "test-deployment"
    assert config.endpoint == "https://example.cognitiveservices.azure.com"
    assert config.responses_url == "https://example.cognitiveservices.azure.com/openai/responses"
    assert config.api_version == "2025-04-01-preview"
    assert config.api_kind == "responses"
    assert config.auth_mode == "auto"
    assert config.temperature is None
    assert config.max_tokens is None


def test_coach_specific_env_overrides_shared_aoai_env(monkeypatch):
    _clear_model_env(monkeypatch)
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://shared.openai.azure.com")
    monkeypatch.setenv("AZURE_OPENAI_DEPLOYMENT", "gpt-4.1")
    monkeypatch.setenv("STRIDE_COACH_AZURE_OPENAI_ENDPOINT", "https://coach.openai.azure.com")
    monkeypatch.setenv("STRIDE_COACH_AZURE_OPENAI_DEPLOYMENT", "coach-deployment")
    monkeypatch.setenv("STRIDE_COACH_AZURE_OPENAI_API_VERSION", "2026-01-01")
    monkeypatch.setenv("STRIDE_COACH_TEMPERATURE", "0.2")
    monkeypatch.setenv("STRIDE_COACH_MAX_TOKENS", "4096")

    config = get_model_config()

    assert config.endpoint == "https://coach.openai.azure.com"
    assert config.deployment == "coach-deployment"
    assert config.api_version == "2026-01-01"
    assert config.temperature == 0.2
    assert config.max_tokens == 4096
    assert get_generated_by() == "coach-deployment"


def test_full_responses_url_parses_api_version(monkeypatch):
    _clear_model_env(monkeypatch)
    monkeypatch.setenv("STRIDE_COACH_AZURE_OPENAI_DEPLOYMENT", "my-deployment")
    monkeypatch.setenv(
        "STRIDE_COACH_AZURE_OPENAI_RESPONSES_URL",
        "https://example.cognitiveservices.azure.com/openai/responses?api-version=2025-04-01-preview",
    )

    config = get_model_config()

    assert config.endpoint == "https://example.cognitiveservices.azure.com"
    assert config.responses_url == "https://example.cognitiveservices.azure.com/openai/responses"
    assert config.api_version == "2025-04-01-preview"


def test_unsupported_provider_is_explicit(monkeypatch):
    _clear_model_env(monkeypatch)
    monkeypatch.setenv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com")
    monkeypatch.setenv("STRIDE_COACH_LLM_PROVIDER", "azure-anthropic")

    with pytest.raises(AOAIUnavailable, match="Unsupported STRIDE_COACH_LLM_PROVIDER"):
        get_model_config()


def test_config_file_values_feed_model_config(tmp_path, monkeypatch):
    _clear_model_env(monkeypatch)
    config_path = tmp_path / "coach.json"
    config_path.write_text(
        json.dumps(
            {
                "azure_openai": {
                    "responses_url": (
                        "https://cfg.example.com/openai/responses"
                        "?api-version=2025-04-01-preview"
                    ),
                    "deployment": "configured-deployment",
                    "auth": "credential",
                    "temperature": 0.15,
                    "max_tokens": 1234,
                    "timeout_seconds": 99,
                }
            }
        ),
        encoding="utf-8",
    )

    from stride_server.coach_agent.cli import _apply_model_config_file

    _apply_model_config_file(config_path)
    config = get_model_config()

    assert config.endpoint == "https://cfg.example.com"
    assert config.responses_url == "https://cfg.example.com/openai/responses"
    assert config.api_version == "2025-04-01-preview"
    assert config.deployment == "configured-deployment"
    assert config.auth_mode == "credential"
    assert config.temperature == 0.15
    assert config.max_tokens == 1234
    assert config.timeout_s == 99


def test_token_provider_prefers_ide_and_shared_cache_credentials(monkeypatch):
    _clear_model_env(monkeypatch)
    monkeypatch.setenv("STRIDE_COACH_AZURE_TENANT_ID", "tenant-1")
    monkeypatch.setenv("STRIDE_COACH_AZURE_USERNAME", "runner@example.com")

    import azure.identity as identity

    constructed: list[tuple[str, dict]] = []

    def credential_cls(name: str):
        class Credential:
            def __init__(self, **kwargs):
                constructed.append((name, kwargs))

        Credential.__name__ = name
        return Credential

    class ChainedTokenCredential:
        def __init__(self, *credentials):
            self.credentials = credentials

    captured = {}

    def get_bearer_token_provider(credential, scope):
        captured["credential"] = credential
        captured["scope"] = scope
        return lambda: "token"

    monkeypatch.setattr(identity, "VisualStudioCodeCredential", credential_cls("VisualStudioCodeCredential"))
    monkeypatch.setattr(identity, "SharedTokenCacheCredential", credential_cls("SharedTokenCacheCredential"))
    monkeypatch.setattr(identity, "AzureDeveloperCliCredential", credential_cls("AzureDeveloperCliCredential"))
    monkeypatch.setattr(identity, "AzureCliCredential", credential_cls("AzureCliCredential"))
    monkeypatch.setattr(identity, "AzurePowerShellCredential", credential_cls("AzurePowerShellCredential"))
    monkeypatch.setattr(identity, "DefaultAzureCredential", credential_cls("DefaultAzureCredential"))
    monkeypatch.setattr(identity, "ChainedTokenCredential", ChainedTokenCredential)
    monkeypatch.setattr(identity, "get_bearer_token_provider", get_bearer_token_provider)

    provider = build_azure_token_provider()

    assert provider() == "token"
    assert captured["scope"] == COGNITIVE_SERVICES_SCOPE
    assert [name for name, _ in constructed] == [
        "VisualStudioCodeCredential",
        "SharedTokenCacheCredential",
        "AzurePowerShellCredential",
        "AzureDeveloperCliCredential",
        "AzureCliCredential",
        "DefaultAzureCredential",
    ]
    assert constructed[1] == (
        "SharedTokenCacheCredential",
        {"username": "runner@example.com", "tenant_id": "tenant-1"},
    )
