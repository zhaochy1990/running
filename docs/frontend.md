# Frontend (STRIDE Dashboard) + API 路由清单

**何时读**：改 `frontend/`、加 API 路由、或调 SPA / FastAPI 接合处时必读。

## 一句话

React + Vite + TypeScript SPA 在 `frontend/`。Light theme，monospace-heavy。共享 sidebar navigation 用 `AppLayout`。

## Pages

| Route | Component | 说明 |
|-------|-----------|------|
| `/` | `WeekLayout` | 主视图 —— 侧栏列周，主区 plan/activities/feedback tabs |
| `/week/:folder` | `WeekLayout` | 指定周视图 |
| `/activity/:id` | `ActivityDetailPage` | 活动详情 —— metrics / HR/pace charts / zones / segment / sport_note |
| `/health` | `HealthPage` | Fatigue / HRV / RHR / 训练负荷 趋势（recharts） |
| `/plan` | `TrainingPlanPage` | overall training plan + phase 时间轴 |
| `/coach` | `CoachChatPage` | 日常 Coach 问答；两栏布局，固定 `web-default` 长期会话 |
| `/coach/week/:folder/adjust` | `WeeklyPlanAdjustPage` | 本周课表调整与整单 Diff Review；三栏布局 |
| `/coach/master/:planId/adjust` | `MasterPlanAdjustPage` | 赛季训练计划调整与整单 Diff Review；三栏布局 |
| `/login` | `LoginPage` | Auth（Entra ID / MSAL） |

## API Layer (`src/stride_server/`)

FastAPI backend 同时服务 REST API 和构建好的 frontend（SPA 静态文件）。入口 `stride_server.main:app`（跑 `uvicorn stride_server.main:app`）。app 是三个包的组合：

- **`stride_core/`** —— 共享数据层：DB schema、models、analyze/export helpers、`DataSource` protocol (`stride_core/source.py`)。source-agnostic —— 不 import `coros_sync`。
- **`coros_sync/`** —— COROS-specific adapter + CLI。`coros_sync/adapter.py::CorosDataSource` 实现 `DataSource`。
- **`stride_server/`** —— FastAPI 路由分在 `routes/{users,activities,weeks,sync,training_plan,health}.py`。路由通过 `Depends(get_source)` 访问 sync adapter —— 永远不直接 import `coros_sync`。组合发生在 `stride_server/main.py`（`create_app(CorosDataSource())`），一次。

## Key endpoints

- `GET /api/users` —— list user profiles (`routes/users.py`)
- `GET /api/{user}/activities` —— 分页活动列表 + 过滤 (`routes/activities.py`)
- `GET /api/{user}/activities/{id}` —— 活动详情（laps / segments / zones / timeseries）
- `POST /api/{user}/activities/{id}/resync` —— 从 COROS 重拉单个活动（拿更新的 feedback）
- `GET /api/{user}/weeks` / `GET /api/{user}/weeks/{folder}` (`routes/weeks.py`) —— training-week plan/feedback/activities
- `GET /api/{user}/training-plan` —— TRAINING_PLAN.md 内容 + 解析后的 phase 时间轴 (`routes/training_plan.py`)
- `GET /api/{user}/dashboard` / `/health` / `/pmc` / `/stats` —— fitness & health (`routes/health.py`)
- `POST /api/{user}/sync` —— 经配置的 `DataSource` 触发完整 sync (`routes/sync.py`)
- `POST /api/users/me/coach/chat` —— 固定 session 的 Coach 对话；请求带 `client_turn_id`，计划工作区额外带 typed `target`
- `GET /api/users/me/coach/sessions/{session_id}/messages` —— JWT 派生 thread 的对话历史；普通/debug 用户按 capability 过滤内部轨迹
- `POST /api/users/me/coach/plan/{folder}/apply` —— 整单启用本周课表创建/调整，校验 fingerprint 与赛季影响确认；`session_id` 绑定 trusted event 会话
- `POST /api/users/me/coach/master-plan/{plan_id}/apply` —— 整单启用赛季训练计划调整，校验 plan version；`session_id` 绑定 trusted event 会话
- `POST /api/users/me/coach/proposals/abandon` —— 记录用户放弃调整方案的 trusted event；`session_id` 决定写入的长期会话

## Segment Display

活动 segment 用 `exercise_type` 映射展示名（热身/训练/放松/恢复）。已知 COROS exercise code（T-codes for strength，S-codes for rest）的名字来自 `_EXERCISE_NAMES` dict。未知 S-code（如 running workout plan 引用 S4208）fallback 到 `exercise_type` 映射。

## Weekly Feedback

"本周反馈" tab 合并两个来源：
1. 周 logs 目录下的 `feedback.md`
2. 该周 DB activities 的 `sport_note`（前 20 字符 dedupe 已有 feedback）
