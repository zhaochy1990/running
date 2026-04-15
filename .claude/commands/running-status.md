# Training Status Check

Sync the latest data from COROS, then analyze training load, recovery, and fitness trends to determine if the athlete is on track with their training plan.

## User Profile

Use the profile specified by the user argument: `$ARGUMENTS` (e.g., `zhaochaoyi`, `dehua`).
If no argument is given, default to `zhaochaoyi`.

**Important: The entire report MUST be written in Chinese (中文). All section headers, analysis text, recommendations, and verdicts should be in Chinese.**

## Step 1: Sync Latest Data

Run sync first to ensure we have the most recent data:

```bash
PYTHONIOENCODING=utf-8 python -m coros_sync -P {profile} sync
```

If sync fails (e.g., auth expired), note it and proceed with whatever data is already in the database — mention the last sync time so the user knows how stale the data is.

## Step 2: Query All Data Sources

Use `python -c` with `PYTHONIOENCODING=utf-8` to query. Always use the internal `_conn` attribute:

```python
from coros_sync.db import Database
db = Database(user='{profile}')
db._conn.execute(SQL).fetchall()
```

Run these queries **in parallel** (they are independent):

### 2a. Recent Activities (last 14 days)

```sql
SELECT date, name, sport_name, distance_m, duration_s,
       avg_pace_s_km, avg_hr, max_hr, training_load, vo2max,
       aerobic_effect, anaerobic_effect
FROM activities
WHERE date >= date('now', '-14 days')
ORDER BY date DESC
```

### 2b. Fatigue & Training Load Trend (last 21 days)

```sql
SELECT date, fatigue, ati, cti, training_load_ratio, training_load_state, rhr, hrv
FROM daily_health
ORDER BY date DESC LIMIT 21
```

### 2b2. TSB (Training Stress Balance) — PMC Data

Compute TSB = CTI - ATI for each day. TSB zones:
- **比赛就绪** (10 ~ 25): well-rested, peak performance
- **过渡区** (-10 ~ 10): recovering or maintaining
- **正常训练** (-30 ~ -10): productive training stress
- **过度负荷** (< -30): too much stress, injury risk
- **减量过多** (> 25): losing fitness from too little training

```sql
SELECT date, cti, ati, (cti - ati) AS tsb, rhr, fatigue
FROM daily_health
WHERE cti IS NOT NULL AND ati IS NOT NULL
ORDER BY date DESC LIMIT 21
```

### 2c. Dashboard Fitness Metrics

```sql
SELECT running_level, aerobic_score, lactate_threshold_score,
       anaerobic_endurance_score, anaerobic_capacity_score,
       rhr, threshold_hr, threshold_pace_s_km,
       recovery_pct, avg_sleep_hrv, hrv_normal_low, hrv_normal_high,
       weekly_distance_m, weekly_duration_s
FROM dashboard WHERE id = 1
```

### 2d. Race Predictions

```sql
SELECT race_type, duration_s, avg_pace FROM race_predictions
```

### 2e. Weekly Mileage (last 6 weeks)

Note: `distance_m` is stored in km despite the column name. Dates are UTC — use `+8 hours` for CST grouping.

```sql
SELECT
    strftime('%Y-W%W', datetime(date, '+8 hours')) AS week,
    ROUND(SUM(distance_m), 1) AS km,
    COUNT(*) AS runs,
    ROUND(AVG(avg_pace_s_km), 0) AS avg_pace,
    ROUND(AVG(avg_hr), 0) AS avg_hr
FROM activities
WHERE date >= date('now', '-42 days') AND sport_name IN ('Run', 'Track Run', 'Indoor Run')
GROUP BY strftime('%Y-W%W', datetime(date, '+8 hours'))
ORDER BY week DESC
```

### 2f. HR Zone Distribution (last 14 days)

```sql
SELECT z.zone_index,
       ROUND(SUM(z.duration_s) / 60.0, 0) AS total_min,
       ROUND(SUM(z.duration_s) * 100.0 / NULLIF(SUM(SUM(z.duration_s)) OVER (), 0), 1) AS pct
FROM zones z
JOIN activities a ON z.label_id = a.label_id
WHERE z.zone_type = 'heartRate'
  AND a.date >= date('now', '-14 days')
GROUP BY z.zone_index
ORDER BY z.zone_index
```

If the window function doesn't work, calculate totals manually:

```sql
SELECT z.zone_index,
       SUM(z.duration_s) AS total_seconds
FROM zones z
JOIN activities a ON z.label_id = a.label_id
WHERE z.zone_type = 'heartRate'
  AND a.date >= date('now', '-14 days')
GROUP BY z.zone_index
ORDER BY z.zone_index
```

Then compute percentages yourself.

### 2g. Last Sync Timestamp

```sql
SELECT key, value FROM sync_meta WHERE key IN ('last_sync', 'last_activity_date')
```

## Step 3: Read Current Training Plan Context

