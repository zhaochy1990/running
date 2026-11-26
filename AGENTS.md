# AGENTS.md

This file is the **single source of agent instructions** for this repository. It
provides guidance to coding agents (Claude Code, Codex, OpenCode, and any other
agent) when working with code here. `CLAUDE.md` (and any other agent-specific
instruction file) references this file instead of duplicating rules, so there is
exactly **one** set of instructions to follow.

除非特别说明，否则一律用中文回复用户，不管用户发送的是中文还是英文

---

## Agent skills

### Issue tracker

Issues and PRDs are tracked in the shared tracker repo `zhaochy1990/stride-devops` (project label `project:running`, all gh calls with `-R`). See `docs/agents/issue-tracker.md`.

### `to-spec` / `to-tickets` 开票环境

| 工作范围 | 开发与验收环境 |
| --- | --- |
| 后端（API、worker、存储等） | 云端开发和测试。按需用 Docker 启动数据库、消息队列（MQ）、Redis 等依赖。 |
| Web | 云端开发和测试，用 Chromium 预览页面并验收交互。 |
| 微信小程序 | 本机开发，用本机微信开发者工具模拟器验收。 |
| iOS App | 本机开发，用本机 Xcode 的 iOS Simulator 验收。 |

云端任务可使用 Codex Cloud 中的 `running` 或 `Coach Agent` 环境。

- `to-spec` 在规格工单的实施与测试决策里，逐项写明开发范围、执行环境、所需依赖和验收方式。涉及云端与本机时，写清各自交付范围和共用的 API 契约。
- `to-tickets` 在每张实现票正文写明 **开发与测试环境**（云端或本机），并在验收标准里列明对应的测试入口（API 测试、Chromium 或本机模拟器）。跨环境功能按环境拆票，纵向切片以单一环境为边界，每张票都能在指定环境独立交付和验收。只为实际前置依赖建立工单阻塞关系，例如客户端交付依赖尚未可用的 API。

### Triage labels

Use the canonical labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This repo uses a single-context domain-doc layout. See `docs/agents/domain.md`.

### Design changes

设计变更确认后，在同一任务内同步更新受影响的设计文档，包括正文、架构图、ER 图、接口示例和验收标准。已有设计在工单中维护时，同步更新对应工单。完成前核对各处的术语、字段、关系与行为一致。

---

## Go HTTP 服务（HARD）

