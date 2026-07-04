"""ModelSpec — provider-agnostic description of one LLM deployment.

Two role-bearing fields:

* ``role`` (set at construction by ``config.load_config``) — which coach
  function this model powers: ``generator``, ``reviewer``, ``commentary``.
* ``provider`` — which LLM API surface backs the role: ``azure-openai``
  (AOAI deployments), ``azure-ai-inference`` (Foundry serverless endpoints),
  or ``openai-compatible`` (third-party OpenAI-compatible chat endpoints such
  as DeepSeek).

The split keeps role names stable while the backing model can be swapped
per-environment by editing ``config/coach.toml``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


Role = Literal["generator", "reviewer", "commentary", "orchestrator"]
Provider = Literal["azure-openai", "azure-ai-inference", "openai-compatible"]
AuthMode = Literal["managed-identity", "api-key"]
ApiKind = Literal["chat-completions", "responses"]
ReasoningEffort = Literal["minimal", "low", "medium", "high", "max"]


@dataclass(frozen=True)
class ModelSpec:
    """Self-contained description of one model deployment."""

    role: Role
    provider: Provider
    model: str                # descriptive id (used as ``generated_by`` stamp)
    deployment: str           # Azure deployment name or request model id
    endpoint: str             # full base URL (e.g. https://x.cognitiveservices.azure.com)
    api_version: str | None
    temperature: float | None
    max_tokens: int | None
    timeout_s: float
    auth_mode: AuthMode = "managed-identity"
    api_key_env: str | None = None   # ``api-key`` auth only; ``None`` → MI
    api_kind: ApiKind = "chat-completions"  # ``responses`` → AOAI /openai/responses path
    # Reasoning-effort budget for reasoning models. Azure GPT/o-series use
    # minimal/low/medium/high; DeepSeek V4 also accepts max. ``None`` leaves
    # the kwarg unset so the SDK/model use their default. Leave unset unless
    # there is a concrete reason to control reasoning budget. Typed as a
    # Literal so an invalid value in coach.toml fails at config-load time, not
    # at first LLM call.
    reasoning_effort: ReasoningEffort | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def is_placeholder(self) -> bool:
        """True when the deployment hasn't been filled in yet."""
        return self.deployment.startswith("<PLACEHOLDER_") and self.deployment.endswith(">")
