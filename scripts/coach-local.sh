#!/usr/bin/env bash

# =============================================================================
# Local Coach + Agent Maestro（默认）/ GitHub Copilot Proxy（可选）
# =============================================================================
#
# 用途
# ----
# `coach` 和 `eval-resolver` 默认通过本机 Agent Maestro 的 OpenAI-compatible
# Responses API 使用 GPT-5.6。`auth` / `start` / `smoke` / `stop` 则管理可选
# Copilot proxy，供需要绕过 Agent Maestro 直接测试 Copilot 时使用。
# 这些命令仅用于本地开发测试，不用于生产环境或共享代理服务。
#
# 前置依赖
# --------
# - 默认 Coach：Agent Maestro 已监听 http://127.0.0.1:23333，且已安装 openssl
# - 可选 Copilot proxy：Node.js + npm/npx、curl、有效 Copilot 订阅
#
# 默认 Agent Maestro 流程
# -----------------------
#   scripts/coach-local.sh coach
#   scripts/coach-local.sh eval-resolver
#
# 可选 Copilot proxy：首次授权
# ---------------------------
#   scripts/coach-local.sh auth
#
# 按终端提示到 https://github.com/login/device 完成 Device Flow。授权成功后，
# credential 会持久保存在用户目录；正常 start/stop 不会再次要求授权。
#
# 其他常用命令
# ------------
#   scripts/coach-local.sh start                 # 启动可选 Copilot proxy
#   scripts/coach-local.sh smoke                 # 验证 Copilot Responses API
#   scripts/coach-local.sh coach "我当前的总体训练计划是什么？"
#   scripts/coach-local.sh status                # 查看 Copilot proxy 状态
#   scripts/coach-local.sh logs                  # 查看最近 50 行代理日志
#   scripts/coach-local.sh stop                  # 停止代理但保留凭据
#   scripts/coach-local.sh auth --force          # 强制重新授权
#   scripts/coach-local.sh reset                 # 停止并删除全部本地状态
#
# 本地状态与安全边界
# ----------------
# Agent Maestro endpoint：http://127.0.0.1:23333/api/openai/v1
# Copilot 持久目录：~/.local/share/stride/copilot-proxy/
# Copilot npm cache：~/.cache/stride/copilot-proxy-npm/
# Copilot endpoint：http://127.0.0.1:44141/v1
#
# Copilot 状态目录权限为 0700，OAuth credential 和本地 API key 权限为 0600。
# 凭据、API key 和日志均不写入仓库。Copilot proxy 会监听所有网卡，因此脚本
# 始终启用随机 API key；不要把端口暴露到公网、局域网共享或反向代理。`stop`
# 只停止进程并保留凭据；只有 `reset` 会删除 credential、API key、日志和 cache。
#
# 可选环境变量
# ------------
# AGENT_MAESTRO_API_KEY=...             覆盖 Agent Maestro bearer 占位值
# COPILOT_PROXY_API_KEY=...              覆盖已保存的 Copilot proxy API key
# COPILOT_PROXY_PORT=44141               覆盖本地 Copilot proxy 端口
# COPILOT_PROXY_STATE_DIR=...            覆盖 Copilot 持久状态目录
# COPILOT_PROXY_CACHE_DIR=...            覆盖 Copilot npm cache 目录
#
# 故障排查
# --------
# - `coach` 连接失败：确认 Agent Maestro 正在 127.0.0.1:23333 监听。
# - `start` 报 no saved credentials：先运行 `auth`。
# - `start` 报端口被占用：停止占用进程，或设置 COPILOT_PROXY_PORT。
# - Copilot 启动失败时运行 `logs`；脚本不会开启 verbose 请求日志。
# - 完整命令速查：scripts/coach-local.sh help
# =============================================================================

set -Eeuo pipefail
umask 077

PROXY_VERSION="0.10.22"
PROXY_PORT="${COPILOT_PROXY_PORT:-44141}"
PROXY_BASE_URL="http://127.0.0.1:$PROXY_PORT/v1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

