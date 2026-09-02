## Frontend local verification (HARD)

改 `frontend/` 且影响页面、路由、auth、API 请求或用户工作流时，收尾必须跑真实本地浏览器 smoke，不能只跑 unit test / build。

前端是**静态容器**（无 BFF）。本地 dev 用 Vite 起 SPA，SPA 用相对 `/api/*`，Vite dev server 服务端代理到 API 网关（`VITE_DEV_API_PROXY=...`，默认 `https://api.stride-running.cn`），因此浏览器不做跨域调用：

1. 启动：`cd frontend && npm run dev:web:local`（Vite 跑 `:5174`）。
2. 用 Playwright 跑：`cd frontend && npm run smoke:web:local`（打 Vite 的 `http://127.0.0.1:5174`）。

`smoke:web:local` 从仓库根目录 `.credentials.local` 读取真实账号；如果当前 checkout 是 git worktree 且 worktree 根目录没有 `.credentials.local`，去主仓库目录找同名文件。不能把 email / password / token 打到回复或日志里。它必须完成登录、打开 `/activities`、并点进一个 `/activity/:id` 详情页确认数据可见。登录失败先查浏览器 console/network。

auth 经同一 API 网关：SPA 的 API origin 由构建期 `VITE_API_BASE_URL` 烘焙（`src/lib/apiRouting.ts`）。本地 dev 该值为空 → 相对 `/api/auth` → Vite 代理到网关；生产构建烘焙为 `https://api.stride-running.cn`，浏览器直接跨域调用网关（网关必须对 `https://stride-running.cn` 放行 CORS）。
