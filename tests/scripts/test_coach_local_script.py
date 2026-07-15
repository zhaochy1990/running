"""Contract tests for the local Coach workflow wrapper."""

from __future__ import annotations

import os
import signal
import socket
import stat
import subprocess
import sys
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


def test_script_header_documents_quickstart_and_persistent_credentials() -> None:
    header = SCRIPT.read_text(encoding="utf-8").split("set -Eeuo pipefail", 1)[0]

    assert "首次使用：只需授权一次" in header
    assert 'scripts/coach-local.sh start' in header
    assert 'scripts/coach-local.sh coach' in header
    assert 'scripts/coach-local.sh stop' in header
    assert "~/.local/share/stride/copilot-proxy/" in header
    assert "只有 `reset` 会删除" in header
    assert "copilot" not in SCRIPT.name


def test_help_exposes_coach_workflow(tmp_path: Path) -> None:
    env = os.environ.copy()
    env["HOME"] = str(tmp_path / "home")

    result = _run("help", env=env)

    assert result.returncode == 0
    assert "smoke [model]" in result.stdout
    assert "coach [message]" in result.stdout
    assert "smoke [model]" in result.stdout


def test_coach_command_loads_both_config_layers() -> None:
    source = SCRIPT.read_text(encoding="utf-8")

    assert "cmd_coach" in source
    assert 'STRIDE_COACH_CONFIG_PATH="$REPO_ROOT/config/coach.copilot.toml"' in source
    assert "server.coach-cli.toml" in source
    assert "STRIDE_CONFIG_FILES" in source
    assert "coros_sync" in source


def test_status_reports_missing_persistent_credentials(tmp_path: Path) -> None:
    env = os.environ.copy()
    env["HOME"] = str(tmp_path / "home")
    env["COPILOT_PROXY_STATE_DIR"] = str(tmp_path / "state")
    env["COPILOT_PROXY_CACHE_DIR"] = str(tmp_path / "cache")
    env["COPILOT_PROXY_PORT"] = _free_port()

    result = _run("status", env=env)

    assert result.returncode == 1
    assert "stopped  auth=missing" in result.stdout
    assert "github_token" not in result.stdout


def test_auth_is_persistent_and_second_run_skips_device_flow(tmp_path: Path) -> None:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_npx = fake_bin / "npx"
    fake_npx.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        'mkdir -p "$HOME/.local/share/copilot-proxy-api"\n'
        'printf fake-token > "$HOME/.local/share/copilot-proxy-api/github_token"\n'
        'printf called >> "$FAKE_NPX_CALLS"\n',
        encoding="utf-8",
    )
    fake_npx.chmod(0o755)

    state_dir = tmp_path / "state"
    calls_file = tmp_path / "calls"
    env = os.environ.copy()
    env["PATH"] = f"{fake_bin}:{env['PATH']}"
    env["HOME"] = str(tmp_path / "home")
    env["COPILOT_PROXY_STATE_DIR"] = str(state_dir)
    env["COPILOT_PROXY_CACHE_DIR"] = str(tmp_path / "cache")
    env["FAKE_NPX_CALLS"] = str(calls_file)

    first = _run("auth", env=env)
    second = _run("auth", env=env)

    credential = state_dir / "home" / ".local/share/copilot-proxy-api/github_token"
    assert first.returncode == 0, first.stderr
    assert second.returncode == 0, second.stderr
    assert credential.read_text(encoding="utf-8") == "fake-token"
    assert stat.S_IMODE(credential.stat().st_mode) == 0o600
    assert calls_file.read_text(encoding="utf-8") == "called"
    assert "already exist" in second.stdout
    assert "fake-token" not in first.stdout + first.stderr + second.stdout + second.stderr


def test_force_auth_restarts_a_running_managed_proxy() -> None:
    source = SCRIPT.read_text(encoding="utf-8")
    auth_body = source.split("cmd_auth() {", 1)[1].split("ensure_api_key() {", 1)[0]

    assert "process_group_alive" in auth_body
    assert "cmd_stop" in auth_body
    assert "cmd_start" in auth_body
    assert "refreshed credentials" in auth_body


