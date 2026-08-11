# 周反馈与 RPE / feel_type

**何时读**：读取或写入周反馈，或在 plan / commentary 里引用 RPE 时必读。

## 周反馈是什么

周反馈是运动员针对一个上海自然周记录的整周反馈，canonical source 是 MySQL `weekly_feedback`。每名运动员每周至多一条；空白正文表示没有反馈，但记录仍可保留编辑时间。legacy `feedback.md` 仅作为一次性迁移来源，运行时不再读取、追加或同步。

活动 `sport_note` 和 `feel_type` 属于单次活动，随活动展示，不自动拼接到周反馈。

## 查询本周带 `sport_note` 的活动

```python
from stride_core.db import Database
db = Database(user='zhaochaoyi')
rows = db._conn.execute('''
    SELECT date, name, sport_name, feel_type, sport_note
    FROM activities
    WHERE sport_note IS NOT NULL AND date >= ?
    ORDER BY date
''', (week_start_iso,)).fetchall()
```

## `feel_type` 含义

COROS App 训练后表情评分：1=很好，2=好，3=一般，4=差，5=很差。若无法确认准确映射，以 `sport_note` 文字内容为准。

## 周反馈内容

周反馈不需要模板，可包含：

1. **主观反馈**——整周 RPE、感知疲劳、疼痛、恢复与计划执行感受
2. **客观数据**（10km 测试成绩、周跑量、总时长、平均心率等）—— 从 DB 活动记录和健康数据查询

用户通过周反馈 API 整体保存正文；不要用 `____` 占位符。活动反馈保持在活动记录中。

## RPE (Rate of Perceived Exertion)

1-10 分尺度衡量努力程度：

| RPE | 强度 | 描述 |
|-----|------|------|
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
