# Frontend (STRIDE Dashboard) + API 路由清单

**何时读**：改 `frontend/`、加 API 路由、或调 SPA / FastAPI 接合处时必读。

## 一句话

React + Vite + TypeScript SPA 在 `frontend/`。Light theme，monospace-heavy。共享 sidebar navigation 用 `AppLayout`。

> **当前部署**：前端是**静态容器 `stride-web`**（无 Node/Hono BFF）。Caddy 是唯一流量入口：
> `stride-running.cn` → 前端容器（静态 SPA），`api.stride-running.cn` → 各后端
> （Go/Python/auth）。页面仍 CSR，token 模型不变。SPA 的 API origin 由构建期
> `VITE_API_BASE_URL` 烘焙（`src/lib/apiRouting.ts`）；浏览器跨域直连 `api.stride-running.cn`，
> 网关需对 `https://stride-running.cn` 放行 CORS。`stride-app` 现在是 API-only，以下
> FastAPI+SPA 说明只保留为历史 fallback。

## Pages

| Route | Component | 说明 |
|-------|-----------|------|
| `/` | `WeekLayout` | 主视图 —— 侧栏列周，主区 plan/activities/feedback tabs |
| `/week/:folder` | `WeekLayout` | 指定周视图 |
| `/activity/:id` | `ActivityDetailPage` | 活动详情 —— metrics / HR/pace charts / zones / segment / sport_note |
| `/health` | `HealthPage` | Fatigue / HRV / RHR / 训练负荷 趋势（recharts） |
| `/plan` | `TrainingPlanPage` | 当前赛季训练计划；一次统一请求，支持 Markdown 与结构化展示 |
| `/coach` | `CoachChatPage` | 日常 Coach 问答；两栏布局，固定 `web-default` 长期会话 |
| `/coach/week/:folder/adjust` | `WeeklyPlanAdjustPage` | 本周课表调整与整单 Diff Review；三栏布局 |
| `/coach/master/:planId/adjust` | `MasterPlanAdjustPage` | 赛季训练计划调整与整单 Diff Review；三栏布局 |
| `/login` | `LoginPage` | Auth（Entra ID / MSAL） |

## API Layer (`src/stride_server/`)

生产中的 `stride-app` 只服务 REST API；本地 Python backend 入口仍是 `stride_server.main:app`（跑 `uvicorn stride_server.main:app`）。以下是其三个包的组成；其旧 SPA 静态挂载不再是生产前端路径：

- **`stride_core/`** —— 共享数据层：DB schema、models、analyze/export helpers、`DataSource` protocol (`stride_core/source.py`)。source-agnostic —— 不 import `coros_sync`。
- **`coros_sync/`** —— COROS-specific adapter + CLI。`coros_sync/adapter.py::CorosDataSource` 实现 `DataSource`。
- **`stride_server/`** —— FastAPI 路由分在 `routes/{users,activities,weeks,sync,training_plan,health}.py`。路由通过 `Depends(get_source)` 访问 sync adapter —— 永远不直接 import `coros_sync`。组合发生在 `stride_server/main.py`（`create_app(CorosDataSource())`），一次。

## Key endpoints

