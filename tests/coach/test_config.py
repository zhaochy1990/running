"""Config loader tests — TOML round-trip + validation."""

from __future__ import annotations

from pathlib import Path

import pytest

from coach.runtime.config import (
    CoachConfig,
    CoachConfigError,
    PATH_ENV,
    load_config,
)
from coach.runtime.model_spec import ModelSpec


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _valid_toml(deployment_suffix: str = "<PLACEHOLDER_X>") -> str:
    return f"""
[generator]
provider     = "azure-openai"
model        = "gpt-5.4"
deployment   = "{deployment_suffix}"
endpoint     = "https://example.openai.azure.com"
api_version  = "2024-10-01-preview"
temperature  = 0.4
max_tokens   = 4096
timeout_s    = 120

[reviewer]
provider     = "azure-ai-inference"
model        = "claude-opus-4-7"
deployment   = "<PLACEHOLDER_CLAUDE>"
endpoint     = "https://example.openai.azure.com"
api_version  = "2024-05-01-preview"
temperature  = 0.0
max_tokens   = 4096
timeout_s    = 180

[commentary]
provider     = "azure-openai"
model        = "gpt-4.1"
deployment   = "<PLACEHOLDER_GPT_4_1>"
endpoint     = "https://example.openai.azure.com"
api_version  = "2024-10-01-preview"
temperature  = 0.6
max_tokens   = 2048
timeout_s    = 90

[auth]
mode = "managed-identity"
"""


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_load_config_returns_three_role_specs(tmp_path: Path) -> None:
    p = tmp_path / "coach.toml"
    p.write_text(_valid_toml())
    cfg = load_config(p)
    assert isinstance(cfg, CoachConfig)
    assert cfg.auth_mode == "managed-identity"
    assert cfg.generator.role == "generator"
    assert cfg.generator.provider == "azure-openai"
    assert cfg.generator.model == "gpt-5.4"
    assert cfg.reviewer.role == "reviewer"
    assert cfg.reviewer.provider == "azure-ai-inference"
    assert cfg.commentary.role == "commentary"
    assert cfg.commentary.model == "gpt-4.1"


def test_for_role_returns_matching_spec(tmp_path: Path) -> None:
    p = tmp_path / "coach.toml"
    p.write_text(_valid_toml())
    cfg = load_config(p)
    assert cfg.for_role("generator") is cfg.generator
    assert cfg.for_role("reviewer") is cfg.reviewer
    assert cfg.for_role("commentary") is cfg.commentary
    with pytest.raises(ValueError):
        cfg.for_role("bogus")  # type: ignore[arg-type]


def test_placeholder_detection() -> None:
    spec = ModelSpec(
        role="generator",
        provider="azure-openai",
        model="gpt-5",
        deployment="<PLACEHOLDER_FOO>",
        endpoint="https://example/",
        api_version="2024-01-01",
        temperature=None,
        max_tokens=None,
        timeout_s=60,
    )
    assert spec.is_placeholder()
    real = ModelSpec(**{**spec.__dict__, "deployment": "gpt-5-prod"})
    assert not real.is_placeholder()


# ---------------------------------------------------------------------------
# Path resolution
# ---------------------------------------------------------------------------


def test_env_var_overrides_default_path(tmp_path: Path, monkeypatch) -> None:
    p = tmp_path / "alt-coach.toml"
    p.write_text(_valid_toml())
    monkeypatch.setenv(PATH_ENV, str(p))
    cfg = load_config()  # no explicit path; should pick up env var
    assert cfg.generator.deployment == "<PLACEHOLDER_X>"


def test_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(CoachConfigError, match="not found"):
        load_config(tmp_path / "does-not-exist.toml")


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def test_unknown_provider_rejected(tmp_path: Path) -> None:
    bad = _valid_toml().replace('provider     = "azure-openai"', 'provider     = "bogus"', 1)
    p = tmp_path / "coach.toml"
    p.write_text(bad)
    with pytest.raises(CoachConfigError, match="unknown provider"):
        load_config(p)


