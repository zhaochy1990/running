---
name: analyze-activity
description: >-
  解读并分析来自 get_activities_by_date_range 工具返回的 Activity 运动数据。
  当需要回答"今天/最近跑得怎么样"、评估单次或一段时间的跑步训练（配速 / 心率 / 步频 / 功率 /
  训练负荷 / 疲劳 / 天气影响），或解释某个 Activity 字段含义时使用。本 skill 覆盖每个字段的语义、
  单位、取值范围与枚举映射（sport / feel / train_kind），以及配速换算、
  强度判定、天气校正和多日周期负荷分析的方法。
---

# 分析高驰 (COROS) 运动数据

`Activity` 是一次运动（一堂课）的记录，包含运动类型、时间、距离、配速、心率、步频、功率、训练负荷等字段。

## 1. 属性列表

一次 Activity 的全部字段；`sport` / `feel` / `trainKind` 的取值列在表格下方。

| 字段 | 类型 / 单位 | 含义 |
|---|---|---|
| `userId` | string | 用户在本系统中的 UUID。分析时不用展示。 |
| `labelId` | string | 这次运动的唯一 ID。 |
| `name` | string \| null | 活动名称，如 "上海市 运动场跑步"。 |
| `provider` | string | 数据来源，目前可能来自于 coros 或者 garmin。 |
| `date` | Date (UTC) | 运动**开始**时刻。UTC 时间（展示转上海）。 |
| `sport` | string | 运动类型，取值见下方。 |
| `feel` | string \| null | 主观感受（体感），取值见下方。 |
| `trainKind` | string \| null | 课型（训练强度分类），取值见下方。 |
| `distanceM` | 米 (m) | 距离。 |
| `durationS` | 秒 (s) | 运动时长。 |
| `avgPaceSKm` | s/km | 全程平均配速（**越小越快**，展示换 `mm:ss/km`）。 |
| `adjustedPace` | s/km | 坡度校正配速 (GAP)；平地（爬升 0）时 ≈ 平均配速。 |
| `bestKmPace` | s/km | 最快的**连续 1 公里**配速。 |
| `maxPace` | s/km | **瞬时**最快配速。 |
| `avgHr` | bpm | 平均心率。 |
| `maxHr` | bpm | 最高心率。 |
| `avgCadence` / `maxCadence` | spm（双脚合计） | 步频。 |
| `avgStepLenCm` | cm | 平均步幅。 |
| `avgPower` / `maxPower` | W | 跑步功率。 |
| `ascentM` | 米 | 累计爬升（场地 / 跑步机通常为 0）。 |
| `descentM` | 米 | 累计下降。 |
| `aerobicEffect` | 0.0–5.9 | 有氧训练效果（分级见表下）。 |
| `anaerobicEffect` | 0.0–5.9 | 无氧训练效果（分级见表下）。 |
| `caloriesKcal` | 千卡 | 消耗热量。 |
| `trainingLoad` | 数值 (COROS, EPOC) | **单次课**的训练负荷。短/轻松课低（十几），长/高强度课高（200+）。 |
| `vo2max` | ml/kg/min | 当次估算的最大摄氧量（体能水平指标，变化很慢）。 |
| `temperature` | °C | 气温。 |
| `feelsLike` | °C | 体感温度。 |
| `humidity` | % | 相对湿度。 |
| `windSpeed` | km/h | 风速。 |
| `verticalOscillationMm` | mm | 垂直振幅（null=没采集，忽略）。 |
| `groundContactTimeMs` | ms | 触地时间（null=没采集，忽略）。 |
| `verticalRatioPct` | % | 垂直步幅比（null=没采集，忽略）。 |
| `sportNote` | string \| null | 运动员写的备注，有就引用。 |
| `pauses` | JSON \| null | 暂停区间，null=无暂停。 |

**训练效果分级**（`aerobicEffect` / `anaerobicEffect`；长时间中低强度→有氧，短时间高强度间歇→无氧）：

