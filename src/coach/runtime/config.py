"""TOML loader for coach LLM configuration — see ``config/coach.toml``.

Path resolution order:
1. The ``path`` argument to :func:`load_config` (test injection).
2. ``STRIDE_COACH_CONFIG_PATH`` env var.
3. ``<repo-root>/config/coach.toml`` (the canonical location).
4. ``<cwd>/config/coach.toml`` (fallback for ad-hoc invocations).

Repo root is detected by walking up from this file until a ``pyproject.toml``
sibling is found; this keeps the loader working in editable installs and
in deployed containers where the repo layout is preserved.
"""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .model_spec import AuthMode, ModelSpec, Provider, Role


CONFIG_FILENAME = "config/coach.toml"
PATH_ENV = "STRIDE_COACH_CONFIG_PATH"


class CoachConfigError(RuntimeError):
    """Raised when the TOML cannot be loaded, parsed, or validated."""


@dataclass(frozen=True)
class CoachConfig:
    generator: ModelSpec
    reviewer: ModelSpec
    commentary: ModelSpec
    auth_mode: AuthMode

    def for_role(self, role: Role) -> ModelSpec:
        if role == "generator":
            return self.generator
        if role == "reviewer":
            return self.reviewer
        if role == "commentary":
            return self.commentary
        raise ValueError(f"unknown role {role!r}")


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------


def _find_repo_root() -> Path | None:
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        if (parent / "pyproject.toml").exists():
            return parent
    return None


def _resolve_path(path: str | Path | None) -> Path:
    if path is not None:
        return Path(path).resolve()
    env_override = os.environ.get(PATH_ENV)
    if env_override:
        return Path(env_override).resolve()
    repo_root = _find_repo_root()
    if repo_root is not None:
        candidate = repo_root / CONFIG_FILENAME
        if candidate.exists():
            return candidate.resolve()
    cwd_candidate = Path.cwd() / CONFIG_FILENAME
    return cwd_candidate.resolve()


_VALID_PROVIDERS: set[str] = {"azure-openai", "azure-ai-inference"}
_VALID_AUTH_MODES: set[str] = {"managed-identity", "api-key"}
_VALID_API_KINDS: set[str] = {"chat-completions", "responses"}
_REQUIRED_FIELDS = (
    "provider",
    "model",
    "deployment",
    "endpoint",
    "api_version",
    "timeout_s",
)


def _build_spec(role: Role, raw: dict[str, Any]) -> ModelSpec:
    missing = [f for f in _REQUIRED_FIELDS if f not in raw]
    if missing:
        raise CoachConfigError(
            f"[{role}] missing required fields in coach.toml: {missing}"
        )
    provider = raw["provider"]
    if provider not in _VALID_PROVIDERS:
        raise CoachConfigError(
            f"[{role}] unknown provider {provider!r}; valid: {sorted(_VALID_PROVIDERS)}"
        )
    temperature = raw.get("temperature")
    max_tokens = raw.get("max_tokens")
    reasoning_effort = raw.get("reasoning_effort")
    api_kind = raw.get("api_kind", "chat-completions")
    if api_kind not in _VALID_API_KINDS:
        raise CoachConfigError(
            f"[{role}] unknown api_kind {api_kind!r}; valid: {sorted(_VALID_API_KINDS)}"
        )
    endpoint = str(raw["endpoint"])
    if not endpoint.startswith(("https://", "http://")):
        raise CoachConfigError(
            f"[{role}] endpoint {endpoint!r} must start with https:// or http://"
        )
    return ModelSpec(
        role=role,
        provider=provider,  # type: ignore[arg-type]
        model=str(raw["model"]),
        deployment=str(raw["deployment"]),
        endpoint=endpoint,
        api_version=str(raw["api_version"]),
        temperature=float(temperature) if temperature is not None else None,
        max_tokens=int(max_tokens) if max_tokens is not None else None,
        timeout_s=float(raw["timeout_s"]),
        api_key_env=raw.get("api_key_env"),
        api_kind=api_kind,  # type: ignore[arg-type]
        reasoning_effort=str(reasoning_effort) if reasoning_effort is not None else None,
        extra=dict(raw.get("extra") or {}),
    )


def load_config(path: str | Path | None = None) -> CoachConfig:
    cfg_path = _resolve_path(path)
    if not cfg_path.exists():
        raise CoachConfigError(
            f"coach config not found at {cfg_path}; set {PATH_ENV} or create the file"
        )
    try:
        raw = tomllib.loads(cfg_path.read_text(encoding="utf-8"))
    except (tomllib.TOMLDecodeError, OSError) as exc:
        raise CoachConfigError(f"failed to load {cfg_path}: {exc}") from exc

    for required_section in ("generator", "reviewer", "commentary", "auth"):
        if required_section not in raw:
            raise CoachConfigError(
                f"{cfg_path}: missing required section [{required_section}]"
            )

    auth_mode = raw["auth"].get("mode", "managed-identity")
    if auth_mode not in _VALID_AUTH_MODES:
        raise CoachConfigError(
            f"[auth] unknown mode {auth_mode!r}; valid: {sorted(_VALID_AUTH_MODES)}"
        )

    return CoachConfig(
        generator=_build_spec("generator", raw["generator"]),
        reviewer=_build_spec("reviewer", raw["reviewer"]),
        commentary=_build_spec("commentary", raw["commentary"]),
        auth_mode=auth_mode,  # type: ignore[arg-type]
    )
