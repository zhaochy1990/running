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


@dataclass(frozen=True)
class ModelSpec:
    """Self-contained description of one model deployment."""

    role: Role
    provider: Provider
    model: str                # descriptive id (used as ``generated_by`` stamp)
    deployment: str           # Azure deployment name
    endpoint_env: str         # env var name holding the endpoint URL
    api_version: str
    temperature: float | None
    max_tokens: int | None
    timeout_s: float
    api_key_env: str | None = None   # ``api-key`` auth only; ``None`` → MI
    extra: dict[str, Any] = field(default_factory=dict)

    def is_placeholder(self) -> bool:
        """True when the deployment hasn't been filled in yet."""
        return self.deployment.startswith("<PLACEHOLDER_") and self.deployment.endswith(">")
