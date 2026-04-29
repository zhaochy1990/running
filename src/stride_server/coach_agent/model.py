"""Chat-model factory for the local STRIDE coach agent."""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs, urlparse, urlunparse

from stride_server.aoai_client import AOAIUnavailable

COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default"


@dataclass(frozen=True)
class CoachModelConfig:
    provider: str
    deployment: str
    endpoint: str
    responses_url: str
    api_version: str
    api_kind: str
    auth_mode: str
    temperature: float
    max_tokens: int | None
    timeout_s: float


def _normalise_endpoint(raw_endpoint: str, raw_api_version: str | None) -> tuple[str, str, str]:
    """Return `(base_endpoint, responses_url, api_version)`.

    Accepts either a resource endpoint (`https://x.cognitiveservices.azure.com`)
    or the full Azure Responses URL
    (`https://x.cognitiveservices.azure.com/openai/responses?api-version=...`).
    """
    parsed = urlparse(raw_endpoint.rstrip("/"))
    query = parse_qs(parsed.query)
    api_version = raw_api_version or (query.get("api-version") or [None])[0]
    if not api_version:
        raise AOAIUnavailable(
            "Missing Azure OpenAI API version. Set STRIDE_COACH_AZURE_OPENAI_API_VERSION "
            "or AZURE_OPENAI_API_VERSION, pass --api-version, or include api-version "
            "in the responses URL."
        )

    if parsed.path.rstrip("/").endswith("/openai/responses"):
        base = urlunparse((parsed.scheme, parsed.netloc, "", "", "", ""))
        responses_url = urlunparse((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", "", ""))
        return base, responses_url, api_version

    base = urlunparse((parsed.scheme, parsed.netloc, "", "", "", ""))
    responses_url = f"{base}/openai/responses"
    return base, responses_url, api_version


def get_model_config() -> CoachModelConfig:
    """Read the local coach-agent model config from environment variables."""
    provider = os.environ.get("STRIDE_COACH_LLM_PROVIDER", "azure-openai").lower()
    if provider not in {"azure-openai", "azure_openai"}:
        raise AOAIUnavailable(
            f"Unsupported STRIDE_COACH_LLM_PROVIDER={provider!r}; "
            "only 'azure-openai' is wired for the local coach CLI."
        )

    raw_endpoint = (
        os.environ.get("STRIDE_COACH_AZURE_OPENAI_RESPONSES_URL")
        or os.environ.get("STRIDE_COACH_AZURE_OPENAI_ENDPOINT")
        or os.environ.get("AZURE_OPENAI_ENDPOINT")
    )
    if not raw_endpoint:
        raise AOAIUnavailable(
            "Missing Azure OpenAI endpoint. Set STRIDE_COACH_AZURE_OPENAI_RESPONSES_URL, "
            "STRIDE_COACH_AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_ENDPOINT, or pass --endpoint."
        )
    deployment = (
        os.environ.get("STRIDE_COACH_AZURE_OPENAI_DEPLOYMENT")
        or os.environ.get("AZURE_OPENAI_DEPLOYMENT")
    )
    if not deployment:
        raise AOAIUnavailable(
            "Missing coach deployment. Set STRIDE_COACH_AZURE_OPENAI_DEPLOYMENT "
            "or AZURE_OPENAI_DEPLOYMENT, or pass --deployment to stride-coach."
        )
    raw_api_version = (
        os.environ.get("STRIDE_COACH_AZURE_OPENAI_API_VERSION")
        or os.environ.get("AZURE_OPENAI_API_VERSION")
    )
    endpoint, responses_url, api_version = _normalise_endpoint(raw_endpoint, raw_api_version)
    api_kind = os.environ.get("STRIDE_COACH_AZURE_OPENAI_API_KIND", "responses").lower()
    auth_mode = os.environ.get("STRIDE_COACH_AUTH_MODE", "auto").lower()
    if auth_mode not in {"auto", "api-key", "api_key", "credential", "aad"}:
        raise AOAIUnavailable(
            "STRIDE_COACH_AUTH_MODE must be one of: auto, api-key, credential"
        )
    temperature = float(os.environ.get("STRIDE_COACH_TEMPERATURE", "0.4"))
    max_tokens_env = os.environ.get("STRIDE_COACH_MAX_TOKENS")
    max_tokens = int(max_tokens_env) if max_tokens_env else None
    timeout_s = float(os.environ.get("STRIDE_COACH_TIMEOUT_SECONDS", "120"))

    return CoachModelConfig(
        provider="azure-openai",
        deployment=deployment,
        endpoint=endpoint,
        responses_url=responses_url,
        api_version=api_version,
        api_kind=api_kind,
        auth_mode=auth_mode,
        temperature=temperature,
        max_tokens=max_tokens,
        timeout_s=timeout_s,
    )


def _credential_with_optional_tenant(cls: Any, tenant_id: str | None) -> Any:
    if not tenant_id:
        return cls()
    try:
        return cls(tenant_id=tenant_id)
    except TypeError:
        return cls()


def build_azure_token_provider() -> Callable[[], str]:
    """Build an AAD token provider, trying VS Code credentials first.

    This is intended for local evaluation with a corporate account signed in to
    VS Code. CLI / developer CLI / DefaultAzureCredential remain as fallbacks.
    """
    try:
        from azure.identity import (
            AzureCliCredential,
            AzureDeveloperCliCredential,
            ChainedTokenCredential,
            DefaultAzureCredential,
            VisualStudioCodeCredential,
            get_bearer_token_provider,
        )
    except ImportError as e:
        raise AOAIUnavailable(
            "azure-identity not installed. Install the web extras with "
            '`python -m pip install -e ".[web]"`.'
        )

    tenant_id = (
        os.environ.get("STRIDE_COACH_AZURE_TENANT_ID")
        or os.environ.get("AZURE_TENANT_ID")
    )
    credential = ChainedTokenCredential(
        _credential_with_optional_tenant(VisualStudioCodeCredential, tenant_id),
        _credential_with_optional_tenant(AzureDeveloperCliCredential, tenant_id),
        _credential_with_optional_tenant(AzureCliCredential, tenant_id),
        DefaultAzureCredential(),
    )
    return get_bearer_token_provider(credential, COGNITIVE_SERVICES_SCOPE)


class AzureResponsesChatModel:
    """Small LangChain-like wrapper around Azure OpenAI Responses API."""

    def __init__(
        self,
        config: CoachModelConfig,
        *,
        token_provider: Callable[[], str] | None = None,
    ) -> None:
        self.config = config
        self._token_provider = token_provider

    def _headers(self) -> dict[str, str]:
        api_key = os.environ.get("STRIDE_COACH_AZURE_OPENAI_API_KEY") or os.environ.get("AZURE_OPENAI_API_KEY")
        if self.config.auth_mode in {"api-key", "api_key"}:
            if not api_key:
                raise AOAIUnavailable(
                    "STRIDE_COACH_AUTH_MODE=api-key but no "
                    "STRIDE_COACH_AZURE_OPENAI_API_KEY or AZURE_OPENAI_API_KEY is set"
                )
            return {"api-key": api_key, "Content-Type": "application/json"}
        if self.config.auth_mode == "auto" and api_key:
            return {"api-key": api_key, "Content-Type": "application/json"}
        token_provider = self._token_provider or build_azure_token_provider()
        return {
            "Authorization": f"Bearer {token_provider()}",
            "Content-Type": "application/json",
        }

    def _payload(self, messages: list[tuple[str, str]] | list[dict[str, Any]]) -> dict[str, Any]:
        input_messages = []
        for msg in messages:
            if isinstance(msg, tuple):
                role, content = msg
                input_messages.append({"role": role, "content": content})
            else:
                input_messages.append({"role": msg.get("role", "user"), "content": msg.get("content", "")})
        payload: dict[str, Any] = {
            "model": self.config.deployment,
            "input": input_messages,
            "temperature": self.config.temperature,
        }
        if self.config.max_tokens is not None:
            payload["max_output_tokens"] = self.config.max_tokens
        return payload

    @staticmethod
    def _extract_text(data: dict[str, Any]) -> str:
        if isinstance(data.get("output_text"), str):
            return data["output_text"].strip()
        chunks: list[str] = []
        for output in data.get("output") or []:
            for item in output.get("content") or []:
                text = item.get("text") or item.get("content")
                if text:
                    chunks.append(str(text))
        if chunks:
            return "\n".join(chunks).strip()
        return str(data).strip()

    def invoke(self, messages: list[tuple[str, str]] | list[dict[str, Any]]) -> Any:
        import httpx

        resp = httpx.post(
            self.config.responses_url,
            params={"api-version": self.config.api_version},
            headers=self._headers(),
            json=self._payload(messages),
            timeout=self.config.timeout_s,
        )
        resp.raise_for_status()
        return SimpleNamespace(content=self._extract_text(resp.json()))


def get_chat_model() -> Any:
    """Create the local coach chat model.

    Defaults to Azure OpenAI Responses API and AAD auth through VS Code
    credentials. Set
    `STRIDE_COACH_AZURE_OPENAI_API_KIND=chat-completions` to use the older
    LangChain AzureChatOpenAI path.
    """
    config = get_model_config()
    if config.api_kind in {"responses", "response"}:
        return AzureResponsesChatModel(config)

    try:
        from langchain_openai import AzureChatOpenAI
    except ImportError as e:
        raise AOAIUnavailable(f"langchain-openai not installed: {e}")

    api_key = os.environ.get("STRIDE_COACH_AZURE_OPENAI_API_KEY") or os.environ.get("AZURE_OPENAI_API_KEY")
    common: dict[str, Any] = {
        "azure_endpoint": config.endpoint,
        "azure_deployment": config.deployment,
        "api_version": config.api_version,
        "temperature": config.temperature,
    }
    if config.max_tokens is not None:
        common["max_tokens"] = config.max_tokens
    if config.auth_mode in {"api-key", "api_key"}:
        if not api_key:
            raise AOAIUnavailable(
                "STRIDE_COACH_AUTH_MODE=api-key but no "
                "STRIDE_COACH_AZURE_OPENAI_API_KEY or AZURE_OPENAI_API_KEY is set"
            )
        return AzureChatOpenAI(api_key=api_key, **common)
    if config.auth_mode == "auto" and api_key:
        return AzureChatOpenAI(api_key=api_key, **common)
    return AzureChatOpenAI(azure_ad_token_provider=build_azure_token_provider(), **common)


def get_generated_by() -> str:
    """Stable model identifier to stamp generated DB rows."""
    deployment = (
        os.environ.get("STRIDE_COACH_AZURE_OPENAI_DEPLOYMENT")
        or os.environ.get("AZURE_OPENAI_DEPLOYMENT")
    )
    if not deployment:
        raise AOAIUnavailable(
            "Missing coach deployment. Set STRIDE_COACH_AZURE_OPENAI_DEPLOYMENT "
            "or AZURE_OPENAI_DEPLOYMENT, or pass --deployment to stride-coach."
        )
    return deployment
