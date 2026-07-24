#!/usr/bin/env bash

# =============================================================================
# Local Coach via Agent Maestro
# =============================================================================
#
# 用途
# ----
# `coach`、`eval-resolver` 和 `smoke` 通过本机 Agent Maestro 的 OpenAI-compatible
# Responses API 使用 GPT-5.6：`gpt-5.6-luna` 处理编排和只读 status_insight，
# `gpt-5.6-sol` 处理计划生成和 reviewer。仅用于本地开发测试，不用于生产环境。
#
# 前置依赖
# --------
# - Agent Maestro 已在 VS Code 中启动并监听 http://127.0.0.1:23333
# - Python 3（默认用主 checkout 的 .venv）、curl、Node.js（smoke 解析响应用）、
#   openssl（生成临时 bearer；也可用 AGENT_MAESTRO_API_KEY 覆盖）
#
# 默认 Agent Maestro 流程
# -----------------------
#   scripts/coach-local.sh coach
#   scripts/coach-local.sh eval-resolver
#
# 其他常用命令
# ------------
#   scripts/coach-local.sh coach "我当前的总体训练计划是什么？"
#   scripts/coach-local.sh sync                  # 仅同步本地 COROS DB，不启动 Coach
#   scripts/coach-local.sh eval-resolver resolver-master-read
#   scripts/coach-local.sh smoke                 # 验证 Agent Maestro Responses API
#   scripts/coach-local.sh smoke gpt-5.6-luna
#   scripts/coach-local.sh help                  # 命令速查
#
# 安全边界
# --------
# Agent Maestro endpoint：http://127.0.0.1:23333/api/openai/v1
# Agent Maestro 由 VS Code 扩展自行管理，本脚本不启动 / 停止 / 授权任何进程，也
# 不持久化任何凭据。Agent Maestro 当前接受任意 bearer，但 Coach runtime 仍要求
# 该值非空，因此脚本默认生成一个临时随机值。prompt、response 和 token 均不写入
# 日志、回复或仓库文件。
#
# 可选环境变量
# ------------
# AGENT_MAESTRO_API_KEY=...    覆盖临时 Agent Maestro bearer 占位值
# AGENT_MAESTRO_BASE_URL=...   覆盖 Agent Maestro OpenAI-compatible base URL
# STRIDE_COACH_PROFILE=...     Coach/COROS profile（默认 zhaochaoyi）
# STRIDE_COACH_DATA_DIR=...    本地数据目录（默认主 checkout/data）
# STRIDE_COACH_PYTHON=...      Python 可执行文件（默认主 checkout .venv）
# STRIDE_COACH_SKIP_SYNC=1     跳过 coach 前的 COROS 同步
#
# 故障排查
# --------
# - `coach` / `smoke` 连接失败：确认 Agent Maestro 正在 127.0.0.1:23333 监听
#   （在 VS Code 中启动该扩展）。
# - `smoke` 返回非 200：确认所选模型在 VS Code Language Model 中可用。
# - 完整命令速查：scripts/coach-local.sh help
# =============================================================================

set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

AGENT_MAESTRO_BASE_URL="${AGENT_MAESTRO_BASE_URL:-http://127.0.0.1:23333/api/openai/v1}"

