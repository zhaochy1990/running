# 力量训练动作选择与推送

**何时读**：在 plan.md / plan.json 里写力量动作、或调 strength push 代码时必读。

## 核心规则（一句话）

力量动作必须填 COROS T-code（查 `src/coros_sync/exercise_catalog.md`）。adapter 按 T-code O(1) lookup，没匹配就 fallback 走 `client.add_exercise()` 创建自定义。**不做名称模糊匹配** —— 历史教训：误命中比未命中更危险。

## Authoring 责任

生成 plan.md 时，力量动作表必须含 "COROS ID" 列。Claude 从 `exercise_catalog.md`（COROS 内置 377 个）查 T-code 填入。例：

| # | 动作 | COROS ID | 组×次 | 组间 | 要点 |
|---|------|----------|-------|------|------|
| 1 | 哑铃高脚杯深蹲（5kg） | T1336 | 3×12 | 45s | 哑铃贴胸，全蹲到底 |
| 2 | 平板支撑 | T1262 | 3×60s | 30s | 臀腰平直 |

plan.json 里：每个 `StrengthExerciseSpec` 的 `provider_id` 字段填 T-code。

catalog 中真没有的动作允许留空 → adapter 自动经 `client.add_exercise()` 创建自定义（无动画但功能完整）。

## Push 行为

adapter 拿 `provider_id` 在 `client.query_exercises` 结果里按 `name` 字段做 O(1) lookup：
- **命中**：用 catalog 的 dict（带动画 + 标准化记录）
- **未命中**（provider_id 缺失或 catalog 没有）：fallback `client.add_exercise` 创建自定义

实现：`src/coros_sync/translate.py:normalized_to_coros_strength`（COROS）。Garmin adapter 尚未支持力量推送，将来实现时复用同一 ID 策略。

## Programmatic push 例子

```python
from coros_sync.client import CorosClient
from coros_sync.workout import StrengthWorkout, push_strength_workout

client = CorosClient(user='zhaochaoyi')
exercises = client.query_exercises(sport_type=4)  # 419 built-in + custom

def find_ex(keyword):
    return next(e for e in exercises if keyword in e.get('overview',''))

workout = StrengthWorkout(name='力量训练', date='20260417')
workout.add_exercise(find_ex('planks'), sets=3, target_type=2, target_value=45, rest_value=60)
workout.add_exercise(find_ex('bird_dog'), sets=3, target_type=3, target_value=10, rest_value=30)
push_strength_workout(client, workout)

# Custom exercise (no built-in match):
custom = client.add_exercise({
    'sportType': 4, 'exerciseType': 2,
    'name': '动作名', 'overview': '动作名',
    'part': ['4'], 'muscle': ['6'], 'muscleRelevance': [],
    'equipment': ['1'], 'access': 1,
    'intensityCustom': 0, 'intensityMultiplier': 0,
    'intensityType': 1, 'intensityValue': 0, 'intensityValueExtend': 0,
    'restType': 1, 'restValue': 30, 'targetType': 3, 'targetValue': 15
})
```

`targetType`：2=time（秒），3=reps。`restValue` 单位秒。

## 为什么取消名称匹配

1. 名称匹配模糊不可靠（中英混杂、equipment suffix、token overlap 都会误命中错误动作）
2. 错误命中 ≠ 没匹配 —— 看似命中但实际是远房动作，watch 端没动画且数据不对
3. ID 匹配是 O(1) 确定性 lookup，没有匹配错误的可能 —— 错就错在 authoring 层填错 T-code，容易发现和修

## COROS schedule API 结构（delete + idempotency）

`client.query_schedule(date, date)` 返回：

```
data: {
  id: <plan_id>,                        # Plan-level ID (passed to delete_scheduled_workout)
  entities: [                           # Scheduled instances
    { idInPlan, planProgramId, happenDay, exerciseBarChart, ... },
    ...
  ],
  programs: [                           # Program *definitions* — names live HERE
    { id, idInPlan, name: "[STRIDE] 力量 A ...", sportType, ... },
    ...
  ],
}
```

**Critical gotcha**：`entity.exerciseBarChart` 在 **新推但未完成的条目上是空的**。别按 `exerciseBarChart[*].name` 过滤 —— 必须 join `entities[i].idInPlan == programs[j].idInPlan` 然后看 `programs[j].name.startswith("[STRIDE]")`。adapter `delete_scheduled_workout`（`src/coros_sync/adapter.py`）就这么干；诊断脚本 `scripts/inspect_schedule.py` dump 两个 array。

**Sweep 必须按确切 program name 过滤**：单日多 `[STRIDE]` 条目时（run + strength 同日、双 run session 等），推一个不能误删其他。adapter 接 `name=<program-name> | None`；路由（`POST /api/{user}/plan/sessions/{date}/{idx}/push`）传 `workout.name` 限定 sweep。重推同 session 用同名 → 老的清掉、其他保留。`name=None` 是 legacy "删该日所有 `[STRIDE]`" 行为（迁移工具 / CLI 用）。
