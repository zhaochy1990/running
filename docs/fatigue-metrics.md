# Fatigue / Training Load / TSB / HRV

**何时读**：分析 status / 疲劳 / 训练负荷，或写 weekly plan 前评估身体状态时必读。

## Coach 数据来源边界（HARD）

Coach 只允许使用：

- STRIDE 自算：`daily_training_load.training_dose / acute_load / chronic_load / form / load_ratio`
- 手表原始测量：RHR、HRV、心率、配速、睡眠时长

Coach 禁止读取、引用或回退到手表厂商计算的派生结论：

- `daily_health.fatigue / ati / cti / training_load_ratio / training_load_state`
- dashboard `recovery_pct / running_level / aerobic_score`
- 厂商 HRV status / baseline band、训练效果、跑力、比赛预测
- 当前 `daily_training_load.readiness_gate/reasons` 和 `ability_snapshot` 的 L2、L3
  recovery、L4（仍依赖 legacy 厂商恢复信号；迁移前 Coach 不使用）

用户问“疲劳/状态”时，用 STRIDE `form / load_ratio` 加原始 RHR/HRV 趋势回答；
STRIDE 数据缺失时明确说缺失。以下厂商字段说明仅用于 legacy 数据排障和非 Coach
旧页面维护，不得作为 Coach prompt/context 输入。

## `daily_health` 关键字段

| Field | 说明 |
|-------|------|
| `fatigue` | 疲劳分（COROS `tiredRate`）。<40 恢复，40-50 正常，50-60 疲劳，>60 高疲劳 |
| `ati` | Acute Training Index —— 7 日加权训练负荷（短期 stress） |
| `cti` | Chronic Training Index —— 28 日加权训练负荷（fitness baseline） |
| `training_load_ratio` | ATI/CTI。0.8-1.0 optimal，>1.2 Very High，<0.7 detraining |
| `training_load_state` | COROS label：Low / Optimal / High / Very High |
| `rhr` | 静息心率 |

## 查询 legacy 厂商疲劳趋势（仅排障，禁止用于 Coach）

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

## Legacy 综合判断（禁止用于 Coach）

分析 status 时合并所有信号：RHR + HRV + fatigue + TSB + training_load_ratio。单一指标会误导；多信号收敛更可靠。
