---
name: analyze-activity
description: >-
  解读并分析来自 get_activities_by_date_range 工具返回的 Activity 运动数据。
  当需要回答"今天/最近跑得怎么样"、评估单次或一段时间的跑步训练（配速 / 心率 / 步频 / 功率 /
  STRIDE 训练负荷 / 疲劳 / 天气影响），或解释某个 Activity 字段含义时使用。本 skill 覆盖每个字段的语义、
  单位、取值范围与枚举映射（sport / feel），以及配速换算、
  强度判定、天气校正和多日周期负荷分析的方法。
---

# 分析高驰 (COROS) 运动数据

工具返回 `{ activities, provenance }`；`provenance` 必须是 `{ source: "stride", vendor_derived: false }`。`Activity` 是一次运动（一堂课）的记录，包含运动类型、时间、距离、配速、心率、步频、功率，以及用于内部汇总的 STRIDE 自算 session class。厂商训练类型、训练效果、训练负荷和手表 VO2max 不会进入 Coach context；训练负荷统一读取 `get_daily_training_load` 的 `stride_training_load`。

## 1. 属性列表

一次 Activity 的全部字段；`sport` 的取值列在表格下方，体感量表见第 3 节。

| 字段 | 类型 / 单位 | 含义 |
|---|---|---|
| `userId` | string | 用户在本系统中的 UUID。分析时不用展示。 |
| `labelId` | string | 这次运动的唯一 ID。 |
| `name` | string \| null | 活动名称，如 "上海市 运动场跑步"。 |
| `provider` | string | 数据来源，目前可能来自于 coros 或者 garmin。 |
| `date` | Date (UTC) | 运动**开始**时刻。UTC 时间（展示转上海）。 |
| `sport` | string | 运动类型，取值见下方。 |
| `feel` | number \| null | 厂商归一化体感，1–10 RPE 量表（量表见第 3 节）；厂商数据，null=厂商未评。 |
| `feelNote` | string \| null | 运动员经教练对话补填的体感**原话**（自由文本，可分段，如「前面4组体感6，最后两组7-8」）；null=没说过。 |
| `distanceM` | 米 (m) | 距离。 |
| `durationS` | 秒 (s) | 运动时长。 |
| `avgPaceSKm` | s/km | 全程平均配速（**越小越快**，展示换 `mm:ss/km`）。 |
| `bestKmPace` | s/km | 最快的**连续 1 公里**配速。 |
| `maxPace` | s/km | **瞬时**最快配速。 |
| `avgHr` | bpm | 平均心率。 |
| `maxHr` | bpm | 最高心率。 |
| `avgCadence` / `maxCadence` | spm（双脚合计） | 步频。 |
| `avgStepLenCm` | cm | 平均步幅。 |
| `avgPower` / `maxPower` | W | 跑步功率。 |
| `ascentM` | 米 | 累计爬升（场地 / 跑步机通常为 0）。 |
| `descentM` | 米 | 累计下降。 |
| `strideSessionClass` | string \| null | STRIDE 自算训练类别，用于聚合质量课；不是厂商训练类型。 |
| `temperature` | °C | 气温。 |
| `feelsLike` | °C | 体感温度。 |
| `humidity` | % | 相对湿度。 |
| `windSpeed` | km/h | 风速。 |
| `verticalOscillationMm` | mm | 垂直振幅（null=没采集，忽略）。 |
| `groundContactTimeMs` | ms | 触地时间（null=没采集，忽略）。 |
| `verticalRatioPct` | % | 垂直步幅比（null=没采集，忽略）。 |
| `sportNote` | string \| null | 运动员写的备注，有就引用。 |
| `pauses` | JSON \| null | 暂停区间，null=无暂停。 |
| `laps` | `ActivityLap[]` \| undefined | 每次运动的分段（仪表盘/手表自动切的每公里，或间歇课的各 set），很可能为空 `[]`。**只给分段数据，不做厂商训练负荷/类型判断**。 |

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

