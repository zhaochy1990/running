"""LangSmith observability toggle — config parsing + env activation (pure)."""

from __future__ import annotations

import os
import textwrap

from coach.runtime.config import ObservabilityConfig, load_config
from coach.runtime.observability import configure_langsmith

_MINIMAL = textwrap.dedent(
    """
    [generator]
    provider="azure-openai"
    model="m"
    deployment="m"
    endpoint="https://x"
    api_version="v"
    timeout_s=10
    [reviewer]
    provider="azure-openai"
    model="m"
    deployment="m"
    endpoint="https://x"
    api_version="v"
    timeout_s=10
    [commentary]
    provider="azure-openai"
    model="m"
    deployment="m"
    endpoint="https://x"
    api_version="v"
    timeout_s=10
    [auth]
    mode="managed-identity"
    """
)


def _write(tmp_path, body: str):
    p = tmp_path / "coach.toml"
    p.write_text(body, encoding="utf-8")
    return p


# --- config parsing --------------------------------------------------------


def test_observability_defaults_disabled_when_section_absent(tmp_path):
    cfg = load_config(_write(tmp_path, _MINIMAL))
    assert cfg.observability.langsmith_enabled is False
    assert cfg.observability.langsmith_api_key_env == "LANGSMITH_API_KEY"


def test_observability_section_parsed(tmp_path):
    body = _MINIMAL + textwrap.dedent(
        """
        [observability]
        langsmith_enabled = true
        langsmith_project = "p"
        langsmith_endpoint = "https://smith.example"
        langsmith_api_key_env = "MY_KEY"
        """
    )
    o = load_config(_write(tmp_path, body)).observability
    assert o.langsmith_enabled is True
    assert o.langsmith_project == "p"
    assert o.langsmith_endpoint == "https://smith.example"
    assert o.langsmith_api_key_env == "MY_KEY"


# --- activation (env side effects, isolated via monkeypatch) ---------------


def test_disabled_forces_tracing_off_even_with_stray_env(monkeypatch):
    monkeypatch.setenv("LANGSMITH_TRACING", "true")  # stray ambient value
    on = configure_langsmith(ObservabilityConfig(langsmith_enabled=False))
    assert on is False
    assert os.environ["LANGSMITH_TRACING"] == "false"


def test_enabled_without_key_stays_off(monkeypatch):
    monkeypatch.delenv("LANGSMITH_API_KEY", raising=False)
    on = configure_langsmith(ObservabilityConfig(langsmith_enabled=True))
    assert on is False
    assert os.environ["LANGSMITH_TRACING"] == "false"


def test_enabled_with_key_sets_canonical_env(monkeypatch):
    monkeypatch.setenv("LANGSMITH_API_KEY", "sk-test")
    on = configure_langsmith(
        ObservabilityConfig(
            langsmith_enabled=True,
            langsmith_project="proj",
            langsmith_endpoint="https://smith.example",
        )
    )
    assert on is True
    assert os.environ["LANGSMITH_TRACING"] == "true"
    assert os.environ["LANGSMITH_PROJECT"] == "proj"
    assert os.environ["LANGSMITH_ENDPOINT"] == "https://smith.example"
    assert os.environ["LANGSMITH_API_KEY"] == "sk-test"


def test_custom_key_env_copied_to_canonical(monkeypatch):
    monkeypatch.delenv("LANGSMITH_API_KEY", raising=False)
    monkeypatch.setenv("MY_LS_KEY", "sk-xyz")
    on = configure_langsmith(
        ObservabilityConfig(langsmith_enabled=True, langsmith_api_key_env="MY_LS_KEY")
    )
    assert on is True
    assert os.environ["LANGSMITH_API_KEY"] == "sk-xyz"
