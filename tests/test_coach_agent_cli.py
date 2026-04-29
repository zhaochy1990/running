from __future__ import annotations

import json
import os

from click.testing import CliRunner

from stride_core import db as core_db
from stride_server.coach_agent.cli import cli


def _clear_model_env(monkeypatch) -> None:
    for key in (
        "COROS_PROFILE",
        "STRIDE_COACH_CONFIG",
        "STRIDE_COACH_LLM_PROVIDER",
        "STRIDE_COACH_AZURE_OPENAI_ENDPOINT",
        "STRIDE_COACH_AZURE_OPENAI_RESPONSES_URL",
        "STRIDE_COACH_AZURE_OPENAI_DEPLOYMENT",
        "STRIDE_COACH_AZURE_OPENAI_API_VERSION",
        "STRIDE_COACH_AZURE_OPENAI_API_KIND",
        "STRIDE_COACH_AZURE_OPENAI_API_KEY",
        "STRIDE_COACH_AUTH_MODE",
        "STRIDE_COACH_AZURE_TENANT_ID",
        "STRIDE_COACH_TEMPERATURE",
        "STRIDE_COACH_MAX_TOKENS",
        "STRIDE_COACH_TIMEOUT_SECONDS",
        "AZURE_OPENAI_ENDPOINT",
        "AZURE_OPENAI_DEPLOYMENT",
        "AZURE_OPENAI_API_VERSION",
        "AZURE_OPENAI_API_KEY",
    ):
        monkeypatch.delenv(key, raising=False)


def _write_config(path, deployment: str = "configured-deployment") -> None:
    path.write_text(
        json.dumps(
            {
                "azure_openai": {
                    "responses_url": (
                        "https://config.example.com/openai/responses"
                        "?api-version=2025-04-01-preview"
                    ),
                    "deployment": deployment,
                    "auth": "credential",
                    "temperature": 0.25,
                }
            }
        ),
        encoding="utf-8",
    )


def test_config_command_discovers_profile_config(tmp_path, monkeypatch):
    _clear_model_env(monkeypatch)
    monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)
    user_id = "f10bc353-01ab-4db1-af9f-d9305ea9a532"
    (tmp_path / ".slug_aliases.json").write_text(
        json.dumps({"runner": user_id}),
        encoding="utf-8",
    )
    user_dir = tmp_path / user_id
    user_dir.mkdir()
    config_path = user_dir / "coach.json"
    _write_config(config_path)

    result = CliRunner().invoke(cli, ["-P", "runner", "config"])

    assert result.exit_code == 0, result.output
    assert "configured-deployment" in result.output
    assert "credential" in result.output
    assert os.environ["STRIDE_COACH_AZURE_OPENAI_DEPLOYMENT"] == "configured-deployment"


def test_cli_options_override_config_file(tmp_path, monkeypatch):
    _clear_model_env(monkeypatch)
    monkeypatch.setattr(core_db, "USER_DATA_DIR", tmp_path)
    config_path = tmp_path / "coach.json"
    _write_config(config_path, deployment="from-config")

    result = CliRunner().invoke(
        cli,
        [
            "--config",
            str(config_path),
            "--deployment",
            "from-cli",
            "--temperature",
            "0.1",
            "config",
        ],
    )

    assert result.exit_code == 0, result.output
    assert "from-cli" in result.output
    assert "from-config" not in result.output
    assert "0.1" in result.output