**`feel` 取值**（厂商归一化 1–10 RPE，越大越吃力；`null` = 厂商当次未评，**不代表"感觉一般"**，别过度解读。量表的分档锚点与对话采集规则见第 3 节。）

---

## 2. 回答形态（HARD：判断先行三段式）

复盘/分析类回答一律三段式，**固定小节模板已废除**（「基本盘→强度定性→分段→纵向对照→负荷→缺什么」的菜谱不再使用）：

1. **判断先行**：第一句话就是定性结论 + 归因。例：「名义轻松跑，实际是渐进节奏课；末段心率顶到阈值是主动加劲，不是漂移。」**不许用「基本盘」复述开头**——距离/配速/时长 App 活动页已有，复述它们是浪费运动员时间。
2. **只挑有信息的对照**：数据只在支撑判断时出现——基线 delta、天气修正、负荷位置。没有信息的字段（缺数据、无变化、与判断无关）直接不提，绝不为了「全面」拼表格。
3. **明确行动指令**：结尾必给「明天/接下来怎么办」的具体指令（例：「明天彻底休息，周五心率压 144 以下跑回 easy」）。实在没有可调整的就明说「保持安排，下次课后找我」。绝不以「继续加油」这类空话收尾。

**长度硬上限**：常规课 ≤300 字；复杂课（变速/间歇/超长距离/异常数据）≤500 字。超了就砍对照细节，保判断和行动。

**语言**：全部中文，包括工具调用前的进度句。

### 2.1 单次复盘流程（"我今天/这次跑得怎么样？"）

1. **先调 `get_activity_insights(labelId)`**——一次拿全六类确定性结论：强度定位、效率 delta、漂移归因、分割、计划偏差、负荷位置（逐字段含义与解读见 2.2）。**算术已在代码里算好，你只叙述，不要自己跨活动拼数据算数。**
2. `available=false`（`activity_not_found` / `not_a_running_activity`）或某字段降级（`n=0`、`available=false` 带原因）时，回退现有工具：`get_activities_by_date_range` → `get_activity_details` → `get_daily_training_load` / `get_running_calibration`，按三段式自行分析。
3. insight 缺失的维度直接跳过，不编数、不臆测。
4. `feelNote` 有值就织进判断（客观数据 vs 主观感受是否一致：数据显示阈值强度而体感「很轻松」，要指出可能低估了强度；`feel` 数值作厂商侧参考）；两者均空时按第 3 节的规则自然地问**一次**（仅限复盘当下这堂课，历史批量复盘不问）。

### 2.2 解读知识（叙述 insight 时用）

- **强度定位**：`hr_pct_of_threshold` ≈100% = 阈值课；轻松课通常 75–87%。配合 `session_class` 与活动名称定性。
- **效率 delta**：同配速下实际心率比近 4 周同 class 基线**低 = 有氧进步**（负 delta）；高 = 疲劳/环境/状态退步。`n<3` 时是粗基线（method=mean），叙述时留余地。
- **漂移归因**：`residual_bpm` 是扣掉配速影响后前后半程的心率抬升。<3 bpm = `pace_explained`；≥3 bpm 且 `thermal_drift` = 热漂移（正常生理反应，别解读成状态下滑）；`unexplained_drift` = 配速与天气都解释不了，值得点名（补给/脱水/强度失控）。`load_position.as_of` 不是当天时，form/load_ratio 是最近一行的值，叙述要带日期。
- **天气背景**：体感 >30°C 或湿度 ≥85% 时同心率配速偏慢属正常，分析要点明「考虑到当天 X°C / 湿度 Y%，这个配速合理」。
- **分割**：`split=negative`（后半程更快）常见于渐加速课；`positive` + `last_lap_decay_pct` 高 = 后程失速，结合漂移归因区分「主动加劲」与「掉速」。
- **计划偏差**：`intensity=easier_than_planned` 要点破（该快没快）；`harder_than_planned` 要判断是质量溢出还是该休息没休息。
- **负荷位置**：`form` 负值越深越疲劳、`load_ratio` >1.3 提示快速堆量；结合 `week_quality_count` 判断这堂课在当周的位置（本周第几堂质量课）。
- **跑姿 / 功率**（字段非 null 时）：步频一般 170–185 spm；步幅、功率作补充参考，不单独成段。
- 缺的字段（`null`）表示"没有采集到这个数据"，不要编造含义。
- `date` 是 UTC 时间，生成回答时转换为上海时间（UTC+8）。
- 跨天的**体能/疲劳/状态 (form/TSB) 趋势**需要 PMC 数据：疲劳/负荷类问题先用 `get_daily_training_load` 拿趋势，不要用厂商派生分数推断。