- 0–0.9：无效果，对运动能力作用微乎其微
- 1.0–1.9：恢复，运动能力没提高，但促进恢复
- 2.0–2.9：维持，维持运动能力，改善作用较小
- 3.0–3.9：提高，每周重复 2–4 次可提高运动能力
- 4.0–4.9：大幅提高，每周 1–2 次可快速提高，但身体负荷较大
- 5.0–5.9：过度训练，需结合充足恢复，否则造成过度训练、负荷极大

**`sport` 取值**（跑步 5 种 + 其它 5 种；跑步分析只看 `sport LIKE 'run%'`）

1. run_outdoor — 户外跑
2. run_indoor — 室内跑
3. run_trail — 越野跑
4. run_track — 场地跑
5. run_treadmill — 跑步机
6. bike_outdoor — 户外骑行
7. swim_pool — 泳池游泳
8. triathlon — 铁三
9. strength — 力量
10. unknown — 未识别

**`feel` 取值**（`feel=null` = 运动员当次没填感受，**不代表"感觉一般"**，别过度解读）

1. excellent — 很好
2. good — 好
3. normal — 一般
4. bad — 差
5. awful — 很差
6. null — 未记录（没填）

**`trainKind` 取值**

1. aerobic — 有氧
2. base — 基础
3. threshold — 阈值
4. interval — 间歇
5. vo2max — 最大摄氧
6. anaerobic — 无氧
7. null — 未分类

---

## 2. 怎么分析

注意：
1. 高温高湿（体感 >30°C）下**同样心率会配速偏慢**，这是正常生理反应，分析时要把天气当背景，不要把"热天变慢"解读成状态下滑。
2. 缺的字段（`null`）表示"没有采集到这个数据"，不要编造含义。
3. date 是UTC时间，在生成回答的时候需要转换为上海时间（UTC+8）。

### A. 单次运动（"我今天/这次跑得怎么样？"）

1. **基本面**：`sport`、上海时间、`distanceM/1000` km、`durationS` 时长、`avgPaceSKm` 换 `mm:ss`。
2. **强度定性**：综合 `trainKind` + `avgHr/maxHr` + `anaerobicEffect`
   判断是轻松有氧、阈值、还是间歇/高强度。三者应当自洽（如 base + 低心率 +
   无氧 0 = 一堂轻松课）。若矛盾（如 base 却心率很高），以心率 + 无氧效果为准，
   并说明这是单条噪声。
3. **配速 vs 心率（跑步效率）**：同样心率下配速越快越好；同样配速下心率越低越好。
   跨多次轻松跑比较这个比值能看有氧进步。
4. **天气校正**：`feelsLike` 高（>30°C）或 `humidity` 高时，同心率配速偏慢属正常，
   分析要点明"考虑到当天 X°C / 湿度 Y%，这个配速合理"。
5. **跑姿 / 功率**（若非 null）：步频（一般 170–185 spm）、步幅、功率给补充参考。
6. **感受**：`feel` 有值就结合（客观数据 vs 主观感受是否一致）。

### B. 一段时间（"最近状态怎么样？"，多条 Activity）

先过滤 `sport LIKE 'run%'`，再按上海日期归组，然后：

1. **训练量**：区间内总 km、总时长、跑步次数、平均单次距离。
2. **强度分布**：按 `trainKind` 统计各类课占比。健康的分布应"轻松为主"
   （aerobic/base 占多数），高强度（interval/vo2max/threshold）适量。全是高强度或全是垃圾
   量都要点出来。
3. **负荷趋势**：按天汇总 `trainingLoad`，看是稳步、堆量还是骤降；连续多天高负荷 +
   感受转差（`feel` 往 bad/awful 走）提示疲劳堆积。
4. **一致性**：有没有长时间断跑、忽多忽少。
5. **纵向对比**：同类型课（如都取 `trainKind='base'`）的"配速 @ 心率"随时间的变化 = 有氧进步信号。

> 跨天的**体能/疲劳/状态 (form/TSB)** 需要 PMC 数据，`Activity` 里没有；如需要，明确告诉运动员
> 这部分要另外的负荷/疲劳数据源，别用 `trainingLoad` 硬凑 form。