STATE_DIR="${COPILOT_PROXY_STATE_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/stride/copilot-proxy}"
CACHE_DIR="${COPILOT_PROXY_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/stride/copilot-proxy-npm}"
PROXY_HOME="$STATE_DIR/home"
AUTH_FILE="$PROXY_HOME/.local/share/copilot-proxy-api/github_token"
KEY_FILE="$STATE_DIR/api-key"
PID_FILE="$STATE_DIR/proxy.pgid"
IDENTITY_FILE="$STATE_DIR/proxy.identity"
LOG_FILE="$STATE_DIR/proxy.log"

usage() {
  cat <<'EOF'
Usage: scripts/coach-local.sh <command>

Commands:
  auth [--force]   One-time GitHub Device Flow; credentials persist locally
  start            Start the authenticated local proxy
  status           Show proxy and credential status
  smoke [model]     Verify /v1/responses (default: gpt-5.6-sol)
  eval-resolver [id]  Run real-LLM Resolver fixtures (optional fixture id)
  coach [message]   Start Coach CLI; no message opens the interactive REPL
  logs             Show the last 50 non-verbose proxy log lines
  stop             Stop the proxy but keep credentials and API key
  reset            Stop the proxy and delete all persistent local state
  help             Show this help

Optional environment variables:
  AGENT_MAESTRO_API_KEY     Override the ephemeral Agent Maestro bearer value
  COPILOT_PROXY_API_KEY     Override the saved Copilot proxy API key
  COPILOT_PROXY_STATE_DIR   Persistent credential/state directory
  COPILOT_PROXY_CACHE_DIR   npm cache directory
  COPILOT_PROXY_PORT        Local port (default: 44141)
  STRIDE_COACH_PROFILE      Coach/COROS profile (default: zhaochaoyi)
  STRIDE_COACH_DATA_DIR     Local data directory (default: main checkout/data)
  STRIDE_COACH_PYTHON       Python executable (default: main checkout .venv)
  STRIDE_COACH_SKIP_SYNC=1  Skip the pre-Coach COROS sync
EOF
}

