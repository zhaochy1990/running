# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This project contains the training plans, logs for multiple marathon runners.
It also contains tools like coros-sync to sync the training data from COROS to the local for further analysis.

## Working Model — Local Authoring + Cloud Draft-Writer

Going forward, keep this split in mind:

- **Local machine** is the **author** environment. Large-language-model tooling (Claude Code) runs here, reads local state (SQLite + markdown under `data/`), and produces the authoritative content: weekly `plan.md`, `feedback.md`, refined `activity_commentary` DB rows, plus ad-hoc analyses.
- **Azure Container App (`stride-app`)** is the **reader** environment *and* a **default draft-writer**. It serves the dashboard UI and read API; its data comes from:
  - Markdown files synced via the `sync-data.yml` GitHub Action (push to master → `az storage file upload-batch` to `authstorage2026/stride-data`).
  - SQLite data (activities, health) synced independently on both sides from COROS.
  - DB rows that are *not* COROS-sourced and only live locally (e.g. Claude Code–refined `activity_commentary`) must be pushed via the dedicated CLI over the authenticated API — they are not in the markdown sync path.
  - **Azure OpenAI (GPT-4.1)** auto-generates a commentary **draft** for every newly-synced activity via MI-authenticated calls from the server. Drafts are stamped with `generated_by='gpt-4.1'`.

### Commentary authorship rules