- `GET /api/users` —— list user profiles (`routes/users.py`)
- `GET /api/{user}/activities` —— 分页活动列表 + 过滤 (`routes/activities.py`)
- `GET /api/{user}/activities/{id}` —— 活动详情（laps / segments / zones / timeseries）
- `POST /api/{user}/activities/{id}/resync` —— 从 COROS 重拉单个活动（拿更新的 feedback）
- `GET /api/{user}/weeks` / `GET /api/{user}/weeks/{week_name}`（Go `cmd/api`）—— training-week summary/detail；详情使用规范化 `week_name`
- `GET /api/{user}/plan/weeks` / `GET /api/{user}/plan/weeks/{week_name}`（Go `cmd/api`）—— active 本周课表元数据列表与详情；新接口以规范化周名称替代 legacy folder
- `GET /api/users/{user_id}/master-plan/current` —— Go/MySQL 按用户统一返回当前赛季训练计划；Web 从登录 JWT 的 `sub` 构造 `user_id`。普通用户只能读取自己的 `user_id`，admin JWT 和 internal token 可跨用户读取；`/api/users/me/master-plan/current` 仅作为后端兼容别名保留。`content_version=1` 的 `plan` 是 Markdown 且 `revision=null`，`content_version=2` 的 `plan` 是结构化内容且 `revision>=1`。只有 404 表示尚无计划；其他失败由 Web 显示读取错误。
- `POST /api/users/{user_id}/master-plan`（Go `cmd/api`）—— 将校验通过的 structured Master Plan 应用到目标用户，仅 admin JWT（TierAdmin）可调用，TierUser / internal token 均 `403`。替换激活计划必须带 `replace_existing: true` 以及确认过的 `expected_active_plan_id` + `expected_active_revision`，服务端原子归档旧行并插入 revision 1 新行；未带则 `409 master_plan_exists`，revision 不匹配则 `409 master_plan_changed`。请求 `content` 须满足结构化计划契约（`goal.goal_id` 为 UUID，且 phases/weeks/milestones 等结构合法，否则 `422 invalid_content`），请求体超 1 MiB 返回 `413 master_plan_too_large`。
- `PATCH /api/users/{user_id}/master-plan`（Go `cmd/api`）—— 原地更新激活中的 structured Master Plan：**plan_id 不变**，仅内容 / goal / revision 更新（revision + 1），不产生新行。仅 admin JWT（TierAdmin）可调用。必须携带确认过的 `expected_active_plan_id` + `expected_active_revision`（乐观并发），不匹配返回 `409 master_plan_changed`；无激活计划返回 `404 master_plan_not_found`；legacy markdown active 计划无法 PATCH（`409`），改用 POST apply 替换。`content` 校验规则同 POST。
- `GET /api/{user}/dashboard` / `/health` / `/pmc` / `/stats` —— fitness & health (`routes/health.py`)
- `POST /api/{user}/sync` —— 经配置的 `DataSource` 触发完整 sync (`routes/sync.py`)
- `POST /api/users/me/coach/chat` —— 固定 session 的 Coach 对话；请求带 `client_turn_id`，计划工作区额外带 typed `target`
- `GET /api/users/me/coach/sessions/{session_id}/messages` —— JWT 派生 thread 的对话历史；普通/debug 用户按 capability 过滤内部轨迹
- `POST /api/users/me/coach/plan/{folder}/apply` —— 整单启用本周课表创建/调整，校验 fingerprint 与赛季影响确认；`session_id` 绑定 trusted event 会话
- `POST /api/users/me/coach/master-plan/{plan_id}/apply` —— 整单启用赛季训练计划调整，校验 plan version；`session_id` 绑定 trusted event 会话
- `POST /api/users/me/coach/proposals/abandon` —— 记录用户放弃调整方案的 trusted event；`session_id` 决定写入的长期会话

当前赛季计划的无凭据浏览器回归用自包含 fixture（本地静态 SPA + 本地 fixture API，无需 BFF/上游）：`cd frontend && npm run smoke:plan:fixture`。它覆盖结构化、Markdown、404 创建页和读取错误四种状态。

## Profile cutover target

- Go `GET`/`POST`/`PATCH /api/users/me/profile` owns the five core profile fields plus `running_age_range`.
- Injury history is a separate Go resource under `/api/users/me/injuries`; it is not embedded in profile PATCH.
- Weekly mileage and PBs are derived from watch data, not user-declared profile fields.
- Web plan setup no longer calls Python `running-profile`, `full-sync`, or `full-sync-status`. It saves the race goal, waits for a Go incremental `data_sync` Pipeline Run, then starts the existing season-plan generation flow.
- Python season-plan generation remains unchanged and is outside this Go cutover. Detailed route contract: [`spec/go-profile-sync-cutover.md`](../spec/go-profile-sync-cutover.md).

## Segment Display

活动 segment 用 `exercise_type` 映射展示名（热身/训练/放松/恢复）。已知 COROS exercise code（T-codes for strength，S-codes for rest）的名字来自 `_EXERCISE_NAMES` dict。未知 S-code（如 running workout plan 引用 S4208）fallback 到 `exercise_type` 映射。

## Weekly Feedback

rollout marker 前，"本周反馈" tab 仍兼容 Python/legacy 保存响应；marker 后
读取并整体保存 MySQL `weekly_feedback`。活动 `sport_note` 始终随活动展示，
不拼接进周反馈；marker 后 legacy `feedback.md` 只用于迁移。
