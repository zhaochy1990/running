"""ModelSpec — provider-agnostic description of one LLM deployment.

Two role-bearing fields:

* ``role`` (set at construction by ``config.load_config``) — which coach
  function this model powers: ``generator``, ``reviewer``, ``commentary``.
* ``provider`` — which Azure surface it's deployed on: ``azure-openai``
  (AOAI deployments) or ``azure-ai-inference`` (Foundry serverless
  endpoints, used for non-OpenAI models like Claude / Gemini / Llama).

The split keeps role names stable while the backing model can be swapped
per-environment by editing ``config/coach.toml``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


Role = Literal["generator", "reviewer", "commentary"]
Provider = Literal["azure-openai", "azure-ai-inference"]
AuthMode = Literal["managed-identity", "api-key"]
ApiKind = Literal["chat-completions", "responses"]


@dataclass(frozen=True)
class ModelSpec:
    """Self-contained description of one model deployment."""

    role: Role
    provider: Provider
    model: str                # descriptive id (used as ``generated_by`` stamp)
    deployment: str           # Azure deployment name
    endpoint: str             # full base URL (e.g. https://x.cognitiveservices.azure.com)
    api_version: str
    temperature: float | None
    max_tokens: int | None
    timeout_s: float
    api_key_env: str | None = None   # ``api-key`` auth only; ``None`` → MI
    api_kind: ApiKind = "chat-completions"  # ``responses`` → AOAI /openai/responses path
    # Reasoning-effort budget for gpt-5 / o-series models on the Responses
    # API. ``None`` (default) leaves the kwarg unset → the SDK / model use
    # their default (typically ``medium``). Lowering it to ``low`` or
    # ``minimal`` trades reasoning depth for output-token budget, which is
    # sometimes needed when a long structured response (e.g. S1 master
    # plan) bumps against the cap — but it can degrade quality on tasks
    # that legitimately need deep chain-of-thought (multi-month
    # periodisation reasoning, goal realism, etc.). Leave None unless
    # there's a concrete reason.
    reasoning_effort: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def is_placeholder(self) -> bool:
        """True when the deployment hasn't been filled in yet."""
        return self.deployment.startswith("<PLACEHOLDER_") and self.deployment.endswith(">")
