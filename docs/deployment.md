# Deployment / Docker / CI/CD

**何时读**：改 `Dockerfile` / `.github/workflows/*`、调 reparse webhook、或调 prod / Azure 资源时必读。

## Docker

Multi-stage build (`Dockerfile`)：

1. **Stage 1** (node:24-alpine)：Vite 构建 frontend
2. **Stage 2** (python:3.13-slim)：Python runtime with FastAPI/uvicorn，拷贝构建好的 frontend

`.dockerignore` 排除 `data/` 但放行 `data/*/TRAINING_PLAN.md`，让默认 training plans 进 image。

## Planned：前端剥离为 `stride-web`（见 ADR 0017）

> 设计已定、尚未实施。完整取舍见 [`docs/adr/0017-frontend-bff-strangler-split.md`](adr/0017-frontend-bff-strangler-split.md)。

目标态把前端从这个共享镜像里拆出去，成为独立服务/容器 **`stride-web`** = 静态 Vite SPA +
一个 Node/Hono **前端 BFF**（唯一前门；页面仍 CSR，不做 SSR）。届时：

- **两份镜像、两条 workflow**。新 `deploy-web.yml` 构建 `Dockerfile.web`，一次构建后 tag 推到
  **GHCR + 阿里云 ACR 两个 registry**，部署到新 Container App `stride-web`；它拥有 `VITE_*` +
  AMap 的 Key Vault build-arg。**Azure Container App 从 GHCR 拉取（authoritative）**，ACR 是为
  大陆拉取 / 未来搬到 Tencent 预备的镜像镜像。既有 `deploy.yml` 收敛为 Python-only：去掉
  `Dockerfile` stage 1、去掉 `frontend/**` 与 `strength_illustrations/**` path filter。
- **BFF 拥有 `/api` 路由（strangler）**：版本化 TS 路由表按 path 把 `/api/*` 分流到
  `PYTHON_API_URL`（stride-app）或 `GO_API_URL`（Tencent `stride api`），缺省 Python；
  `/api/auth/*` 走 `AUTH_UPSTREAM_URL`。这**反转了 ADR 0012 的 browser-direct-to-Go**。
- **`strength_illustrations/` 搬进 `stride-web` 镜像**（前端拥有 UI 插图资源）。
- **分阶段 cutover**：`stride-web` 先上新 host 验证 → 翻 `stride-running.cn` → 之后的 backend
  部署里移除 `mount_frontend` / `static.py`。翻域名前 `stride-app` 继续 serve SPA 作 fallback。
- **ACR push 需要新 secrets/vars**：`ALIYUN_ACR_REGISTRY`、`ALIYUN_ACR_NAMESPACE`、
  `ALIYUN_ACR_USERNAME`/`ALIYUN_ACR_PASSWORD`（或 RAM AccessKey）；缺失时该 step 显式失败/跳过，
  不能静默只推一处却当双份成功。

## CI/CD（GitHub Actions）

两个 workflow 驱动生产：

### `.github/workflows/deploy.yml` —— 重建 + 重部署容器

触发：push 到 `master` 且 `src/coros_sync/**`、`src/stride_core/**`、`src/stride_server/**`、`src/coach/**`、`config/**`、`frontend/**`、`Dockerfile`、`.github/workflows/deploy.yml`、`pyproject.toml` 中任一变更。

Pipeline：Build Docker image → Push to GHCR → Azure Login (OIDC) → Deploy to Azure Container Apps → Health check。

训练负荷算法升级时，deploy 在新 revision 通过 health check 后调用受内部 token
保护的 `/internal/training-load/users`。服务端从生产 Azure Files 挂载盘枚举所有
UUID 目录中的 `coros.db`（不依赖可能滞后的 `.slug_aliases.json`）。365 天扫描（约
1.2M 条 timeseries）不能放进单个 ACA 请求，也不能交给另一个直接打开 SQLite 的
worker；deploy 因此按用户串行 POST `/internal/training-load/backfill/step`，每次只推进
最多 30 天，并在 `503` / 网络失败时指数退避重试。

API 内按 user 互斥 watch 数据写入与 training-load shard。每片成功后将 `next_start`、末端 ATL/CTL
及本轮固定 calibration 写入 `sync_meta.training_load_backfill_progress`；请求超时或 API
重启后从这里续传。首片从零 prior 开始，后续片显式接续上一片末端状态。同步若在回填
未完成时写入新 watch 数据，会清除旧 progress，下一片从零安全重建，避免使用过期前态。

