# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This project contains the training plans, logs for a marathon runner.
It also contains tools like coros-sync to sync the training data from COROS to the local for further analysis.

## Folder Structure

```
logs/
    3-30_4-5/       # folder name: <start date>_<end date> contains all training log for that week.
        plan.md     # which contains the training plan for this week
        inbody.jpg  # In-body body composition test report
        feedback.md # Training feedback for this week
    4-6_4-12/
        plan.md
        inbody.png
        feedback.md
src/                 # contains the source code for the tools
tests/               # contains testing files for the tools
TRAINING_PLAN.md     # The overall training plan of current training season.
```

## Training Plan (plan.md)

Each weekly plan.md must comprehensively cover three major components:

1. **Running**: daily run schedule, pace targets, heart rate zones, weekly mileage goal
2. **Strength & Conditioning**: strength training, core work, flexibility/mobility exercises with specific movements and sets/reps
3. **Nutrition**: calorie targets based on InBody data, macronutrient breakdown (protein/carbs/fat), meal suggestions

When creating a plan, consider how these three components interact — for example: differentiated carb intake on run days vs rest days, protein timing around strength sessions, and calorie deficit management during recovery weeks.

**Important**: When answering any question about current status, load, fatigue, or training metrics, ALWAYS run `PYTHONIOENCODING=utf-8 python -m coros_sync sync` first to ensure the local database has the latest data before querying.

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
PYTHONIOENCODING=utf-8 python -m coros_sync sync

# Query recent fatigue (last 14 days)
python -c "
from coros_sync.db import Database
db = Database()
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

# Run CLI (use python -m coros_sync instead of coros-sync)
PYTHONIOENCODING=utf-8 python -m coros_sync login
PYTHONIOENCODING=utf-8 python -m coros_sync sync [--full] [-j 4]
PYTHONIOENCODING=utf-8 python -m coros_sync status
PYTHONIOENCODING=utf-8 python -m coros_sync export [--from YYYYMMDD] [--to YYYYMMDD] [-o file.csv]
PYTHONIOENCODING=utf-8 python -m coros_sync analyze weekly|monthly|zones|load|hrv|predictions
PYTHONIOENCODING=utf-8 python -m coros_sync workout push easy|tempo|interval|long --date YYYYMMDD [options]
PYTHONIOENCODING=utf-8 python -m coros_sync workout week --start YYYYMMDD
PYTHONIOENCODING=utf-8 python -m coros_sync workout delete YYYYMMDD

# Direct DB query (when CLI export doesn't work)
python -c "
from coros_sync.db import Database
db = Database()
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
- Two request patterns: `_request()` for GET/POST with query params, `_request_json()` for JSON body endpoints that need the `yfheader` (workout/training endpoints)
- Rate-limited with configurable `request_delay` between calls

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
- Reverse-engineered COROS workout protocol: `exerciseType` (1=warmup, 2=training, 3=cooldown), pace in ms/km, distance in mm
- `RunWorkout` builder pattern: `.add_warmup()` → `.add_training()` → `.add_cooldown()`
- `push_workout()` flow: query schedule for next `idInPlan` → build payload → calculate via API → push update

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
