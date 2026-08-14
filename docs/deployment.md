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
  `Dockerfile` 的前端构建 stage + `COPY frontend/dist`、去掉 `frontend/**` path filter。
  **`strength_illustrations/**` path filter 保留** —— `strength_library.py` 仍在 stride-app 上
  读这些文件来拼 image URL（byte-serving 已搬到 stride-web，但 URL 版本号仍靠后端扫盘）。
- **BFF 拥有 `/api` 路由（strangler）**：版本化 TS 路由表按 path 把 `/api/*` 分流到
  `PYTHON_API_URL`（stride-app）或 `GO_API_URL`（Tencent `stride api`），缺省 Python；
  每个 endpoint 由各自的 `STRIDE_ROUTE_*` 环境变量选择上游（值为 `go` → Go，未设置 / 其它值 →
  Python），所以单个 endpoint 的 cutover 只需在部署环境里设该变量，无需改路由表代码；
	`/api/auth/*` 走 `AUTH_UPSTREAM_URL`。这**反转了 ADR 0012 的 browser-direct-to-Go**。Web onboarding 生产 cutover 必须原子地设置 `web-onboarding-v2` 完整 12 项 route flags：profile GET/POST/PATCH、injury GET/POST/PUT/DELETE、watch login、incremental sync、pipeline/job polling 和 onboarding completion。Plan setup 另有 `plan-setup-v1` 完整 4 项 flags：training-goal GET/POST、incremental sync 和 pipeline polling。部署前，workflow 通过 `/api/readyz/onboarding` 和 `/api/readyz/plan-setup` 检查 Go origin 的两个静态 readiness contract，以及（若配置）direct gateway 的同一路径；`/api` 前缀确保 readiness 复用网关现有 API 转发规则。不执行 authenticated 或 mutating gateway route probe，因为没有 harmless endpoint/token。两个 contract 共享的 route flags 在提交给 ACA 前按变量名去重；同名同值只保留一次，同名异值则 fail closed。随后 `deploy-web.yml` 清理所有 manifest `STRIDE_ROUTE_*` ACA overrides，再写入完整 flags，并核对部署后的 exact env set。缺失/部分 route、readiness contract 不匹配或部署后 flag 丢失都会失败。readiness endpoint 不认证、不接收或打印 end-user credential、JWT 或 internal token；BFF 启动也拒绝未实现的 Go route 或原子 cutover。Python season-plan generation remains unchanged and is outside this Go cutover. 发布后的 profile PATCH、injury CRUD、onboarding 和 incremental pipeline 必须作为单独的 production release-verification 步骤，由持有合法用户令牌的发布人员执行。
- **Team API cutover（ADR 0026）**：15 个已迁移 method/path 可通过各自 `STRIDE_ROUTE_*` flag 切到 Go；`POST /api/teams/:teamId/sync-all` 未迁移，保持 flag 未设置并继续走 Python。feed + GET/POST/DELETE likes 虽有独立 flag 便于验证，生产必须作为一个原子 cutover/rollback 单元：
  - `STRIDE_ROUTE_GET_TEAMS_TEAMID_FEED`
  - `STRIDE_ROUTE_GET_TEAMS_TEAMID_ACTIVITIES_USERID_LABELID_LIKES`
  - `STRIDE_ROUTE_POST_TEAMS_TEAMID_ACTIVITIES_USERID_LABELID_LIKES`
  - `STRIDE_ROUTE_DELETE_TEAMS_TEAMID_ACTIVITIES_USERID_LABELID_LIKES`

  四项一起设为 `go` 或一起清除；Go/MySQL likes 不 backfill、不 dual-write 到 legacy Azure，回滚不会同步两边历史。完整 flag 清单见 `frontend/.env.web.local.example`。
- **`strength_illustrations/` 搬进 `stride-web` 镜像**（前端拥有 UI 插图资源）。
- **分阶段 cutover（已完成）**：`stride-web` 先上新 host 验证 → 翻 `stride-running.cn` 到
  `stride-web`（同一 `stride-env`、同 static IP 的 hostname rebind，DNS 不变）→ backend 收尾部署里
  移除 `mount_frontend` / `static.py`（及短暂的 `routes/auth_proxy.py` fallback）。`stride-app`
  现在是纯 `/api/*` 后端，不再服务 SPA。
- **ACR push 复用 Go 服务已有的 ACR**（`worker-go.yml` 同款 `ALIYUN_ACR_REGISTRY` var +
  `ALIYUN_ACR_USERNAME`/`ALIYUN_ACR_PASSWORD` secrets），namespace 硬编码 `stride`，镜像即
  `${ALIYUN_ACR_REGISTRY}/stride/stride-web`（与 `stride/stride-api`、`stride/stride-worker` 并列）。
   ACR mirror 步骤放在 deploy + 新 revision 进入 `Running` 之后、`if: always()`，misconfig 只让 job 变红不阻断部署。

### Go team API runtime and schema startup

