# Frontend (STRIDE Dashboard) + API 路由清单

**何时读**：改 `frontend/`、加 API 路由、或调 SPA / FastAPI 接合处时必读。

## 一句话

React + Vite + TypeScript SPA 在 `frontend/`。Light theme，monospace-heavy。共享 sidebar navigation 用 `AppLayout`。

> **当前部署（ADR 0017）**：前端已拆为独立服务/容器 `stride-web` = 静态 SPA + Node/Hono
> 前端 BFF。页面仍 CSR，token 模型不变。BFF 用版本化 TS **API 路由表** 把 `/api/*` 分流到
> Python（`stride-app`）或 Go（Tencent `stride api`），`/api/auth/*` 也经 BFF 走 auth 上游。默认
> 为 same-origin；配置 `PUBLIC_DIRECT_BASE_URL` 时，SPA 可按同一 manifest 直连 Tencent-bound
> auth/Go routes。`stride-app` 现在是 API-only，以下 FastAPI+SPA 说明只保留为历史 fallback。

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
- `GET /api/users/me/master-plan/current` —— Go/MySQL 统一返回当前赛季训练计划；`content_version=1` 的 `plan` 是 Markdown 且 `revision=null`，`content_version=2` 的 `plan` 是结构化内容且 `revision>=1`。只有 404 表示尚无计划；其他失败由 Web 显示读取错误。
- `GET /api/{user}/dashboard` / `/health` / `/pmc` / `/stats` —— fitness & health (`routes/health.py`)
- `POST /api/{user}/sync` —— 经配置的 `DataSource` 触发完整 sync (`routes/sync.py`)
- `POST /api/users/me/coach/chat` —— 固定 session 的 Coach 对话；请求带 `client_turn_id`，计划工作区额外带 typed `target`
- `GET /api/users/me/coach/sessions/{session_id}/messages` —— JWT 派生 thread 的对话历史；普通/debug 用户按 capability 过滤内部轨迹
- `POST /api/users/me/coach/plan/{folder}/apply` —— 整单启用本周课表创建/调整，校验 fingerprint 与赛季影响确认；`session_id` 绑定 trusted event 会话
- `POST /api/users/me/coach/master-plan/{plan_id}/apply` —— 整单启用赛季训练计划调整，校验 plan version；`session_id` 绑定 trusted event 会话
- `POST /api/users/me/coach/proposals/abandon` —— 记录用户放弃调整方案的 trusted event；`session_id` 决定写入的长期会话

当前赛季计划的无凭据浏览器回归使用真实 BFF 路由和本地 fixture 上游：`cd frontend && npm run smoke:plan:fixture`。它覆盖结构化、Markdown、404 创建页和读取错误四种状态。

## Profile cutover target

- Go `GET`/`POST`/`PATCH /api/users/me/profile` owns the five core profile fields plus `running_age_range`.
- Injury history is a separate Go resource under `/api/users/me/injuries`; it is not embedded in profile PATCH.
- Weekly mileage and PBs are derived from watch data, not user-declared profile fields.
- Web plan setup no longer calls Python `running-profile`, `full-sync`, or `full-sync-status`. It saves the race goal, waits for a Go incremental `data_sync` Pipeline Run, then starts the existing season-plan generation flow.
- Python season-plan generation remains unchanged and is outside this Go cutover. Detailed route contract: [`spec/go-profile-sync-cutover.md`](../spec/go-profile-sync-cutover.md).

## Segment Display

活动 segment 用 `exercise_type` 映射展示名（热身/训练/放松/恢复）。已知 COROS exercise code（T-codes for strength，S-codes for rest）的名字来自 `_EXERCISE_NAMES` dict。未知 S-code（如 running workout plan 引用 S4208）fallback 到 `exercise_type` 映射。

## Weekly Feedback

"本周反馈" tab 合并两个来源：
1. 周 logs 目录下的 `feedback.md`
2. 该周 DB activities 的 `sport_note`（前 20 字符 dedupe 已有 feedback）