fail() {
  echo "error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

ensure_dirs() {
  mkdir -p "$STATE_DIR" "$PROXY_HOME" "$CACHE_DIR"
  chmod 700 "$STATE_DIR" "$PROXY_HOME" "$CACHE_DIR"
}

read_pgid() {
  if [[ -s "$PID_FILE" ]]; then
    local pgid
    pgid="$(tr -dc '0-9' <"$PID_FILE")"
    [[ -n "$pgid" ]] && echo "$pgid"
  fi
}

process_group_alive() {
  local pgid="${1:-}"
  [[ -n "$pgid" ]] || return 1
  node -e 'try { process.kill(-Number(process.argv[1]), 0) } catch { process.exit(1) }' \
    "$pgid" >/dev/null 2>&1
}

cleanup_process_state() {
  rm -f "$PID_FILE" "$IDENTITY_FILE"
}

process_start_identity() {
  local pgid="${1:-}"
  [[ -n "$pgid" ]] || return 1
  LC_ALL=C ps -p "$pgid" -o lstart= 2>/dev/null \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

proxy_process_matches() {
  local pgid="${1:-}" command
  [[ -n "$pgid" ]] || return 1
  # procps truncates ``command`` to the terminal width unless wide output is
  # requested; the port and API-key flags can otherwise disappear on Linux.
  command="$(ps -ww -p "$pgid" -o command= 2>/dev/null || true)"
  [[ "$command" == *"copilot-proxy-api@$PROXY_VERSION"* \
    && "$command" == *" start "* \
    && "$command" == *"--port $PROXY_PORT"* \
    && "$command" == *"--api-key"* ]]
}

adopt_process_identity() {
  local pgid="${1:-}" started
  [[ -n "$pgid" && ! -e "$IDENTITY_FILE" ]] || return 1
  proxy_process_matches "$pgid" || return 1
  started="$(process_start_identity "$pgid")"
  [[ -n "$started" ]] || return 1
  printf '%s\n' "$started" >"$IDENTITY_FILE"
  chmod 600 "$IDENTITY_FILE"
}

process_identity_matches() {
  local pgid="${1:-}" identity current
  [[ -n "$pgid" && -s "$IDENTITY_FILE" ]] || return 1
  identity="$(<"$IDENTITY_FILE")"
  current="$(process_start_identity "$pgid")"
  [[ -n "$current" && "$current" == "$identity" ]] \
    && proxy_process_matches "$pgid"
}

managed_process_group_alive() {
  local pgid="${1:-}"
  process_group_alive "$pgid" || return 1
  if [[ ! -e "$IDENTITY_FILE" ]]; then
    adopt_process_identity "$pgid" || return 1
  fi
  process_identity_matches "$pgid"
}

signal_process_group() {
  local pgid="$1" signal="$2"
  node -e '
const pgid = Number(process.argv[1]);
const signal = process.argv[2];
try {
  process.kill(-pgid, signal);
} catch (error) {
  if (error.code !== "ESRCH") throw error;
}
' "$pgid" "$signal"
}

local_no_proxy() {
  local existing="${NO_PROXY:-${no_proxy:-}}"
  if [[ -n "$existing" ]]; then
    echo "localhost,127.0.0.1,::1,$existing"
  else
    echo "localhost,127.0.0.1,::1"
  fi
}

agent_maestro_api_key() {
  if [[ -n "${AGENT_MAESTRO_API_KEY:-}" ]]; then
    printf '%s' "$AGENT_MAESTRO_API_KEY"
  else
    require_command openssl
    openssl rand -hex 32
  fi
}

copilot_proxy_api_key() {
  local api_key="${COPILOT_PROXY_API_KEY:-}"
  if [[ -z "$api_key" && -s "$KEY_FILE" ]]; then
    api_key="$(<"$KEY_FILE")"
  fi
  printf '%s' "$api_key"
}

proxy_ready() {
  [[ -s "$KEY_FILE" ]] || return 1
  curl --noproxy '*' -fsS --max-time 3 \
    -H "Authorization: Bearer $(<"$KEY_FILE")" \
    "$PROXY_BASE_URL/models" >/dev/null 2>&1
}

port_in_use() {
  node -e '
const net = require("node:net");
const socket = net.createConnection({ host: "127.0.0.1", port: Number(process.argv[1]) });
socket.setTimeout(500);
socket.once("connect", () => { socket.destroy(); process.exit(0); });
socket.once("timeout", () => { socket.destroy(); process.exit(1); });
socket.once("error", () => process.exit(1));
' "$PROXY_PORT" >/dev/null 2>&1
}

wait_until_ready() {
  local timeout="${COPILOT_PROXY_START_TIMEOUT:-90}"
  local attempts=$((timeout * 2))
  local i
  for ((i = 0; i < attempts; i++)); do
    proxy_ready && return 0
    sleep 0.5
  done
  return 1
}

cmd_auth() {
  ensure_dirs
  [[ "${1:-}" == "" || "${1:-}" == "--force" ]] || fail "auth accepts only --force"
  if [[ -s "$AUTH_FILE" && "${1:-}" != "--force" ]]; then
    chmod 600 "$AUTH_FILE"
    echo "GitHub Copilot credentials already exist. No authorization needed."
    echo "Stored at: $AUTH_FILE"
    return
  fi

  local restart_proxy=0 pgid
  pgid="$(read_pgid || true)"
  if managed_process_group_alive "$pgid"; then
    restart_proxy=1
    echo "Stopping the running proxy so refreshed credentials take effect..."
    cmd_stop
  fi

  require_command npx
  rm -f "$AUTH_FILE"
  echo "Starting GitHub Device Flow (one-time setup)..."
  HOME="$PROXY_HOME" \
    npm_config_cache="$CACHE_DIR" \
    npx -y "copilot-proxy-api@$PROXY_VERSION" auth
  [[ -s "$AUTH_FILE" ]] || fail "authorization finished without creating credentials"
  chmod 600 "$AUTH_FILE"
  echo "Authorization saved locally. Future starts will not ask again."
  if [[ $restart_proxy -eq 1 ]]; then
    echo "Restarting the proxy with the refreshed credentials..."
    cmd_start
  fi
}

ensure_api_key() {
  ensure_dirs
  if [[ ! -s "$KEY_FILE" ]]; then
    require_command openssl
    openssl rand -hex 32 >"$KEY_FILE"
  fi
  chmod 600 "$KEY_FILE"
}

cmd_start() {
  ensure_dirs
  require_command npx
  require_command curl
  [[ -s "$AUTH_FILE" ]] || fail "no saved credentials; run: $0 auth"
  chmod 600 "$AUTH_FILE"
  ensure_api_key

  if proxy_ready; then
    managed_process_group_alive "$(read_pgid || true)" >/dev/null 2>&1 || true
    echo "Copilot proxy is already running at $PROXY_BASE_URL"
    return
  fi
  if port_in_use; then
    fail "port $PROXY_PORT is already used by another process; stop it or set COPILOT_PROXY_PORT"
  fi

  local old_pgid
  old_pgid="$(read_pgid || true)"
  if managed_process_group_alive "$old_pgid"; then
    fail "proxy process exists but is not ready; run '$0 stop' and inspect '$LOG_FILE'"
  fi
  cleanup_process_state
  : >"$LOG_FILE"
  chmod 600 "$LOG_FILE"

  local npx_bin bypass
  npx_bin="$(command -v npx)"
  bypass="$(local_no_proxy)"
  COPILOT_LOCAL_API_KEY="$(<"$KEY_FILE")" \
  COPILOT_NPX_BIN="$npx_bin" \
  COPILOT_PROXY_PACKAGE="copilot-proxy-api@$PROXY_VERSION" \
  COPILOT_PROXY_HOME="$PROXY_HOME" \
  COPILOT_PROXY_CACHE="$CACHE_DIR" \
  COPILOT_PROXY_LOG="$LOG_FILE" \
  COPILOT_PROXY_PGID_FILE="$PID_FILE" \
  COPILOT_PROXY_PORT_VALUE="$PROXY_PORT" \
  COPILOT_NO_PROXY="$bypass" \
    node - <<'JS'
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const env = { ...process.env };
const apiKey = env.COPILOT_LOCAL_API_KEY;
delete env.COPILOT_LOCAL_API_KEY;
const command = env.COPILOT_NPX_BIN;
const args = [
  "-y",
  env.COPILOT_PROXY_PACKAGE,
  "start",
  "--port",
  env.COPILOT_PROXY_PORT_VALUE,
  "--api-key",
  apiKey,
];
env.HOME = env.COPILOT_PROXY_HOME;
env.npm_config_cache = env.COPILOT_PROXY_CACHE;
env.NO_PROXY = env.no_proxy = env.COPILOT_NO_PROXY;
const logPath = env.COPILOT_PROXY_LOG;
const pidPath = env.COPILOT_PROXY_PGID_FILE;
for (const key of Object.keys(env)) {
  if (key.startsWith("COPILOT_")) delete env[key];
}
const log = fs.openSync(logPath, "a", 0o600);
const child = spawn(command, args, {
  detached: true,
  env,
  stdio: ["ignore", log, log],
});
child.unref();
fs.closeSync(log);
fs.writeFileSync(pidPath, `${child.pid}\n`, { mode: 0o600 });
JS

  if ! wait_until_ready; then
    echo "Proxy did not become ready. Last log lines:" >&2
    tail -n 20 "$LOG_FILE" >&2 || true
    cmd_stop >/dev/null 2>&1 || true
    return 1
  fi
  adopt_process_identity "$(read_pgid || true)" \
    || fail "proxy became ready but its process identity could not be recorded"
  echo "Copilot proxy started: $PROXY_BASE_URL"
  echo "Credentials will persist after stop."
}

cmd_status() {
  local auth_status="missing"
  [[ -s "$AUTH_FILE" ]] && auth_status="saved"
  if proxy_ready; then
    echo "running  $PROXY_BASE_URL"
    echo "auth     $auth_status"
    echo "state    $STATE_DIR"
    return 0
  fi
  local pgid
  pgid="$(read_pgid || true)"
  if managed_process_group_alive "$pgid"; then
    echo "unhealthy/startup  process-group=$pgid"
    echo "auth               $auth_status"
    echo "log                $LOG_FILE"
    return 2
  fi
  if process_group_alive "$pgid"; then
    cleanup_process_state
    echo "stale-state  refused to manage reused process-group=$pgid"
  fi
  if port_in_use; then
    echo "occupied  port=$PROXY_PORT (not managed by this script)"
    echo "auth      $auth_status"
    return 2
  fi
  echo "stopped  auth=$auth_status"
  echo "state    $STATE_DIR"
  return 1
}

cmd_smoke() {
  local model="${1:-gpt-5.6-sol}"
  proxy_ready || fail "proxy is not running; run: $0 start"
  local payload result response status text
  payload="$(node -e 'process.stdout.write(JSON.stringify({model: process.argv[1], input: "Reply exactly: HELLO_WORLD_OK", max_output_tokens: 64}))' "$model")"
  if ! result="$(curl --noproxy '*' -sS -w $'\n%{http_code}' \
    "$PROXY_BASE_URL/responses" \
    -H "Authorization: Bearer $(<"$KEY_FILE")" \
    -H "Content-Type: application/json" \
    -d "$payload")"; then
    fail "could not reach the local proxy; check: $0 logs"
  fi
  status="${result##*$'\n'}"
  response="${result%$'\n'*}"
  if [[ "$status" == "401" ]]; then
    fail "Copilot upstream token is unauthorized. Run '$0 auth --force'; it will now stop and restart a running proxy automatically."
  fi
  if [[ "$status" != "200" ]]; then
    fail "Responses smoke failed with HTTP $status; check: $0 logs"
  fi
  text="$(printf '%s' "$response" | node -e '
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { raw += chunk; });
process.stdin.on("end", () => {
  const data = JSON.parse(raw);
  const text = (data.output || [])
    .filter(item => item.type === "message")
    .flatMap(item => item.content || [])
    .filter(item => item.type === "output_text")
    .map(item => item.text || "")
    .join("");
  process.stdout.write(text);
});
')"
  [[ "$text" == "HELLO_WORLD_OK" ]] || fail "unexpected Hello World response for $model"
  echo "HELLO_WORLD_OK model=$model endpoint=/v1/responses"
}

main_checkout_root() {
  local common_dir
  common_dir="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [[ -n "$common_dir" ]]; then
    dirname "$common_dir"
  else
    echo "$REPO_ROOT"
  fi
}

coach_python() {
  if [[ -n "${STRIDE_COACH_PYTHON:-}" ]]; then
    echo "$STRIDE_COACH_PYTHON"
    return
  fi
  local main_root="$1"
  if [[ -x "$main_root/.venv/bin/python" ]]; then
    echo "$main_root/.venv/bin/python"
  else
    command -v python3 || fail "Python 3 not found; set STRIDE_COACH_PYTHON"
  fi
}

cmd_coach() {
  local main_root data_dir python profile bypass config_files agent_api_key copilot_api_key
  main_root="$(main_checkout_root)"
  data_dir="${STRIDE_COACH_DATA_DIR:-$main_root/data}"
  python="$(coach_python "$main_root")"
  profile="${STRIDE_COACH_PROFILE:-zhaochaoyi}"
  bypass="$(local_no_proxy)"
  config_files="$REPO_ROOT/config/server.toml;$REPO_ROOT/config/server.local.toml;$REPO_ROOT/config/server.coach-cli.toml"
  agent_api_key="$(agent_maestro_api_key)"
  copilot_api_key="$(copilot_proxy_api_key)"

  [[ -x "$python" ]] || fail "Coach Python is not executable: $python"
  [[ -d "$data_dir" ]] || fail "Coach data directory not found: $data_dir"
  [[ -f "$REPO_ROOT/config/coach.copilot.toml" ]] || fail "missing Coach Copilot config"
  [[ -f "$REPO_ROOT/config/server.coach-cli.toml" ]] || fail "missing Coach CLI server overlay"

  if [[ "${STRIDE_COACH_SKIP_SYNC:-0}" != "1" ]]; then
    PYTHONIOENCODING=utf-8 PYTHONPATH="$main_root/src${PYTHONPATH:+:$PYTHONPATH}" \
      "$python" -m coros_sync -P "$profile" sync
  fi

  local args=(
    -m coach_cli.cli
    -P "$profile"
    --data-dir "$data_dir"
  )
  if [[ $# -gt 0 ]]; then
    args+=(--message "$*")
  fi

  AGENT_MAESTRO_API_KEY="$agent_api_key" \
  COPILOT_PROXY_API_KEY="$copilot_api_key" \
  STRIDE_COACH_CONFIG_PATH="$REPO_ROOT/config/coach.copilot.toml" \
  STRIDE_CONFIG_FILES="$config_files" \
  PYTHONPATH="$REPO_ROOT/src${PYTHONPATH:+:$PYTHONPATH}" \
  NO_PROXY="$bypass" no_proxy="$bypass" \
    "$python" "${args[@]}"
}

cmd_eval_resolver() {
  local main_root python bypass agent_api_key copilot_api_key
  main_root="$(main_checkout_root)"
  python="$(coach_python "$main_root")"
  bypass="$(local_no_proxy)"
  agent_api_key="$(agent_maestro_api_key)"
  copilot_api_key="$(copilot_proxy_api_key)"

  [[ -x "$python" ]] || fail "Coach Python is not executable: $python"
  [[ -f "$REPO_ROOT/config/coach.copilot.toml" ]] || fail "missing Coach Copilot config"

  local args=(-m scripts.eval_resolver)
  if [[ $# -gt 0 ]]; then
    args+=(--fixture "$1")
  fi

  AGENT_MAESTRO_API_KEY="$agent_api_key" \
  COPILOT_PROXY_API_KEY="$copilot_api_key" \
  STRIDE_COACH_CONFIG_PATH="$REPO_ROOT/config/coach.copilot.toml" \
  PYTHONPATH="$REPO_ROOT/src${PYTHONPATH:+:$PYTHONPATH}" \
  NO_PROXY="$bypass" no_proxy="$bypass" \
    "$python" "${args[@]}"
}

cmd_logs() {
  [[ -f "$LOG_FILE" ]] || fail "no proxy log exists yet"
  tail -n 50 "$LOG_FILE"
}

cmd_stop() {
  local pgid
  pgid="$(read_pgid || true)"
  if [[ -z "$pgid" ]] || ! process_group_alive "$pgid"; then
    cleanup_process_state
    echo "Copilot proxy is already stopped. Credentials remain saved."
    return
  fi
  if ! managed_process_group_alive "$pgid"; then
    cleanup_process_state
    echo "Refusing to signal stale or unverified process-group=$pgid. Removed stale state."
    return
  fi

  signal_process_group "$pgid" SIGTERM
  local i
  for ((i = 0; i < 50; i++)); do
    if ! process_group_alive "$pgid"; then
      cleanup_process_state
      echo "Copilot proxy stopped. Credentials remain saved for the next start."
      return
    fi
    if ! process_identity_matches "$pgid"; then
      cleanup_process_state
      echo "Copilot proxy stopped; refusing to signal a changed process identity. Credentials remain saved."
      return
    fi
    sleep 0.1
  done
  if process_identity_matches "$pgid"; then
    signal_process_group "$pgid" SIGKILL
  fi
  cleanup_process_state
  echo "Copilot proxy stopped. Credentials remain saved for the next start."
}

cmd_reset() {
  cmd_stop >/dev/null 2>&1 || true
  for path in "$STATE_DIR" "$CACHE_DIR"; do
    [[ -n "$path" && "$path" != "/" && "$path" != "$HOME" ]] \
      || fail "refusing to reset unsafe path: $path"
  done
  rm -rf "$STATE_DIR" "$CACHE_DIR"
  echo "Deleted saved Copilot credentials, API key, logs, and npm cache."
}

command_name="${1:-help}"
shift || true
case "$command_name" in
  auth) cmd_auth "$@" ;;
  start) [[ $# -eq 0 ]] || fail "start takes no arguments"; cmd_start ;;
  status) [[ $# -eq 0 ]] || fail "status takes no arguments"; cmd_status ;;
  smoke) [[ $# -le 1 ]] || fail "smoke accepts at most one model"; cmd_smoke "$@" ;;
  eval-resolver) [[ $# -le 1 ]] || fail "eval-resolver accepts at most one fixture id"; cmd_eval_resolver "$@" ;;
  coach) cmd_coach "$@" ;;
  logs) [[ $# -eq 0 ]] || fail "logs takes no arguments"; cmd_logs ;;
  stop) [[ $# -eq 0 ]] || fail "stop takes no arguments"; cmd_stop ;;
  reset) [[ $# -eq 0 ]] || fail "reset takes no arguments"; cmd_reset ;;
  help|-h|--help) usage ;;
  *) usage >&2; fail "unknown command: $command_name" ;;
esac
