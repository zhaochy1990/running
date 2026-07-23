"""Contract tests for the local Coach workflow wrapper (Agent Maestro)."""

from __future__ import annotations

import os
import socket
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "coach-local.sh"


def _free_port() -> str:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return str(sock.getsockname()[1])


def _run(*args: str, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(SCRIPT), *args],
        cwd=REPO_ROOT,
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def test_shell_syntax_is_valid() -> None:
    result = subprocess.run(
        ["bash", "-n", str(SCRIPT)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_script_header_documents_agent_maestro_only() -> None:
    header = SCRIPT.read_text(encoding="utf-8").split("set -Eeuo pipefail", 1)[0]

    assert "Agent Maestro" in header
    assert "scripts/coach-local.sh coach" in header
    assert "http://127.0.0.1:23333/api/openai/v1" in header
    # The Copilot proxy path is fully removed from the local workflow.
    assert "copilot-proxy" not in header
    assert "COPILOT_PROXY" not in header
    assert "copilot" not in SCRIPT.name


def test_help_exposes_coach_workflow(tmp_path: Path) -> None:
    env = os.environ.copy()
    env["HOME"] = str(tmp_path / "home")

    result = _run("help", env=env)

    assert result.returncode == 0
    assert "smoke [model]" in result.stdout
    assert "eval-resolver [id]" in result.stdout
    assert "coach [message]" in result.stdout
    # The proxy lifecycle commands no longer exist.
    assert "auth" not in result.stdout
    assert "start" not in result.stdout
    assert "stop" not in result.stdout
    assert "reset" not in result.stdout


def test_no_copilot_proxy_machinery_remains() -> None:
    source = SCRIPT.read_text(encoding="utf-8")

    for token in (
        "COPILOT_PROXY",
        "copilot-proxy-api",
        "copilot_proxy_api_key",
        "cmd_auth",
        "cmd_start",
        "cmd_stop",
        "cmd_reset",
        "cmd_logs",
        "cmd_status",
        "PROXY_VERSION",
        "npx",
    ):
        assert token not in source, f"unexpected proxy leftover: {token}"


def test_coach_command_uses_agent_maestro() -> None:
    source = SCRIPT.read_text(encoding="utf-8")
    body = source.split("cmd_coach() {", 1)[1].split("cmd_eval_resolver() {", 1)[0]

    assert 'STRIDE_COACH_CONFIG_PATH="$REPO_ROOT/config/coach.copilot.toml"' in body
    assert 'agent_api_key="$(agent_maestro_api_key)"' in body
    assert 'AGENT_MAESTRO_API_KEY="$agent_api_key"' in body
    assert "COPILOT_PROXY_API_KEY" not in body
    assert "server.coach-cli.toml" in body
    assert "STRIDE_CONFIG_FILES" in body
    assert "coros_sync" in body


def test_eval_resolver_uses_agent_maestro_without_sync() -> None:
    source = SCRIPT.read_text(encoding="utf-8")
    body = source.split("cmd_eval_resolver() {", 1)[1].split("command_name=", 1)[0]

    assert "scripts.eval_resolver" in body
    assert 'STRIDE_COACH_CONFIG_PATH="$REPO_ROOT/config/coach.copilot.toml"' in body
    assert 'agent_api_key="$(agent_maestro_api_key)"' in body
    assert 'AGENT_MAESTRO_API_KEY="$agent_api_key"' in body
    assert "COPILOT_PROXY_API_KEY" not in body
    assert "coros_sync" not in body


def test_smoke_targets_agent_maestro_responses_endpoint() -> None:
    source = SCRIPT.read_text(encoding="utf-8")
    smoke_body = source.split("cmd_smoke() {", 1)[1].split("main_checkout_root() {", 1)[0]

    assert '"$base_url/responses"' in smoke_body
    assert "agent_maestro_api_key" in smoke_body
    assert "HELLO_WORLD_OK" in smoke_body
    assert '[[ "$status" == "401" ]]' in smoke_body


def test_unknown_command_fails_with_usage(tmp_path: Path) -> None:
    env = os.environ.copy()
    env["HOME"] = str(tmp_path / "home")

    result = _run("start", env=env)

    assert result.returncode != 0
    assert "unknown command: start" in result.stderr
