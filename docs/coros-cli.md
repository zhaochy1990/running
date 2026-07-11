# coros-sync CLI 完整指南

**何时读**：跑 CLI 命令、写 sync / workout push 代码、或调 architecture 相关问题时必读。

## 一句话

CLI 工具，把 COROS 手表数据（经非官方 Training Hub API）同步到本地 SQLite，支持分析、导出、workout scheduling。

## 安装

```bash
pip install -e ".[dev,analysis]"
```

## 重要 caveat（Windows）

CLI 入口 `coros-sync` 可能不在 PATH。用 `python -m coros_sync` 替代。Windows 上必须设 `PYTHONIOENCODING=utf-8`，否则 Rich/Unicode 在 cp1252 下渲染报错。

## 常用命令

`-P/--profile` 选用户（UUID 或 slug；数据存 `data/{user_id}/`）；不传则 fallback 到 legacy platformdirs 路径。

```bash
PYTHONIOENCODING=utf-8 python -m coros_sync -P zhaochaoyi login
PYTHONIOENCODING=utf-8 python -m coros_sync -P zhaochaoyi sync [--full] [-j 4]
PYTHONIOENCODING=utf-8 python -m coros_sync -P zhaochaoyi status
PYTHONIOENCODING=utf-8 python -m coros_sync -P zhaochaoyi export [--from YYYYMMDD] [--to YYYYMMDD] [-o file.csv]
PYTHONIOENCODING=utf-8 python -m coros_sync -P zhaochaoyi analyze weekly|monthly|zones|load|hrv|predictions
PYTHONIOENCODING=utf-8 python -m coros_sync -P zhaochaoyi workout push easy|tempo|interval|long --date YYYYMMDD [options]
PYTHONIOENCODING=utf-8 python -m coros_sync -P zhaochaoyi workout week --start YYYYMMDD
PYTHONIOENCODING=utf-8 python -m coros_sync -P zhaochaoyi workout delete YYYYMMDD

# 另一个 user：
PYTHONIOENCODING=utf-8 python -m coros_sync -P dehua login
PYTHONIOENCODING=utf-8 python -m coros_sync -P dehua sync
```

## 直接查 DB（CLI export 用不了时）

```python
python -c "
from stride_core.db import Database
db = Database(user='zhaochaoyi')
rows = db._conn.execute('SELECT * FROM activities WHERE date >= ? ORDER BY date', ('2026-03-30',)).fetchall()
for r in rows: print(dict(r))
"
```

## Tests

```bash
pytest                    # 全部
pytest tests/test_db.py   # 单文件
pytest -k test_pace_str   # 按名字筛选
```

---

## Architecture

### API Layer (`client.py`)

- `CorosClient` wraps the unofficial COROS Training Hub REST API via `httpx`
- 三个区域 API base：global / cn / eu —— 登录时自动检测
- Token 自动刷新，并行 fetch 时 `_relogin_lock` thread-safe
- 两种请求模式：`_request()` 走 GET/POST + query params（可选 `yfheader`）；`_request_json()` 走 JSON body 端点（workout/training 必需 `yfheader`）
- 配置化 rate limit（`request_delay`）
- **Exercise library**：`query_exercises(sport_type)` 查内置 + 自定义；`add_exercise()` 创建自定义

### Data Models (`models.py`)

- Dataclasses + `from_api()` classmethod 是**唯一单位转换边界** —— 所有 API→内部单位映射只在这里
- COROS API 单位怪点：activity list summary 的 `distance` 已观察为米；detail/lap 的 `summary.distance` / `lap.distance` 已观察为厘米（除 100 得米）；frequencyList 的累计 `distance` 仍按 provider 原始采样处理，消费端用活动总距离校准；time centiseconds（除 100 得秒），calories cal*1000
- `Activity`（列表 summary） vs `ActivityDetail`（完整含 laps/zones/timeseries）来自不同端点

### Database (`db.py`)

- SQLite WAL，存 `platformdirs.user_data_dir("coros-sync")/coros.db`
- Schema：`activities`, `laps`, `zones`, `timeseries`, `daily_health`, `dashboard`, `race_predictions`, `sync_meta`
- 所有写入用 `INSERT OR REPLACE` 实现幂等 upsert
- `Database(db_path)` 接 optional path 用于测试；测试用 `tmp_path` fixture

### Sync Engine (`sync.py`)

- 默认增量：分页拉 activity list 直到撞上已同步的 `label_id`
- 详情用 `ThreadPoolExecutor` 并行（可配 `jobs`），DB 写入顺序进行
- 两阶段：`sync_activities()` then `sync_health()`（analyse + dashboard endpoints）

### Workout Builder (`workout.py`)

逆向工程的 COROS workout 协议，覆盖跑步和力量训练：

- **Running**：`RunWorkout` builder，`exerciseType`（1=warmup, 2=training, 3=cooldown），pace ms/km，distance mm
  - `push_workout()` 流程：query schedule 拿下一个 `idInPlan` → 拼 payload → API calculate → push update
- **Strength** (sportType=4)：详见 [strength-training.md](./strength-training.md)

### Auth (`auth.py`)

- 凭据存 JSON 在 `platformdirs.user_config_dir("coros-sync")/config.json`
- 密码存 MD5 hash（匹配 COROS API 预期）

### Testing 现状

- `pytest` + `pytest-httpx`（HTTP mocking）
- `conftest.py` 提供 `db` fixture（temp SQLite）
- `test_models.py` 覆盖单位转换；`test_db.py` 覆盖 DB ops
- `client.py` / `sync.py` / `workout.py` 暂无测试（外部 API）

### Key Conventions

- 日期是 `YYYYMMDD` string（匹配 COROS API 格式）
- Pace 内部用 秒/km；显示用 `pace_str()` 转 `M:SS/km`
- CLI 用 Click groups：`cli`（顶层），`analyze`（子组），`workout`（子组）
- Analysis 命令惰性 import pandas/matplotlib，保持核心 deps 轻
- `rich` 负责所有终端输出（tables / progress bars / colored text）