Before enabling any team route flag, the Go `stride api` deployment must have working MySQL/RabbitMQ configuration, JWT verification config, and `STRIDE_WORKER_API_AUTH_SERVICE_URL`. The browser's original `Authorization` header passes through `stride-web` to Go; Go forwards it unchanged to auth-service for canonical team/membership authorization. `AUTH_UPSTREAM_URL` on `stride-web` is a separate browser-auth proxy setting and does not satisfy the Go dependency.

On every `stride api` boot, startup runs `AutoMigrateTeamLikes` after the core/user/plan schema steps. It creates or reconciles only canonical MySQL `team_likes`; teams and memberships remain auth-service-owned. Any migration error fails startup, so deploy health checks must pass before team flags are enabled. The table intentionally starts without an Azure likes backfill.

## CI/CD（GitHub Actions）

两个 workflow 驱动生产：

### `.github/workflows/daily-sync.yml` —— Go daily watch sync

每天 00:00 Asia/Shanghai（GitHub Actions 可能延迟）从 `data/.slug_aliases.json` 枚举用户，调用 Go API 的 `POST /api/{uuid}/sync` 并传入 `{"mode":"incremental"}`。它使用仓库变量 `STRIDE_GO_API_URL` 和专属 secret `STRIDE_GO_INTERNAL_TOKEN`；部署 Go API 时必须将同一个 secret 注入为 `STRIDE_WORKER_API_INTERNAL_TOKEN`，否则内部认证会返回 401。Python 的 `STRIDE_INTERNAL_TOKEN` 不可用于 Go 服务。workflow 为每个用户 / 上海日期使用幂等键，并轮询 `GET /api/pipelines/{run_id}`；只有 pipeline 到达 `done` 才计为成功。

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

`/internal/training-load/backfill` 只允许最多 90 天的诊断性短窗口。异步 worker 仍服务 onboarding 等既有 pipeline；其中
onboarding handlers 直接写 per-user SQLite 是独立的历史架构债，本次只移除专用
`training_load_backfill` worker writer，不能把 worker 描述为全局 SQLite 零写入。

### `.github/workflows/worker-go.yml` —— 发布 Go worker + API 镜像

`src/go/**` 变更 push 到 `master` 且 Go 测试通过后，workflow 统一计算本次 CalVer，并用两项 matrix 在独立 runner 上并行构建 `stride-worker` 和 `stride-api`。两个镜像分别推送到 GHCR 与阿里云 ACR；worker 额外保留 commit SHA tag。两项构建使用独立 BuildKit GHA cache scope，避免并发导出缓存互相覆盖。只有整个 matrix 成功后，独立的 Renovate job 才更新 `stride-devops` 中两项镜像版本，避免部署指向只发布了一半的 release。仅修改 workflow 本身会运行测试，但不会重新发布镜像。
阿里云个人版 ACR 不支持 BuildKit 0.32 默认生成的 OCI artifact provenance，
因此 workflow 将 BuildKit 固定为最后确认可同时推送 GHCR 与 ACR 的 `v0.31.2`。

#### Race detection worker configuration

The worker's independent race-detection module (ADR 0029) requires
`STRIDE_WORKER_RACE_DETECTION_API_KEY`. The deployment must inject it only into
`stride-worker`; `stride-api` neither loads nor needs the key. The committed
`src/go/config.yml` supplies the non-secret defaults:

- endpoint `https://api.deepseek.com`;
- API protocol `chat-completions`;
- model `deepseek-v4-flash`;
- timeout 30 seconds;
- maximum concurrency 8.

They can be overridden with the corresponding `STRIDE_WORKER_RACE_DETECTION_*`
environment variables. Missing/empty key or invalid race-detection settings make
the worker fail at startup by design. Before rollout, add the provider key to the
deployment's secret store and expose it as
`STRIDE_WORKER_RACE_DETECTION_API_KEY`; never commit or print its value.

The worker also supports `race-detection.api-kind: responses` for a
worker-reachable OpenAI-compatible Responses endpoint. Local Agent Maestro
(`http://127.0.0.1:23333/api/openai/v1`, model `gpt-5.6-luna`) is suitable
for local golden validation only: that loopback service runs inside VS Code and
is not reachable from the deployed worker container. Do not point production at
this local URL. Copy `src/go/config.local.example.yml` to the ignored
`src/go/config.local.yml`, set its local MySQL DSN, and run
`make test-racedetection`; production continues to read `src/go/config.yml`.

After the schema and worker are deployed, enqueue internal-only
`race_detection_backfill` once per existing user to inspect historical HM/FM
candidates. It is not a scheduled job and is unnecessary for newly synced
activities. The job is partial-success: confirmed rows are committed as they are
found, while a failed candidate remains absent and causes the job to retry/fail.

### 赛季训练计划统一读取切流

Web 只通过 Go `GET /api/users/me/master-plan/current` 读取当前赛季训练计划。该接口从
MySQL `master_plan` 的唯一 active 行读取，并按 `content_version` 返回 Markdown 或结构化
内容；不得 fallback 到 Python、Azure、文件或 SQLite。Web 镜像在 `Dockerfile.web` 中把
`STRIDE_ROUTE_GET_USERS_ME_MASTER_PLAN_CURRENT=go` 设为默认值，`deploy-web.yml` 不提供
额外 readiness gate，因此发布顺序由人工负责。