`daily_training_load` 是按日期唯一的 canonical 存储；`algorithm_version` 只记录生成该行
的算法版本，不参与主键或读取过滤。算法升级期间旧行继续可读，新回填按日期原位覆盖。
是否跳过全量回填只看 `sync_meta.training_load_backfill_complete`，不能用“存在任意当前版本
行”代替。只有最后一片成功且实际写出 daily rows 后才更新 completion marker；空窗口
返回 `skipped=no_source_data` 但不写 marker，失败或零行结果同样不写 marker。deploy
校验每个带 shard 的响应 `daily_rows_written > 0`，并要求非终态响应提供且推进
`next_shard_start`；任一异常都会失败。

手工 `weekly-running-calibration.yml` 的 `backfill` 模式也使用同一 shard 接口，并用
GitHub workflow run token 幂等触发强制重建；`/internal/training-load/backfill` 只允许
最多 90 天的诊断性短窗口。异步 worker 仍服务 onboarding 等既有 pipeline；其中
onboarding handlers 直接写 per-user SQLite 是独立的历史架构债，本次只移除专用
`training_load_backfill` worker writer，不能把 worker 描述为全局 SQLite 零写入。

### `.github/workflows/sync-data.yml` —— 同步 training-log markdown 到 prod Azure Files

触发：push 到 `master` 且 `data/*/logs/**`、`data/*/TRAINING_PLAN.md`、`data/*/status.md` 中任一变更。经 `az storage file upload-batch` 推到 `authstorage2026` 上 `stride-data` share（RG `rg-common-prod`）。

这就是 `plan.md` / `feedback.md` 不重建镜像也能在 prod 出现的原因 —— 它们 runtime 落到 Azure Files，不在 image 里。`.dockerignore` 排掉 `data/` 整个（除 `data/*/TRAINING_PLAN.md`），所以 `logs/` 下的 markdown 只经 `sync-data.yml` 到 prod，不经 image。

**DB-row 内容**（如 `activity_commentary`）**不**在 `sync-data.yml` 覆盖范围内（住在 SQLite 不是 markdown）。用 `coros-sync -P <user> commentary push <label_id> --url $STRIDE_PROD_URL`，POST 到 server 的 `/api/{user}/activities/{label_id}/commentary`。

### Structured-plan reparse webhook

迁移期每次 push `data/*/logs/*/plan.md` 或 `plan.json` 后，`sync-data.yml` 调 `POST /internal/plan/reparse?user=&folder=`，header `X-Internal-Token: $STRIDE_INTERNAL_TOKEN`，把旧 authoring artifact 导入 `WeeklyPlanStore`（prod `strideweeklyplan`）。新计划直接生成并保存为 `WeeklyPlan`，不再创建或 review `plan.md`；SQLite 也不保存新的结构化周计划。
首次上线 `strideweeklyplan` 后，手工触发一次 `sync-data.yml` 的
`workflow_dispatch`。workflow 会先幂等创建 Azure Table，再枚举全部历史
`plan.json` 并通过同一 webhook 回填；普通 push 仍只处理本次变更的周目录。

要工作必须配两件事：

- **GitHub Actions secrets**：`STRIDE_PROD_URL`（如 `https://stride-app.<region>.azurecontainerapps.io`）和 `STRIDE_INTERNAL_TOKEN`（随机 32+ 字符）
- **Azure Container App env var**：相同 `STRIDE_INTERNAL_TOKEN` 值，如 `az containerapp update --name stride-app --resource-group rg-running-prod --set-env-vars STRIDE_INTERNAL_TOKEN=<value>`

server 端没设 → route 返 401；两端都没设 → workflow step 静默跳过。

## Infrastructure

- **Container**：Azure Container Apps（`stride-app` in `rg-running-prod`）
- **Registry**：GitHub Container Registry（`ghcr.io`）
- **Storage**：Azure Files share `stride-data` on `authstorage2026`（RG `rg-common-prod`），挂到 `/app/data` —— 含 per-user SQLite databases / credentials / logs / training plans
- **Auth**：Entra ID OIDC for deployment；独立 auth-service（见 [auth-wiring.md](./auth-wiring.md)）做 API-level authn/authz

## Build Commands

```bash
# Frontend dev
cd frontend && npm run dev      # Vite dev server with HMR
cd frontend && npm run build    # tsc -b && vite build (used in Docker)

# Backend dev
PYTHONIOENCODING=utf-8 uvicorn stride_server.main:app --reload --port 8000

# Full Docker build
docker build -t stride .
docker run -p 8080:8080 -v ./data:/app/data stride
```
