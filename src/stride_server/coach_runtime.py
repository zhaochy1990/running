"""Coach runtime — request-scoped graph + module-level LLM singletons.

Three role-based LLMs are exposed (``get_generator_llm`` / ``get_reviewer_llm``
/ ``get_commentary_llm``). Each is lazy-built on first call via
``coach.runtime.llm_factory.build_*_llm()`` which reads the role's
``ModelSpec`` from ``config/coach.toml``.

The checkpointer is also a process-wide singleton so multi-turn coach
threads can pick up where they left off across requests.

NOTE on the commentary singleton: nothing in the live route surface
currently calls ``get_commentary_llm()``. The production commentary
generation path uses its own direct AOAI client and will be migrated in a
separate commit. The singleton + test-injection point are here only so the
migration commit has a target.
"""

from __future__ import annotations

import logging
import os
import threading
from typing import Any

logger = logging.getLogger(__name__)


_CHECKPOINTER_LOCK = threading.Lock()
_CHECKPOINTER: Any = None
_GENERATOR_LLM_LOCK = threading.Lock()
_GENERATOR_LLM: Any = None
_REVIEWER_LLM_LOCK = threading.Lock()
_REVIEWER_LLM: Any = None
_COMMENTARY_LLM_LOCK = threading.Lock()
_COMMENTARY_LLM: Any = None


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


def reset_for_tests() -> None:
    """Clear cached LLMs + checkpointer (test-only)."""
    global _CHECKPOINTER, _GENERATOR_LLM, _REVIEWER_LLM, _COMMENTARY_LLM
    with _CHECKPOINTER_LOCK, _GENERATOR_LLM_LOCK, _REVIEWER_LLM_LOCK, _COMMENTARY_LLM_LOCK:
        _CHECKPOINTER = None
        _GENERATOR_LLM = None
        _REVIEWER_LLM = None
        _COMMENTARY_LLM = None


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


def get_generator_llm() -> Any:
    """Return a process-wide singleton generator (Coach Agent)."""
    global _GENERATOR_LLM
    if _GENERATOR_LLM is None:
        with _GENERATOR_LLM_LOCK:
            if _GENERATOR_LLM is None:
                from coach.runtime.llm_factory import build_generator_llm

                _GENERATOR_LLM = build_generator_llm(
                    credentials=_build_azure_credentials(),
                )
    return _GENERATOR_LLM


def set_generator_llm_for_tests(llm: Any) -> None:
    """Inject a test LLM so route tests don't need real credentials."""
    global _GENERATOR_LLM
    with _GENERATOR_LLM_LOCK:
        _GENERATOR_LLM = llm


def get_reviewer_llm() -> Any:
    """Return a process-wide singleton reviewer (Reviewer Agent)."""
    global _REVIEWER_LLM
    if _REVIEWER_LLM is None:
        with _REVIEWER_LLM_LOCK:
            if _REVIEWER_LLM is None:
                from coach.runtime.llm_factory import build_reviewer_llm

                _REVIEWER_LLM = build_reviewer_llm(
                    credentials=_build_azure_credentials(),
                )
    return _REVIEWER_LLM


def set_reviewer_llm_for_tests(llm: Any) -> None:
    global _REVIEWER_LLM
    with _REVIEWER_LLM_LOCK:
        _REVIEWER_LLM = llm


def get_commentary_llm() -> Any:
    """Return a process-wide singleton commentary LLM.

    Forward-looking — no live route calls this yet. The current production
    commentary generation path remains on its own AOAI client until the
    migration commit (US-010 wire-up) lands.
    """
    global _COMMENTARY_LLM
    if _COMMENTARY_LLM is None:
        with _COMMENTARY_LLM_LOCK:
            if _COMMENTARY_LLM is None:
                from coach.runtime.config import load_config
                from coach.runtime.llm_factory import build_commentary_llm

                cfg = load_config()
                api_key = None
                if cfg.commentary.api_key_env:
                    api_key = os.environ.get(cfg.commentary.api_key_env)
                if api_key:
                    _COMMENTARY_LLM = build_commentary_llm(
                        api_key=api_key,
                        config=cfg,
                    )
                else:
                    _COMMENTARY_LLM = build_commentary_llm(
                        credentials=_build_azure_credentials(),
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
    llm = get_generator_llm()
    checkpointer = get_checkpointer()
    return build_conversation_graph(
        toolkit=toolkit, llm=llm, checkpointer=checkpointer, scope=scope
    )