def test_missing_required_section_rejected(tmp_path: Path) -> None:
    missing_reviewer = "\n".join(
        block for block in _valid_toml().split("\n\n") if not block.strip().startswith("[reviewer]")
    )
    p = tmp_path / "coach.toml"
    p.write_text(missing_reviewer)
    with pytest.raises(CoachConfigError, match=r"\[reviewer\]"):
        load_config(p)


def test_missing_required_field_rejected(tmp_path: Path) -> None:
    bad = _valid_toml().replace('deployment   = "<PLACEHOLDER_X>"', "", 1)
    p = tmp_path / "coach.toml"
    p.write_text(bad)
    with pytest.raises(CoachConfigError, match="missing required fields"):
        load_config(p)


def test_unknown_auth_mode_rejected(tmp_path: Path) -> None:
    bad = _valid_toml().replace('mode = "managed-identity"', 'mode = "shared-key"')
    p = tmp_path / "coach.toml"
    p.write_text(bad)
    with pytest.raises(CoachConfigError, match="unknown mode"):
        load_config(p)


def test_canonical_config_file_loads(tmp_path: Path, monkeypatch) -> None:
    """The repo-shipped config/coach.toml must parse without errors and
    reflect the current real deployments (no placeholders)."""
    monkeypatch.delenv(PATH_ENV, raising=False)
    cfg = load_config()  # uses repo root resolver
    assert cfg.auth_mode == "managed-identity"

    # Generator + Reviewer share the gpt-5.4 deployment on the Responses API
    # endpoint until the Claude Opus reviewer lands.
    for spec in (cfg.generator, cfg.reviewer):
        assert spec.deployment == "gpt-5.4"
        assert spec.api_kind == "responses"
        assert spec.endpoint == "https://word-learner-llm.cognitiveservices.azure.com"
        assert not spec.is_placeholder()
    # Temperature differentiation between generator (creative) and reviewer
    # (deterministic) survives even when they share a model.
    assert cfg.generator.temperature == 0.4
    assert cfg.reviewer.temperature == 0.0

    # Commentary on gpt-4.1 via chat/completions.
    assert cfg.commentary.deployment == "gpt-4.1"
    assert cfg.commentary.api_kind == "chat-completions"
    assert cfg.commentary.endpoint == "https://word-learner-llm.cognitiveservices.azure.com"
    assert not cfg.commentary.is_placeholder()


def test_endpoint_must_be_http_url(tmp_path: Path) -> None:
    bad = _valid_toml().replace(
        'endpoint     = "https://example.openai.azure.com"',
        'endpoint     = "not-a-url"',
        1,
    )
    p = tmp_path / "coach.toml"
    p.write_text(bad)
    with pytest.raises(CoachConfigError, match="endpoint .* must start with"):
        load_config(p)


def test_api_kind_defaults_to_chat_completions(tmp_path: Path) -> None:
    """A spec without an explicit api_kind defaults to chat-completions
    (back-compat for older configs)."""
    p = tmp_path / "coach.toml"
    p.write_text(_valid_toml())  # _valid_toml doesn't set api_kind
    cfg = load_config(p)
    for spec in (cfg.generator, cfg.reviewer, cfg.commentary):
        assert spec.api_kind == "chat-completions"


def test_unknown_api_kind_rejected(tmp_path: Path) -> None:
    bad = _valid_toml().replace(
        "timeout_s    = 120",
        "timeout_s    = 120\napi_kind     = \"streaming\"",
        1,
    )
    p = tmp_path / "coach.toml"
    p.write_text(bad)
    with pytest.raises(CoachConfigError, match="unknown api_kind"):
        load_config(p)


def test_api_kind_responses_round_trips(tmp_path: Path) -> None:
    toml = _valid_toml().replace(
        "timeout_s    = 120",
        "timeout_s    = 120\napi_kind     = \"responses\"",
        1,
    )
    p = tmp_path / "coach.toml"
    p.write_text(toml)
    cfg = load_config(p)
    assert cfg.generator.api_kind == "responses"
    assert cfg.reviewer.api_kind == "chat-completions"  # only generator overridden