`src/go/` 是 Go 模块（`github.com/zhaochy1990/stride`，Tencent 部署的 async-job worker + sync CLIs + **承载全部客户端请求的 API server**）。`src/go/internal/api/` 是**唯一面向客户端（小程序 / Web / 手机）的生产 API**，为 `https://api.stride-running.cn` 提供后端；**所有 HTTP 请求一律走 Go API，不再有 Python API 承担客户端请求**。**唯一例外是 `coach_agent_api`（TS）承担的教练对话**：Caddy 网关把 `/api/users/me/coach/*` 分流到该 TS 服务，Go API 不实现这些路由（见上方 Prod API endpoint）。**所有 Go HTTP 服务统一用 [gin](https://github.com/gin-gonic/gin)**（`cmd/api`、`internal/health` liveness 探针，以及后续任何 HTTP server / handler），不要用 chi / echo / 裸 `net/http` router —— 无例外。

---

## Topic-specific docs（按需 Read）

写代码 / 文档前，按任务类型主动 Read 对应文件：

| 任务 | 必读 |
|------|------|
| 写 / 改 weekly `plan.json` | [`docs/plan-json-schema.md`](docs/plan-json-schema.md) —— HARD 校验 gate |
| 写 plan.md 里的力量动作 / 调 strength push | [`docs/strength-training.md`](docs/strength-training.md) |
| 分析疲劳 / TSB / HRV / 训练负荷 | [`docs/fatigue-metrics.md`](docs/fatigue-metrics.md) |
| 读 / 写周反馈，引用 RPE 或 feel_type | [`docs/feedback-md.md`](docs/feedback-md.md) |
| 跑 coros-sync CLI / 改 sync 代码 / 直查 DB | [`docs/coros-cli.md`](docs/coros-cli.md)（`src/coros_sync/` 待删除，勿新增依赖） |
| 改 Coach Agent（TS，`src/coach_agent/*`） | [`src/coach_agent/AGENTS.md`](src/coach_agent/AGENTS.md) —— TS Coach Agent 为准；含 DeepSeek Responses API 踩坑清单（LLM 直连/结构化输出/SDK 升级必读） |
| Auth wiring / Bearer / 401 排障 | [`docs/auth-wiring.md`](docs/auth-wiring.md) |
| Docker / CI/CD / reparse webhook | [`docs/deployment.md`](docs/deployment.md) |
| Frontend pages / API 路由清单 | [`docs/frontend.md`](docs/frontend.md) |

---

## Storage scope rule (HARD)

**腾讯云 MySQL 是生产环境用户运动与健康数据的 canonical source**，包括 activities、laps、zones、timeseries、daily_health、dashboard、race predictions、ability snapshots、structured planned sessions/nutrition、weekly plans 和 scheduled workouts。`data/{user_id}/coros.db` 仅用于遗留迁移、专项调试或测试 fixture；生成 weekly plan 时不得把它当作数据源，也不得在 MySQL 不可用时静默 fallback 到 SQLite。

用正确的后端：

| Data shape | Backend |
|------------|---------|
| 用户运动、健康和训练计划数据 | **腾讯云 MySQL**（应用代码经 `src/go/internal/storage/`） |
| Go API 持久化数据（含跨用户 social signals、preferences、push registrations） | **MySQL**（经 `src/go/internal/storage/`） |
| Bulk binary blobs (photos, video, large export files) | **Azure Blob Storage**（经非客户端 Python 运行时，见下） |
| 用户图片文件（头像 avatar image、活动路线缩略图 route thumbnail） | **腾讯云 COS**（对象存储 + CDN；头像经应用侧媒体上传接口，缩略图由 worker 生成上传，DB 只存 URL 字段 `avatar_url` / `route_thumb_url`） |
| Authoring artifacts (plan.md, TRAINING_PLAN.md) | **Markdown files in `data/{user_id}/logs/`**（仅本地，不同步到任何远端）；weekly plan 草稿遵守下方人工 review 门禁，发布走受支持的 MySQL 写接口 |
| 周反馈 | rollout 前沿用 legacy `feedback.md`；`STRIDE_WEEKLY_FEEDBACK_CUTOVER_COMPLETE=true` 后以 **腾讯云 MySQL `weekly_feedback`** 为唯一来源 |
| Go API auth tokens / secrets | **MySQL**（经 `src/go/internal/storage/`） |
| Python 遗留运行时（旧 worker 等）的 auth tokens / secrets | **Azure Key Vault** |

**Go API 的所有持久化状态统一落 MySQL**，不要为 Go API 新增 Azure Table、Azure Blob、Azure Files 或 Key Vault 存储依赖；**唯一例外是用户图片文件**——头像与活动路线缩略图的二进制不经 MySQL，存腾讯云 COS（对象存储 + CDN），MySQL / auth-service 只存 URL 字段（`avatar_url` / `route_thumb_url`）；缩略图是可由 activities + timeseries 重新生成的派生物，不是 canonical 数据。**Python 仓库内包 `stride_server/`、`stride_storage/`、`stride_core/`、`coros_sync/`、`coach/`（旧 Python Coach Agent，已被 TS `coach_agent` 取代）全部标记为待删除（legacy / to-be-removed）**：不再承担任何来自小程序 / Web / 手机的客户端请求，也不应在新增代码中被依赖；新代码一律走 Go API → MySQL。这些包仅在迁移、遗留 CLI、测试 fixture 等暂时保留的路径里使用（如 `garmin_sync/` 仍引用 `coros_sync/`）。`src/coach_cli/` 已删除，不要引用。遗留 SQLite 的迁移或调试任务必须与 weekly plan authoring 流程隔离。likes_store 是 Python two-backend 文件（dev JSON / prod Azure Table）+ `DefaultAzureCredential`，不要把它用于 Go API。

### SQL ownership rule (HARD)

只有各运行时的 storage 包允许直接写 SQL 读取 / 修改数据库：Python `src/stride_storage/`（**待删除**，仅遗留路径使用；客户端请求不经过 Python）、Go `src/go/internal/storage/`（**客户端请求唯一数据路径**）、TypeScript Coach API `src/coach_agent_api/src/persistence/`（checkpoint/store/turn receipt 写入与 thread lock）与 `src/coach_agent_worker/src/data/`（只读 `DataProvider` adapter，coach 服务与 worker 共用）。**训练计划任务的 job 状态不是 TS 侧的表**（ADR 0033）：`jobs` 行由 Go 拥有，coach API 与 worker 只能经 Go internal API（`/api/internal/jobs*`）读写，不得直连该表；worker 不持有该库的连接。`src/coach_agent/` 核心只定义只读 `DataProvider` interface，不依赖数据库客户端。其它包（`stride_server/`〔待删除〕、`coach/`〔待删除，旧 Python Coach Agent〕、`stride_core/`〔待删除〕、routes、scripts 等）需要数据时必须调用对应 storage 包暴露的 API / repository / store 方法；缺方法就先在 storage 层增加一个语义明确的方法，并补 storage 层测试。

禁止在非 storage 包里新增：`db._conn.execute(...)`、`conn.execute(...)`、裸 SQL 字符串查询表、或为了绕开缺失 API 直接打开 SQLite 连接。例外只限：已有 legacy 代码的迁移前状态；`src/migration/` 下不进入应用运行时的一次性数据迁移脚本；以及下方 weekly plan authoring 流程中使用 prod readonly 账号执行的临时 MySQL CLI 查询。一次性迁移必须默认 dry-run，只处理 `src/migration/src/users.js` 中的真实用户，写入采用条件更新或等价幂等策略，支持限定范围和限流，并在提交前完成本地 dry-run、有限写入、源数据回读比对与重复运行验证。weekly plan CLI 例外不得写入应用代码或持久化为脚本。改到其它 legacy 代码时要顺手收敛到 storage API，不能扩大直接 SQL 面。

## Timezone discipline (HARD)

所有数据库时间戳列存 **UTC ISO 8601**。所有面向用户的日 / 周分类是 **Asia/Shanghai (UTC+8, 无 DST)**。混用会把 00:00–07:59 上海窗口静默错分到错误日期。

**Canonical helpers**：

- Python: `src/stride_core/timefmt.py` —— `utc_iso_to_shanghai_iso()`, `today_shanghai()`, `SHANGHAI_DAY_SQL`, `shanghai_day_to_utc_range()`, `shanghai_week_range()`, `SHANGHAI_TZ`
- TypeScript (frontend): `frontend/src/lib/shanghai.ts` —— `shanghaiDate()`, `shanghaiMonthDay()`, `shanghaiTime()`, `shanghaiToday()`, `shanghaiWeekday()`
- TypeScript (coach backend): `@stride/contract` `src/coach_contract/src/date.ts` —— `shanghaiDay()` / `shanghaiIso()`；活动日归属一律读 Provider 算好的 `Activity.shanghaiDay`（devops#936），下游禁止自算 +8h

**禁用 patterns**（由 `tests/test_timezone_invariants.py` 校验）：

| 别这么写 | 用这个 |
|---|---|
| `WHERE date >= '2026-05-09'` against `activities.*` | `WHERE date(datetime(date, '+8 hours')) >= ?`（用 `SHANGHAI_DAY_SQL`） |
| `date.today()` / `datetime.now()`（无 `tz=`） | `today_shanghai()` from `stride_core.timefmt` |
| `r["date"][:10]` in route serializers | `utc_iso_to_shanghai_iso(r["date"])` 再 slice —— 或 SQL 里 alias `date(datetime(date, '+8 hours')) AS shanghai_date` |
| `activity.date.slice(0, 10)` in React | `shanghaiDate(activity.date)` from `lib/shanghai` |
| coach TS 里对 `Activity.date` 自算 +8h 取日 | 读 Provider 字段 `Activity.shanghaiDay`（devops#936；换算只在 `rowToActivity` 一处） |
| `new Date().getFullYear()` 等表示"今天" | `shanghaiToday()` |

**API 边界规则**：Go API 的 activity 序列化（`src/go/internal/api/`，经 `internal/apifmt`）MUST 在每个 activity 行输出前把 `date` 转成上海 ISO（等价于 Python 的 `utc_iso_to_shanghai_iso()`）。这就是 frontend `.slice(0, 10)` "刚好能用"的原因 —— offset 转过，instant 保留。`stride_server/`（Python FastAPI 客户端 API 层）**标为待删除**，不承担客户端请求。

`tests/test_timezone_invariants.py` 失败时几乎总是 fix 是 import + 用上面 helper 之一，不是把文件加 whitelist。该 test 里的 `WHITELIST` dict 是给真正操作 Shanghai-local 列（`weekly_plan.date_from`、`daily_health.date` YYYYMMDD）的文件 —— 顺手加项需要 code-review 理由。

## Athlete baseline metrics — single source (HARD)

生产基线算法的 canonical owner 是 **`src/go/internal/compute/calibration/`**，持久化与版本 policy 由 **`src/go/internal/storage/`** 拥有。Python `src/stride_core/running_calibration/` 是冻结的遗留对照，仅迁移/测试使用；新增基线逻辑在 Go 原域扩展。本文取代 ADR 0015 中“先 Python 后 Go”的基线开发约定；冻结 v3 算法源码和 golden 不改。

消费 HRmax、RHR、阈值、CP 与 zones 时，调用 `ReadEffectiveRunningCalibration(user, Shanghai cutoff day, active)` 一次读取同一 snapshot 的完整 bundle；Coach TS adapter 读取同一条 MySQL policy 并遵守同样规则。#999 起该 resolver 先看该用户 active 的 `running_calibration_user_override`（pin (version, revision)，读时 revision 进 WHERE；缺失回落 global 并报 `override_snapshot_missing`；candidate 读不受影响）——Go 与 TS 是同一 policy 的仅有的两个实现，`calibrationPolicyContract.json` 钉住共享常量。单用户发布/回退/重算走内部 `user_calibration` job 或 `stride calibration user *` CLI（三门槛授权另行才有；全局 policy 与其他用户永不被这些入口改动）。逐活动计算按活动上海日读，缺历史返回显式 unavailable，保留原派生值，随后由明确历史校准/重算任务处理。普通 GET / Coach 读取保持只读。

默认 active=3、candidate=4、fallback=3；只有首选版本缺行才回退，已有候选行但中心缺失仍保留候选语义。生产候选持久化默认关闭；隔离 preview 仅返回内存结果。校准发布、同日 ID 兼容、冻结派生来源、重算顺序与 rollback 边界，见 [ADR 0045](docs/adr/0045-calibration-policy-bundles-and-lineage.md)。改基线读写、版本、历史消费或来源解释时必须读该 ADR 和 [客户端解释契约](docs/calibration/client-explanation-contract.md)。

v4 演进（SPEC #993，2026-11-16 拍板）**不开新顶层身份**：新旧 v4 输出以快照/lineage 中的算法修订标记区分（`algorithm_revision` 列进快照唯一键，历史 v4 行 revision 为空且不覆写），估计契约与评估协议 v2 冻结在 [estimation-contract-v2.md](docs/calibration/estimation-contract-v2.md) / [evaluation-protocol-v2.md](docs/calibration/evaluation-protocol-v2.md)；改 v4 行为必须先读这两份。

所有长期个体基线都经该 reader 消费，不在 route / Coach / ability 另算 RHR 分位数，不用 magic HRmax=185，不创建平行 baseline 包。onboarding 的新用户 seed prefill 语义不同，仍可保留明确注释。

## 不要重复造轮子（一般原则）

加 helper / 算法 / 工具函数前，先在仓库 grep 同名 / 同概念实现。遇到现有实现质量不够 —— 修它，不要绕开新写一个。"两份功能相同的代码并存"在 review 里直接打回。这条规则的具体应用：上面的 Athlete baseline 单源，以及 [Timezone helpers](#timezone-discipline-hard) 单源。

## Workout / plan 契约 — canonical = coach_contract（Python stride_core 冻结）

「一次训练课」（run-workout/v1 / strength-workout/v1，ADR 0043）与 weekly / master plan 的结构契约，canonical 来源是 **TS `src/coach_contract/src/`**（`workout/`、`weekly_plan/`、`master_plan/`）；对外 JSON Schema 由 `generate-weekly-plan-schema.mjs` 生成进 `src/go/internal/api/`。Python `src/stride_core/`（`plan_spec.py` / `workout_spec.py` 等）**冻结只读**：不再新增或修改契约字段，仅供遗留迁移路径使用；路由与 import 不动。契约演化一律改 coach_contract，Go（embedded schema + `internal/provider` 类型）与各客户端随后对齐。

---

## Working Model summary

- **腾讯云 MySQL** 是生产用户运动、健康和正式训练计划的 canonical data store。
- **Local machine** 是训练计划的 **author/review** 环境：coding agent 从 prod MySQL 只读获取最新数据，在 `data/{user_id}/logs/` 生成 `plan.md` / `plan.json` 草稿。
- 生成阶段只允许读取 prod MySQL；本地草稿不得自动写入 MySQL 或同步到其他远端。只有用户明确表示 review 通过并要求发布当前草稿后，才可通过受支持的 MySQL 写接口写入；确认前禁止创建、覆盖、激活或归档远端 weekly plan。

### Prod API endpoint（HARD）

**生产唯一面向所有客户端（小程序、Web、手机/APP）的 API 前门是 `https://api.stride-running.cn`，由 Go API（`src/go/internal/api/`）承担，数据落腾讯云 MySQL。不再有承担客户端请求的 Python API。** 所有小程序、Web、手机端请求、部署、脚本、CLI（`coros-sync` 等）和前端指向生产 API 时统一用它；`STRIDE_PROD_URL` / `STRIDE_GO_API_URL` 在生产也以它为值。**不要沿用旧 Azure `stride-app.*.azurecontainerapps.io` 地址，也不要新增/依赖任何独立的 Python FastAPI 客户端 API。** 完整配置见 [`docs/deployment.md`](docs/deployment.md)。

**所有客户端请求统一经过 Caddy 网关**：`api.stride-running.cn` 由 Caddy 反代并**按路径分流**——`/api/users/me/coach/*`（教练对话：`chat`、`sessions`、`sessions/{id}/messages` 等）路由到 **TypeScript `coach_agent_api` 服务**（镜像 `stride-coach-api`，核心 `coach_agent` / `coach_contract`），其余 STRIDE 数据面请求路由到 Go API。**教练对话接口不经过 Go API，Go API 不实现也不代理 `/api/users/me/coach/*`**；小程序 / Web 教练 tab 的 `COACH_BASE_URL` 在生产即为 `https://api.stride-running.cn`，由 Caddy 按 coach 前缀转发到 TS 服务。改 coach 对话契约时同步改 `coach_agent_api`，不要往 Go API 加同类路由。

---

## Folder Structure

```
src/                 # source code
tests/               # tests
frontend/            # React + Vite frontend (STRIDE dashboard)
docs/                # topic-specific docs（按需 Read，见顶部表）
```

### Multi-user Architecture

生产用户数据以 JWT `sub` UUID 在腾讯云 MySQL 中隔离。`data/{user_id}/` 保留本地 authoring artifacts、必要配置及遗留/测试数据；CLI 可用 UUID 或 friendly slug（如 `zhaochaoyi`，经 `data/.slug_aliases.json` 解析）选择用户。API 用 `/{user_id}/` 路径前缀，路径 UUID 与 JWT `sub` 不匹配则拒绝。

