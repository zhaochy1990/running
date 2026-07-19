# Deployment / Docker / CI/CD

**何时读**：改 `Dockerfile` / `.github/workflows/*`、调 reparse webhook、或调 prod / Azure 资源时必读。

## Docker

Multi-stage build (`Dockerfile`)：

1. **Stage 1** (node:24-alpine)：Vite 构建 frontend
2. **Stage 2** (python:3.13-slim)：Python runtime with FastAPI/uvicorn，拷贝构建好的 frontend

`.dockerignore` 排除 `data/` 但放行 `data/*/TRAINING_PLAN.md`，让默认 training plans 进 image。

## CI/CD（GitHub Actions）

两个 workflow 驱动生产：

### `.github/workflows/deploy.yml` —— 重建 + 重部署容器

触发：push 到 `master` 且 `src/coros_sync/**`、`src/stride_core/**`、`src/stride_server/**`、`src/coach/**`、`config/**`、`frontend/**`、`Dockerfile`、`.github/workflows/deploy.yml`、`pyproject.toml` 中任一变更。

Pipeline：Build Docker image → Push to GHCR → Azure Login (OIDC) → Deploy to Azure Container Apps → Health check。

训练负荷算法升级时，deploy 在新 revision 通过 health check 后调用受内部 token
保护的 `/internal/training-load/users`。服务端从生产 Azure Files 挂载盘枚举所有
UUID 目录中的 `coros.db`（不依赖可能滞后的 `.slug_aliases.json`）。回填**不再**在
请求内同步执行 —— 365 天扫描（~1.2M 条 timeseries）会超过 ACA 240s 请求预算而
504。deploy 对缺少独立 completion marker 的用户 POST
`/internal/training-load/backfill/enqueue`，入队一个 `training_load_backfill` 异步 job，
**先全部入队**再轮询 `/internal/jobs/{partition}/{job_id}` 到 `done` / `failed` / 超时。
worker deploy 显式固定 `min=max=1`，确保队列始终有且仅有一个消费者。

`daily_training_load` 是按日期唯一的 canonical 存储；`algorithm_version` 只记录生成该行
的算法版本，不参与主键或读取过滤。算法升级期间旧行继续可读，新回填按日期原位覆盖。
是否跳过全量回填只看 `sync_meta.training_load_backfill_complete`，不能用“存在任意当前版本
行”代替。worker 复用已有 calibration snapshot；成功写出 daily rows 后才更新 completion
marker。空库返回 `skipped=no_source_data` 但不写 marker，失败或零行结果同样不写 marker。
任务标记 `done` 后 deploy 仍解析 `result_json` 并确认非 skip 任务的
`daily_rows_written > 0`；零行结果、任一 job `failed` 或轮询超时都会让 deploy 失败。

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
