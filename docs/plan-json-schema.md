# plan.json canonical schema (HARD)

**何时读**：写或改 `data/{user}/logs/{week}/plan.json` 之前必读。这是 HARD gate —— 不合规就 commit 不动。

每次写完 plan.md 必须**同时**写一个 schema-valid 的 `plan.json` 放在同目录。这个文件是 authoring/import artifact；Server 端的 `/internal/plan/reparse` webhook（`sync-data.yml` 触发）会优先尝试 plan.json-authored 路径：plan.json 能过 `WeeklyPlan.from_dict` 校验 → 写入 canonical `WeeklyPlanStore`（prod Azure Table `strideweeklyplan`）并更新 SQLite 手表投影层；否则 fallback 到 LLM 反向解析 plan.md。**plan.json 不合规 → server 静默退回 LLM → 复杂 plan.md 可能解析失败 → 用户日历空白 + "重新解析" 按钮无效。**

## Source of truth

`src/stride_core/plan_spec.py` 和 `src/stride_core/workout_spec.py`。任何字段命名分歧以这两个文件为准；这份 doc 落后于代码时 **信代码**。

## Top-level shape (`WeeklyPlan`)

```json
{
  "schema": "weekly-plan/v1",
  "week_folder": "2026-05-11_05-17(P1W3)",
  "sessions": [PlannedSession, ...],
  "nutrition": [PlannedNutrition, ...],
  "notes_md": "可选 — 本周顶层备注"
}
```

不允许的多余顶层字段（authoring 历史漂移过的）：`user`, `user_id`, `phase`, `theme`, `weekly_mileage_km`, `weekly_mileage_cap_km`, `monitoring`, `structured_status`, `generated_by`。这些信息应该在 plan.md 里，不要塞进 plan.json。

## `PlannedSession`

必需字段 `date` (ISO YYYY-MM-DD)、`session_index` (int ≥0；同一天多 session 时区分)、`kind`、`summary`、可选 `spec` / `notes_md` / `total_distance_m` / `total_duration_s`。

| 枚举 | 合法值 |
|------|--------|
| `SessionKind` | `run`, `strength`, `rest`, `cross`, `note`（**没有** `interval`/`easy_run`/`long_run`/`tempo` —— 这些全部映射为 `run`） |
| `DurationKind` (Run step) | `distance_m`, `time_s`, `open`（**没有** `duration_s`） |
| `TargetKind` (Run step) | `pace_s_km`, `hr_bpm`, `power_w`, `open` |
| `StrengthTargetKind` | `reps`, `time_s` |
| `StepKind` | `warmup`, `work`, `recovery`, `cooldown`, `rest` |

**RUN session 的 `spec`** 是 `NormalizedRunWorkout`：`{name, date, blocks:[{repeat, steps:[WorkoutStep]}], note?}`。每个 `WorkoutStep` = `{step_kind, duration:{kind,value}, target:{kind,low,high}, note?, hr_cap_bpm?}`。pace 单位是 **秒/km**（4:00/km = 240）。距离是 **米**。

**STRENGTH session 的 `spec`** 是 `NormalizedStrengthWorkout`：`{name, date, exercises:[StrengthExerciseSpec], note?}`。每个 exercise = `{canonical_id, display_name, sets, target_kind, target_value, rest_seconds, note?, provider_id?}`。`canonical_id` 当前等于 COROS T-code（如 `T1262`），`provider_id` 同值。**不允许的字段名**：`name`（用 `display_name`）、`reps`/`duration_s`/`rest_s`（合并到 `target_kind`+`target_value`+`rest_seconds`）、`notes`（用 `note`）。

**REST / CROSS / NOTE session**：`spec` **必须** 为 `null`。

## `PlannedNutrition`

必需 `date` (ISO YYYY-MM-DD)。可选 `kcal_target`/`carbs_g`/`protein_g`/`fat_g`/`water_ml`/`meals[]`/`notes_md`。**不允许的字段名**：`day_type`、`applies_to_dates`（用 `date` 单值）、`calories_kcal`（用 `kcal_target`）、`carbs_g_per_kg`/`protein_g_per_kg`/`fat_g_per_kg`（已知体重时换算为绝对克数；不知道就放 `notes_md` 里）。

## 写入前必须本地校验（硬性 gate）

避免再次出现 W2/P1W3 这种"plan.json 假装符合 schema 但 server 嚼不动"的事故：

```bash
PYTHONIOENCODING=utf-8 python -c "
import json, sys
sys.path.insert(0, 'src')
from stride_core.plan_spec import WeeklyPlan
path = 'data/<user_uuid>/logs/<week>/plan.json'
with open(path, encoding='utf-8') as f:
    wp = WeeklyPlan.from_dict(json.load(f))
print(f'OK: {len(wp.sessions)} sessions, {len(wp.nutrition)} nutrition')
"
```

抛任何异常 = 不要 commit。`from_dict` 递归校验所有嵌套 dataclass，过了就保证 server `_try_authored_reparse` 也能 OK。