usage() {
  cat <<'EOF'
Usage: scripts/coach-local.sh <command>

Commands:
  smoke [model]       Verify Agent Maestro /responses (default: gpt-5.6-sol)
  eval-resolver [id]  Run real-LLM Resolver fixtures (optional fixture id)
  coach [message]     Start Coach CLI; no message opens the interactive REPL
  sync                Sync the local COROS DB without launching Coach
  help                Show this help

Optional environment variables:
  AGENT_MAESTRO_API_KEY     Override the ephemeral Agent Maestro bearer value
  AGENT_MAESTRO_BASE_URL    Agent Maestro OpenAI-compatible base URL
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

cmd_smoke() {
  local model="${1:-gpt-5.6-sol}"
  require_command curl
  require_command node
  local base_url api_key payload result response status text
  base_url="${AGENT_MAESTRO_BASE_URL%/}"
  api_key="$(agent_maestro_api_key)"
  payload="$(node -e 'process.stdout.write(JSON.stringify({model: process.argv[1], input: "Reply exactly: HELLO_WORLD_OK", max_output_tokens: 64}))' "$model")"
  if ! result="$(curl --noproxy '*' -sS -w $'\n%{http_code}' \
    "$base_url/responses" \
    -H "Authorization: Bearer $api_key" \
    -H "Content-Type: application/json" \
    -d "$payload")"; then
    fail "could not reach Agent Maestro at $base_url; start it in VS Code and check: $0 help"
  fi
  status="${result##*$'\n'}"
  response="${result%$'\n'*}"
  if [[ "$status" == "401" ]]; then
    fail "Agent Maestro rejected the bearer token (HTTP 401); check the VS Code extension."
  fi
  if [[ "$status" != "200" ]]; then
    fail "Responses smoke failed with HTTP $status; confirm '$model' is available in the VS Code Language Model."
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
  echo "HELLO_WORLD_OK model=$model endpoint=$base_url/responses"
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

run_coros_sync() {
  local main_root="$1" python="$2" profile="$3"
  PYTHONIOENCODING=utf-8 PYTHONPATH="$main_root/src${PYTHONPATH:+:$PYTHONPATH}" \
    "$python" -m coros_sync -P "$profile" sync
}

cmd_sync() {
  local main_root python profile
  main_root="$(main_checkout_root)"
  python="$(coach_python "$main_root")"
  profile="${STRIDE_COACH_PROFILE:-zhaochaoyi}"

  [[ -x "$python" ]] || fail "Coach Python is not executable: $python"

  run_coros_sync "$main_root" "$python" "$profile"
}

cmd_coach() {
  local main_root data_dir python profile bypass config_files agent_api_key
  main_root="$(main_checkout_root)"
  data_dir="${STRIDE_COACH_DATA_DIR:-$main_root/data}"
  python="$(coach_python "$main_root")"
  profile="${STRIDE_COACH_PROFILE:-zhaochaoyi}"
  bypass="$(local_no_proxy)"
  config_files="$REPO_ROOT/config/server.toml;$REPO_ROOT/config/server.local.toml;$REPO_ROOT/config/server.coach-cli.toml"
  agent_api_key="$(agent_maestro_api_key)"

  [[ -x "$python" ]] || fail "Coach Python is not executable: $python"
  [[ -d "$data_dir" ]] || fail "Coach data directory not found: $data_dir"
  [[ -f "$REPO_ROOT/config/coach.copilot.toml" ]] || fail "missing Coach LLM config"
  [[ -f "$REPO_ROOT/config/server.coach-cli.toml" ]] || fail "missing Coach CLI server overlay"

  if [[ "${STRIDE_COACH_SKIP_SYNC:-0}" != "1" ]]; then
    run_coros_sync "$main_root" "$python" "$profile"
  fi

  local args=(
    -m coach_cli.cli
    -P "$profile"
    --data-dir "$data_dir"
  )
  [[ "${STRIDE_COACH_DEBUG:-0}" == "1" ]] && args+=(-v)
  if [[ $# -gt 0 ]]; then
    args+=(--message "$*")
  fi

  AGENT_MAESTRO_API_KEY="$agent_api_key" \
  STRIDE_COACH_CONFIG_PATH="$REPO_ROOT/config/coach.copilot.toml" \
  STRIDE_CONFIG_FILES="$config_files" \
  PYTHONPATH="$REPO_ROOT/src${PYTHONPATH:+:$PYTHONPATH}" \
  NO_PROXY="$bypass" no_proxy="$bypass" \
    "$python" "${args[@]}"
}

cmd_eval_resolver() {
  local main_root python bypass agent_api_key
  main_root="$(main_checkout_root)"
  python="$(coach_python "$main_root")"
  bypass="$(local_no_proxy)"
  agent_api_key="$(agent_maestro_api_key)"

  [[ -x "$python" ]] || fail "Coach Python is not executable: $python"
  [[ -f "$REPO_ROOT/config/coach.copilot.toml" ]] || fail "missing Coach LLM config"

  local args=(-m scripts.eval_resolver)
  if [[ $# -gt 0 ]]; then
    args+=(--fixture "$1")
  fi

  AGENT_MAESTRO_API_KEY="$agent_api_key" \
  STRIDE_COACH_CONFIG_PATH="$REPO_ROOT/config/coach.copilot.toml" \
  PYTHONPATH="$REPO_ROOT/src${PYTHONPATH:+:$PYTHONPATH}" \
  NO_PROXY="$bypass" no_proxy="$bypass" \
    "$python" "${args[@]}"
}

command_name="${1:-help}"
shift || true
case "$command_name" in
  smoke) [[ $# -le 1 ]] || fail "smoke accepts at most one model"; cmd_smoke "$@" ;;
  eval-resolver) [[ $# -le 1 ]] || fail "eval-resolver accepts at most one fixture id"; cmd_eval_resolver "$@" ;;
  coach) cmd_coach "$@" ;;
  sync) [[ $# -eq 0 ]] || fail "sync takes no arguments"; cmd_sync ;;
  help|-h|--help) usage ;;
  *) usage >&2; fail "unknown command: $command_name" ;;
esac
