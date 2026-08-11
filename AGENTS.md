# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

---

## Go HTTP 服务（HARD）

`src/go/` 是 Go 模块（`github.com/zhaochy1990/stride`，Tencent 部署的 async-job worker + sync CLIs）。**所有 Go HTTP 服务统一用 [gin](https://github.com/gin-gonic/gin)**（`cmd/api`、`internal/health` liveness 探针，以及后续任何 HTTP server / handler），不要用 chi / echo / 裸 `net/http` router —— 无例外。

---

## Worktree-first development（HARD）

任何可能修改仓库内容的开发任务（含代码、测试、文档、配置、设计和生成文件）开始时，必须先运行项目 skill [`worktree-development`](.claude/skills/worktree-development/SKILL.md) 的唯一可移植入口：

```bash
python3 ".claude/skills/worktree-development/scripts/create_worktree.py" <3-5-word-kebab-name>
```

它为该任务创建专属的全新 linked Git worktree + 分支（分支 `worktree-<name>`，路径 primary 下已 ignore 的 `.worktrees/<name>`），并自动完成初始化（athlete DB 快照）。该入口只用 Python 标准库 + `git` CLI，跨 coding agent 可移植（Codex / OpenCode / Claude Code / 纯 shell），不依赖任何 agent 专用工具或 API。

脚本无法改变父 agent 进程的 cwd：成功时 stdout 最后一行是稳定 JSON，解析其中 `worktree_path` 绝对路径，此后所有探索、实现、测试、验证、review、commit、push 都必须在该 worktree 内完成（shell 用 `git -C "<worktree_path>"` 或切 cwd）；不得修改启动 checkout。初始化失败时脚本保留 worktree/分支（不自动删除）并给出 cleanup 指引。纯只读问答或当前会话已位于本任务专属 worktree 时除外。细节见该 skill 的 `SKILL.md`。

---


## Topic-specific docs（按需 Read）

写代码 / 文档前，按任务类型主动 Read 对应文件：

| 任务 | 必读 |
|------|------|
| 写 / 改 weekly `plan.json` | [`docs/plan-json-schema.md`](docs/plan-json-schema.md) —— HARD 校验 gate |
| 写 plan.md 里的力量动作 / 调 strength push | [`docs/strength-training.md`](docs/strength-training.md) |
| 分析疲劳 / TSB / HRV / 训练负荷 | [`docs/fatigue-metrics.md`](docs/fatigue-metrics.md) |
| 读 / 写周反馈，引用 RPE 或 feel_type | [`docs/feedback-md.md`](docs/feedback-md.md) |
| Multi-model A/B/C variants 流程 | [`docs/multi-variant.md`](docs/multi-variant.md) |
| Commentary 写入 / 推 prod / daily loop | [`docs/working-model.md`](docs/working-model.md) |
| 跑 coros-sync CLI / 改 sync 代码 / 直查 DB | [`docs/coros-cli.md`](docs/coros-cli.md) |
| 改 `src/coach/*` 或 `src/stride_server/coach_*` | [`docs/coach-agent.md`](docs/coach-agent.md) |
| 加 / 改 coach agent 评估（框架 / L1+L2+L3、Judge graph、CLI、目录约定） | [`docs/coach-eval.md`](docs/coach-eval.md) |
| 改 S1 赛季备战计划评估（fixture / L1 master_rule_filter / S1 judge axes） | [`docs/coach-eval_S1.md`](docs/coach-eval_S1.md) |
| 改 S2 周训练计划评估（fixture / L1 rule_filter / S2 judge axes） | [`docs/coach-eval_S2.md`](docs/coach-eval_S2.md) |
| 改 S3 每日问答评估（fixture / metric_traceability / S3 judge axes） | [`docs/coach-eval_S3.md`](docs/coach-eval_S3.md) |
| Auth wiring / Bearer / 401 排障 | [`docs/auth-wiring.md`](docs/auth-wiring.md) |
| Docker / CI/CD / reparse webhook | [`docs/deployment.md`](docs/deployment.md) |
| Frontend pages / API 路由清单 | [`docs/frontend.md`](docs/frontend.md) |

## Frontend local verification (HARD)

改 `frontend/` 且影响页面、路由、auth、API 请求或用户工作流时，收尾必须跑真实本地浏览器 smoke，不能只跑 unit test / build。

自 stride-web 剥离（ADR 0017）起，本地默认走 **BFF 在 Vite 前**的高保真流程，使 dev 的每个 `/api/*` 都经前端 BFF 的路由表（Python/Go strangler seam）：

1. 装 BFF 依赖（首次）：`cd frontend/server && npm install`。
2. 启动：`cd frontend && npm run dev:web:local`（Vite 跑 `:5173`，BFF 跑 `:8080` 并 front Vite；HMR 经 `VITE_HMR_CLIENT_PORT` 直连 Vite）。
3. 用 Playwright 跑：`cd frontend && npm run smoke:web:local`（打 BFF 的 `http://127.0.0.1:8080`）。

`smoke:web:local` = `smoke:local` + `STRIDE_LOCAL_URL=http://127.0.0.1:8080`；两者都从仓库根目录 `.credentials.local` 读取真实账号；如果当前 checkout 是 git worktree 且 worktree 根目录没有 `.credentials.local`，去主仓库目录找同名文件。不能把 email / password / token 打到回复或日志里。它必须完成登录、打开 `/activities`、并点进一个 `/activity/:id` 详情页确认数据可见。登录失败先查浏览器 console/network。

auth 现在**同源经 BFF**（`authStore.ts` 不再有 dev/prod 分支，永远相对 `/api/auth`），BFF 把 `/api/auth/*` 转发到 `AUTH_UPSTREAM_URL`，避免浏览器 CORS。

纯 UI 内循环（不需要验证路由表）仍可用旧的 `npm run dev:frontend:local` + `npm run smoke:local`（Vite `:5173` 直接代理 `/api`，不经 BFF）；`STRIDE_LOCAL_URL` 覆盖实际地址。


---

## UI design

For both Web UI and mobile UI, we need to use the Stitch MCP to design with Stitch.

---

## Local Coach provider（Agent Maestro）

`config/coach.copilot.toml` 通过本机 Agent Maestro 的 OpenAI-compatible
Responses API（`http://127.0.0.1:23333/api/openai/v1`）运行 Coach：
`gpt-5.6-luna` 处理编排和只读 `status_insight`，`gpt-5.6-sol` 处理计划生成和
reviewer。Agent Maestro 必须已在 VS Code 中启动；日常直接运行：

```bash
scripts/coach-local.sh coach
scripts/coach-local.sh eval-resolver
```

脚本自动加载 `config/coach.copilot.toml`（LLM）以及 `config/server.toml` +
`server.local.toml` + `server.coach-cli.toml`（基础设施），并为 Coach runtime
生成非空的临时随机 bearer 值。生成 weekly plan 时，活动和健康数据必须从 prod
腾讯云 MySQL 只读获取，不得读取本地 SQLite；checkpoint 仍使用本地数据。生成阶段
不得对 prod MySQL 执行写操作，草稿通过人工 review 后才可按下方流程发布。

周总结必须优先走 `get_training_summary` 单次聚合工具，避免反复扩大活动明细请求。

跑长会话前可先验证 Agent Maestro 的 Responses 端点可用：

```bash
scripts/coach-local.sh smoke            # 默认 gpt-5.6-sol
scripts/coach-local.sh smoke gpt-5.6-luna
```

`smoke` 必须输出 `HELLO_WORLD_OK model=... endpoint=.../responses`；非 200
说明 Agent Maestro 未启动或该模型在 VS Code Language Model 中不可用。脚本不
启动 / 停止 / 授权任何进程，也不持久化凭据 —— Agent Maestro 由 VS Code 扩展
自行管理。prompt、response、token 均不写入日志、回复或仓库文件。

---

## Storage scope rule (HARD)

**腾讯云 MySQL 是生产环境用户运动与健康数据的 canonical source**，包括 activities、laps、zones、timeseries、daily_health、dashboard、race predictions、ability snapshots、structured planned sessions/nutrition、weekly plans 和 scheduled workouts。`data/{user_id}/coros.db` 仅用于遗留迁移、专项调试或测试 fixture；生成 weekly plan 时不得把它当作数据源，也不得在 MySQL 不可用时静默 fallback 到 SQLite。

用正确的后端：

| Data shape | Backend |
|------------|---------|
| 用户运动、健康和训练计划数据 | **腾讯云 MySQL**（应用代码经 `src/go/internal/storage/`） |
| Go API 持久化数据（含跨用户 social signals、preferences、push registrations） | **MySQL**（经 `src/go/internal/storage/`） |
| Python 服务的跨用户 social signals、preferences、push registrations | **Azure Table Storage**（canonical pattern：`stride_server/likes_store.py`） |
| Bulk binary blobs (photos, video, large export files) | **Azure Blob Storage**（Python 服务） |
| Authoring artifacts (plan.md, TRAINING_PLAN.md) | **Markdown files in `data/{user_id}/logs/`**；只有明确批准同步的非草稿内容才可经 `sync-data.yml` 到 Azure Files，weekly plan 草稿遵守下方人工 review 门禁 |
| 周反馈 | **腾讯云 MySQL `weekly_feedback`**；legacy `feedback.md` 只用于迁移，不再读取、追加或同步 |
| Go API auth tokens / secrets | **MySQL**（经 `src/go/internal/storage/`） |
| Python/Auth 服务的 auth tokens / secrets | **Azure Key Vault** |

**Go API 的所有持久化状态统一落 MySQL**，不要为 Go API 新增 Azure Table、Azure Blob、Azure Files 或 Key Vault 存储依赖；Python 服务保留既有 Azure 后端。遗留 SQLite 的迁移或调试任务必须与 weekly plan authoring 流程隔离。likes_store 是 Python two-backend 文件（dev JSON / prod Azure Table）+ `DefaultAzureCredential`，不要把它用于 Go API。

### SQL ownership rule (HARD)

只有 `src/stride_storage/` 包允许直接写 SQL 读取 / 修改数据库。其它包（`stride_server/`、`coach/`、`stride_core/`、routes、adapters、scripts 等）需要数据时必须调用 `stride_storage` 暴露的 API / repository / store 方法；缺方法就先在 `stride_storage` 增加一个语义明确的方法，并补 storage 层测试。

禁止在非 storage 包里新增：`db._conn.execute(...)`、`conn.execute(...)`、裸 SQL 字符串查询表、或为了绕开缺失 API 直接打开 SQLite 连接。例外只限已有 legacy 代码的迁移前状态，以及下方 weekly plan authoring 流程中使用 prod readonly 账号执行的临时 MySQL CLI 查询；该 CLI 例外不得写入应用代码或持久化为脚本。改到 legacy 代码时要顺手收敛到 storage API，不能扩大直接 SQL 面。

## Timezone discipline (HARD)

所有 `coros.db` 时间戳列存 **UTC ISO 8601**。所有面向用户的日 / 周分类是 **Asia/Shanghai (UTC+8, 无 DST)**。混用会把 00:00–07:59 上海窗口静默错分到错误日期。

**Canonical helpers**：

- Python: `src/stride_core/timefmt.py` —— `utc_iso_to_shanghai_iso()`, `today_shanghai()`, `SHANGHAI_DAY_SQL`, `shanghai_day_to_utc_range()`, `shanghai_week_range()`, `SHANGHAI_TZ`
- TypeScript: `frontend/src/lib/shanghai.ts` —— `shanghaiDate()`, `shanghaiMonthDay()`, `shanghaiTime()`, `shanghaiToday()`, `shanghaiWeekday()`

**禁用 patterns**（CI 经 `tests/test_timezone_invariants.py` grep）：

| 别这么写 | 用这个 |
|---|---|
| `WHERE date >= '2026-05-09'` against `activities.*` | `WHERE date(datetime(date, '+8 hours')) >= ?`（用 `SHANGHAI_DAY_SQL`） |
| `date.today()` / `datetime.now()`（无 `tz=`） | `today_shanghai()` from `stride_core.timefmt` |
| `r["date"][:10]` in route serializers | `utc_iso_to_shanghai_iso(r["date"])` 再 slice —— 或 SQL 里 alias `date(datetime(date, '+8 hours')) AS shanghai_date` |
| `activity.date.slice(0, 10)` in React | `shanghaiDate(activity.date)` from `lib/shanghai` |
| `new Date().getFullYear()` 等表示"今天" | `shanghaiToday()` |

**API 边界规则**：`stride_server/routes/` 下的路由 MUST 在每个 activity 行序列化前对 `date` 跑 `utc_iso_to_shanghai_iso()`。这就是 frontend `.slice(0, 10)` "刚好能用"的原因 —— offset 转过，instant 保留。

`tests/test_timezone_invariants.py` 失败时几乎总是 fix 是 import + 用上面 helper 之一，不是把文件加 whitelist。该 test 里的 `WHITELIST` dict 是给真正操作 Shanghai-local 列（`weekly_plan.date_from`、`daily_health.date` YYYYMMDD）的文件 —— 顺手加项需要 code-review 理由。

## Athlete baseline metrics — single source (HARD)

所有"用 N 天用户历史 → 算出一个 athlete-level 常量"的 baseline 指标只能存活在 **`src/stride_core/running_calibration/`** —— 这是 canonical 包，按需扩展，不要新建并行包。覆盖范围（非穷举）：

- `max_hr` / `observed_max_hr` / `hrmax_estimate` / `high_hr_reference`
- `rhr_baseline`
- `threshold_hr` (LTHR)
- `threshold_speed_mps` / threshold pace
- `critical_power_w`
- HR zones / pace zones
- 任何未来的"长期个体基线"指标

**新增 / 改基线指标**：

1. 纯算法加在 `running_calibration/core.py` 或 `segments.py`（无 DB 依赖，接 `RunningActivity` 序列）
2. 字段加在 `RunningCalibrationSnapshot`（`types.py`）
3. SQLite schema 加列在 `running_calibration/sqlite_connector.py` 的 `RUNNING_CALIBRATION_SCHEMA` + `_ensure_columns`
4. 带 `CalibrationConfidence` + `CalibrationEvidence`，跟现有字段一致

**消费基线指标**：

- 经 `RunningCalibrationRepository.fetch_latest(as_of_date)` 读，**不要** inline 再算一次
- `compute_ability_snapshot(hr_max=185)` 这种 hard-coded default 视为 bug —— 调用方必须从 reader 取
- 改老代码遇到 inline 重复（如 routes/coach context 各自 `SELECT rhr FROM daily_health` 算 P10）→ 删掉换 reader

**禁止 patterns**：

| 别这么写 | 用这个 |
|---|---|
| `training_load/calibration.py::_estimate_hrmax`（同概念第二实现） | `running_calibration.estimate_hrmax_profile` |
| route / coach / ability 里 inline 算 RHR P10 | `RunningCalibrationRepository.fetch_latest().rhr_baseline` |
| `hr_max: int = 185` magic default | reader 取；缺数据时显式 fallback 到 onboarding profile 或抛错 |
| 新建 `src/stride_core/athlete_baseline/` 等并行包 | 在 `running_calibration/` 原地扩展（后续可改名，但只能有一个） |

**例外**：`routes/onboarding.py::_suggest_rhr_from_health`（P25/30d）是 new-user seed value 占位，数据不足时给前端 prefill，**语义不同**于 trained baseline —— 保留但保持注释清楚。

**历史教训**：`training_load/calibration.py::_estimate_hrmax` 是 running_calibration 抽出来时**没改完的 delegation 残留**，和 `running_calibration/core.py::estimate_hrmax_profile` 算同一指标但更弱（无置信度 / 无邻居支撑度检验）。"两个函数算同一指标"是这类 bug 的典型形态 —— 加新代码前先 grep 现有实现。

## 不要重复造轮子（一般原则）

加 helper / 算法 / 工具函数前，先在仓库 grep 同名 / 同概念实现。遇到现有实现质量不够 —— 修它，不要绕开新写一个。"两份功能相同的代码并存"在 review 里直接打回。这条规则的具体应用：上面的 Athlete baseline 单源，以及 [Timezone helpers](#timezone-discipline-hard) 单源。

---

## Working Model summary

- **腾讯云 MySQL** 是生产用户运动、健康和正式训练计划的 canonical data store。
- **Local machine** 是训练计划的 **author/review** 环境：OpenCode 从 prod MySQL 只读获取最新数据，在 `data/{user_id}/logs/` 生成 `plan.md` / `plan.json` 草稿。
- 生成阶段只允许读取 prod MySQL；本地草稿不得自动写入 MySQL 或同步到其他远端。只有用户明确表示 review 通过并要求发布当前草稿后，才可通过受支持的 MySQL 写接口写入；确认前禁止创建、覆盖、激活或归档远端 weekly plan。

完整 commentary 规则、daily loop bash、prod/local 不一致排障 → [`docs/working-model.md`](docs/working-model.md)。

---

### Multi-user Architecture

生产用户数据以 JWT `sub` UUID 在腾讯云 MySQL 中隔离。`data/{user_id}/` 保留本地 authoring artifacts、必要配置及遗留/测试数据；CLI 可用 UUID 或 friendly slug（如 `zhaochaoyi`，经 `data/.slug_aliases.json` 解析）选择用户。API 用 `/{user_id}/` 路径前缀，路径 UUID 与 JWT `sub` 不匹配则拒绝。

---

## Training Plan (plan.md)

每个 weekly plan.md 必须覆盖三大成分：

1. **Running**：每日跑步安排、配速目标、心率区间、周里程目标
2. **Strength & Conditioning**：力量、核心、柔韧/灵活性，含具体动作与组×次（COROS T-code 见 [`docs/strength-training.md`](docs/strength-training.md)）
3. **Nutrition**：基于体测数据的热量目标、宏量营养拆分（蛋白/碳水/脂肪）、餐食建议

考虑三者交互 —— 跑步日 vs 休息日的差异化碳水、力量后的蛋白时机、恢复周的热量赤字管理。

### Weekly plan generation workflow（HARD）

1. **按需同步所有用户**：如需在生成前刷新 prod 数据，可手动触发 GitHub Actions 的 `.github/workflows/daily-sync.yml`（`Daily auto-sync`）：`gh workflow run daily-sync.yml`。该 workflow 会遍历 `data/.slug_aliases.json` 中的所有 user UUID，触发并等待每个用户的 data pipeline。必须等待 workflow 成功完成；任一用户失败时先报告失败，不得把旧数据误称为最新数据。不要把它与 `.github/workflows/sync-data.yml` 混淆，后者同步 authoring files 到 Azure，不负责刷新 MySQL 运动数据。
2. **prod MySQL 只读检查**：生成下一周计划期间，允许直接使用非交互 MySQL CLI 对 prod 腾讯云 MySQL 执行只读 SQL，读取目标用户的最新活动、健康、训练负荷和能力基线。连接参数必须且只能从主 checkout 根目录 `.credentials.local` 的 `host`、`port`、`database_name`、`database_readonly_username`、`database_readonly_password` 加载；不得使用 `database_username` / `database_password` 读写账号，也不得在 readonly 账号不可用时回退到任何其他账号。只允许 `SELECT`、`SHOW`、`DESCRIBE` / `DESC`、`EXPLAIN`、`WITH ... SELECT` 等只读语句；禁止多语句输入、存储过程调用、写操作及 schema 变更，并禁止 `INTO OUTFILE` / `INTO DUMPFILE`、`FOR UPDATE`、`LOCK IN SHARE MODE`、`GET_LOCK()` 等写文件或显式加锁形式。
3. **禁止 SQLite 数据源**：不得运行本地 sync 来准备计划上下文，不得读取 `data/{user_id}/coros.db`，也不得在 MySQL 查询失败、数据缺失或连接不可用时退回 SQLite。此时应停止生成并向用户报告缺失项或连接问题。
4. **组合 authoring 输入**：当前训练阶段读取本地 `TRAINING_PLAN.md`；上一周人工反馈、运动和健康事实只读取本轮 prod MySQL，周反馈来自 `weekly_feedback`，不得回退 `feedback.md`。
5. **生成本地草稿**：只把结果写到本地 `data/{user_id}/logs/<week>/plan.md` 和 `plan.json`。生成后完成 schema 校验和 review，但不要写入 MySQL、提交/推送 Git 或触发任何远端同步。
6. **等待人工 review**：为 `plan.md` 和 `plan.json` 分别计算 Git blob hash（未跟踪文件则计算 SHA-256），把两个文件路径及 hash 组成同一份草稿 manifest。向用户展示 manifest 和校验结果，并等待用户明确表示该版本 **review 通过**。仅生成草稿、查看草稿、提出修改意见或完成自动 review 均不构成写入授权；任一文件内容变化都会使之前的 review 通过失效，必须重新生成 manifest 并重新 review。
7. **review 通过后写入 MySQL**：只有用户明确表示已 review 通过并要求发布已确认 manifest 后，才允许从只读阶段升级为写操作，并通过仓库已有且受支持的 MySQL 写接口发布。写入必须携带预期 plan revision（或等价 CAS 条件），原子地拒绝并发变化；写入前再次核对 manifest、user UUID、week start 和 revision。若没有受支持的发布接口，停止并报告需要先实现接口，禁止用临时脚本或裸 SQL 绕过。若任一项变化、写入冲突或校验失败，停止发布且不得激活新计划。写入成功后回读并核对远端内容与本地已确认 manifest 一致；不一致时立即报告，不得继续覆盖。

MySQL CLI 必须使用 batch/non-interactive 模式。不得把密码放在命令行参数中；应使用权限为 `0600` 的临时 `--defaults-extra-file`，用后立即删除。不得输出、记录或回复 `.credentials.local` 的任何值、DSN、密码或 token；查询结果也不得包含 credential/token/secret 列。若 readonly 凭据缺失、连接失败或权限异常，停止检查并报告，不得改用读写账号。

### 起草新 weekly plan 前必看的输入

- **当前训练阶段**：本周在整体周期化中的位置（从 TRAINING_PLAN.md）
- **上周 feedback**：从腾讯云 MySQL `weekly_feedback` 读取 RPE、感知疲劳和记录的问题
- **近期身体指标**：从腾讯云 MySQL 获取 RHR、HRV 趋势、睡眠质量/时长
- **近期训练执行**：从腾讯云 MySQL 获取活动、训练负荷、完成度及异常信号
- **最新体测数据**：从腾讯云 MySQL 获取体重、体脂率、骨骼肌量趋势

按这些信号调整训练负荷、营养、恢复。例：HRV 下行或睡眠差 → 降强度、加恢复；体脂停滞 → 重新评估热量赤字。

### 训练负荷分布约束（HARD）

STRIDE `training_dose` 是 TSS-scaled（1h 阈值 = 100 分），`form = chronic − acute`。Form zone 按**当日 chronic（CTL）比例**分类，**不要**用经典 TrainingPeaks 固定 TSB 阈值（那是为 CTL 80-120 校准的，跑者 CTL 通常 40-70）：

| Form / CTL | ratio = acute/chronic | Zone |
|---|---|---|
| > +25% | < 0.75 | 减量过多（detraining）|
| +10% ~ +25% | 0.75 ~ 0.90 | 比赛就绪（race-ready）|
| −10% ~ +10% | 0.90 ~ 1.10 | 维持期（acute ≈ chronic，体能持平）|
| −25% ~ −10% | 1.10 ~ 1.25 | 提升期（acute > chronic，驱动体能进步）|
| < −25% | > 1.25 | 过度负荷（overreach）|

**每个 weekly plan.md 必须在顶部 metadata 区显式声明**：

1. **本周 phase 定位**：base / build / peak / taper / recovery / race
2. **期望 form 分布**：本周 form 落在哪个 zone 占主导（如"base 阶段：维持期 40% + 提升期 40% + 比赛就绪 20%"）

**Phase 与 Form 分布对应关系**：

| Phase | 期望 form 分布 | 周量 ramp |
|---|---|---|
| Base（基础期）| 维持期 40-50% + 提升期 30-40% + 比赛就绪 10-20% | chronic 缓慢上行 |
| Build（进展期）| **提升期 50-60%** + 维持期 20-30% + 比赛就绪 10% | chronic 明显上行 |
| Peak（赛前期）| 提升期 40% + 维持期 30% + 比赛就绪 30% | chronic 持平或微降 |
| Taper（减量周）| 比赛就绪 60-70% + 维持期 20-30% | acute 下降 |
| Recovery（恢复周）| 比赛就绪 70% + 维持期 30% + 偶尔减量过多 | chronic 主动下行 |

**Anti-patterns（避免）**：

- **"Spike + flat" 节奏**：周内 1-2 个 200+ dose 硬课 + 3 个零 dose 天 → acute 暴涨后被零日清零，form 停在维持期。提升期 form 需要 acute **持续** 高于 chronic 5+ 天 → 靠每天都有 dose，不是靠单日 spike。
- **三个零 dose 天/周**（Mon 力量 + Thu mobility + Sun rest）：acute 每周必然被两次清零。**力量日 + 短 jog**（30-40 min）或 **mobility 日 + shake-out**（5K easy）把零日填到 ≤2 个/周。
- **Tue / Fri 易漏跑**：这两天是 form 进入提升期的 hinge —— 每砍一次直接退回维持期。Plan 时把这两天列为"硬性必跑"。
- **单日长跑占周量 > 35%**：长距 dose 占比过高即"spike + flat"的根因。Long run dose / weekly dose 目标 < 33%。

**Plan 设计 heuristic**：

- **周 dose 目标 ≈ chronic × 7**（如 chronic 70 → 周 dose 490 才能维持；想推到提升期需要 ≥ chronic × 7.7 ≈ 540+）
- **build phase 周 ramp**：weekly dose 周-周递增 5-8%，4 周 ramp + 1 周 recovery（3:1 周期）
- **过度负荷 (< −25% CTL) 触发**：连续 3 天落入，下周必须减 15-20%；连续 5 天则当周强插一个完整休息日

完整 Form / CTL 含义、PMC 公式 → `src/stride_core/training_load/core.py` + `frontend/src/pages/TrainingStatusPage.tsx::classifyForm`。

### Prompt role discipline（HARD）

任何 coach LLM 调用，**system 与 user prompt 按职责切分**，不要把两类内容混在一条消息里：

| Turn | 装什么 | 性质 |
|------|--------|------|
| **System** | 人设 + 不变规则 + 输出 schema/格式契约（"你是谁 / 按什么规矩办 / 输出长什么样"）| 跨用户、跨调用**逐字节相同** |
| **User** | 本轮任务 + 输入数据（这名 athlete 的 goal / profile / history / fitness、本轮算出的 plan_start / race_date、conditional context blocks、以及"开始生成"的指令）| 每轮变 |

**为什么是 HARD**：把 per-athlete 数据塞进 system 会让那一大块静态 doctrine 前缀每次都不同 → **prompt cache 永远命中不了**，白烧 input token。规则文本若需引用本轮值（如 `plan_start`），在 system 里**引用 user message 里的字段名**（"the `plan_start` given in the user message"），**不要**把具体值插值进 system。

**Canonical 实现**：`stride_server/master_plan_generator.py::build_master_prompts(...) -> (system, user)` —— S1 master-plan 的参考实现。system 由 `coach/skills/master_plan_planner/SKILL.md`（无运行时 `${...}` 占位符）渲染；user 由同目录 `user_prompt.md` 渲染。加新 LLM 调用（S2/S3）或改 prompt 时复用这个划分，别回退到"全塞 system"。回归不变量见 `tests/stride_server/test_master_plan_generator.py::TestPromptRoleSplit`。

---

(AGENTS.md 在 `deploy.yml` 触发路径里但纯文档修改不影响 runtime —— build 在 no-code-change delta 上 skip。)
