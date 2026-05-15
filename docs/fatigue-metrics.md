# Fatigue / Training Load / TSB / HRV

**何时读**：分析 status / 疲劳 / 训练负荷，或写 weekly plan 前评估身体状态时必读。

## `daily_health` 关键字段

| Field | 说明 |
|-------|------|
| `fatigue` | 疲劳分（COROS `tiredRate`）。<40 恢复，40-50 正常，50-60 疲劳，>60 高疲劳 |
| `ati` | Acute Training Index —— 7 日加权训练负荷（短期 stress） |
| `cti` | Chronic Training Index —— 28 日加权训练负荷（fitness baseline） |
| `training_load_ratio` | ATI/CTI。0.8-1.0 optimal，>1.2 Very High，<0.7 detraining |
| `training_load_state` | COROS label：Low / Optimal / High / Very High |
| `rhr` | 静息心率 |

## 查询近 14 天疲劳趋势

```bash
# 先 sync 拿最新 health
PYTHONIOENCODING=utf-8 python -m coros_sync -P zhaochaoyi sync

# 查询
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

## 比赛就绪 / 训练 / 恢复 阈值

写 weekly plan 时把疲劳趋势表带进 context。关键阈值：

- **Race-ready**: fatigue <35, load ratio 0.7-0.9, RHR at baseline, TSB 10-25
- **Normal training**: fatigue 40-50, load ratio 0.8-1.1, TSB -30 to -10
- **Needs recovery**: fatigue >50, load ratio >1.2, RHR elevated, TSB < -30

## TSB (Training Stress Balance) — PMC

TSB = CTI − ATI。表示 readiness to perform：

| TSB Zone | Range | 含义 |
|----------|-------|------|
| 比赛就绪 | 10 ~ 25 | Well-rested, peak performance |
| 过渡区 | -10 ~ 10 | Recovering or maintaining |
| 正常训练 | -30 ~ -10 | Productive training stress |
| 过度负荷 | < -30 | Too much stress, injury/overtraining risk |
| 减量过多 | > 25 | Losing fitness, too much rest |

## HRV

HRV 当前只有 COROS dashboard 的 snapshot（`avg_sleep_hrv`, `hrv_normal_low`, `hrv_normal_high`）。每日 HRV 趋势需要 COROS sleep detail API（未实现 —— tracked as future feature）。

## 综合判断

分析 status 时合并所有信号：RHR + HRV + fatigue + TSB + training_load_ratio。单一指标会误导；多信号收敛更可靠。
