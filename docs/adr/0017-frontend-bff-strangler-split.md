# 前端剥离为 stride-web 服务：Node BFF 拥有 Python→Go 的 strangler 路由

> **Status:** accepted。**Supersedes ADR 0012 的一个具体决定** —— 0012 记录的
> "we want the browser/app to call the Go API directly"（拒绝 proxy user traffic
> through a fronting service）在浏览器路径上被本 ADR 反转：浏览器不再直连 Go，而是
> 只跟 `stride-web` 的 BFF 同源对话，由 BFF 服务端路由到 Python 或 Go。ADR 0012 的
> **服务端到服务端**内部调用（Python↔Go、`X-Internal-Token` 两层 auth、idempotency、
> catalog）**不受影响**，继续成立。

今天前端和 Python 后端**焊死在同一个镜像 / 同一个 Azure Container App（`stride-app`）**：
`Dockerfile` stage 1 用 Vite 构建 SPA，stage 2 的 Python 镜像 `COPY frontend/dist`
并由 `stride_server/static.py::mount_frontend` 以 SPA catch-all 同源服务，和 `/api/*`
跑在同一进程。前端与 API 的唯一耦合是 `frontend/src/api.ts` 里的相对量 `const BASE = '/api'`。

我们要把前端剥离成**独立的服务 + 容器（`stride-web`）**，目标有三：**清晰的架构边界**、
**为 Python API 被 Go 版本 strangler 演进铺路**、**解耦前后端部署节奏**（前端改动不再重建
Python 镜像、不再触发 training-load backfill 与 5 分钟 health-check）。

## Decision

- **`stride-web` = 静态 Vite SPA（构建方式与今天完全一致）+ 一个 Node/Hono BFF，作为唯一前门。**
  页面仍然客户端渲染（CSR），**不做 SSR**；token 模型（`sessionStorage` + Bearer）不变。
  这是一个代理形态的 BFF，不是框架重写。
- **BFF 拥有 API 路由（day-one strangler）。** 三个运行时可配上游：
  - `PYTHON_API_URL` → `stride-app`（Azure，同区）
  - `GO_API_URL` → `stride api`（Tencent CVM，ADR 0012/0016）
  - `AUTH_UPSTREAM_URL` → in-house auth-service（Azure）
  一张**版本化 TS 路由表**（path 前缀/glob → `python` | `go`，缺省 `python`）决定每个
  `/api/*` 落到哪个上游。把某个 endpoint 切到 Go = 改这张表一行 + 配套的前端 contract 改动
  （Go/Python contract 本就不同，如 `watch_ready`、`/watch/login`，见 ADR 0013）+ 一次
  tiny 前端重部署。路由表走 PR/CI，可审计。
- **`/api/auth/*` 也经 BFF，全链路 same-origin。** `frontend/src/store/authStore.ts` 去掉
  dev/prod 分支（不再有 `VITE_AUTH_BASE_URL` 绝对量直连），永远相对 `/api/auth`。浏览器
  不再跨域直连 Python / Go / auth 中的任何一个 —— BFF 是单一前门。
- **部署在 Azure，反转 0012 的 browser-direct-to-Go。** 前端+BFF 与 Python、auth 同区。
  BFF 代理 Python 是同区廉价 hop，代理 Go 是跨境到 Tencent 的 hop。
- **Monorepo，BFF 落在 `frontend/server/`。** 与现有 Python(`src/`) + Go(`src/go/`) +
  `frontend/` 的 polyglot monorepo 一致，worktree 流程不变。
- **`strength_illustrations/` 搬进前端镜像。** 它们是 UI 插图静态资源，归前端拥有并由
  `stride-web` static 直接服务 `/strength_illustrations/output`；不再依赖即将退役的 Python
  镜像（Go 不保证 serve 它）。
- **两份镜像、两条 workflow。**
  - 新 `deploy-web.yml`：构建 `Dockerfile.web` → 一次构建、tag 后推到 **GHCR + 阿里云 ACR
    两个 registry**（不按 registry 重复构建）→ 部署到新 Container App `stride-web`。它拥有
    `VITE_*` + AMap 的 Key Vault build-arg。触发路径 `frontend/**`、`strength_illustrations/**`、
    `Dockerfile.web`、`.github/workflows/deploy-web.yml`。**Azure Container App 从 GHCR 拉取
    （authoritative）**，ACR 是为大陆拉取 / 未来搬到 Tencent 预备的镜像镜像。
  - 既有 `deploy.yml`：去掉前端构建（`Dockerfile` stage 1 移除）、去掉 `frontend/**` 与
    `strength_illustrations/**` path filter，收敛为 Python-only。
