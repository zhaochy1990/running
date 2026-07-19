# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This project contains the training plans, logs for multiple marathon runners.
It also contains tools like coros-sync to sync the training data from COROS to the local for further analysis.

---

## Agent skills

### Worktree-first development（HARD）

任何可能修改仓库内容的开发任务（含代码、测试、文档、配置、设计和生成文件）开始时，必须先运行项目 skill [`worktree-development`](.claude/skills/worktree-development/SKILL.md) 的唯一可移植入口 `python ".claude/skills/worktree-development/scripts/create_worktree.py" <3-5-word-kebab-name>`，为该任务创建专属的全新 linked Git worktree + 分支，并自动完成初始化（athlete DB 快照）。该入口只用 Python 标准库 + `git` CLI，跨 coding agent 可移植（Claude Code / OpenCode / 纯 shell），不依赖任何 agent 专用工具或内置 worktree 工具。脚本无法改变父进程 cwd：解析其 stdout 最后一行 JSON 里的 `worktree_path`，此后所有探索、实现、测试、验证、review、commit、push 都必须在该 worktree 内完成（shell 用 `git -C "<worktree_path>"` 或切 cwd）；不得修改启动 checkout。纯只读问答或当前会话已位于本任务专属 worktree 时除外。

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This repo uses a single-context domain-doc layout. See `docs/agents/domain.md`.

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
| 接支付 / 支付宝 / 微信 / 订阅付费（调研 + 大陆主体接入方案，未开工）| [`docs/payment-china.md`](docs/payment-china.md) |
| 改 race 预测 / 个体疲劳指数 / CS-D′ speed-duration 模型（去掉写死 Riegel 0.06，设计稿未实现）| [`docs/race-prediction-model.md`](docs/race-prediction-model.md) |
| Frontend pages / API 路由清单 | [`docs/frontend.md`](docs/frontend.md) |
| Web 产品设计 / Stitch 设计稿 | [`frontend/DESIGN.md`](frontend/DESIGN.md) —— Stitch MCP workflow + 设计规则 |

## Stitch MCP design workflow (HARD)

Web design work uses Stitch as the source of truth. Formal STRIDE Web design changes must be made through Stitch MCP first, then exported to `frontend/design/` as review snapshots.

Before inspecting, updating, regenerating, or adding Stitch designs, read [`frontend/DESIGN.md`](frontend/DESIGN.md). It defines the required two-column / three-column workspace rules, user-facing terminology, CTA ownership, review checklist, and the MCP sequence: `list_projects` -> `list_design_systems` -> `list_screens` -> `get_screen` -> `edit_screens` or generation -> export HTML -> update `frontend/design/README.md` and the scenario README -> visible-text audit.

Do not hand-edit local exported HTML as the final design source. If direct Stitch MCP tools are unavailable, use the configured `stitch` MCP server via JSON-RPC at `https://stitch.googleapis.com/mcp` with local Codex credentials; never write or reveal credential values.

Operational rules for Stitch MCP:

1. Treat Stitch screen IDs and returned artifacts as the source of truth; local HTML files are review snapshots only.
2. For existing screens, call `get_screen` first, then use `edit_screens`; only use generation when a required state does not exist.
3. Use project `STRIDE · Web` (`9898197682875783129`) and design system `STRIDE Endurance Lab` (`assets/78bc062efcff47b5944c094f5db74850`) unless the user explicitly changes the design direction.
4. In prompts, describe layout, content, state, preserved product capabilities, terminology constraints, and CTA ownership; do not duplicate design-system token details for normal generation.
5. Stitch responses may return full `outputComponents` artifacts or only a session/update event. If the artifact is missing, call `get_screen` for the updated screen before exporting.
6. Download `htmlCode.downloadUrl` to `.stitch/designs/`, then copy the story-ordered review HTML files to the relevant `frontend/design/` scenario directory.
7. Update `frontend/design/README.md`, the scenario README, and `frontend/design/manifest.json`; verify HTML links and run the banned visible-text audit before handing design work back.

## Frontend local verification (HARD)

改 `frontend/` 且影响页面、路由、auth、API 请求或用户工作流时，收尾必须跑真实本地浏览器 smoke，不能只跑 unit test / build：

1. 启动：`cd frontend && npm run dev:frontend:local`。
2. 用 Playwright 跑：`cd frontend && npm run smoke:local`。
3. 如果 Vite 不在默认 `http://127.0.0.1:5173`，设置 `STRIDE_LOCAL_URL` 为实际地址。

