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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, get_args

from .model_spec import AuthMode, ModelSpec, Provider, ReasoningEffort, Role


CONFIG_FILENAME = "config/coach.toml"
LOCAL_CONFIG_FILENAME = "config/coach.local.toml"
PATH_ENV = "STRIDE_COACH_CONFIG_PATH"


class CoachConfigError(RuntimeError):
    """Raised when the TOML cannot be loaded, parsed, or validated."""


@dataclass(frozen=True)
class ObservabilityConfig:
    """LangSmith tracing toggle (``[observability]`` section).

    **Off by default.** Flip ``langsmith_enabled`` on for the test phase to get
    LangChain/LangGraph span tracing in LangSmith. It MUST be turned back off
    before commercial launch: the coach's prompts/responses carry sensitive
    athlete health data (HRV / RHR / injuries / life events) and LangSmith SaaS
    is a US third-party processor — a PIPL cross-border-transfer liability for a
    China-market product. The API key is read from the environment (never the
    config file), so an enabled flag with no key safely stays off.
    """

    langsmith_enabled: bool = False
    langsmith_project: str = "stride-coach"
    langsmith_endpoint: str = "https://api.smith.langchain.com"
    langsmith_api_key_env: str = "LANGSMITH_API_KEY"


@dataclass(frozen=True)
class CoachConfig:
    generator: ModelSpec
    reviewer: ModelSpec
    commentary: ModelSpec
    auth_mode: AuthMode
    # Optional cheap/fast model for the orchestrator brain (Resolver /
    # Supervisor / Aggregator / Memory Writer). Absent ``[orchestrator]``
    # section → falls back to ``reviewer`` so existing configs keep working
    # without an edit (the orchestration nodes still run, just on the reviewer
    # model). Point this at a cheap deployment (gpt-4.1-mini) to realise the
    # low-latency main path (§4.7).
    orchestrator: ModelSpec | None = None
    # Optional LangSmith tracing toggle; absent ``[observability]`` → disabled.
    observability: ObservabilityConfig = field(default_factory=ObservabilityConfig)

    def for_role(self, role: Role) -> ModelSpec:
        if role == "generator":
            return self.generator
        if role == "reviewer":
            return self.reviewer
        if role == "commentary":
            return self.commentary
        if role == "orchestrator":
            return self.orchestrator or self.reviewer
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
    """Resolve which coach config file to load.

    Order (first hit wins):

    1. Explicit ``path=`` argument
    2. ``STRIDE_COACH_CONFIG_PATH`` env var
    3. ``<repo-root>/config/coach.local.toml`` — developer override (gpt-5.5
       on the dev resource; checked into the repo so every developer shares
       the same dev endpoint without having to re-create it)
    4. ``<repo-root>/config/coach.toml`` — prod config; in the Docker image
       this file is created by ``cp coach.prod.toml coach.toml`` and is the
       only config present. On a developer machine this file does NOT
       normally exist; resolution falls through to the local file above.
    5. ``<cwd>/config/coach.toml`` — last-resort fallback for tests / ad-hoc
       runs that happen to ``cd`` into a directory containing the config.
    """
    if path is not None:
        return Path(path).resolve()
    env_override = os.environ.get(PATH_ENV)
    if env_override:
        return Path(env_override).resolve()
    repo_root = _find_repo_root()
    if repo_root is not None:
        prod_candidate = repo_root / CONFIG_FILENAME
        if os.environ.get("STRIDE_CONFIG_ENV", "").lower() == "prod" and prod_candidate.exists():
            return prod_candidate.resolve()
        local_candidate = repo_root / LOCAL_CONFIG_FILENAME
        if local_candidate.exists():
            return local_candidate.resolve()
        if prod_candidate.exists():
            return prod_candidate.resolve()
    cwd_candidate = Path.cwd() / CONFIG_FILENAME
    return cwd_candidate.resolve()


_VALID_PROVIDERS: set[str] = {"azure-openai", "azure-ai-inference"}
_VALID_AUTH_MODES: set[str] = {"managed-identity", "api-key"}
_VALID_API_KINDS: set[str] = {"chat-completions", "responses"}
# Derived from the ``ReasoningEffort`` Literal so adding a new level
# (e.g. ``"maximal"``) is a single-line change in ``model_spec.py`` and
# doesn't drift between the type alias and runtime validation.
_VALID_REASONING_EFFORTS: frozenset[str] = frozenset(get_args(ReasoningEffort))
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
    if reasoning_effort is not None and reasoning_effort not in _VALID_REASONING_EFFORTS:
        # Validate at config-load time so a typo (``"hihg"``) raises here
        # instead of surviving until the first LLM call returns 400.
        raise CoachConfigError(
            f"[{role}] unknown reasoning_effort {reasoning_effort!r}; "
            f"valid: {sorted(_VALID_REASONING_EFFORTS)}"
        )
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
        reasoning_effort=reasoning_effort,  # validated against enum above
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

    # ``[orchestrator]`` is optional — absent → for_role("orchestrator") falls
    # back to the reviewer spec, so the 11 existing config files (and the
    # eval-sweep variants) keep loading without an edit.
    orchestrator = (
        _build_spec("orchestrator", raw["orchestrator"])
        if "orchestrator" in raw
        else None
    )

    obs_raw = raw.get("observability", {})
    observability = ObservabilityConfig(
        langsmith_enabled=bool(obs_raw.get("langsmith_enabled", False)),
        langsmith_project=str(obs_raw.get("langsmith_project", "stride-coach")),
        langsmith_endpoint=str(
            obs_raw.get("langsmith_endpoint", "https://api.smith.langchain.com")
        ),
        langsmith_api_key_env=str(obs_raw.get("langsmith_api_key_env", "LANGSMITH_API_KEY")),
    )

    return CoachConfig(
        generator=_build_spec("generator", raw["generator"]),
        reviewer=_build_spec("reviewer", raw["reviewer"]),
        commentary=_build_spec("commentary", raw["commentary"]),
        auth_mode=auth_mode,  # type: ignore[arg-type]
        orchestrator=orchestrator,
        observability=observability,
    )
