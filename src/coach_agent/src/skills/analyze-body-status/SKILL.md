---
name: analyze-body-status
description: >-
  分析用户的身体状态和负荷分布。当用户问"最近状态怎么样 / 身体状态怎么样 / 累不累"、
  需要评估一段时间（多条 Activity）的训练量与一致性、强度分布、负荷趋势、
  纵向有氧进步信号，或解读恢复状态（HRV、静息心率）时使用。
  单次训练的复盘用 analyze-activity，比赛复盘用 analyze-race。
---

# 分析身体状态与负荷分布

## 可用工具

- 一段时间的多条活动：`get_activities_by_date_range`
- 负荷趋势：`get_daily_training_load`
- 恢复状态（HRV / 静息心率）：`get_recovery_status(days)`（缺省 14 天，上限 60）

涉及疲劳、负荷、恢复、状态、能否加量的问题，先调工具拿确定性结论再作答，不要用单次跑步的心率推断整体状态。`date` 是 UTC 时间，生成回答时转换为上海时间（UTC+8）。

## 一段时间（"最近状态怎么样？"，多条 Activity）

先过滤 `sport LIKE 'run%'`，再按上海日期归组，然后按三段式组织（判断先行）：

1. **训练量与一致性**：区间内总 km、次数、有无长时间断跑或忽多忽少。
2. **强度分布**：轻松跑与质量课占比。健康的分布应轻松为主，高强度适量。
3. **负荷趋势**：`get_daily_training_load` 的 `stride_training_load`（`available=false` 时说明 `missing_reason`），看是稳步、堆量还是骤降；连续多天高负荷 + `feelNote` 反复描述吃力（或厂商 `feel` 数值走低）提示疲劳堆积。
4. **纵向对比**：同类型轻松跑的"配速 @ 心率"随时间的变化 = 有氧进步信号。

## 恢复状态（"身体状态怎么样 / 最近 HRV 和静息心率情况"）

状态/疲劳/恢复/HRV/静息心率类问题，**先调 `get_recovery_status(days)`**（缺省 14 天，上限 60）拿确定性结论再作答，不要用单次跑步的心率推断恢复状态。工具一次返回：

| 字段 | 含义 |
|---|---|
| `daily` | `{date, rhr, hrv}[]` 日序列（上海日历日，最早在前）；只有日聚合（昨晚均值），没有夜间逐段曲线。缺的日期 = 厂商当天没同步，不编数。 |
| `hrvBaseline` | 厂商 HRV 基线区间 `{low, high, provider, date}`；null = 厂商还没算出基线（新用户常见）。 |
| `lastNight` | 最近一夜 HRV 对基线的三分类：`below` 低于区间 / `within` 区间内 / `above` 高于区间 / `no_data` 缺数或无基线。`date` 不是近 1–2 天时，叙述要带日期说明数据滞后。 |
| `rhrTrend` | 近 7 日 vs 前 7 日静息心率均值：`deltaBpm` 正 = 走高；`direction` 只在变化 ≥±2 bpm 时判 rising/falling；`recent7Days`/`prior7Days` 是实际样本数，样本少时叙述留余地。窗口锚定在最新有数的一天。 |
| `coverage` | 窗口内 HRV/RHR 覆盖天数与来源 `provider`——判断结论可信度，覆盖稀疏时明说。 |

**解读口径：**

- **昨晚 HRV vs 基线区间 = 当日恢复状态**：`below` = 交感受抑制（恢复不足、疲劳、生病、饮酒都可能）；单日 below 是正常波动，连续多日 below 才是信号。`within` = 正常。`above` 结合负荷判断（超量恢复或应激兴奋）。
- **RHR 走高 = 疲劳积累信号**：`direction=rising` 且 `deltaBpm ≥ 5` 提示疲劳在积累；`falling` = 适应良好。
- **与 PMC 交叉验证（必做，另调 `get_daily_training_load`）**：HRV below + form 负 = 真疲劳，建议减量或休息；HRV below 但负荷轻 = 考虑睡眠、压力等非训练因素，直接问运动员近几天睡眠/生活状态。
- **数据边界要明说**：`hrvBaseline=null` 时不判 below/above，只叙述数值与趋势；COROS 用户没有睡眠分期/压力/身体电量数据，不硬解释"深度睡眠不足"这类结论；`available=false`（`no_recovery_data`，新用户或厂商未同步恢复数据）时回退 PMC 负荷分析，并说明缺的是什么数据。

## 写作规则

三段式组织：判断先行、只挑有信息的对照、行动指令收尾。缺的数据（null / 缺日期 / 覆盖稀疏）明说，不编造含义。