Read `TRAINING_PLAN.md` to understand:
- What is the long term goal and recent objectives
- Which **phase** the athlete is currently in (based on today's date)
- What the **target weekly volume** should be
- What **checkpoints** are coming up

Also check if there is a `plan.md` for the current week in the `logs/` folder — it will tell you what was specifically planned.

Also check if there is a `feedback.md` for the current or previous week — it will have subjective RPE and perceived fatigue notes.

## Data Conversions

- **Pace**: stored as seconds/km. Format as `M:SS/km` (e.g., 342 → 5:42/km)
- **Distance**: stored as meters in activities. Divide by 1000 for km.
- **Duration**: stored as seconds. Format as `H:MM:SS` or `MM:SS`
- **Training load ratio**: ATI/CTI. 0.8-1.0 optimal, >1.2 very high, <0.7 detraining
- **Fatigue**: <40 recovered, 40-50 normal, 50-60 fatigued, >60 high fatigue

## Step 4: Generate Training Status Report (全部使用中文)

Structure the report as follows:

### 训练状态报告 — {date}

#### 1. 当前阶段与计划对齐

说明当前处于哪个训练阶段、该阶段的第几周。对比实际周跑量与计划目标跑量，指出偏差。尤其是判断近期身体状态是否与训练计划、训练负荷一致，判断是否需要调整个别训练。

#### 2. 训练负荷与恢复

| 指标 | 当前值 | 7天趋势 | 状态 |
|------|--------|---------|------|

包含：
- **疲劳度**：最新值 + 7天趋势（改善/恶化/稳定）
- **ATI / CTI**：数值 + 训练负荷比
- **训练负荷状态**：来自COROS（Low/Optimal/High/Very High）
- **静息心率**：最新值 vs 基线（运动员档案中47 bpm）。RHR升高 = 疲劳信号。
- **恢复百分比**：来自dashboard
- **HRV**：睡眠HRV均值 vs 正常范围（来自dashboard）。HRV下降 = 恢复不良/过度训练信号
- **TSB竞技状态**：CTI - ATI。TSB > 10 = 比赛就绪，-10~10 = 过渡区，-30~-10 = 正常训练，< -30 = 过度负荷

使用 TRAINING_PLAN.md 中的阈值：

| 指标 | 绿灯 | 黄灯 | 红灯 |
|------|------|------|------|
| 静息心率 | < 50 | 50-55 | > 55 |
| HRV | 稳定/上升 | 下降10% | 下降20% |
| 疲劳度 | < 40 | 40-50 | > 50 |
| 负荷比 | 0.8-1.0 | 1.0-1.2 | > 1.2 或 < 0.7 |

#### 3. 体能指标

| 指标 | 当前值 | 目标值 | 状态 |
|------|--------|--------|------|

包含：
- **VO2max**：当前 vs 目标（>59 绿灯, 57-59 黄灯, <57 红灯）
- **跑力等级**：来自dashboard
- **乳酸阈配速**：当前 vs 计划目标（3:50/km）
- **比赛预测**：当前马拉松预测 vs 2:50目标

#### 4. 跑量与强度分析

- **周跑量趋势**（最近4-6周表格）
- **心率区间分布**：实际Z1-Z2占比 vs 目标80%。标记Z3"垃圾跑量"是否过多。
- **轻松跑纪律**：轻松跑是否真的轻松？检查标记为轻松跑的平均心率。

#### 5. 近期训练概览

最近7-14天训练活动表格，包含日期、类型、距离、配速、心率、训练负荷。

#### 6. 综合评估与建议

将所有数据综合为一个明确的判断：

**总体状态**：以下三者之一：
- ✅ **状态良好** — 各项指标符合计划，恢复充分
- ⚠️ **需要关注** — 存在黄灯信号，需要小幅调整
- 🔴 **需要干预** — 存在红灯信号，必须采取行动

然后给出3-5条具体、可执行的建议。例如：
- "周跑量比Phase 1目标低15% — 考虑增加一次8km轻松跑"
- "Z3时间占比25% — 减少中等强度训练，轻松跑心率控制在145以下"
- "静息心率比基线高4 bpm，持续5天 — 安排额外休息日"
- "HRV下降12% — 跳过明天的节奏跑，改为轻松跑"
- "负荷比1.3 — 本周降低强度，让CTI追上来"
- "跟腱检查：上次长距离后晨起是否有疼痛？如果>3/10，跳过下次强度课"

始终引用 TRAINING_PLAN.md 中的具体调整规则：
- 同一周出现2个以上红灯指标 → 跑量削减30%，持续1周
- HRV下降20%以上 → 跳过强度课，改为轻松跑
- 静息心率升高5+ bpm持续3天以上 → 安排休息日

#### 7. 本周重点

基于当前阶段和周次，提醒运动员：
- 本周有哪些关键训练
- 即将到来的检查点或比赛
- 应优先关注什么（跑量、强度、恢复等）
