## Frontend local verification (HARD)

改 `frontend/` 且影响页面、路由、auth、API 请求或用户工作流时，收尾必须跑真实本地浏览器 smoke，不能只跑 unit test / build。

自 stride-web 剥离（ADR 0017）起，本地默认走 **BFF 在 Vite 前**的高保真流程，使 dev 的每个 `/api/*` 都经前端 BFF 的路由表（Python/Go strangler seam）：

1. 装 BFF 依赖（首次）：`cd frontend/server && npm install`。
2. 启动：`cd frontend && npm run dev:web:local`（Vite 跑 `:5173`，BFF 跑 `:8080` 并 front Vite；HMR 经 `VITE_HMR_CLIENT_PORT` 直连 Vite）。
3. 用 Playwright 跑：`cd frontend && npm run smoke:web:local`（打 BFF 的 `http://127.0.0.1:8080`）。

`smoke:web:local` = `smoke:local` + `STRIDE_LOCAL_URL=http://127.0.0.1:8080`；两者都从仓库根目录 `.credentials.local` 读取真实账号；如果当前 checkout 是 git worktree 且 worktree 根目录没有 `.credentials.local`，去主仓库目录找同名文件。不能把 email / password / token 打到回复或日志里。它必须完成登录、打开 `/activities`、并点进一个 `/activity/:id` 详情页确认数据可见。登录失败先查浏览器 console/network。

auth 现在**同源经 BFF**（`authStore.ts` 不再有 dev/prod 分支，永远相对 `/api/auth`），BFF 把 `/api/auth/*` 转发到 `AUTH_UPSTREAM_URL`，避免浏览器 CORS。

纯 UI 内循环（不需要验证路由表）仍可用旧的 `npm run dev:frontend:local` + `npm run smoke:local`（Vite `:5173` 直接代理 `/api`，不经 BFF）；`STRIDE_LOCAL_URL` 覆盖实际地址。
