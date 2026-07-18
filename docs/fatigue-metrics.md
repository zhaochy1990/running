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
| `ati` | 厂家短期负荷（COROS/Garmin 的单位和时间窗不同，仅用于同厂商趋势对照） |
| `cti` | 厂家长期负荷（COROS/Garmin 的单位和时间窗不同，仅用于同厂商趋势对照） |
| `training_load_ratio` | 厂家短期/长期负荷比；不可假定等于 STRIDE ATL/CTL。Garmin 同步在 ATI/CTI 完整时存精确 `ATI/CTI`，避免其一位小数 ACWR 字段的量化误差 |
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

## STRIDE 负荷定义

- `training_dose`：TSS-scaled，个人阈值强度 1 小时 = 100。
- `acute_load` / `chronic_load`：分别为 7 / 42 天时间常数的 EWMA。
- `form = chronic_load - acute_load`；分类必须使用 `form / chronic_load`，不能使用固定 TSB 分值。
- `load_ratio = acute_load / chronic_load`。厂家 ratio 只做趋势对照，不能作为同公式的真值。
- STRIDE canonical ratio 固定为 7/42 天时间常数 EWMA，不按厂商切换；跨厂家离线验证可补充 7/28 eACWR 参考线，但不能据此改写 PMC。
- 实际活动逐时间段积分，包含心率、速度和高强度工作后恢复残余三个可审计通道；计划活动按结构化训练段输出 expected/low/high 区间，两者使用同一 TSS 标尺。
- 厂家负荷、training effect 与厂家 ratio 只做离线验证，不作为 STRIDE 计算输入。
- `coverage_status=unknown` 的日期不按零负荷休息日衰减；只有完整活动历史或厂家健康日存在时才能确认休息。

## 比赛就绪 / 训练 / 恢复阈值

写 weekly plan 时把疲劳趋势表带进 context。关键阈值：

- **减量过多**：`acute/chronic < 0.75`
- **比赛就绪**：`0.75 <= acute/chronic < 0.90`
- **维持期**：`0.90 <= acute/chronic <= 1.10`
- **提升期**：`1.10 < acute/chronic <= 1.25`
- **过度负荷**：`acute/chronic > 1.25`

## HRV

HRV 当前只有 COROS dashboard 的 snapshot（`avg_sleep_hrv`, `hrv_normal_low`, `hrv_normal_high`）。每日 HRV 趋势需要 COROS sleep detail API（未实现 —— tracked as future feature）。

## Legacy 综合判断（禁止用于 Coach）

分析 status 时合并所有信号：RHR + HRV + fatigue + TSB + training_load_ratio。单一指标会误导；多信号收敛更可靠。