- Every `activity_commentary` row carries `generated_by` (model identifier: `gpt-4.1`, `claude-opus-4-7`, etc.) and `generated_at`.
- Auto-generation on `sync` **never overwrites an existing row**. It fills empty slots only.
- To overwrite an AOAI draft with a Claude Code refinement: locally write the row with `generated_by=<your model>`, then `coros-sync commentary push <id> --generated-by <your model>`.
- To force a fresh AOAI draft (overwrites whatever's there): `POST /api/{user}/activities/{id}/commentary/regenerate` or use the "重新生成" button on the activity detail page.
- AOAI is gated by `AOAI_COMMENTARY_ENABLED=true` + `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_DEPLOYMENT` env vars. Auth: set `AZURE_OPENAI_API_KEY` for key-based auth, or leave it unset to use Managed Identity + `Cognitive Services OpenAI User` RBAC on the AOAI account. With any required var unset, sync skips the AOAI step silently.

### Canonical daily loop

```bash
# 1. Sync COROS data to local DB. Prod-side AOAI auto-writes a gpt-4.1
#    draft commentary for every newly-synced activity (server does this
#    on its own sync path; locally we only see the activity rows).
PYTHONIOENCODING=utf-8 python -m coros_sync -P zhaochaoyi sync

# 2. [Claude does its thing] — refine AOAI drafts, write plan/feedback,
#    produce deeper commentaries using local data. Local DB row should
#    stamp generated_by with the model producing it:
python -c "
from stride_core.db import Database
db = Database(user='zhaochaoyi')
db.upsert_activity_commentary('<label_id>', '<text>', generated_by='claude-opus-4-7')
"

# 3a. Commentary → STRIDE prod via authenticated POST. MUST pass
#     --generated-by so the row on prod keeps the correct author stamp
#     (otherwise generated_by stays NULL on prod and the UI badge is
#     blank / future AOAI auto-gen on re-sync might overwrite).
coros-sync -P zhaochaoyi commentary push <label_id> --generated-by claude-opus-4-7

# 3b. plan.md / feedback.md / TRAINING_PLAN.md / status.md → STRIDE prod via git
git add data/<user-uuid>/logs/<week>/plan.md
git commit -m "docs: update week plan"
git push origin master   # sync-data.yml uploads the markdown to Azure Files
```

### When something only works locally but not in prod

Most likely: the content is a DB row that never propagated. Check `activity_commentary` first. `plan.md` / `feedback.md` should always propagate via git push + `sync-data.yml`; if they don't, inspect the workflow run.

### Multi-model variants 流程 (when applicable)

When you want to A/B/C the same week against multiple LLMs (Claude / Codex / Gemini) before committing to one, use the variant flow. Variants are append-only side rows; selecting one promotes its markdown + structured layer into the canonical `weekly_plan` / `planned_session` / `planned_nutrition` tables — same path the existing UI / push / commentary code already reads.

**Canonical happy path**:

```bash
# 1. Generate 3 model variants for next week (parallel via omc-teams).
#    Each model gets the same context (TRAINING_PLAN.md + recent
#    weeks' plan.md + feedback.md), with a sentinel-anchored JSON
#    output protocol. Failures upload as parse_failed (browsable but
#    unselectable). Auth required (no anonymous fallback).
coros-sync plan generate-variants -P zhaochaoyi --week 2026-05-04_05-10 \
    --models claude,codex,gemini --prod-url $STRIDE_PROD_URL

# 2. UI: open https://stride-app.../week/<folder> → "方案" tab
#    (only visible when variants_summary.total > 0)
#    → rate 4 dimensions + overall on each variant (sliders, 800ms
#       debounced; comment textarea same)
#    → click "选定" on the preferred variant
#    Or via CLI:
coros-sync plan select -P zhaochaoyi --week 2026-05-04_05-10 --variant-id <N>
```

**Change-of-mind / re-select scenario**:

If you've already pushed a session to the watch from variant A and then change to variant B, the prior pushed `scheduled_workout` rows lose their plan-side back-pointer:

- `coros-sync plan select` (or UI 改选) returns **HTTP 409 selection_conflict** with `already_pushed_count` when force is false.
- Pass `--force` (UI: confirm dialog) to override. The response lists `dropped_scheduled_workout_ids: [...]` — those rows get `scheduled_workout.abandoned_by_promote_at = now`.
- **Manual cleanup required**: open COROS App and delete the listed `[STRIDE]` watch entries before pushing the new variant's sessions, or you'll get duplicates on the watch.
- The "训练计划" tab shows a red banner listing the abandoned dates; the relevant `ActivityDetailPage` shows a warning card on completed activities tied to abandoned scheduled_workouts.

**Why no auto re-stitch**: Step 0 spike measured `(date, session_index, kind)` matching-key hit rate at **73.7%** across 12 directed pairs of 4 evaluation/ variants — below the 90% gate. Bimodal distribution (8/12 at 100% intra-cluster vs 4/12 at ~45% cross-cluster) means we can't rely on the key being stable across model outputs that disagree on the long-run cadence. Step 1 ships the FALLBACK design: every prior `scheduled_workout` becomes an orphan on 改选; user manually cleans up COROS. See `.omc/plans/multi-variant-weekly-plans.md` § Step 0 + `spike/restitch-findings.md` (local-only).

**`coros-sync plan` subcommands**:

- `generate-variants` — fan out to N `omc ask <model>` workers (ThreadPoolExecutor, 180s timeout each), parse each output via 3-tier sentinel/fenced/balanced-braces parser with hard `schema='weekly-plan/v1'` anchor, POST each to `/api/{user}/plan/{folder}/variants`.
- `list-variants` — GET active variants (or `--include-superseded`), table view with model_id / status / sessions / overall rating / is_selected / selectable.
- `rate` — UPSERT per-dimension ratings: `--overall N --suitability N --structure N --nutrition N --difficulty N --comment STR` (any subset of dims).
- `select` — promote variant; auto-retries once on 409 concurrent_select with `Retry-After: 1`.
- `delete-variants` — clear all variants + ratings for a week (confirmation prompt unless `--yes`).

(CLAUDE.md is in `deploy.yml`'s trigger paths but doc-only edits don't affect runtime — the build skips on no-code-change deltas.)

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
                feedback.md              # training feedback with RPE
            2026-04-20_04-26(W0)/
                plan.md
    dehua/                       # another user
        coros.db
        config.json
        TRAINING_PLAN.md
        logs/
src/                 # contains the source code for the tools
tests/               # contains testing files for the tools
frontend/            # React + Vite frontend (STRIDE dashboard)
```

### Multi-user Architecture

Each user has an isolated directory under `data/{user_id}/` (UUID-keyed — `{user_id}` is the JWT `sub` UUID) containing their own SQLite database, COROS credentials, and training logs. The CLI uses `--profile` / `-P` to select a user — pass the UUID directly, or a friendly slug (e.g. `zhaochaoyi`) that's resolved to its UUID via `data/.slug_aliases.json`. The API uses `/{user_id}/` path prefix and rejects requests where the path UUID doesn't match the JWT `sub`.

## Training Plan (plan.md)

Each weekly plan.md must comprehensively cover three major components:

1. **Running**: daily run schedule, pace targets, heart rate zones, weekly mileage goal
2. **Strength & Conditioning**: strength training, core work, flexibility/mobility exercises with specific movements and sets/reps
3. **Nutrition**: calorie targets based on InBody data, macronutrient breakdown (protein/carbs/fat), meal suggestions

When creating a plan, consider how these three components interact — for example: differentiated carb intake on run days vs rest days, protein timing around strength sessions, and calorie deficit management during recovery weeks.

**Important**: When answering any question about current status, load, fatigue, or training metrics, ALWAYS run `PYTHONIOENCODING=utf-8 python -m coros_sync -P {username} sync` first to ensure the local database has the latest data before querying. Default user is `zhaochaoyi`.

**力量训练动作选择原则**: 优先使用COROS内置动作（377个），这样推送到手表后有动画指导和标准化记录。内置动作库见 `src/coros_sync/exercise_catalog.md`。**生成 plan.md 时必须为每个动作填写 COROS ID 列**（T-code，例 `T1262`），由 adapter 在 push 时按 ID 直接 lookup catalog —— 没有名称匹配，没有模糊容错，错就错在你填的 T-code 上，容易发现和修。catalog 中真没有的动作允许留空，adapter 会自动通过 `client.add_exercise()` 创建自定义（无动画但功能完整）。

### 推送力量训练到手表（COROS / Garmin）的动作 ID 策略

**Authoring 时记录 ID**：生成 plan.md 时，力量动作表必须含 "COROS ID" 列。Claude 从 `src/coros_sync/exercise_catalog.md` 查找匹配的 T-code 填入。例：

| # | 动作 | COROS ID | 组×次 | 组间 | 要点 |
|---|------|----------|-------|------|------|
| 1 | 哑铃高脚杯深蹲（5kg） | T1336 | 3×12 | 45s | 哑铃贴胸，全蹲到底 |
| 2 | 平板支撑 | T1262 | 3×60s | 30s | 臀腰平直 |

**plan.json 字段**：每个 `StrengthExerciseSpec` 携带 `provider_id`（COROS T-code）。

**Push 时**：adapter 用 `provider_id` 在 `client.query_exercises` 结果里按 `name` 字段直接 lookup。命中即用 catalog 的 dict（带动画 + 标准化记录）。lookup 失败（provider_id 缺失或 catalog 没有）→ fallback `client.add_exercise` 创建自定义。

**为什么取消名称匹配**：(1) 名称匹配模糊不可靠（中英混杂、equipment suffix、token overlap 都会误命中错误动作）。(2) 错误命中 ≠ 没匹配 — 看似命中但实际是远房动作，watch 端没动画且数据不对。(3) ID 匹配是 O(1) 确定性 lookup，没有匹配错误的可能 — 错就错在 authoring 层填错 T-code，容易发现和修。

**Authoring 责任**：Claude 生成 plan.md 时必须查 `exercise_catalog.md` 选准 T-code。catalog 没有的动作（罕见）允许留空，adapter 会自动创建自定义动作（无动画但功能完整）。

**适配器实现**：`src/coros_sync/translate.py:normalized_to_coros_strength`（COROS）。Garmin adapter 当前还未支持力量推送（参见"Folder Structure"节末尾），将来实现时复用同一 ID 策略。

Before drafting a new weekly plan, always review the following inputs:

- **Current training phase**: where this week sits in the overall periodization (from TRAINING_PLAN.md)
- **Previous week's feedback**: RPE data, perceived fatigue, and any issues noted in the prior week's feedback.md
- **Recent body metrics**: resting heart rate, HRV trends, sleep quality/duration — sourced via `coros-sync status` or `coros-sync analyze hrv`
- **Latest InBody data**: body weight, body fat %, skeletal muscle mass trends

Adjust training load, nutrition, and recovery based on these signals. For example: if HRV is trending down or sleep quality is poor, reduce intensity and increase recovery; if body fat is stalling, revisit the calorie deficit.

当创建或更新训练计划时，不要”已推送到 COROS 手表的训练”这个章节。

当创建或更新训练计划后，检查计划中的内容，剔除或合并相同内容。

**周计划精简原则**（plan.md 篇幅控制）：

- 目标长度 **80-150 行**。超过 200 行就是过度啰嗦，必须精简。
- **保留**：”为什么这么跑”的简要理由——但用 inline 括号 / 半句带过，不要多段铺陈。例如 “26K 默认（W1 25K +1K，符合 5-10% 周-周递进）” 而不是 5 行论证。
- **删除**：
  - 多个备选方案的对比论证（”为什么选 C 不选 A 或 B”）—— 直接给最终决策即可；备选方案讨论放 commit message 或一次性记录。
  - 重复 TRAINING_PLAN.md 已有的内容（区间定义、阶段定义、温度规则等）—— 引用即可。
  - 大块”教练思路”或”决策推演”段落 —— 决定就是决定，不要再论证。
  - 多版本演进记录（V1→V2→V3）—— 不是周计划职责，git history 已经记录了。
- **优先用表格而不是文字段**：每日表、距离决策矩阵、监控触发表、营养时机表等。表格信息密度高于段落。
- **结构模板**（仅供参考，不是硬规则）：本周定位 1 段 → 上周小结 → 本周目标 → 每日表 → 各专项（核心课/辅助课/力量等）→ 营养 → 监控 → 下周衔接。
- **执行视角**优先于解释视角：plan.md 是给未来某天的”我”看的执行清单，不是给读者讲一遍训练学。简洁直白。

### Fatigue / Training Load Data

The `daily_health` table stores daily fatigue and training load metrics synced from COROS. Key fields:

| Field | Description |
|-------|-------------|
| `fatigue` | Fatigue score (from COROS `tiredRate`). <40 recovered, 40-50 normal, 50-60 fatigued, >60 high fatigue |
| `ati` | Acute Training Index — 7-day weighted training load (short-term stress) |
| `cti` | Chronic Training Index — 28-day weighted training load (fitness baseline) |
| `training_load_ratio` | ATI/CTI ratio. 0.8-1.0 optimal, >1.2 Very High, <0.7 detraining |
| `training_load_state` | COROS label: Low / Optimal / High / Very High |
| `rhr` | Resting heart rate |

To query fatigue trends:

```bash
# Sync latest health data first
PYTHONIOENCODING=utf-8 python -m coros_sync -P zhaochaoyi sync

# Query recent fatigue (last 14 days)
python -c "
from stride_core.db import Database
db = Database(user='zhaochaoyi')
rows = db._conn.execute('''
    SELECT date, fatigue, training_load_ratio, training_load_state, rhr, ati, cti
    FROM daily_health ORDER BY date DESC LIMIT 14
''').fetchall()
for r in rows: print(dict(r))
"
```

When creating weekly plans, include the fatigue trend table for context. Key thresholds for race readiness:
- **Race-ready**: fatigue <35, load ratio 0.7-0.9, RHR at baseline, TSB 10-25
- **Normal training**: fatigue 40-50, load ratio 0.8-1.1, TSB -30 to -10
- **Needs recovery**: fatigue >50, load ratio >1.2, RHR elevated, TSB < -30

### TSB (Training Stress Balance) — PMC

TSB = CTI − ATI. Indicates readiness to perform:

| TSB Zone | Range | Meaning |
|----------|-------|---------|
| 比赛就绪 | 10 ~ 25 | Well-rested, peak performance |
| 过渡区 | -10 ~ 10 | Recovering or maintaining |
| 正常训练 | -30 ~ -10 | Productive training stress |
| 过度负荷 | < -30 | Too much stress, injury/overtraining risk |
| 减量过多 | > 25 | Losing fitness, too much rest |

### HRV (Heart Rate Variability)

HRV data is currently a snapshot from the COROS dashboard (`avg_sleep_hrv`, `hrv_normal_low`, `hrv_normal_high`). Daily HRV trends require the COROS sleep detail API (not yet implemented — tracked as a future feature).

When analyzing status, combine all signals: RHR + HRV + fatigue + TSB + training_load_ratio for a holistic picture. A single metric can be misleading; convergence of multiple signals is more reliable.

## The feedback.md

This file contains the feedback for the trainings in this week, ususally contains perceived exertion.

**自动同步训练反馈**: 每次执行 `coros-sync sync` 同步到新的训练记录后，检查本周的活动是否带有训练反馈（`sport_note` 字段不为空）。如果有，将反馈内容追加到对应周目录的 `feedback.md` 中。格式为直接追加原始文本，保持与用户在 COROS App 中写的一致。查询方式：

```python
from stride_core.db import Database
db = Database(user='zhaochaoyi')
rows = db._conn.execute('''
    SELECT date, name, sport_name, feel_type, sport_note
    FROM activities
    WHERE sport_note IS NOT NULL AND date >= ?
    ORDER BY date
''', (week_start_iso,)).fetchall()
```

`feel_type` 含义（COROS App 训练后表情评分）：1=很好, 2=好, 3=一般, 4=差, 5=很差。若无法确认准确映射，以用户 `sport_note` 文字内容为准。

**Feedback 自动生成，不要使用模板**: feedback.md 不需要提前创建模板。内容全部从数据自动获取：
1. **主观反馈**（`sport_note` + `feel_type`）— 从 COROS App 训练反馈同步，是用户在训练后写的体感和备注
2. **客观数据**（10km 测试成绩、周跑量、总时长、平均心率等）— 从 DB 活动记录和健康数据查询
每次更新 feedback.md 时追加内容，不覆盖已有内容。不要用 `____` 占位符。

I will use RPE (Rate of Perceived Exertion) as the metrics to measure how hard I'm during a run. The RPE effort rates from 1 to 10.
RPE 1 Very Easy
No effort. Walking or complete rest.
RPE 2 Easy
Very light effort. Comfortable jog, full sentences are easy.
RPE 3 Easy / Conversational
Easy running. Breathing is relaxed; you can talk comfortably for a long time.
RPE 4 Comfortable but Working
Slight effort. Breathing is deeper but controlled; conversation is still easy.
RPE 5 Moderate
Noticeable effort. Breathing is steady but stronger; talking takes more focus.
(Sustainable for a long time 45 often marathon effort.)
RPE 6 Moderately Hard
Challenging but controlled. Breathing is heavier; you can speak only short sentences.
RPE 7 Hard
Hard effort. Deep, fast breathing; only a few words at a time.
(Sustainable for a limited time 45 threshold effort.)
RPE 8 Very Hard
Very demanding. Breathing is labored; speaking is difficult.
(Common for intervals or 5K effort.)
RPE 9 Extremely Hard
Near maximal effort. Barely sustainable; focus is on holding pace.
RPE 10 Maximal
All-out effort. Sprinting; cannot be sustained for more than a short burst.

## How to use the InBody report

The InBody report contains core metrics like
- Weight
- Body Fat Percentage
- Body Fat Mass
- Skeletal Muscle Mass

We need to use it to track fat loss vs muscle gain
monitoring fitness and training progress
long-term trend analysis, trend comparison over time.


## Tools 

**coros-sync** — A CLI tool that syncs running data from COROS watches (via unofficial Training Hub API) into a local SQLite database for analysis, export, and workout scheduling.

### Commands

The CLI entry point `coros-sync` may not be on PATH. Use `python -m coros_sync` instead.
On Windows, set `PYTHONIOENCODING=utf-8` to avoid Rich/Unicode rendering errors with cp1252.

```bash
# Install (editable, with all extras)
pip install -e ".[dev,analysis]"

# Run CLI — use -P/--profile to select user (UUID or slug; data stored in data/{user_id}/)
# Without -P, falls back to legacy platformdirs paths
PYTHONIOENCODING=utf-8 python -m coros_sync -P zhaochaoyi login
PYTHONIOENCODING=utf-8 python -m coros_sync -P zhaochaoyi sync [--full] [-j 4]
PYTHONIOENCODING=utf-8 python -m coros_sync -P zhaochaoyi status
PYTHONIOENCODING=utf-8 python -m coros_sync -P zhaochaoyi export [--from YYYYMMDD] [--to YYYYMMDD] [-o file.csv]
PYTHONIOENCODING=utf-8 python -m coros_sync -P zhaochaoyi analyze weekly|monthly|zones|load|hrv|predictions
PYTHONIOENCODING=utf-8 python -m coros_sync -P zhaochaoyi workout push easy|tempo|interval|long --date YYYYMMDD [options]
PYTHONIOENCODING=utf-8 python -m coros_sync -P zhaochaoyi workout week --start YYYYMMDD
PYTHONIOENCODING=utf-8 python -m coros_sync -P zhaochaoyi workout delete YYYYMMDD

# For dehua:
PYTHONIOENCODING=utf-8 python -m coros_sync -P dehua login
PYTHONIOENCODING=utf-8 python -m coros_sync -P dehua sync

# Push strength training (programmatic, no CLI command yet)
python -c "
from coros_sync.client import CorosClient
from coros_sync.workout import StrengthWorkout, push_strength_workout

client = CorosClient(user='zhaochaoyi')  # or 'dehua'
exercises = client.query_exercises(sport_type=4)  # 419 built-in + custom

# Find exercise by overview keyword
def find_ex(keyword):
    return next(e for e in exercises if keyword in e.get('overview',''))

workout = StrengthWorkout(name='力量训练', date='20260417')
workout.add_exercise(find_ex('planks'), sets=3, target_type=2, target_value=45, rest_value=60)
workout.add_exercise(find_ex('bird_dog'), sets=3, target_type=3, target_value=10, rest_value=30)
push_strength_workout(client, workout)

# Create custom exercise if no built-in match
custom = client.add_exercise({
    'sportType': 4, 'exerciseType': 2,
    'name': '动作名', 'overview': '动作名',
    'part': ['4'], 'muscle': ['6'], 'muscleRelevance': [],
    'equipment': ['1'], 'access': 1,
    'intensityCustom': 0, 'intensityMultiplier': 0,
    'intensityType': 1, 'intensityValue': 0, 'intensityValueExtend': 0,
    'restType': 1, 'restValue': 30, 'targetType': 3, 'targetValue': 15
})
"

# Direct DB query (when CLI export doesn't work)
python -c "
from stride_core.db import Database
db = Database(user='zhaochaoyi')
rows = db._conn.execute('SELECT * FROM activities WHERE date >= ? ORDER BY date', ('2026-03-30',)).fetchall()
for r in rows: print(dict(r))
"

# Tests
pytest                    # run all tests
pytest tests/test_db.py   # single file
pytest -k test_pace_str   # single test by name
```

### Architecture

#### API Layer (`client.py`)
- `CorosClient` wraps the unofficial COROS Training Hub REST API via `httpx`
- Three regional API bases: global, cn, eu — auto-detected at login
- Token auto-refresh with thread-safe re-login (`_relogin_lock`) for parallel fetches
- Two request patterns: `_request()` for GET/POST with query params (optional `yfheader`), `_request_json()` for JSON body endpoints that need the `yfheader` (workout/training endpoints)
- Rate-limited with configurable `request_delay` between calls
- **Exercise library**: `query_exercises(sport_type)` queries built-in + custom exercises; `add_exercise()` creates custom exercises

#### Data Models (`models.py`)
- Dataclasses with `from_api()` classmethods as the **sole unit-conversion boundary** — all API-to-internal unit mapping happens here
- Key COROS API quirks: distance in cm*1000 (divide by 100,000 for meters), time in centiseconds (divide by 100), calories in cal*1000
- `Activity` (list summary) vs `ActivityDetail` (full detail with laps, zones, timeseries) are separate models from different endpoints

#### Database (`db.py`)
- SQLite with WAL mode, stored at `platformdirs.user_data_dir("coros-sync")/coros.db`
- Schema: `activities`, `laps`, `zones`, `timeseries`, `daily_health`, `dashboard`, `race_predictions`, `sync_meta`
- All writes use `INSERT OR REPLACE` for idempotent upserts
- `Database(db_path)` accepts optional path for testing; tests use `tmp_path` fixture

#### Sync Engine (`sync.py`)
- Incremental by default: paginate activity list until hitting an already-synced `label_id`
- Parallel detail fetching via `ThreadPoolExecutor` (configurable `jobs`), sequential DB writes
- Two phases: `sync_activities()` then `sync_health()` (analyse + dashboard endpoints)

#### Workout Builder (`workout.py`)
- Reverse-engineered COROS workout protocol for both running and strength training
- **Running**: `RunWorkout` builder with `exerciseType` (1=warmup, 2=training, 3=cooldown), pace in ms/km, distance in mm
  - `push_workout()` flow: query schedule for next `idInPlan` → build payload → calculate via API → push update
- **Strength** (sportType=4): `StrengthWorkout` builder with exercises from COROS library
  - `push_strength_workout()` — same calculate → push flow as running
  - Exercises come from `client.query_exercises(sport_type=4)` (419 built-in + custom)
  - Custom exercises created via `client.add_exercise()` when no built-in match exists
  - Key fields: `targetType` (2=time in seconds, 3=reps), `sets`, `restValue` (seconds)
  - **Exercise name matching**: COROS built-in names may differ from common names (e.g. "侧卧平板撑" = "侧平板"). Always search the library first before creating custom exercises.

#### Auth (`auth.py`)
- Credentials stored as JSON at `platformdirs.user_config_dir("coros-sync")/config.json`
- Password stored as MD5 hash (matching COROS API expectation)

### Testing

- Tests use `pytest` with `pytest-httpx` available for HTTP mocking
- `conftest.py` provides a `db` fixture with a temp SQLite database
- `test_models.py` covers unit conversions; `test_db.py` covers database operations
- No tests currently exist for `client.py`, `sync.py`, or `workout.py` (these hit external APIs)

### Key Conventions

- Dates are `YYYYMMDD` strings throughout (matching COROS API format)
- Pace values are seconds-per-km internally; displayed as `M:SS/km` via `pace_str()`
- CLI uses Click groups: `cli` (top-level), `analyze` (subgroup), `workout` (subgroup)
- Analysis commands lazy-import pandas/matplotlib to keep core deps light
- `rich` is used for all terminal output (tables, progress bars, colored text)

## Frontend (STRIDE Dashboard)

React + Vite + TypeScript SPA at `frontend/`. Light theme, monospace-heavy design. Shared sidebar navigation via `AppLayout` component.

### Pages

| Route | Component | Description |
|-------|-----------|-------------|
| `/` | `WeekLayout` | Main view — sidebar with week list, main area with plan/activities/feedback tabs |
| `/week/:folder` | `WeekLayout` | Specific week view |
| `/activity/:id` | `ActivityDetailPage` | Activity detail — metrics, HR/pace charts, zones, segment data, sport_note feedback |
| `/health` | `HealthPage` | Fatigue, HRV, RHR, training load trends (recharts) |
| `/plan` | `TrainingPlanPage` | Overall training plan with phase timeline visualization |
| `/login` | `LoginPage` | Auth (Entra ID / MSAL) |

### API Layer (`src/stride_server/`)

FastAPI backend serving both the REST API and the built frontend (SPA static files). Entry module is `stride_server.main:app` (run via `uvicorn stride_server.main:app`). The app is a composition of three packages:

- **`stride_core/`** — shared data layer: DB schema, models, analyze/export helpers, and the `DataSource` protocol (`stride_core/source.py`). Source-agnostic — does not import `coros_sync`.
- **`coros_sync/`** — COROS-specific adapter + CLI. `coros_sync/adapter.py::CorosDataSource` implements `DataSource`.
- **`stride_server/`** — FastAPI routes split under `routes/{users,activities,weeks,sync,training_plan,health}.py`. Routes access the sync adapter via `Depends(get_source)` — never by importing `coros_sync` directly. Composition happens once in `stride_server/main.py` (`create_app(CorosDataSource())`).

Key endpoints:
- `GET /api/users` — list user profiles (`routes/users.py`)
- `GET /api/{user}/activities` — paginated activity list with filters (`routes/activities.py`)
- `GET /api/{user}/activities/{id}` — activity detail (laps, segments, zones, timeseries)
- `POST /api/{user}/activities/{id}/resync` — re-fetch single activity from COROS (for updated feedback)
- `GET /api/{user}/weeks` / `GET /api/{user}/weeks/{folder}` (`routes/weeks.py`) — training-week plan/feedback/activities
- `GET /api/{user}/training-plan` — TRAINING_PLAN.md content + parsed phase timeline (`routes/training_plan.py`)
- `GET /api/{user}/dashboard` / `/health` / `/pmc` / `/stats` — fitness & health (`routes/health.py`)
- `POST /api/{user}/sync` — trigger a full data sync via the configured `DataSource` (`routes/sync.py`)

### Segment Display

Activity segments use `exercise_type` mapping for display names (热身/训练/放松/恢复). For known COROS exercise codes (T-codes for strength, S-codes for rest), names come from `_EXERCISE_NAMES` dict. Unknown S-codes (e.g. running workout plan references like S4208) fall back to `exercise_type` mapping.

### Weekly Feedback

The "本周反馈" tab combines two sources:
1. `feedback.md` file from the week's logs directory
2. `sport_note` fields from DB activities for that week (deduplicated by checking first 20 chars against existing feedback)

## Deployment

### Docker

Multi-stage build (`Dockerfile`):
1. **Stage 1** (node:24-alpine): Build frontend with Vite
2. **Stage 2** (python:3.13-slim): Python runtime with FastAPI/uvicorn, copies built frontend

`.dockerignore` excludes `data/` but allows `data/*/TRAINING_PLAN.md` so training plans are baked into the image as defaults.

### CI/CD (GitHub Actions)

Two workflows drive production:

**`.github/workflows/deploy.yml`** — rebuild + redeploy the container. Triggers on push to `master` when `src/coros_sync/**`, `src/stride_core/**`, `src/stride_server/**`, `frontend/**`, `Dockerfile`, `.github/workflows/deploy.yml`, or `pyproject.toml` change.
Pipeline: Build Docker image → Push to GHCR → Azure Login (OIDC) → Deploy to Azure Container Apps → Health check.

**`.github/workflows/sync-data.yml`** — sync training-log markdown to the prod Azure Files share. Triggers on push to `master` when `data/*/logs/**`, `data/*/TRAINING_PLAN.md`, or `data/*/status.md` change. Uploads via `az storage file upload-batch` to share `stride-data` on storage account `authstorage2026` (resource group `rg-common-prod`). This is why `plan.md` / `feedback.md` appear in prod without a container rebuild — they land on Azure Files at runtime, not in the image. `.dockerignore` excludes `data/` entirely except `data/*/TRAINING_PLAN.md`; so markdown under `logs/` reaches prod ONLY via `sync-data.yml`, not via the image.

**DB-row content** (e.g. `activity_commentary`) is NOT covered by `sync-data.yml` since it lives inside SQLite, not markdown. Use `coros-sync -P <user> commentary push <label_id> --url $STRIDE_PROD_URL` to sync a row, which POSTs to `/api/{user}/activities/{label_id}/commentary` on the server.

**Structured-plan reparse webhook**: after every `data/*/logs/*/plan.md` push, `sync-data.yml` calls `POST /internal/plan/reparse?user=&folder=` with header `X-Internal-Token: $STRIDE_INTERNAL_TOKEN` so the server re-runs the LLM reverse parser and refreshes the `planned_session` / `planned_nutrition` cache. Two pieces have to be configured for this to work:

- GitHub Actions secrets: `STRIDE_PROD_URL` (e.g. `https://stride-app.<region>.azurecontainerapps.io`) and `STRIDE_INTERNAL_TOKEN` (random 32+ char string).
- Azure Container App env var: same `STRIDE_INTERNAL_TOKEN` value, e.g. `az containerapp update --name stride-app --resource-group rg-running-prod --set-env-vars STRIDE_INTERNAL_TOKEN=<value>`. With this unset on the server side the route 401s; with both unset the workflow step skips silently.

### Infrastructure

- **Container**: Azure Container Apps (`stride-app` in `rg-running-prod`)
- **Registry**: GitHub Container Registry (`ghcr.io`)
- **Storage**: Azure Files share `stride-data` on `authstorage2026` (RG `rg-common-prod`), mounted at `/app/data` — contains per-user SQLite databases, credentials, logs, and training plans
- **Auth**: Entra ID OIDC for deployment; separate auth-service (see below) for API-level authn/authz

### Authentication (auth-service)

STRIDE does **not** run its own auth. It integrates with a separate in-house auth service:

- **Repo**: `C:\Users\zhaochaoyi\workspace\auth` (monorepo). Backend code: `sources/dev/authentication/` (Rust/Axum, Azure Table Storage, JWT RS256).
- **Deployment**: Azure Container Apps (image `ghcr.io/<owner>/auth-backend`). JWT keys on Azure File Share. Release model is CalVer (`YYYY.M.MICRO`) via auto-tagged releases.
- **Auth model**: OAuth2 + JWT (RS256) with PKCE. Public key is served by the auth service and used to verify access tokens.

**Relevant endpoints** (base URL is the auth-service FQDN):

| Prefix | Header | Purpose |
|--------|--------|---------|
| `POST /api/auth/register`, `/login`, `/refresh`, `/logout` | `X-Client-Id: <app>` | User auth flows — returns access + refresh tokens |
| `GET /api/users/me`, `/accounts` | `Authorization: Bearer <jwt>` | Current-user info |
| `POST /oauth/token`, `/revoke`, `/introspect` | `Authorization: Basic <client_id:secret>` | Machine-to-machine + token lifecycle |
| `GET /health` | none | health |

**Current wiring** (enabled in prod):

1. **Server** (`src/stride_server/bearer.py`): `require_bearer` FastAPI dependency reads the auth-service public key from `STRIDE_AUTH_PUBLIC_KEY_PEM` (inline PEM) or `STRIDE_AUTH_PUBLIC_KEY_PATH` (file), verifies RS256 tokens locally (no network call). Validates `iss` (default `auth-service`) and, when `STRIDE_AUTH_AUDIENCE` is set, `aud`. If no public key env var is set, verification is bypassed with a one-time warning log (fail-open for dev). This is **enabled** on the Azure Container App as of revision `stride-app--0000037`:
   - `STRIDE_AUTH_PUBLIC_KEY_PEM` → secretref `auth-public-pem` (downloaded from `authstorage2026/jwt-keys/public.pem`)
   - `STRIDE_AUTH_AUDIENCE=app_62978bf2803346878a2e4805` (the STRIDE frontend client_id, reused here)

2. **Protected endpoints** — every `/api/*` route except `/api/health` requires Bearer when the key env var is set. The factory in `stride_server/app.py` applies router-level `Depends(require_bearer)` to all routers except `public` (which hosts only `/api/health` for the Azure liveness probe). CORS is intentionally kept wide open (`allow_origins=["*"]`) — the real authz boundary is the Bearer layer, not Origin. Verified: no token on any `/api/*` (except `/api/health`) → 401, with valid user token → 200. This covers both reads (`/users`, `/weeks`, `/activities`, `/dashboard`, `/health`, `/pmc`, `/stats`, `/training-plan`) and writes (`/sync`, `/resync`, `/commentary`).

3. **CLI** (`coros-sync auth` group):
   - `auth login --email X --auth-url Y --client-id Z` exchanges email/password for tokens via `/api/auth/login` and persists them to `data/{user_id}/auth.json`.
   - `auth logout` removes the stored token; `auth status` prints metadata.
   - `commentary push` auto-attaches `Authorization: Bearer <access_token>`, auto-refreshes via `/api/auth/refresh` if the token expires within 60s. Falls back to anonymous if no token is stored.

4. **Canonical env for local CLI**:

   ```bash
   export STRIDE_AUTH_URL="https://auth-backend.delightfulwave-240938c0.southeastasia.azurecontainerapps.io"
   export STRIDE_CLIENT_ID="app_62978bf2803346878a2e4805"
   export STRIDE_PROD_URL="https://stride-app.victoriousdesert-bd552447.southeastasia.azurecontainerapps.io"
   ```

   First-time login (credentials from `.credentials.local`, git-ignored):

   ```bash
   coros-sync -P zhaochaoyi auth login \
     --email "$(awk -F= '/^email/{print $2}' .credentials.local | tr -d ' ')" \
     --password "$(awk -F= '/^password/{print $2}' .credentials.local | tr -d ' ')"
   ```

   Subsequent writes (e.g. after Claude generates a commentary):

   ```bash
   coros-sync -P zhaochaoyi commentary push <label_id>
   ```

5. **Frontend**: already on the auth-service flow (no legacy MSAL). `frontend/src/store/authStore.ts` handles login/refresh with `sessionStorage`; `frontend/src/api.ts` attaches `Authorization: Bearer` on every request (including `triggerSync` and `resyncActivity`) and auto-retries once on 401. A 401 after refresh redirects to `/login`.

6. **Still open (follow-ups, non-blocking)**:
   - Add a JWKS endpoint to the auth-service so public-key rotation becomes network-discoverable instead of requiring env var updates on both sides.

### Build Commands

```bash
# Frontend dev
cd frontend && npm run dev      # Vite dev server with HMR
cd frontend && npm run build    # tsc -b && vite build (used in Docker)

# Backend dev
PYTHONIOENCODING=utf-8 uvicorn stride_server.main:app --reload --port 8000

# Full Docker build
docker build -t stride .
docker run -p 8080:8080 -v ./data:/app/data stride
```
