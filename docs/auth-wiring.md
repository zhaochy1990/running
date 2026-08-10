# Authentication wiring (auth-service integration)

**何时读**：调 auth、加 protected endpoint、改 CLI auth 流程、或 401 排障时必读。

## 一句话

STRIDE 不自己跑 auth。集成外部 in-house auth service（OAuth2 + JWT RS256 with PKCE）。

## Auth service 资源

- **Repo**：`C:\Users\zhaochaoyi\workspace\auth`（monorepo）。Backend 代码：`sources/dev/authentication/`（Rust/Axum，Azure Table Storage，JWT RS256）。
- **Deployment**：Azure Container Apps（image `ghcr.io/<owner>/auth-backend`）。JWT keys 在 Azure File Share。Release 用 CalVer（`YYYY.M.MICRO`）auto-tag。
- **Auth model**：OAuth2 + JWT (RS256) with PKCE。public key 由 auth service 提供，用于本地验签 access token。

## Auth service 端点

| Prefix | Header | Purpose |
|--------|--------|---------|
| `POST /api/auth/register`, `/login`, `/refresh`, `/logout` | `X-Client-Id: <app>` | 用户 auth flow —— 返回 access + refresh token |
| `GET /api/users/me`, `/accounts` | `Authorization: Bearer <jwt>` | 当前用户信息 |
| `POST /oauth/token`, `/revoke`, `/introspect` | `Authorization: Basic <client_id:secret>` | M2M + token lifecycle |
| `GET /health` | none | health |

## STRIDE 端 current wiring（prod 已启用）

### 1. Server 端验签 (`src/stride_server/bearer.py`)

`require_bearer` FastAPI dependency 读 auth-service 公钥：
- 从 `STRIDE_AUTH_PUBLIC_KEY_PEM`（inline PEM）或 `STRIDE_AUTH_PUBLIC_KEY_PATH`（文件）
- 本地 RS256 验签（不发网络请求）
- 验 `iss`（默认 `auth-service`），以及 `STRIDE_AUTH_AUDIENCE` set 时验 `aud`
- 公钥 env 没设 → 验签 bypass + 一次 warning log（dev fail-open）

prod 启用：revision `stride-app--0000037` 起：
- `STRIDE_AUTH_PUBLIC_KEY_PEM` → secretref `auth-public-pem`（从 `authstorage2026/jwt-keys/public.pem` 下载）
- `STRIDE_AUTH_AUDIENCE=app_62978bf2803346878a2e4805`（STRIDE frontend client_id 复用）

### 2. 受保护端点

公钥 env set 时，每个 `/api/*` 路由（除 `/api/health`）都要 Bearer。`stride_server/app.py` 在 router 级别套 `Depends(require_bearer)`，只放过 `public` router（仅 `/api/health` 给 Azure liveness probe）。CORS 故意大开（`allow_origins=["*"]`）—— 真正的 authz 边界是 Bearer 层不是 Origin。

已验证：Python `/api/*`（除 `/api/health`）无 token → 401；valid user token → 200。覆盖读（`/users`, `/weeks`, `/activities`, `/dashboard`, `/health`, `/pmc`, `/stats`）和写（`/sync`, `/resync`, `/commentary`）。

Go `stride api` 使用同一 auth-service 公钥在 Gin middleware 本地验签 JWT，并按 JWT `sub` 做用户隔离。Web 只通过 `/api/users/me/master-plan/current` 读取当前赛季训练计划；BFF 默认将该路由转发到 Go，因此它不经过 FastAPI `require_bearer`，也不提供其他数据源 fallback。

### 3. CLI auth (`coros-sync auth` 组)

- `auth login --email X --auth-url Y --client-id Z`：email/password 换 token（经 `/api/auth/login`），存 `data/{user_id}/auth.json`
- `auth logout`：删 token；`auth status`：打 metadata
- `commentary push`：自动加 `Authorization: Bearer <access_token>`；token 60s 内到期则经 `/api/auth/refresh` 自动刷；没 token 时 fallback anonymous