def test_smoke_401_has_actionable_reauth_message() -> None:
    source = SCRIPT.read_text(encoding="utf-8")
    smoke_body = source.split("cmd_smoke() {", 1)[1].split("main_checkout_root() {", 1)[0]

    assert '[[ "$status" == "401" ]]' in smoke_body
    assert "auth --force" in smoke_body
    assert "stop and restart" in smoke_body


def test_stop_refuses_to_signal_reused_process_group(tmp_path: Path) -> None:
    process = subprocess.Popen(
        ["sleep", "30"],
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        state_dir = tmp_path / "state"
        state_dir.mkdir()
        (state_dir / "proxy.pgid").write_text(f"{process.pid}\n", encoding="utf-8")
        (state_dir / "proxy.identity").write_text(
            f"nonce|{'0' * 64}\n", encoding="utf-8"
        )
        env = os.environ.copy()
        env["COPILOT_PROXY_STATE_DIR"] = str(state_dir)
        env["COPILOT_PROXY_CACHE_DIR"] = str(tmp_path / "cache")
        env["COPILOT_PROXY_PORT"] = _free_port()

        result = _run("stop", env=env)

        assert result.returncode == 0, result.stderr
        assert "Refusing to signal stale or unverified process-group" in result.stdout
        assert process.poll() is None
        assert not (state_dir / "proxy.pgid").exists()
        assert not (state_dir / "proxy.identity").exists()
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=5)


def test_stop_signals_only_matching_process_identity(tmp_path: Path) -> None:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    proxy_name = fake_bin / "copilot-proxy-api@0.10.22"
    # Keep the proxy path and arguments visible in ``ps`` on every platform.
    # Invoke the current interpreter directly so Linux does not have an
    # intermediate shebang process that can race the identity snapshot.
    proxy_name.write_text(
        "import time\ntime.sleep(30)\n",
        encoding="utf-8",
    )
    process = subprocess.Popen(
        [
            sys.executable,
            str(proxy_name),
            "start",
            "--port",
            "45998",
            "--api-key",
            "fake",
            "30",
        ],
        start_new_session=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        state_dir = tmp_path / "state"
        state_dir.mkdir()
        (state_dir / "proxy.pgid").write_text(f"{process.pid}\n", encoding="utf-8")
        env = os.environ.copy()
        env["COPILOT_PROXY_STATE_DIR"] = str(state_dir)
        env["COPILOT_PROXY_CACHE_DIR"] = str(tmp_path / "cache")
        env["COPILOT_PROXY_PORT"] = "45998"
        started = subprocess.run(
            ["ps", "-p", str(process.pid), "-o", "lstart="],
            text=True, capture_output=True, check=True,
        ).stdout.strip()
        (state_dir / "proxy.identity").write_text(f"{started}\n", encoding="utf-8")

        result = _run("stop", env=env)

        assert result.returncode == 0, result.stderr
        process.wait(timeout=5)
        assert "Copilot proxy stopped" in result.stdout
        assert not (state_dir / "proxy.pgid").exists()
        assert not (state_dir / "proxy.identity").exists()
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)


def test_stop_keeps_credentials_and_reset_deletes_them(tmp_path: Path) -> None:
    state_dir = tmp_path / "state"
    credential = state_dir / "home" / ".local/share/copilot-proxy-api/github_token"
    credential.parent.mkdir(parents=True)
    credential.write_text("fake-token", encoding="utf-8")
    credential.chmod(0o600)

    env = os.environ.copy()
    env["HOME"] = str(tmp_path / "home")
    env["COPILOT_PROXY_STATE_DIR"] = str(state_dir)
    env["COPILOT_PROXY_CACHE_DIR"] = str(tmp_path / "cache")

    stopped = _run("stop", env=env)
    assert stopped.returncode == 0, stopped.stderr
    assert credential.read_text(encoding="utf-8") == "fake-token"
    assert "Credentials remain saved" in stopped.stdout

    reset = _run("reset", env=env)
    assert reset.returncode == 0, reset.stderr
    assert not state_dir.exists()
    assert "fake-token" not in reset.stdout + reset.stderr
