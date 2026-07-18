"""Coach runtime — request-scoped graph + module-level LLM singletons.

Three role-based LLMs are exposed (``get_generator_llm`` / ``get_reviewer_llm``
/ ``get_commentary_llm``). Each is lazy-built on first call via
``coach.runtime.llm_factory.build_*_llm()`` which reads the role's
``ModelSpec`` from ``config/coach.toml``.

The checkpointer is also a process-wide singleton so multi-turn coach
threads can pick up where they left off across requests.

NOTE on the commentary singleton: ``get_commentary_llm()`` is the LIVE
commentary LLM binding — ``commentary_ai.generate_commentary()`` calls it,
reached from the post-sync hook (``stride_core.post_sync``) and the
``/regenerate`` route (``routes/activities.py``). Its ``ModelSpec`` is the
``[commentary]`` block of ``config/coach.toml``.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Any

logger = logging.getLogger(__name__)


_CHECKPOINTER_LOCK = threading.Lock()
_CHECKPOINTER: Any = None
_ATHLETE_MEMORY_STORE_LOCK = threading.Lock()
_ATHLETE_MEMORY_STORE: Any = None
_GENERATOR_LLM_LOCK = threading.Lock()
_GENERATOR_LLM: Any = None
_ORCHESTRATOR_LLM_LOCK = threading.Lock()
_ORCHESTRATOR_LLM: Any = None
_STATUS_INSIGHT_LLM_LOCK = threading.Lock()
_STATUS_INSIGHT_LLM: Any = None
_REVIEWER_LLM_LOCK = threading.Lock()
_REVIEWER_LLM: Any = None
_COMMENTARY_LLM_LOCK = threading.Lock()
_COMMENTARY_LLM: Any = None
_OBSERVABILITY_LOCK = threading.Lock()
_OBSERVABILITY_CONFIGURED = False


def _seed_langsmith_key_from_credentials(api_key_env: str) -> None:
    """Dev convenience: seed the LangSmith key env from ``.credentials.local``.

    The repo-root ``.credentials.local`` (gitignored, loose ``key=value`` with
    ``//`` comments — the same file the frontend smoke uses) may carry a
    ``langsmith_api_key`` line. If the env var isn't already set, copy it in so
    the CLI / a local server can trace without the developer exporting it by
    hand. No-op in prod: the file is absent there, so the key must come from the
    container env (Key Vault → ``LANGSMITH_API_KEY``)."""
    if os.environ.get(api_key_env):
        return
    from pathlib import Path

    from coach.runtime.config import _find_repo_root

    candidates = [p for p in (_find_repo_root(), Path.cwd()) if p is not None]
    for root in candidates:
        cred = root / ".credentials.local"
        if not cred.exists():
            continue
        try:
            for raw_line in cred.read_text(encoding="utf-8").splitlines():
                line = raw_line.strip()
                if not line or line.startswith(("//", "#")) or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                if key.strip() == "langsmith_api_key" and value.strip():
                    os.environ[api_key_env] = value.strip()
                    return
        except OSError:
            logger.debug("could not read %s for langsmith key", cred, exc_info=True)


def configure_observability() -> None:
    """Apply the LangSmith tracing toggle once, before any LLM runs (idempotent).

    Reads ``[observability]`` from the coach config and sets the ``LANGSMITH_*``
    env accordingly. Cheap no-op after the first call; never raises —
    observability setup must not break a coach turn. Called from each
    ``get_*_llm`` builder so it runs no matter which entry point (HTTP, CLI,
    S1 generation) touches an LLM first."""
    global _OBSERVABILITY_CONFIGURED
    if _OBSERVABILITY_CONFIGURED:
        return
    with _OBSERVABILITY_LOCK:
        if _OBSERVABILITY_CONFIGURED:
            return
        try:
            from coach.runtime.config import load_config
            from coach.runtime.observability import configure_langsmith

            obs = load_config().observability
            if obs.langsmith_enabled:
                _seed_langsmith_key_from_credentials(obs.langsmith_api_key_env)
            configure_langsmith(obs)
        except Exception:  # noqa: BLE001 — tracing setup must never break the coach
            logger.warning("observability setup failed; continuing untraced", exc_info=True)
        _OBSERVABILITY_CONFIGURED = True


def get_checkpointer() -> Any:
    """Return a process-wide singleton ``AzureTableCheckpointSaver``.

    Lazy-built on first call so unit tests that never touch coach endpoints
    don't materialise the dev-backend filesystem layout."""
    global _CHECKPOINTER
    if _CHECKPOINTER is None:
        with _CHECKPOINTER_LOCK:
            if _CHECKPOINTER is None:
                from .coach_adapters.persistence.checkpointer import (
                    AzureTableCheckpointSaver,
                )
                from .config import load_server_config

                _CHECKPOINTER = AzureTableCheckpointSaver.from_config(
                    load_server_config().coach_persistence
                )
    return _CHECKPOINTER


def get_athlete_memory_store() -> Any:
    """Process-wide singleton ``AthleteMemoryStore`` (long-term memory, §5.3).

    Azure Table in prod (reuses the coach-persistence account url), local JSON
    file in dev — both via ``backend_from_config``."""
    global _ATHLETE_MEMORY_STORE
    if _ATHLETE_MEMORY_STORE is None:
        with _ATHLETE_MEMORY_STORE_LOCK:
            if _ATHLETE_MEMORY_STORE is None:
                from .athlete_memory_store import AthleteMemoryStore, backend_from_config

                url = ""
                try:
                    from .config import load_server_config

                    url = load_server_config().coach_persistence.table_account_url or ""
                except Exception:  # noqa: BLE001 — dev / no server config → file backend
                    url = ""
                _ATHLETE_MEMORY_STORE = AthleteMemoryStore(backend_from_config(url))
    return _ATHLETE_MEMORY_STORE


def set_athlete_memory_store_for_tests(store: Any) -> None:
    global _ATHLETE_MEMORY_STORE
    with _ATHLETE_MEMORY_STORE_LOCK:
        _ATHLETE_MEMORY_STORE = store


def reset_for_tests() -> None:
    """Clear cached LLMs + checkpointer (test-only)."""
    global _CHECKPOINTER, _GENERATOR_LLM, _ORCHESTRATOR_LLM, _STATUS_INSIGHT_LLM
    global _REVIEWER_LLM, _COMMENTARY_LLM
    global _ATHLETE_MEMORY_STORE, _OBSERVABILITY_CONFIGURED
    with (
        _CHECKPOINTER_LOCK,
        _GENERATOR_LLM_LOCK,
        _ORCHESTRATOR_LLM_LOCK,
        _STATUS_INSIGHT_LLM_LOCK,
        _REVIEWER_LLM_LOCK,
        _COMMENTARY_LLM_LOCK,
    ):
        _CHECKPOINTER = None
        _GENERATOR_LLM = None
        _ORCHESTRATOR_LLM = None
        _STATUS_INSIGHT_LLM = None
        _REVIEWER_LLM = None
        _COMMENTARY_LLM = None
        _ATHLETE_MEMORY_STORE = None
        _OBSERVABILITY_CONFIGURED = False


def set_checkpointer_for_tests(checkpointer: Any) -> None:
    """Inject a test checkpointer (e.g. file-backed) so route tests don't try
    to talk to Azure."""
    global _CHECKPOINTER
    with _CHECKPOINTER_LOCK:
        _CHECKPOINTER = checkpointer


# ---------------------------------------------------------------------------
# Role-based LLM singletons (config-driven; see config/coach.toml)
# ---------------------------------------------------------------------------


def _build_azure_credentials() -> Any:
    """Build an :class:`AzureCredentials` bundle for the coach LLM factory.

    Lives in the adapter layer (this file) because ``coach.*`` core is
    forbidden from importing ``azure.*`` by import-linter. The two fields
    of the bundle are backed by the same ``ChainedTokenCredential`` —
    callers in ``llm_factory`` pick the one their provider needs (callable
    bearer-token provider for ``langchain_openai``, ``TokenCredential``
    instance for ``langchain_azure_ai``).
    """
    from azure.identity import (
        AzureCliCredential,
        ChainedTokenCredential,
        DefaultAzureCredential,
        get_bearer_token_provider,
    )

    from coach.runtime.llm_factory import AzureCredentials

    scope = "https://cognitiveservices.azure.com/.default"
    credential = ChainedTokenCredential(
        AzureCliCredential(),
        DefaultAzureCredential(),
    )
    return AzureCredentials(
        bearer_token_provider=get_bearer_token_provider(credential, scope),
        token_credential=credential,
    )


def _credentials_for_spec(spec: Any) -> tuple[Any | None, str | None]:
    """Return the auth material needed by ``llm_factory`` for one role."""
    if spec.auth_mode == "api-key":
        api_key = os.environ.get(spec.api_key_env) if spec.api_key_env else None
        return None, api_key
    if spec.provider == "openai-compatible":
        return None, None
    return _build_azure_credentials(), None


def get_generator_llm() -> Any:
    """Return a process-wide singleton generator (Coach Agent)."""
    configure_observability()
    global _GENERATOR_LLM
    if _GENERATOR_LLM is None:
        with _GENERATOR_LLM_LOCK:
            if _GENERATOR_LLM is None:
                from coach.runtime.config import load_config
                from coach.runtime.llm_factory import build_generator_llm

                cfg = load_config()
                credentials, api_key = _credentials_for_spec(cfg.generator)
                _GENERATOR_LLM = build_generator_llm(
                    credentials=credentials,
                    api_key=api_key,
                    config=cfg,
                )
    return _GENERATOR_LLM


def set_generator_llm_for_tests(llm: Any) -> None:
    """Inject a test LLM so route tests don't need real credentials."""
    global _GENERATOR_LLM
    with _GENERATOR_LLM_LOCK:
        _GENERATOR_LLM = llm


def get_generator_model() -> str:
    """Return the configured generator model id (``config/coach.toml``
    ``[generator].model``) for use as a ``generated_by`` audit stamp.

    Reads the same config the generator LLM is built from, so the stamp
    reflects the real model rather than a hardcoded literal. Returns
    ``"unknown"`` if the config can't be read (the LLM call itself would
    have already failed in that case, so this is only a defensive fallback).
    """
    try:
        from coach.runtime.config import load_config

        return load_config().generator.model
    except Exception:  # noqa: BLE001 — stamp must never break generation
        logger.warning("get_generator_model: failed to read coach config", exc_info=True)
        return "unknown"


def get_orchestrator_llm() -> Any:
    """Return a process-wide singleton orchestrator LLM (cheap/fast brain).

    Powers the Resolver / Supervisor / Aggregator. Built from the optional
    ``[orchestrator]`` config role, which falls back to ``[reviewer]`` when
    unset (see ``coach.runtime.config.CoachConfig``)."""
    configure_observability()
    global _ORCHESTRATOR_LLM
    if _ORCHESTRATOR_LLM is None:
        with _ORCHESTRATOR_LLM_LOCK:
            if _ORCHESTRATOR_LLM is None:
                from coach.runtime.config import load_config
                from coach.runtime.llm_factory import build_orchestrator_llm

                cfg = load_config()
                spec = cfg.for_role("orchestrator")
                credentials, api_key = _credentials_for_spec(spec)
                _ORCHESTRATOR_LLM = build_orchestrator_llm(
                    credentials=credentials,
                    api_key=api_key,
                    config=cfg,
                )
    return _ORCHESTRATOR_LLM


def get_status_insight_llm() -> Any:
    """Return the read-only status / weekly-summary specialist model."""
    configure_observability()
    global _STATUS_INSIGHT_LLM
    if _STATUS_INSIGHT_LLM is None:
        with _STATUS_INSIGHT_LLM_LOCK:
            if _STATUS_INSIGHT_LLM is None:
                from coach.runtime.config import load_config
                from coach.runtime.llm_factory import build_status_insight_llm

                cfg = load_config()
                spec = cfg.for_role("status_insight")
                credentials, api_key = _credentials_for_spec(spec)
                _STATUS_INSIGHT_LLM = build_status_insight_llm(
                    credentials=credentials, api_key=api_key, config=cfg
                )
    return _STATUS_INSIGHT_LLM


def set_status_insight_llm_for_tests(llm: Any) -> None:
    global _STATUS_INSIGHT_LLM
    with _STATUS_INSIGHT_LLM_LOCK:
        _STATUS_INSIGHT_LLM = llm


def set_orchestrator_llm_for_tests(llm: Any) -> None:
    """Inject a test orchestrator LLM (must support ``bind_tools``)."""
    global _ORCHESTRATOR_LLM
    with _ORCHESTRATOR_LLM_LOCK:
        _ORCHESTRATOR_LLM = llm


def get_reviewer_llm() -> Any:
    """Return a process-wide singleton reviewer (Reviewer Agent)."""
    configure_observability()
    global _REVIEWER_LLM
    if _REVIEWER_LLM is None:
        with _REVIEWER_LLM_LOCK:
            if _REVIEWER_LLM is None:
                from coach.runtime.config import load_config
                from coach.runtime.llm_factory import build_reviewer_llm

                cfg = load_config()
                credentials, api_key = _credentials_for_spec(cfg.reviewer)
                _REVIEWER_LLM = build_reviewer_llm(
                    credentials=credentials,
                    api_key=api_key,
                    config=cfg,
                )
    return _REVIEWER_LLM


def set_reviewer_llm_for_tests(llm: Any) -> None:
    global _REVIEWER_LLM
    with _REVIEWER_LLM_LOCK:
        _REVIEWER_LLM = llm


def get_commentary_llm() -> Any:
    """Return a process-wide singleton commentary LLM.

    LIVE binding: ``commentary_ai.generate_commentary()`` calls this, reached
    from the post-sync hook and the ``/regenerate`` route. Built from the
    ``[commentary]`` ``ModelSpec`` in ``config/coach.toml``.
    """
    global _COMMENTARY_LLM
    if _COMMENTARY_LLM is None:
        with _COMMENTARY_LLM_LOCK:
            if _COMMENTARY_LLM is None:
                from coach.runtime.config import load_config
                from coach.runtime.llm_factory import build_commentary_llm

                cfg = load_config()
                credentials, api_key = _credentials_for_spec(cfg.commentary)
                _COMMENTARY_LLM = build_commentary_llm(
                    credentials=credentials,
                    api_key=api_key,
                    config=cfg,
                )
    return _COMMENTARY_LLM


def set_commentary_llm_for_tests(llm: Any) -> None:
    global _COMMENTARY_LLM
    with _COMMENTARY_LLM_LOCK:
        _COMMENTARY_LLM = llm


def build_conversation_graph_for_user(*, user_id: str, scope: str) -> Any:
    """Build a fresh conversation graph for one user + scope.

    The toolkit is user-scoped (each read tool needs user_id to open the
    correct DB), so we build the graph per request rather than caching by
    scope only. Compile cost is sub-millisecond once tools are imported.
    """
    from coach.graphs.conversation.graph import build_conversation_graph

    from .coach_adapters.toolkit import build_stride_toolkit

    toolkit = build_stride_toolkit(user_id)
    llm = get_status_insight_llm() if scope == "qa" else get_generator_llm()
    checkpointer = get_checkpointer()
    return build_conversation_graph(
        toolkit=toolkit, llm=llm, checkpointer=checkpointer, scope=scope
    )
