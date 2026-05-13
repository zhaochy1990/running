"""Prompt fragments shared between LLM-based parse and coach-side emission."""

from __future__ import annotations


PARSE_SYSTEM_PROMPT = """你是 STRIDE 训练计划 markdown→JSON 反向解析器。
你的唯一任务是把一份已存在的周训练计划 markdown 转换为 schema-valid 的结构化 JSON。
不要做训练学评论、不要修改训练内容、不要给训练建议——仅做格式转换。
- 日期一律 ISO YYYY-MM-DD,配速单位是秒/km,距离单位是米,时长单位是秒。
- markdown 没明确给出的字段,允许设为 null 或省略,绝不要虚构数据。
- 仅输出一个 ```json``` 代码块,不要输出摘要、不要解释、不要 markdown 注释。
"""


PARSE_PROMPT = """你需要把一份已经存在的 markdown 训练计划反向解析成结构化 JSON。
仅输出一个 ```json``` 代码块,不要输出 markdown 摘要、不要解释。
如果某天的 session 信息不全或无法识别,允许把 spec 设成 null,kind 用最贴切的枚举,summary 写出可读描述。
schema 与 weekly_plan 任务一致。
"""


STRUCTURED_SCHEMA_HINT = """
# 结构化输出要求 (除 markdown 外必须追加)

最后必须再输出一个 ```json``` 代码块,内容是与本周 markdown 等价的结构化计划,
schema 要与 stride_core/plan_spec.WeeklyPlan.to_dict() 一致:

```jsonc
{
  "schema": "weekly-plan/v1",
  "week_folder": "<本周文件夹名,例如 2026-04-20_04-26(W0)>",
  "sessions": [
    {
      "schema": "plan-session/v1",
      "date": "YYYY-MM-DD",
      "session_index": 0,        // 0 = 当天第一节,如有早晚双 session 第二节为 1
      "kind": "run" | "strength" | "rest" | "cross" | "note",
      "summary": "<短描述,例如 6×800m 间歇>",
      "spec": null | <NormalizedRunWorkout JSON> | <NormalizedStrengthWorkout JSON>,
      "notes_md": null | "<可选,该 session 的 markdown 注释>",
      "total_distance_m": null | number,
      "total_duration_s": null | number,
      "scheduled_workout_id": null
    }
  ],
  "nutrition": [
    {
      "schema": "plan-nutrition/v1",
      "date": "YYYY-MM-DD",
      "kcal_target": number | null,
      "carbs_g": number | null,
      "protein_g": number | null,
      "fat_g": number | null,
      "water_ml": number | null,
      "meals": [
        {"name": "早餐", "time_hint": "7:30", "kcal": 600, "carbs_g": 80,
         "protein_g": 30, "fat_g": 15, "items_md": "燕麦 80g + 鸡蛋 2 个"}
      ],
      "notes_md": null | "<可选>"
    }
  ],
  "notes_md": null | "<本周整体注释>"
}
```

NormalizedRunWorkout 形如:
```jsonc
{
  "schema": "run-workout/v1",
  "name": "Easy 10K",
  "date": "YYYY-MM-DD",
  "note": null,
  "blocks": [
    {
      "repeat": 1,
      "steps": [
        {"step_kind": "work",
         "duration": {"kind": "distance_m", "value": 10000},
         "target": {"kind": "pace_s_km", "low": 360, "high": 330},
         "note": null}
      ]
    }
  ]
}
```

间歇用 RepeatGroup 表示,如 6×800m @ 4:00/km + 60s 慢跑:
```jsonc
{
  "schema": "run-workout/v1",
  "name": "6x800m",
  "date": "YYYY-MM-DD",
  "blocks": [
    {"repeat": 6, "steps": [
      {"step_kind": "work",
       "duration": {"kind": "distance_m", "value": 800},
       "target": {"kind": "pace_s_km", "low": 245, "high": 235}},
      {"step_kind": "recovery",
       "duration": {"kind": "time_s", "value": 60},
       "target": {"kind": "open"}}
    ]}
  ]
}
```

如果 work step 同时给了**配速目标 + HR 上限**(例如 "3K×4 @ 4:05-4:10/km, HR ≤167"),
配速进 `target`,HR 上限单独写到 `hr_cap_bpm` 字段(整数 bpm)。
**不要**把 HR 上限放在 note 文本里——下游 UI / 强度分类 / 推送翻译都看不到 note 里的数字。
```jsonc
{
  "step_kind": "work",
  "duration": {"kind": "distance_m", "value": 3000},
  "target": {"kind": "pace_s_km", "low": 250, "high": 245},
  "hr_cap_bpm": 167,
  "note": "硬下限 4:05;HR 超 167 立即退到 4:10"
}
```
仅当计划没显式 HR 上限时,才省略 `hr_cap_bpm`(不写 / 写 null 都行)。
warmup / cooldown / recovery 步骤通常不写 hr_cap_bpm,即使有 HR 区间——
那些 HR 区间是热身/放松的*目标*,放进 `target`(kind=hr_bpm)。

变速跑 (warmup → 多段不同配速 work → cooldown) 用单 block + 多 step,repeat=1:
```jsonc
{"blocks": [
  {"repeat": 1, "steps": [
    {"step_kind": "warmup", "duration": {"kind": "distance_m", "value": 1500},
     "target": {"kind": "pace_s_km", "low": 420, "high": 380}},
    {"step_kind": "work", "duration": {"kind": "distance_m", "value": 2000},
     "target": {"kind": "pace_s_km", "low": 280, "high": 260}},
    {"step_kind": "work", "duration": {"kind": "distance_m", "value": 2000},
     "target": {"kind": "pace_s_km", "low": 260, "high": 250}},
    {"step_kind": "cooldown", "duration": {"kind": "distance_m", "value": 1500},
     "target": {"kind": "pace_s_km", "low": 420, "high": 380}}
  ]}
]}
```

NormalizedStrengthWorkout 形如:
```jsonc
{
  "schema": "strength-workout/v1",
  "name": "Core 30min",
  "date": "YYYY-MM-DD",
  "exercises": [
    {"canonical_id": "plank_basic", "display_name": "平板支撑",
     "sets": 3, "target_kind": "time_s", "target_value": 45, "rest_seconds": 30}
  ]
}
```

双 session 日 (早跑 + 晚力量) 用同一 date 但 session_index=0/1 两条:
```jsonc
{"sessions": [
  {"date": "2026-04-22", "session_index": 0, "kind": "run", "summary": "Easy 10K", "spec": {...}},
  {"date": "2026-04-22", "session_index": 1, "kind": "strength", "summary": "Core 30min", "spec": {...}}
]}
```

注意:
- date 全部用 ISO YYYY-MM-DD,不能用 "周一"/"04/22" 之类
- 配速单位是 seconds-per-km,不是 min/km。例如 4:00/km = 240
- 时长单位是秒,距离单位是米
- 当 kind=rest/cross/note 时 spec 必须是 null
- 当配速尚未确定 (e.g. "Easy,配速 TBD") 时 spec 也可以是 null,session 仍按 kind=run 标记 (aspirational)
- 餐次的 kcal 总和应当与 daily kcal_target 偏离不超过 10%
"""
