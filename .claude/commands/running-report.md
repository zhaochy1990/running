# Running Report Generator

Generate a detailed running activity report by querying the coros-sync SQLite database.

## User Profile

Use the profile specified by the user argument: `$ARGUMENTS` (e.g., `zhaochaoyi`, `dehua`).
If no argument is given, default to `zhaochaoyi`.

## Input

The user will specify one of:
- A specific activity by name or date (e.g., "today's run", "April 2 easy run")
- A date range for multiple activities (e.g., "this week", "last 7 days")

If no input is given, default to the most recent running activity.

## How to Query the Database

Use `python -c` with `PYTHONIOENCODING=utf-8` to query. Always use the internal `_conn` attribute:

```python
from coros_sync.db import Database
db = Database(user='{profile}')
db._conn.execute(SQL).fetchall()
```

### Step 1: Find the Activity

```sql
SELECT label_id, name, sport_name, date, distance_m, duration_s,
       avg_pace_s_km, avg_hr, max_hr, avg_cadence, calories_kcal,
       training_load, vo2max, ascent_m, descent_m
FROM activities
WHERE sport_name = 'Run'
ORDER BY date DESC LIMIT 5
```

Filter by date with `WHERE date >= 'YYYY-MM-DD' AND date <= 'YYYY-MM-DD'`.

### Step 2: Query All Detail Tables

Once you have the `label_id`, query these tables **in parallel** where possible:

#### 2a. Lap Splits (per-km breakdown)

```sql
SELECT lap_index, distance_m, duration_s, avg_pace, adjusted_pace,
       avg_hr, max_hr, avg_cadence, avg_power, ascent_m, descent_m
FROM laps
WHERE label_id = ? AND lap_type = 'autoKm'
ORDER BY lap_index
```

#### 2b. Heart Rate Zones

```sql
SELECT zone_index, range_min, range_max, range_unit, duration_s, percent
FROM zones
WHERE label_id = ? AND zone_type = 'heartRate'
ORDER BY zone_index
```

#### 2c. Pace Zones

```sql
SELECT zone_index, range_min, range_max, range_unit, duration_s, percent
FROM zones
WHERE label_id = ? AND zone_type = 'pace'
ORDER BY zone_index
```

#### 2d. Timeseries Data (second-by-second)

```sql
SELECT timestamp, distance, heart_rate, speed, adjusted_pace,
       cadence, altitude, power
FROM timeseries
WHERE label_id = ?
ORDER BY timestamp
```

#### 2e. Daily Health Context (for that day)

```sql
SELECT * FROM daily_health WHERE date = ?
```

## Timeseries Data Units & Conversions

The timeseries data is stored in **raw COROS API units**. Apply these conversions:

| Field | Raw Unit | Conversion | Display |
|-------|----------|------------|---------|
| `timestamp` | Centiseconds (epoch * 100) | Divide by 100 for epoch seconds. Subtract the first timestamp to get elapsed seconds. | `MM:SS` elapsed |
| `distance` | Centimeters * 1000 | Divide by 100,000 to get **kilometers** | `X.XX km` |
| `speed` / `adjusted_pace` | Seconds per km | Already in seconds/km. Divide by 60 for `M:SS/km` | `M:SS/km` (e.g., 342 -> 5:42/km) |
| `heart_rate` | BPM | No conversion needed | `XXX bpm` |
| `cadence` | Steps per minute | No conversion needed | `XXX spm` |
| `altitude` | Meters | No conversion needed | `X m` |
| `power` | Watts | No conversion needed | `XXX W` |

### Important Notes on Timeseries
- Data points are ~1 second apart (timestamp increments by 100 = 1 centisecond * 100)
- Early data points may have `None` values as sensors warm up (HR, cadence, GPS lock)
- `speed` and `adjusted_pace` are the same concept — pace in seconds/km. `adjusted_pace` accounts for elevation.
- For a 60-min run expect ~3,600 data points. Do NOT print all points — aggregate them.

## Lap Data Units