`smoke:local` 从仓库根目录 `.credentials.local` 读取真实账号，但不能把 email / password / token 打到回复或日志里。它必须完成登录、打开 `/activities`、并点进一个 `/activity/:id` 详情页确认数据可见。若登录失败，先查浏览器 console/network；本地 auth 必须经 `VITE_DEV_AUTH_PROXY` 走 Vite `/api/auth/*` 代理，避免浏览器 CORS。

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

加新 feature 前问：*"这一行来自手表 sync 吗？"* 不是就别加 SQLite 表。

### 统一数据访问层 `stride_storage`（HARD）

所有持久化**实现**现在归一在独立包 **`src/stride_storage/`**（API Server 与 Coach 共享的数据访问层）。分三个 import 层级（`.importlinter` Contract 5 强制）：

| Tier | 路径 | 装什么 | 谁能 import |
|------|------|--------|-------------|
| A `interfaces/` | `stride_storage.interfaces` | 纯 Protocol + frozen config dataclass（无 sqlite/azure import）| 任何包，含 `coach` |
| B `sqlite/` · `content/` | `stride_storage.sqlite` / `.content` | `Database`、state_stores、calibration connector、content 原语；依赖 `sqlite3` + `stride_core` 纯域 | `stride_server` 等；**coach 不可** |
| C `azure/` · `keyvault/` · `factories/` · `coach_persistence/` | 同名子包 | 仅 Azure SDK（Table/Blob/Key Vault）、coach 持久化 | `stride_server`；**coach 永不** |

**加新 store / 改存储实现**：放进 `stride_storage` 对应 tier，复用共享原语 —— `azure/credentials.py::get_credential`（唯一 `DefaultAzureCredential`）、`azure/table_backend.py::AzureTableConnection`、`azure/blob_backend.py::get_container_client`、`azure/backend_select.py::choose_backend`、`keyvault/secret_client.py::get_secret_client`。**不要**再各自 new `DefaultAzureCredential()` 或重写 dev/prod 后端选择。canonical 样板：likes（`interfaces/likes.py` + `azure/likes_backend.py`），two-backend（dev JSON / prod Azure Table）。

**config 加载留 server 侧**：`stride_storage` 的 backend 工厂只接收 resolved config dataclass（如 `LikesStorageConfig`）；`ServerConfig` 解析 + 缓存仍在 `stride_server`（避免 `stride_storage → stride_server` 成环）。

**过渡期 shim**：`stride_core.db` / `stride_core.state_stores` / `stride_server.likes_store` 等旧路径现为薄 re-export shim，consumer 暂可照旧 import；增量 cutover 到 `stride_storage.*` 后删除。新代码直接 import `stride_storage.*`。

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

- **Local machine** 是 **author** 环境：Claude Code 在这里跑，产出 weekly `plan.md`、`feedback.md`、refined `activity_commentary`。
- **Azure Container App (`stride-app`)** 是 **reader** 环境 + **default draft-writer**（GPT-4.1 在 sync 时自动写 commentary 草稿）。
- Markdown 经 `sync-data.yml` 同步到 prod Azure Files；DB 行经 authenticated API 推。

完整 commentary 规则、daily loop bash、prod/local 不一致排障 → [`docs/working-model.md`](docs/working-model.md)。

---

## Folder Structure

```
data/
    zhaochaoyi/                  # per-user data directory
        coros.db                 # user's SQLite database
        config.json              # user's COROS credentials (git-ignored)
        TRAINING_PLAN.md         # user's overall training plan
        logs/
            2026-04-13_04-19(赛后恢复)/  # format: YYYY-MM-DD_MM-DD(阶段标注)
                plan.md                  # weekly training plan
                plan.json                # 结构化版本，server reparse 时优先用
                feedback.md              # training feedback with RPE
    dehua/                       # another user
        ...
src/                 # tools source code
tests/               # tests
frontend/            # React + Vite frontend (STRIDE dashboard)
docs/                # topic-specific docs（按需 Read，见顶部表）
```

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

### plan.md 篇幅控制（精简原则）

- 目标长度 **80-150 行**。超过 200 行 = 过度啰嗦，必须精简。
- **保留**："为什么这么跑"的简要理由 —— inline 括号 / 半句带过，不要多段铺陈
- **删除**：
  - 多个备选方案的对比论证（"为什么选 C 不选 A 或 B"）—— 直接给最终决策；备选方案讨论放 commit message
  - 重复 TRAINING_PLAN.md 已有的内容（区间定义、阶段定义、温度规则等）—— 引用即可
  - 大块"教练思路"或"决策推演"段落 —— 决定就是决定，不要再论证
  - 多版本演进记录（V1→V2→V3）—— git history 已经记录
- **优先表格**：每日表、距离决策矩阵、监控触发表、营养时机表等。表格信息密度高于段落。
- **执行视角** > 解释视角：plan.md 是给未来某天的"我"看的执行清单，不是给读者讲训练学。

