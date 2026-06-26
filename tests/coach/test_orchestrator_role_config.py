"""S1a — orchestrator LLM role: explicit section + reviewer fallback."""

from __future__ import annotations

import textwrap
from pathlib import Path

from coach.runtime.config import load_config


_BASE = """
[generator]
provider = "azure-openai"
model = "gpt-5.5"
deployment = "gpt-5.5"
endpoint = "https://example.cognitiveservices.azure.com"
api_version = "2025-04-01-preview"
api_kind = "responses"
max_tokens = 4096
timeout_s = 120

[reviewer]
provider = "azure-openai"
model = "gpt-5.5"
deployment = "gpt-5.5"
endpoint = "https://example.cognitiveservices.azure.com"
api_version = "2025-04-01-preview"
api_kind = "responses"
max_tokens = 4096
timeout_s = 120

[commentary]
provider = "azure-openai"
model = "gpt-5.5"
deployment = "gpt-5.5"
endpoint = "https://example.cognitiveservices.azure.com"
api_version = "2025-04-01-preview"
api_kind = "responses"
max_tokens = 2048
timeout_s = 90

[auth]
mode = "managed-identity"
"""

_ORCHESTRATOR_SECTION = """
[orchestrator]
provider = "azure-openai"
model = "gpt-4.1-mini"
deployment = "gpt-4.1-mini"
endpoint = "https://example.cognitiveservices.azure.com"
api_version = "2025-04-01-preview"
api_kind = "chat-completions"
temperature = 0.0
max_tokens = 2048
timeout_s = 60
"""


def _write(tmp_path: Path, body: str) -> Path:
    p = tmp_path / "coach.toml"
    p.write_text(textwrap.dedent(body), encoding="utf-8")
    return p


def test_orchestrator_section_loaded(tmp_path: Path) -> None:
    cfg = load_config(_write(tmp_path, _BASE + _ORCHESTRATOR_SECTION))
    assert cfg.orchestrator is not None
    assert cfg.orchestrator.model == "gpt-4.1-mini"
    assert cfg.for_role("orchestrator").deployment == "gpt-4.1-mini"


def test_orchestrator_falls_back_to_reviewer_when_absent(tmp_path: Path) -> None:
    cfg = load_config(_write(tmp_path, _BASE))
    assert cfg.orchestrator is None
    # Fallback keeps existing configs working without an edit.
    assert cfg.for_role("orchestrator") is cfg.reviewer


def test_repo_local_config_has_cheap_orchestrator() -> None:
    """The checked-in dev config points orchestrator at a cheap, fast model."""
    repo_root = Path(__file__).resolve().parents[2]
    cfg = load_config(repo_root / "config" / "coach.local.toml")
    assert cfg.orchestrator is not None
    assert cfg.orchestrator.model == "gpt-4.1-mini"
