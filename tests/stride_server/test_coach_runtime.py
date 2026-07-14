from __future__ import annotations

from pathlib import Path

from coach.runtime.config import PATH_ENV


def _coach_toml_with_commentary_api_key() -> str:
    return """
[generator]
provider     = "azure-openai"
model        = "gpt-5.4"
deployment   = "gpt-5.4"
endpoint     = "https://example.openai.azure.com"
api_version  = "2025-04-01-preview"
api_kind     = "responses"
max_tokens   = 4096
timeout_s    = 120

[reviewer]
provider     = "azure-openai"
model        = "gpt-5.4"
deployment   = "gpt-5.4"
endpoint     = "https://example.openai.azure.com"
api_version  = "2025-04-01-preview"
api_kind     = "responses"
max_tokens   = 4096
timeout_s    = 120

[commentary]
provider     = "azure-openai"
model        = "gpt-4.1"
deployment   = "gpt-4.1"
endpoint     = "https://example.openai.azure.com"
api_version  = "2025-01-01-preview"
api_kind     = "chat-completions"
api_key_env  = "AZURE_OPENAI_API_KEY"
temperature  = 0.6
max_tokens   = 2048
timeout_s    = 90

[auth]
mode = "managed-identity"
"""


def _coach_toml_with_deepseek_generator() -> str:
    return """
[generator]
provider     = "openai-compatible"
model        = "deepseek-v4-flash"
deployment   = "deepseek-v4-flash"
endpoint     = "https://api.deepseek.com"
api_key_env  = "DEEPSEEK_API_KEY"
auth         = "api-key"
api_kind     = "chat-completions"
max_tokens   = 4096
timeout_s    = 120

[generator.extra]
thinking = { type = "enabled" }

[reviewer]
provider     = "azure-openai"
model        = "gpt-5.4"
deployment   = "gpt-5.4"
endpoint     = "https://example.openai.azure.com"
api_version  = "2025-04-01-preview"
api_kind     = "responses"
max_tokens   = 4096
timeout_s    = 120

[commentary]
provider     = "azure-openai"
model        = "gpt-4.1"
deployment   = "gpt-4.1"
endpoint     = "https://example.openai.azure.com"
api_version  = "2025-01-01-preview"
api_kind     = "chat-completions"
api_key_env  = "AZURE_OPENAI_API_KEY"
temperature  = 0.6
max_tokens   = 2048
timeout_s    = 90

[auth]
mode = "managed-identity"
"""


def test_commentary_llm_uses_api_key_without_building_azure_credentials(
    tmp_path: Path,
    monkeypatch,
) -> None:
    cfg_path = tmp_path / "coach.toml"
    cfg_path.write_text(_coach_toml_with_commentary_api_key(), encoding="utf-8")
    monkeypatch.setenv(PATH_ENV, str(cfg_path))
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "sk-prod-commentary")

    from stride_server import coach_runtime
    import coach.runtime.llm_factory as llm_factory

    coach_runtime.reset_for_tests()

    def fail_credentials():
        raise AssertionError("commentary API-key path must not build Azure credentials")

    captured: dict[str, object] = {}

    def fake_build_commentary_llm(*, credentials=None, api_key=None, config=None):
        captured["credentials"] = credentials
        captured["api_key"] = api_key
        return "commentary-llm"

    monkeypatch.setattr(coach_runtime, "_build_azure_credentials", fail_credentials)
    monkeypatch.setattr(llm_factory, "build_commentary_llm", fake_build_commentary_llm)

    try:
        assert coach_runtime.get_commentary_llm() == "commentary-llm"
    finally:
        coach_runtime.reset_for_tests()

    assert captured == {"credentials": None, "api_key": "sk-prod-commentary"}


def test_generator_openai_compatible_uses_api_key_without_azure_credentials(
    tmp_path: Path,
    monkeypatch,
) -> None:
    cfg_path = tmp_path / "coach.toml"
    cfg_path.write_text(_coach_toml_with_deepseek_generator(), encoding="utf-8")
    monkeypatch.setenv(PATH_ENV, str(cfg_path))
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-deepseek")

    from stride_server import coach_runtime
    import coach.runtime.llm_factory as llm_factory

    coach_runtime.reset_for_tests()

    def fail_credentials():
        raise AssertionError("DeepSeek API-key path must not build Azure credentials")

    captured: dict[str, object] = {}

    def fake_build_generator_llm(*, credentials=None, api_key=None, config=None):
        captured["credentials"] = credentials
        captured["api_key"] = api_key
        captured["provider"] = config.generator.provider
        return "generator-llm"

    monkeypatch.setattr(coach_runtime, "_build_azure_credentials", fail_credentials)
    monkeypatch.setattr(llm_factory, "build_generator_llm", fake_build_generator_llm)

    try:
        assert coach_runtime.get_generator_llm() == "generator-llm"
    finally:
        coach_runtime.reset_for_tests()

    assert captured == {
        "credentials": None,
        "api_key": "sk-deepseek",
        "provider": "openai-compatible",
    }


def test_status_insight_llm_uses_its_configured_role(
    tmp_path: Path, monkeypatch
) -> None:
    config_text = _coach_toml_with_deepseek_generator() + """

[status_insight]
provider     = "openai-compatible"
model        = "fast-status"
deployment   = "fast-status"
endpoint     = "http://127.0.0.1:44141/v1"
api_key_env  = "STATUS_KEY"
auth         = "api-key"
api_kind     = "responses"
max_tokens   = 2048
timeout_s    = 90
"""
    cfg_path = tmp_path / "coach.toml"
    cfg_path.write_text(config_text, encoding="utf-8")
    monkeypatch.setenv(PATH_ENV, str(cfg_path))
    monkeypatch.setenv("STATUS_KEY", "local-key")

    from stride_server import coach_runtime
    import coach.runtime.llm_factory as llm_factory

    coach_runtime.reset_for_tests()
    captured: dict[str, object] = {}

    def fake_build_status(*, credentials=None, api_key=None, config=None):
        captured["credentials"] = credentials
        captured["api_key"] = api_key
        captured["model"] = config.for_role("status_insight").model
        return "status-llm"

    monkeypatch.setattr(llm_factory, "build_status_insight_llm", fake_build_status)
    try:
        assert coach_runtime.get_status_insight_llm() == "status-llm"
    finally:
        coach_runtime.reset_for_tests()

    assert captured == {
        "credentials": None,
        "api_key": "local-key",
        "model": "fast-status",
    }
