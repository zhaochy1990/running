# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This project contains the training plans, logs for multiple marathon runners.
It also contains tools like coros-sync to sync the training data from COROS to the local for further analysis.

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
| Core | `src/coach/` | `pydantic`, `langgraph`, `langchain-*`, `stride_core.{plan_spec,workout_spec,plan_diff,master_plan,master_plan_diff}` only |
| Adapters | `src/stride_server/coach_adapters/` | Core + `stride_core.db` + `coros_sync` + `azure.*` + `fastapi` |

`coach.*` **必须不** import `stride_server.*`、`coros_sync.*`、`garmin_sync.*`、`azure.*`、`fastapi.*` 或 `stride_core.db`。CI 经 `lint-imports` 强制（跑 `PYTHONPATH=src lint-imports`）。

三 LLM role 配置、persistence、Pattern X/Y/A/P、generation pipeline、endpoints → [`docs/coach-agent.md`](docs/coach-agent.md)。

---

(CLAUDE.md 在 `deploy.yml` 触发路径里但纯文档修改不影响 runtime —— build 在 no-code-change delta 上 skip。)
