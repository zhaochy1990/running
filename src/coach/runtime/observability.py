"""LangSmith tracing toggle — pure env setup, no infra import, no secret fetch.

Gated by ``[observability].langsmith_enabled`` in the coach config. When on,
LangChain/LangGraph auto-export every node / LLM / tool span to LangSmith — no
code changes beyond the ``LANGSMITH_*`` environment variables set here.

This module is intentionally pure (only ``os``/``logging``) so it stays inside
the ``coach.*`` core import boundary and is unit-testable without infra. The API
key is read from the environment — never the config file — so committing an
``langsmith_enabled = true`` flag with no key on the host safely stays off.

NOTE (commercialisation): the coach's prompts/responses carry sensitive athlete
health data. LangSmith SaaS is a US third-party processor — keep this OFF in the
commercial prod config (PIPL cross-border-transfer). It exists for the test
phase only.
"""

from __future__ import annotations

import logging
import os

from .config import ObservabilityConfig

logger = logging.getLogger(__name__)


def configure_langsmith(cfg: ObservabilityConfig) -> bool:
    """Apply the LangSmith env from config. Returns ``True`` iff tracing is on.

    Safe + idempotent:

    * Disabled → explicitly set ``LANGSMITH_TRACING=false`` so a stray ambient
      env var can't silently turn tracing on behind a disabled config.
    * Enabled but the API-key env var is unset → log a warning and stay off
      (never raises — observability must not break the coach).
    * Enabled with a key → set the canonical ``LANGSMITH_*`` vars LangChain reads.
    """
    if not cfg.langsmith_enabled:
        os.environ["LANGSMITH_TRACING"] = "false"
        return False

    api_key = os.environ.get(cfg.langsmith_api_key_env)
    if not api_key:
        logger.warning(
            "LangSmith tracing is enabled in config but %s is unset; tracing stays OFF",
            cfg.langsmith_api_key_env,
        )
        os.environ["LANGSMITH_TRACING"] = "false"
        return False

    os.environ["LANGSMITH_TRACING"] = "true"
    os.environ["LANGSMITH_PROJECT"] = cfg.langsmith_project
    os.environ["LANGSMITH_ENDPOINT"] = cfg.langsmith_endpoint
    os.environ["LANGSMITH_API_KEY"] = api_key  # canonical name LangChain reads
    logger.info(
        "LangSmith tracing ON — project=%s endpoint=%s",
        cfg.langsmith_project,
        cfg.langsmith_endpoint,
    )
    return True
