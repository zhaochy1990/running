"""Model identity helpers for plan parsing and persistence."""

from __future__ import annotations


def configured_generator_id(default: str = "unknown") -> str:
    """Return the configured coach generator deployment id.

    The parser is used from CLI, server, and tests. Falling back keeps pure
    persistence paths usable when no coach config is present.
    """
    try:
        from coach.runtime.config import load_config

        return load_config().generator.deployment
    except Exception:  # noqa: BLE001
        return default