# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

---

## Topic-specific docs（按需 Read）

写代码 / 文档前，按任务类型主动 Read 对应文件：

| 任务 | 必读 |
|------|------|
| 写 / 改 weekly `plan.json` | [`docs/plan-json-schema.md`](docs/plan-json-schema.md) —— HARD 校验 gate |
| 写 plan.md 里的力量动作 / 调 strength push | [`docs/strength-training.md`](docs/strength-training.md) |
| 分析疲劳 / TSB / HRV / 训练负荷 | [`docs/fatigue-metrics.md`](docs/fatigue-metrics.md) |
| 写 / 更新 feedback.md，引用 RPE 或 feel_type | [`docs/feedback-md.md`](docs/feedback-md.md) |
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

改 `frontend/` 且影响页面、路由、auth、API 请求或用户工作流时，收尾必须跑真实本地浏览器 smoke，不能只跑 unit test / build：

1. 启动：`cd frontend && npm run dev:frontend:local`。
2. 用 Playwright 跑：`cd frontend && npm run smoke:local`。
3. 如果 Vite 不在默认 `http://127.0.0.1:5173`，设置 `STRIDE_LOCAL_URL` 为实际地址。

`smoke:local` 从仓库根目录 `.credentials.local` 读取真实账号；如果当前 checkout 是 git worktree 且 worktree 根目录没有 `.credentials.local`，去主仓库目录找同名文件。不能把 email / password / token 打到回复或日志里。它必须完成登录、打开 `/activities`、并点进一个 `/activity/:id` 详情页确认数据可见。若登录失败，先查浏览器 console/network；本地 auth 必须经 `VITE_DEV_AUTH_PROXY` 走 Vite `/api/auth/*` 代理，避免浏览器 CORS。


---

## UI design

For both Web UI and mobile UI, we need to use the Stitch MCP to design with Stitch.

---

## Local GitHub Copilot proxy（仅开发测试）