| Field | Unit | Display |
|-------|------|---------|
| `distance_m` | Kilometers (despite column name) | `X.X km` |
| `duration_s` | Seconds | `M:SS` |
| `avg_pace` / `adjusted_pace` | Seconds per km | `M:SS/km` |
| `avg_hr` / `max_hr` | BPM | `XXX bpm` |
| `avg_cadence` | Steps per minute | `XXX spm` |
| `avg_power` | Watts | `XXX W` |
| `ascent_m` / `descent_m` | Meters | `X m` |

## Zone Data Units

- **HR zones**: `range_min` / `range_max` are in BPM. No conversion needed.
- **Pace zones**: `range_min` / `range_max` are in **milliseconds per km** (not seconds). Divide by 1000 to get seconds/km, then format as `M:SS/km`. For pace zones, `range_min` is the faster pace (lower number = faster) and `range_max` is the slower pace. Example: 268293 ms/km = 268s/km = 4:28/km.

## Report Structure

Generate the report in this order:

### 1. Summary Overview
- Activity name, date, total distance, total duration
- Average pace, average HR, max HR, calories, training load, VO2max
- Elevation gain/loss

### 2. Kilometer Splits Table
From the `laps` table (`lap_type = 'autoKm'`), build a table:

| KM | Time | Pace | Avg HR | Max HR | Cadence | Power | Elev +/- |
|----|------|------|--------|--------|---------|-------|----------|

Flag the fastest and slowest splits. Calculate negative/positive split ratio (second half avg pace vs first half avg pace).

### 3. Heart Rate Analysis
From `zones` table + timeseries:
- **Zone distribution**: time and % in each HR zone (table format)
- **HR over distance**: sample timeseries every 500m, report HR at each point to show cardiac drift
- **Cardiac drift %**: compare avg HR in first half vs second half at similar pace. Drift > 5% suggests dehydration or fatigue.

### 4. Pace Analysis
From timeseries:
- **Pace over distance**: sample every 500m or 1km, show smoothed pace trend
- **Pace consistency**: standard deviation of per-km splits. Lower = more even pacing.
- **Pace zones**: time in each pace zone from the zones table

### 5. Cadence Analysis
From timeseries:
- **Average cadence** and range
- **Cadence over distance**: sample every 1km
- Flag if cadence drops significantly in later km (fatigue indicator)
- Optimal range reference: 170-185 spm for distance running

### 6. Power Analysis
From timeseries:
- **Average power** and range
- **Power over distance**: sample every 1km
- **Power-to-pace ratio**: are you getting slower at the same power (efficiency loss)?

### 7. Elevation Profile
From timeseries:
- **Total ascent/descent** (from activity summary)
- **Altitude over distance**: sample every 500m
- Correlate pace changes with elevation changes

### 8. Training Insights
Synthesize the data into actionable observations:
- **Pacing strategy**: even, negative, or positive split? Was it appropriate for the workout type?
- **Cardiac efficiency**: HR drift assessment, HR-to-pace coupling
- **Fatigue indicators**: cadence drop, pace drift, power drop in final km
- **Recovery load**: training load value and what it means (< 50 easy, 50-100 moderate, 100-150 hard, 150+ very hard)

## Aggregation Strategy for Timeseries

Since there are thousands of data points, aggregate before displaying:

1. **Per-km averages**: Group by `CAST(distance / 100000 AS INTEGER)` (integer km)
2. **Rolling averages**: Use 30-second windows for smoother trends
3. **Key moments**: Identify max/min values and when they occurred

Example aggregation query:
```sql
SELECT
    CAST(distance / 100000 AS INTEGER) AS km,
    ROUND(AVG(heart_rate), 0) AS avg_hr,
    ROUND(AVG(speed), 1) AS avg_pace,
    ROUND(AVG(cadence), 0) AS avg_cadence,
    ROUND(AVG(power), 0) AS avg_power,
    ROUND(AVG(altitude), 1) AS avg_altitude
FROM timeseries
WHERE label_id = ? AND heart_rate IS NOT NULL
GROUP BY CAST(distance / 100000 AS INTEGER)
ORDER BY km
```

## Formatting

- Use markdown tables for structured data
- Pace always as `M:SS/km` (e.g., 5:23/km not 323s)
- Duration as `H:MM:SS` or `MM:SS`
- Bold or highlight notable values (fastest split, max HR, etc.)
- Keep the report concise but comprehensive — aim for a report the runner can review in 2-3 minutes