### 2.3 一段时间（"最近状态怎么样？"，多条 Activity）

先过滤 `sport LIKE 'run%'`，再按上海日期归组，然后按三段式组织（判断先行照旧）：

1. **训练量与一致性**：区间内总 km、次数、有无长时间断跑或忽多忽少。
2. **强度分布**：轻松跑与质量课占比。健康的分布应轻松为主，高强度适量。
3. **负荷趋势**：`get_daily_training_load` 的 `stride_training_load`（`available=false` 时说明 `missing_reason`），看是稳步、堆量还是骤降；连续多天高负荷 + `feelNote` 反复描述吃力（或厂商 `feel` 数值走低）提示疲劳堆积。
4. **纵向对比**：同类型轻松跑的"配速 @ 心率"随时间的变化 = 有氧进步信号。

---

## 3. 体感（feel / feelNote）对话采集（#508）

体感是教练分析里**唯一的主观信号**，缺失时「客观负荷 vs 主观体感交叉验证」就空转。
复盘某堂课且 `feel` 与 `feelNote` 均为 null 时，自然地问**一次**（口语化，不要用「补记数据」这种腔调），问完立即把回答用于本次分析。

### 3.1 提问与量表

首次提问直接附完整量表表格（用户不一定懂 RPE；小程序与 Web 的聊天渲染都支持 markdown 表格），并明说可以随便用一句话描述、体感可以是分段的：

> 今天这堂课体感怎么样？随便说一句就行，比如「前半轻松，后半顶到 7」。拿不准对照量表：

| RPE | 强度 | 描述 |
|---|---|---|
| 1 | Very Easy | 走路或完全休息 |
| 2 | Easy | 舒适慢跑，可轻松完整说话 |
| 3 | Easy / Conversational | 放松呼吸，可长时间舒适交谈 |
| 4 | Comfortable but Working | 呼吸加深但受控，交谈仍轻松 |
| 5 | Moderate | 呼吸稳定但更强，说话需更集中（marathon effort，可长时间持续） |
| 6 | Moderately Hard | 呼吸更重，只能说短句 |
| 7 | Hard | 深重呼吸，一次几个词（threshold effort，限定时间可持续） |
| 8 | Very Hard | 呼吸费力，说话困难（intervals / 5K effort） |
| 9 | Extremely Hard | 近极限，勉强维持 |
| 10 | Maximal | 全力，冲刺，短时间不可持续 |

### 3.2 落库与使用

运动员回答（一句话或一段描述；纯数字如「7」也按原话对待）后，**原样**调 `set_activity_feel(labelId, feelNote=原话)` 落库——不映射成数字、不改写、不总结、不纠错。
工具返回成功后在**同一轮回答里立即使用**该原话完成交叉验证（例：配速心率显示阈值强度，体感「最后两组顶到 8」——客观数据与主观一致；若体感只有「很轻松」，要指出可能配错了表或低估了强度）。

### 3.3 防念叨（硬规则）

- `feel` 或 `feelNote` 任一有值：**绝不**再问、也不评价「你没填体感」
- 同一次会话里问过一次、用户婉拒/转移话题：**不再追问**，本轮直接用客观数据作答
- 绝不主动批量提醒「你有 N 次活动没填体感」——那是噪音，不是教练
- 历史活动批量复盘（区间统计）时不问体感；只有用户明确在复盘**某一次**课且该课 feel 与 feelNote 均为空时才问
