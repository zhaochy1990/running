#!/usr/bin/env bash
# backfill-session-class.sh — session_class 枚举升级（devops #745）后的全用户 full compute
# backfill：把 365 天窗口内的旧值（tempo/interval/long）覆盖为新七类。
#
# ── RUNBOOK（部署顺序铁律，生产执行由用户操作或明确授权后执行）─────────────────
#
# 1. stride-coach-api 与 stride-coach-worker 都先上（TS 双值兼容层就位——两个镜像
#    都带旧正则；coach-worker 跑 kernel 路径的 weeklyPlan/masterPlan provider，漏更
#    它则 kernel 的 speed_session_count 对新值漏计；只更 coach-api 不够）。
# 2. stride-api / stride-worker 后上（Go 新枚举写入就位）。
# 3. 跑本脚本（365 天内旧值被覆盖为新值）。
#
# 注意事项：
# - full compute 重算的不止 session_class——365 天的 training_dose、daily PMC（零种子
#   重算）、PB、zones 都会按最新校准快照重写。算法幂等；但若某用户校准快照自上次
#   full 后变过，backfill 后 dose 历史会出现正常漂移，对账时勿误判为回归。
# - 无 calibration snapshot 的用户会 permanent error `no_calibration`（正常跳过，
#   汇总单列）；365 天窗口外的旧行保留旧值，由 TS 双值兼容兜底（不做全历史 backfill）。
# - 对账（轻量）：backfill 后抽样新值占比，确认旧值残留全部落在 365 天窗口之外：
#     SELECT session_class, COUNT(*) AS n,
#            SUM(activity_date >= DATE_SUB(CURDATE(), INTERVAL 365 DAY)) AS within_365d
#     FROM activity_training_load GROUP BY session_class;
#   （tempo/interval/long 的 within_365d 应为 0。）
#
# ── 用法 ────────────────────────────────────────────────────────────────────
#   STRIDE_GO_API_URL=https://api.example.com INTERNAL_TOKEN=<token> \
#     scripts/backfill-session-class.sh
#
# 环境变量（无明文密钥入库）：
#   STRIDE_GO_API_URL  必填，Go API 基址（如 https://api.stride-running.cn）
#   INTERNAL_TOKEN     必填，X-Internal-Token（compute 非 UserInitiable，内部令牌）
#   DATE_TAG           可选，幂等键日期段，默认今天（YYYYMMDD）；重跑同一天用同一键
#
# 幂等：Idempotency-Key 作用域是 (UserID, Key)，键形如
#   class-enum-backfill-<DATE_TAG>-<user-uuid>
# 同一天重跑会对每个用户去重返回既有 job，可安全反复执行。
set -euo pipefail

API_URL="${STRIDE_GO_API_URL:?STRIDE_GO_API_URL is required}"
TOKEN="${INTERNAL_TOKEN:?INTERNAL_TOKEN is required}"
DATE_TAG="${DATE_TAG:-$(date +%Y%m%d)}"

POLL_INTERVAL=30
POLL_TIMEOUT=3600 # 单用户 full compute（含 dose/PMC/PB/zones）上限 1 小时

http() {
  curl -sS --fail-with-body --max-time 120 -H "X-Internal-Token: ${TOKEN}" "$@"
}

# 1. 枚举 sync 用户（持有 provider credential 的 UUID，约 21 个活跃）。
users=$(http "${API_URL}/api/internal/sync-users" | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(u) for u in d["users"]]')
if [ -z "${users}" ]; then
  echo "no syncable users returned; aborting" >&2
  exit 1
fi
total=$(printf '%s\n' "${users}" | wc -l | tr -d ' ')
echo "backfill-session-class: ${total} users (date tag ${DATE_TAG})"

# 2. 逐用户提交 full compute（提交阶段全部完成后再轮询，缩短脚本总时长）。
declare -a PENDING=()
ok=0; failed=0
for user in ${users}; do
  key="class-enum-backfill-${DATE_TAG}-${user}"
  resp=$(http -X POST "${API_URL}/jobs" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: ${key}" \
    -d "{\"type\":\"compute\",\"user_id\":\"${user}\",\"input\":{\"mode\":\"full\"}}")
  job_id=$(printf '%s' "${resp}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["job_id"])')
  echo "  submitted ${user} -> job ${job_id}"
  PENDING+=("${user} ${job_id}")
  ok=$((ok + 1))
done
echo "submitted ${ok} compute jobs"

# 3. 轮询至终态，输出成功/失败汇总。
declare -a FAILED_USERS=()
for entry in "${PENDING[@]}"; do
  user=${entry%% *}
  job_id=${entry##* }
  waited=0
  while :; do
    status=$(http "${API_URL}/jobs/${job_id}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
    case "${status}" in
      done)
        echo "  done    ${user} (job ${job_id})"
        break
        ;;
      failed)
        err=$(http "${API_URL}/jobs/${job_id}" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("error_code") or d.get("error_message") or "failed")')
        echo "  FAILED  ${user} (job ${job_id}): ${err}"
        failed=$((failed + 1))
        FAILED_USERS+=("${user}:${err}")
        break
        ;;
      queued|running)
        if [ ${waited} -ge ${POLL_TIMEOUT} ]; then
          echo "  TIMEOUT ${user} (job ${job_id}) after ${POLL_TIMEOUT}s"
          failed=$((failed + 1))
          FAILED_USERS+=("${user}:timeout")
          break
        fi
        sleep "${POLL_INTERVAL}"
        waited=$((waited + POLL_INTERVAL))
        ;;
      *)
        echo "  UNKNOWN status '${status}' for ${user} (job ${job_id})" >&2
        failed=$((failed + 1))
        FAILED_USERS+=("${user}:unknown_status_${status}")
        break
        ;;
    esac
  done
done

echo "──────── summary ────────"
echo "submitted: ${ok}  failed: ${failed}"
if [ ${#FAILED_USERS[@]} -gt 0 ]; then
  echo "failures:"
  for f in "${FAILED_USERS[@]}"; do echo "  ${f}"; done
  exit 1
fi