需要在本地把 GitHub Copilot 暴露成 OpenAI-compatible API 时，使用已实测的
[`voidsteed/copilot-proxy-api`](https://github.com/voidsteed/copilot-proxy-api)。
它是逆向 Copilot 内部 API 的社区项目，**只允许本地实验，禁止生产部署或共享账号服务**。必须启用本地 API key，不得把 prompt、response 或 token 写入日志、回复或仓库文件。测试结束后立即停止服务；本地 credential 可以按下方规则持久保存。

截至 2026-07-14，已验证 `copilot-proxy-api@0.10.22` 的 `/v1/responses` 可调用
`gpt-5.5`、`gpt-5.6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`。固定版本以保证可复现；升级前必须重新跑下方 Hello World。

### 一次授权，日常一键启停

统一使用 [`scripts/coach-local.sh`](scripts/coach-local.sh)。它把 OAuth
credential、本地 API key、PID 和非 verbose 日志持久保存到
`~/.local/share/copilot-proxy/`（目录 `0700`、secret 文件 `0600`），
不写入仓库。首次运行一次 Device Flow：

```bash
scripts/coach-local.sh auth
```

按终端提示在 `https://github.com/login/device` 完成授权。之后日常无需再次
auth：

```bash
scripts/coach-local.sh start
scripts/coach-local.sh smoke
scripts/coach-local.sh coach
scripts/coach-local.sh stop
```

如果 `smoke` 返回上游 401，运行 `scripts/coach-local.sh auth --force`。脚本会
自动停止正在运行的代理、重新授权并重启；只更新 credential 文件而不重启进程，
不会替换进程内存里已经过期的 Copilot 短期 token。

`coach` 自动加载 `config/coach.copilot.toml`（LLM）以及
`config/server.toml` + `server.local.toml` + `server.coach-cli.toml`（基础设施）。
其中 master-plan 与 weekly-plan store 指向生产 Azure Table；活动、健康数据和
checkpoint 仍使用本地数据。用户不需要手工 export 配置环境变量。

`smoke` 是进入 Coach 前的 HARD gate，必须输出严格的
`HELLO_WORLD_OK model=gpt-5.6-sol endpoint=/v1/responses`。HTTP 200 但文本
不匹配也视为失败。

**协议边界**：GPT-5.5 / GPT-5.6 必须走 `/v1/responses`。不要因为 `/v1/models` 列出了模型，就用 `/v1/chat/completions` 判断可用；该路径对这些模型会返回 `unsupported_api_for_model`。

Coach 的 Copilot 配置用 `gpt-5.6-luna` 处理编排和只读
`status_insight`，用 `gpt-5.6-sol` 处理计划生成/reviewer。周总结必须优先走
`get_training_summary` 单次聚合工具，避免反复扩大活动明细请求。

该工具会监听所有网卡，不只 `127.0.0.1`；脚本始终生成并启用本地 API key，
端口不得暴露到公网、局域网共享或反向代理。`stop` 只停进程，**保留凭据**。
只有用户明确要撤销本地状态时才运行：

```bash
scripts/coach-local.sh reset
```

`reset` 会删除本地 credential、API key、日志和 npm cache，但不会撤销 GitHub
OAuth grant；彻底停用时还应在 GitHub Settings 的 Authorized OAuth Apps 中撤销。

---

## Storage scope rule (HARD)

**The per-user SQLite databases at `data/{user_id}/coros.db` are reserved for watch-synced 运动数据 only** —— activities, laps, zones, timeseries, daily_health, dashboard, race predictions, ability snapshots, structured planned sessions/nutrition, weekly plan/feedback markdown layer, scheduled workouts。任何不属于这个范围的（notifications, devices, social signals, cross-user state, app-level config 等）**绝不能**加成 SQLite 表。

用正确的后端：

| Data shape | Backend |
|------------|---------|
| Cross-user social signals (likes, comments, follows) | **Azure Table Storage**（canonical pattern：`stride_server/likes_store.py`） |
| Per-user app preferences not derived from a watch | **Azure Table Storage**（PartitionKey=user_id, RowKey="prefs"） |
| Push device tokens / FCM-style registrations | **Azure Table Storage** |
| Bulk binary blobs (photos, video, large export files) | **Azure Blob Storage** |
| Authoring artifacts (plan.md, feedback.md, TRAINING_PLAN.md) | **Markdown files in `data/{user_id}/logs/`**，经 `sync-data.yml` 同步到 Azure Files |
| Auth tokens / secrets | **Azure Key Vault** |

加新 feature 前问：*"这一行来自手表 sync 吗？"* 不是就别加 SQLite 表。likes_store 是 two-backend 文件（dev JSON / prod Azure Table）+ `DefaultAzureCredential` —— 复用这个 pattern，不要发明新的。

### SQL ownership rule (HARD)

只有 `src/stride_storage/` 包允许直接写 SQL 读取 / 修改数据库。其它包（`stride_server/`、`coach/`、`stride_core/`、routes、adapters、scripts 等）需要数据时必须调用 `stride_storage` 暴露的 API / repository / store 方法；缺方法就先在 `stride_storage` 增加一个语义明确的方法，并补 storage 层测试。

禁止在非 storage 包里新增：`db._conn.execute(...)`、`conn.execute(...)`、裸 SQL 字符串查询表、或为了绕开缺失 API 直接打开 SQLite 连接。例外只限已有 legacy 代码的迁移前状态；改到相关代码时要顺手收敛到 storage API，不能扩大直接 SQL 面。

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

- **Local machine** 是 **author** 环境：Codex 在这里跑，产出 weekly `plan.md`、`feedback.md`、refined `activity_commentary`。
- **Azure Container App (`stride-app`)** 是 **reader** 环境 + **default draft-writer**（GPT-4.1 在 sync 时自动写 commentary 草稿）。
- Markdown 经 `sync-data.yml` 同步到 prod Azure Files；DB 行经 authenticated API 推。

完整 commentary 规则、daily loop bash、prod/local 不一致排障 → [`docs/working-model.md`](docs/working-model.md)。

---

### Multi-user Architecture

每个 user 在 `data/{user_id}/` 下隔离（UUID-keyed —— `{user_id}` 是 JWT `sub` UUID），含自己的 SQLite DB、COROS 凭据、训练 logs。CLI 用 `--profile` / `-P` 选用户 —— 传 UUID 或 friendly slug（如 `zhaochaoyi`）经 `data/.slug_aliases.json` 解析到 UUID。API 用 `/{user_id}/` 路径前缀，路径 UUID 与 JWT `sub` 不匹配则拒绝。

---

## Training Plan (plan.md)

每个 weekly plan.md 必须覆盖三大成分：

1. **Running**：每日跑步安排、配速目标、心率区间、周里程目标
2. **Strength & Conditioning**：力量、核心、柔韧/灵活性，含具体动作与组×次（COROS T-code 见 [`docs/strength-training.md`](docs/strength-training.md)）
3. **Nutrition**：基于体测数据的热量目标、宏量营养拆分（蛋白/碳水/脂肪）、餐食建议

考虑三者交互 —— 跑步日 vs 休息日的差异化碳水、力量后的蛋白时机、恢复周的热量赤字管理。

**关键**：回答任何关于现状 / 负荷 / 疲劳 / 训练指标的问题时，**先**跑 `PYTHONIOENCODING=utf-8 python -m coros_sync -P {username} sync` 确保本地 DB 最新。默认用户 `zhaochaoyi`。

### 起草新 weekly plan 前必看的输入

- **当前训练阶段**：本周在整体周期化中的位置（从 TRAINING_PLAN.md）
- **上周 feedback**：RPE、感知疲劳、上周 feedback.md 记录的问题
- **近期身体指标**：RHR、HRV 趋势、睡眠质量/时长 —— 经 `coros-sync status` 或 `coros-sync analyze hrv`
- **最新体测数据**：体重、体脂率、骨骼肌量趋势

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