### 4. 本地 CLI 规范 env

```bash
export STRIDE_AUTH_URL="https://124.221.38.59"
export STRIDE_CLIENT_ID="app_62978bf2803346878a2e4805"
export STRIDE_PROD_URL="https://stride-app.victoriousdesert-bd552447.southeastasia.azurecontainerapps.io"
```

首次登录（凭据从 `.credentials.local`，git-ignored）：

```bash
coros-sync -P zhaochaoyi auth login \
  --email "$(awk -F= '/^email/{print $2}' .credentials.local | tr -d ' ')" \
  --password "$(awk -F= '/^password/{print $2}' .credentials.local | tr -d ' ')"
```

之后的写入（如 Claude 生成 commentary 后）：

```bash
coros-sync -P zhaochaoyi commentary push <label_id>
```

### 5. Frontend

已经走 auth-service flow（无 legacy MSAL）。`frontend/src/store/authStore.ts` 处理 login/refresh，用 `sessionStorage`；`frontend/src/api.ts` 每个请求挂 `Authorization: Bearer`（包括 `triggerSync` 和 `resyncActivity`），401 自动 retry 一次。refresh 后仍 401 → redirect `/login`。

当前 `authStore.ts` 已经**去掉 dev/prod 分支**（ADR 0017）：两个环境都相对 `/api/auth/*`，
same-origin 经前门转发，不再用 `VITE_AUTH_BASE_URL` 绝对量直连 auth-service。

> **前门 = stride-web BFF（域名切换已完成）**：用户域名 `stride-running.cn` 已翻到 `stride-web`，
> 由它的 Node BFF 作为唯一前门，把 `/api/auth/*` 转发到 `AUTH_UPSTREAM_URL`（auth-service），
> 其它 `/api/*` 按版本化路由表转发到 `PYTHON_API_URL`（stride-app）或 `GO_API_URL`（stride api）。**stride-app 已不再服务 SPA / 不再是 web 前门**：
> `mount_frontend` / `static.py` 及短暂存在过的 `routes/auth_proxy.py` fallback 反代都已随 ADR 0017
> 收尾清理移除。浏览器永不直接打 stride-app 的 `/api/auth/*`，所以老后端无需 auth 反代。


> **Planned（ADR 0017）**：前端剥离为 `stride-web` 后，`/api/auth/*` **两个环境都经前端 BFF**
> 转发到 `AUTH_UPSTREAM_URL`，全链路 same-origin。`authStore.ts` 去掉 dev/prod 分支，永远
> 相对 `/api/auth`；浏览器不再跨域直连 auth-service。届时 auth-service 的 CORS 可收紧为只认
> BFF 服务端。token 模型（`sessionStorage` + Bearer）不变。

### 6. Go team API 的 auth-service dependency（ADR 0026）

Go team API 不拥有 team / membership 数据。它先在 Go API 边界完成现有 JWT 验证，再把浏览器传入的完整 `Authorization` header **原样转发**给 auth-service；不要提取 token 后重建 header，也不要用 service credential 代替终端用户身份。auth-service 负责 team ownership / membership 的 canonical 授权，Go 只使用返回的 member IDs 查询 MySQL activities / profiles / `team_likes`。

`stride api` 必须配置 `api.auth-service-url`（env override：`STRIDE_WORKER_API_AUTH_SERVICE_URL`）。这个值为空、auth-service 网络不可达、或 auth-service 返回 5xx 时，Go team surface 不能仅凭本地验签继续提供完整功能；所有依赖 auth-service 的 team 请求返回 `503`，不会伪装成空集合。BFF 的 `AUTH_UPSTREAM_URL` 只服务浏览器 `/api/auth/*`，不能替代 Go API 自己到 auth-service 的 server-to-server 地址。

### 7. 还没做的（非阻塞 follow-up）

- 给 auth-service 加 JWKS 端点，公钥轮换变成网络可发现，不用两边同时改 env var