- **分阶段 cutover。** 先把 `stride-web` 上到一个新 host 验证 SPA + BFF→Python + BFF→Go 端到端，
  再把 `stride-running.cn` 翻到 `stride-web`，最后在后续 backend 部署里移除
  `mount_frontend` / `static.py`。翻域名验证通过前，`stride-app` 继续 serve SPA 作 fallback。
- **本地 dev 高保真。** BFF 跑在 Vite 前，所有 dev `/api`（含 `/api/auth`）都过路由表；
  `smoke:local`（AGENTS.md HARD 前端验证流程）改成打 BFF 端口而非 Vite 5173。

## Considered options

- **纯 nginx 反向代理**（静态 + location 块路由）：镜像更小、运维更简单，但没有编程能力 ——
  拒绝，因为 strangler 需要一个可编程的"前端的后端"层承载 Python↔Go 切换逻辑与未来
  canary / header / 聚合。
- **改用 SSR 框架**（Next.js / RR7 framework mode）让服务端渲染 + BFF：拒绝 —— SSR 会强制
  auth 从 `sessionStorage` 迁到 httpOnly cookie / 服务端 token handoff，牵动每个受保护路由；
  我们只需要一个 BFF 路由层，CSR 足够。
- **把绝对 API URL 在 build 时烤进 bundle**（`VITE_API_BASE_URL` + 依赖后端 CORS `*`）：
  拒绝 —— Python→Go 重指需要重建前端，且退回跨域请求；BFF 让重指变成配置/表改动。
- **保留 ADR 0012 的 browser-direct-to-Go，路由表放客户端**（前端按 endpoint 选 Python-Azure-URL
  或 Go-Tencent-URL 直连）：延迟最优、无额外 hop，但把路由所有权留在浏览器；本次明确选择让
  "前端的后端"（BFF）拥有路由，换取单一前门、服务端可控切换与可审计路由表。
- **BFF 部署在 Tencent（贴着 Go）**：end-state 延迟最优（Go 同区、Python 跨境且随 Go 接管而
  收缩），但公开入口搬到大陆需要 ICP 备案等更大的基础设施改动 —— **deferred 为逃生舱**（见
  Consequences）。
- **所有镜像都双 registry 发布**（stride-web + Python + Go）：更一致，但要改三条 workflow、
  加 ACR 登录/secrets —— 超出本次剥离范围，deferred。

## Consequences

- **跨境 hop 随 Go 接管而增长。** BFF 在 Azure、Go 在 Tencent，每个路由到 Go 的请求是
  browser→Azure→Tencent→Azure→browser。Go 接管的 endpoint 越多，这个成本越大 ——
  **逃生舱：把 `stride-web`（含 BFF）搬到 Tencent，贴着 Go**（届时 Python 变成收缩中的跨境腿）。
  ACR 镜像发布就是为这一步预备的。
- **BFF 是新的单一前门 SPOF。** 一个 Container App（沿用现有 `min=max=1` 惯例）。它挂了则整个
  前端不可用；健康检查必须覆盖 BFF→上游可达性，不能只探静态。
- **路由表与前端 contract 必须成对改。** 因为 Go/Python 逐 endpoint contract 不同（ADR 0013），
  切一个 endpoint 到 Go 不是纯路由翻转，而是"路由表 + 前端调用形态"同一个 PR 改 —— 这正是选
  版本化 TS 路由表（而非运行时配置）的原因。
- **auth 现状被反转（transport 层）。** 之前 prod 浏览器直连 auth-service，现在同源经 BFF。
  好处：`authStore` 去掉 dev/prod 分支、auth-service 之后可收紧 CORS 只认 BFF 服务端；代价：
  auth 多一个同区 Azure→Azure hop（廉价）。token 模型不变。
- **`smoke:local` HARD 流程要重调。** 从打 Vite 5173 改成打本地 BFF 端口；AGENTS.md 前端本地
  验证章节需同步更新。
- **backend 在 cutover 后失去 SPA 服务能力。** `mount_frontend` / `static.py` /
  `/strength_illustrations/output` mount 会在翻域名验证后的后续 backend 部署里移除；`deploy.yml`
  也随之去掉前端相关 path filter。此前保留作 fallback。
- **ACR 发布复用 Go 服务已有的 Aliyun ACR**（`ALIYUN_ACR_REGISTRY` var +
  `ALIYUN_ACR_USERNAME`/`ALIYUN_ACR_PASSWORD` secrets，与 `worker-go.yml` 同款），namespace
  硬编码 `stride`，镜像 `${ALIYUN_ACR_REGISTRY}/stride/stride-web` 与 `stride/stride-api`、
  `stride/stride-worker` 并列 —— 不新增 namespace 变量。mirror step 在 deploy + health 之后、
  `if: always()`，misconfig 只让 job 变红、不阻断 GHCR 权威部署。
