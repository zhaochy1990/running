# feedback.md 自动同步 + RPE / feel_type 含义

**何时读**：sync 后想把 `sport_note` 追加进 feedback.md，或在 plan / commentary 里引用 RPE 时必读。

## feedback.md 是什么

每周训练的反馈文件，通常含主观感受。每次 sync 后，把本周带 `sport_note` 的活动反馈追加到对应周目录的 `feedback.md` 中。格式直接追加原始文本，与用户在 COROS App 写的保持一致。

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

## Feedback 自动生成，不要用模板

feedback.md 不需要提前创建模板。内容全部从数据自动获取：

1. **主观反馈**（`sport_note` + `feel_type`）—— 从 COROS App 训练反馈同步
2. **客观数据**（10km 测试成绩、周跑量、总时长、平均心率等）—— 从 DB 活动记录和健康数据查询

每次更新 feedback.md 时追加内容，不覆盖已有内容。不要用 `____` 占位符。

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