`master_plan.version` 改名为 `revision` 是停机式破坏性迁移：

1. 运行 target-aware migration dry-run，人工审阅不含计划正文、运动员姓名、凭据或 token 的 manifest。
2. 构建并发布新 Go API 与 Web 镜像，但此时不要 rollout。
3. 开始完整 Go API 维护窗口：从流量入口摘除服务并停止全部旧实例，确认旧容器不会因 restart policy 再启动。维护窗口内，所有已通过 BFF 切到 Go 的 Web 功能都不可用，不只是 `/plan`。
4. 由 `src/migration` 工具幂等执行列 rename、CHECK 更新、数据写入与回读校验。
5. 启动新 Go API并验证 unified current 的 Markdown、JSON 与 404 场景。
6. 将新 Go API重新接入流量并结束维护窗口。
7. 最后部署 Web。

commit 前必须用已人工审阅 manifest 的 hash 重新核对 Azure 源和 MySQL 目标；任一变化都
停止执行并要求重新 dry-run/review。迁移失败时保持 Go API 停止，修复后重跑；工具不自动反向 rename。旧 Go 镜像不知道
`revision`，禁止直接回滚；必须先人工反向迁移 schema。完整契约见
[`spec/go-current-season-plan-cutover.md`](../spec/go-current-season-plan-cutover.md) 与 ADR 0024。

### `.github/workflows/weekly-running-calibration.yml` —— 周度运动员基线校准

每周日触发时，workflow 从 `data/.slug_aliases.json` 枚举用户，并通过 Go API 的
`POST /jobs` 入队 internal-only `calibration` job。请求使用
`STRIDE_GO_API_URL` repository variable、`STRIDE_GO_INTERNAL_TOKEN` secret，以及按
workflow run 和用户固定的 `Idempotency-Key`；因此网络重试不会重复入队。API 返回 `202`（或幂等重放的 `200`）后完成。该 workflow 只调用 Go API，不提供 Python backfill fallback。Go API 的 `STRIDE_WORKER_API_INTERNAL_TOKEN` 必须与 `STRIDE_GO_INTERNAL_TOKEN` 同值。

### `.github/workflows/sync-data.yml` —— 同步 training-log markdown 到 prod Azure Files

触发：push 到 `master` 且 `data/*/logs/**`、`data/*/TRAINING_PLAN.md`、`data/*/status.md` 中任一变更。经 `az storage file upload-batch` 推到 `authstorage2026` 上 `stride-data` share（RG `rg-common-prod`）。

这就是 `plan.md` 不重建镜像也能在 prod 出现的原因：它经 `sync-data.yml` 落到 Azure Files，不在 image 里。完成下方人工 rollout 后，周反馈改由 MySQL `weekly_feedback` 提供，并应从同步 workflow 移除 `feedback.md`。

## Weekly feedback manual rollout

ADR 0028 的生产启用必须由人工完成，本仓库部署 workflow 不自动打开 PUT route：

1. 部署包含 `weekly_feedback` schema、Go GET/PUT 和迁移 CLI 的版本，但保持 feedback PUT 仍指向 Python。
2. 对生产目标运行默认 dry-run，保存并人工审阅零错误 manifest；核对 manifest 的 MySQL `database_name`、`server_uuid`、用户清单和记录哈希。
3. 使用同一 manifest/hash 显式 `--commit`，等待单事务写入和 readback verification 成功。失败时保持 BFF 不变。
4. 在同一个 BFF revision 中确认两个 week GET 已指向 Go，再设置 `STRIDE_ROUTE_PUT_USER_WEEKS_WEEKNAME_FEEDBACK=go` 和 `STRIDE_WEEKLY_FEEDBACK_CUTOVER_COMPLETE=true`。BFF 会拒绝只切 PUT，也会在 completion marker 存在后拒绝任一路由回退。
5. 用真实用户验证 list、detail、非空保存、清空和 reload；确认 `sport_note` 未拼接到周反馈。
6. 验证成功后，将同名 GitHub Actions repository variable `STRIDE_WEEKLY_FEEDBACK_CUTOVER_COMPLETE` 设为 `true`，使 `sync-data.yml` 只同步 `plan.md`。不要通过恢复 Python PUT 回滚；需要回滚时先制定 MySQL 数据一致性方案。

**DB-row 内容**（如 `activity_commentary`）**不**在 `sync-data.yml` 覆盖范围内（住在 SQLite 不是 markdown）。用 `coros-sync -P <user> commentary push <label_id> --url $STRIDE_PROD_URL`，POST 到 server 的 `/api/{user}/activities/{label_id}/commentary`。

### Season-plan generation scope

Python season-plan generation is unchanged and outside this Go profile, injury, and plan-setup cutover. No canonical-reader readiness or deployment wiring is required here.

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