不要"已推送到 COROS 手表的训练"这个章节。生成后检查内容，剔除或合并重复。

### plan.json 同步必须（HARD）

每次写完 plan.md 必须**同时**写一个 schema-valid 的 `plan.json` 放在同目录，并经本地 `WeeklyPlan.from_dict` 校验通过才能 commit。完整 schema、字段、枚举、校验脚本 → [`docs/plan-json-schema.md`](docs/plan-json-schema.md)。

---

## 体测报告（Body Composition Report）

体测报告含核心指标：Weight / Body Fat Percentage / Body Fat Mass / Skeletal Muscle Mass。用来追踪减脂 vs 增肌、监控体能与训练进度、长期趋势对比。

---

## Coach Agent — HARD 边界

STRIDE coach 是 LangGraph-based agent，处理 S1（master-plan）/ S2（weekly-plan 调整）/ S3（daily Q&A）。两层架构由 `.importlinter` 强制：

| Layer | Path | 允许的 deps |
|-------|------|-------------|
| Core | `src/coach/` | `pydantic`, `langgraph`, `langchain-*`, `stride_core` 域原语（`plan_spec` / `workout_spec` / `plan_diff` / `master_plan` / `master_plan_diff`）+ **纯公式层**（`training_load.{core,calibration,types}`、`running_calibration.{core,segments,types,zones,repository}`）+ `stride_storage.interfaces`（纯 Protocol/config，可选）|
| Adapters | `src/stride_server/coach_adapters/` | Core + `stride_storage`（数据访问层，含 `sqlite`/`azure`/`coach_persistence`）+ `coros_sync` + `azure.*` + `fastapi` |

`coach.*` **必须不** import `stride_server.*`、`coros_sync.*`、`garmin_sync.*`、`azure.*`、`fastapi.*`、`stride_core.db`，或 `stride_storage` 的**实现层**（`.sqlite` / `.azure` / `.content` / `.keyvault` / `.factories` / `.coach_persistence` —— Contract 5）。coach 拿数据仍走 DI：`coach_adapters` 构造 `stride_storage` 的具体 store 注入。CI 经 `lint-imports` 强制（跑 `PYTHONPATH=src lint-imports`，5 contract 全 KEPT）。

**enforced 的是黑名单**：`.importlinter` Contract 1 是 `forbidden` 型，只禁上面 6 个 infra 模块——不是 allowlist。所以任何 **infra-free 的 `stride_core` 纯模块** coach core 都可依赖（如负荷预估 helper `training_load.core::estimate_planned_run_load`，Contract 3 已保证 `training_load.{core,calibration,types}` 自身不碰 db/server/sync/azure/fastapi）。表里"允许的 deps"是**推荐最小面**；要新依赖一个纯模块时，跑 `lint-imports` 确认 4 contract 全 KEPT 即可，不必新建并行实现。

三 LLM role 配置、persistence、Pattern X/Y/A/P、generation pipeline、endpoints → [`docs/coach-agent.md`](docs/coach-agent.md)。

### Prompt role discipline（HARD）

任何 coach LLM 调用，**system 与 user prompt 按职责切分**，不要把两类内容混在一条消息里：

| Turn | 装什么 | 性质 |
|------|--------|------|
| **System** | 人设 + 不变规则 + 输出 schema/格式契约（"你是谁 / 按什么规矩办 / 输出长什么样"）| 跨用户、跨调用**逐字节相同** |
| **User** | 本轮任务 + 输入数据（这名 athlete 的 goal / profile / history / fitness、本轮算出的 plan_start / race_date、conditional context blocks、以及"开始生成"的指令）| 每轮变 |

**为什么是 HARD**：把 per-athlete 数据塞进 system 会让那一大块静态 doctrine 前缀每次都不同 → **prompt cache 永远命中不了**，白烧 input token。规则文本若需引用本轮值（如 `plan_start`），在 system 里**引用 user message 里的字段名**（"the `plan_start` given in the user message"），**不要**把具体值插值进 system。

**Canonical 实现**：`stride_server/master_plan_generator.py::build_master_prompts(...) -> (system, user)` —— S1 master-plan 的参考实现。system 由 `coach/skills/master_plan_planner/SKILL.md`（无运行时 `${...}` 占位符）渲染；user 由同目录 `user_prompt.md` 渲染。加新 LLM 调用（S2/S3）或改 prompt 时复用这个划分，别回退到"全塞 system"。回归不变量见 `tests/stride_server/test_master_plan_generator.py::TestPromptRoleSplit`。

---

(CLAUDE.md 在 `deploy.yml` 触发路径里但纯文档修改不影响 runtime —— build 在 no-code-change delta 上 skip。)
