# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This project contains the training plans, logs for multiple marathon runners.
It also contains tools like coros-sync to sync the training data from COROS to the local for further analysis.

## Folder Structure

```
data/
    zhaochaoyi/                  # per-user data directory
        coros.db                 # user's SQLite database
        config.json              # user's COROS credentials (git-ignored)
        logs/
            2026-04-13_04-19(赛后恢复)/  # format: YYYY-MM-DD_MM-DD(阶段标注)
                plan.md                  # weekly training plan
                feedback.md              # training feedback with RPE
            2026-04-20_04-26(W0)/
                plan.md
    dehua/                       # another user
        coros.db
        config.json
        logs/
src/                 # contains the source code for the tools
tests/               # contains testing files for the tools
frontend/            # React + Vite frontend (STRIDE dashboard)
TRAINING_PLAN.md     # The overall training plan — Fall 2026 season (revised Apr 12)
```

### Multi-user Architecture

Each user has an isolated directory under `data/{username}/` containing their own SQLite database, COROS credentials, and training logs. The CLI uses `--profile` / `-P` to select a user, and the API uses `/{user}/` path prefix.

## Training Plan (plan.md)

Each weekly plan.md must comprehensively cover three major components:

1. **Running**: daily run schedule, pace targets, heart rate zones, weekly mileage goal
2. **Strength & Conditioning**: strength training, core work, flexibility/mobility exercises with specific movements and sets/reps
3. **Nutrition**: calorie targets based on InBody data, macronutrient breakdown (protein/carbs/fat), meal suggestions

When creating a plan, consider how these three components interact — for example: differentiated carb intake on run days vs rest days, protein timing around strength sessions, and calorie deficit management during recovery weeks.

**Important**: When answering any question about current status, load, fatigue, or training metrics, ALWAYS run `PYTHONIOENCODING=utf-8 python -m coros_sync -P {username} sync` first to ensure the local database has the latest data before querying. Default user is `zhaochaoyi`.

**力量训练动作选择原则**: 优先使用COROS内置动作（377个），这样推送到手表后有动画指导和标准化记录。内置动作库见 `src/coros_sync/exercise_catalog.md`。只有当内置库中确实没有匹配的动作时，才通过 `client.add_exercise()` 创建自定义动作。注意COROS动作名称可能与常用名称不同（如"侧卧平板撑"="侧平板"，"哥本哈根平板"="哥本哈根侧平板"），搜索时用关键词模糊匹配。

Before drafting a new weekly plan, always review the following inputs:

- **Current training phase**: where this week sits in the overall periodization (from TRAINING_PLAN.md)
- **Previous week's feedback**: RPE data, perceived fatigue, and any issues noted in the prior week's feedback.md
- **Recent body metrics**: resting heart rate, HRV trends, sleep quality/duration — sourced via `coros-sync status` or `coros-sync analyze hrv`
- **Latest InBody data**: body weight, body fat %, skeletal muscle mass trends

Adjust training load, nutrition, and recovery based on these signals. For example: if HRV is trending down or sleep quality is poor, reduce intensity and increase recovery; if body fat is stalling, revisit the calorie deficit.

当创建或更新训练计划时，不要“已推送到 COROS 手表的训练”这个章节。

当创建或更新训练计划后，检查计划中的内容，剔除或合并相同内容。

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
from coros_sync.db import Database
db = Database(user='zhaochaoyi')
rows = db._conn.execute('''
    SELECT date, fatigue, training_load_ratio, training_load_state, rhr, ati, cti
    FROM daily_health ORDER BY date DESC LIMIT 14
''').fetchall()
for r in rows: print(dict(r))
"
```

When creating weekly plans, include the fatigue trend table for context. Key thresholds for race readiness:
- **Race-ready**: fatigue <35, load ratio 0.7-0.9, RHR at baseline
- **Normal training**: fatigue 40-50, load ratio 0.8-1.1
- **Needs recovery**: fatigue >50, load ratio >1.2, RHR elevated

## The feedback.md

This file contains the feedback for the trainings in this week, ususally contains perceived exertion.

**自动同步训练反馈**: 每次执行 `coros-sync sync` 同步到新的训练记录后，检查本周的活动是否带有训练反馈（`sport_note` 字段不为空）。如果有，将反馈内容追加到对应周目录的 `feedback.md` 中。格式为直接追加原始文本，保持与用户在 COROS App 中写的一致。查询方式：

```python
from coros_sync.db import Database
db = Database(user='zhaochaoyi')
rows = db._conn.execute('''
    SELECT date, name, sport_name, feel_type, sport_note
    FROM activities
    WHERE sport_note IS NOT NULL AND date >= ?
    ORDER BY date
''', (week_start_iso,)).fetchall()
```

`feel_type` 含义（COROS App 训练后表情评分）：1=很好, 2=好, 3=一般, 4=差, 5=很差。若无法确认准确映射，以用户 `sport_note` 文字内容为准。

**Feedback 自动生成，不要使用模板**: feedback.md 不需要提前创建模板。内容来源：
1. **COROS 训练反馈**（`sport_note`）— 同步时自动追加
2. **客观数据**（10km 测试成绩、周跑量、总时长、平均心率等）— 从 DB 查询后直接写入，不用占位符
3. **主观反馈**（RPE、体感等）— 用户口头告诉后直接写入
每次更新 feedback.md 时追加内容，不覆盖已有内容。

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

# Run CLI — use -P/--profile to select user (data stored in data/{profile}/)
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
from coros_sync.db import Database
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
