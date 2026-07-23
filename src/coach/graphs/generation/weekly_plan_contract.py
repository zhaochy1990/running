"""Shared WeeklyPlan JSON field-shape contract (PA-T2 extraction).

Both the single-week composer (``weekly_prompt.py``) and the phase-at-once
composer (``phase_prompt.py``) instruct the LLM to emit the **same**
``WeeklyPlan`` field shape — the per-week composer emits one object, the phase
composer emits a list of N of them inside a ``{"weeks":[…]}`` envelope. To avoid
two drifting copies of the field instructions, the field-shape body lives here
once; each composer wraps it in its own sentinel + envelope text.

Pure string/schema — no DB, no LLM, no network. ``coach.*`` core boundary: no
imports beyond the standard library. The field names below mirror
``stride_core.plan_spec`` (WeeklyPlan / PlannedSession / PlannedNutrition /
Meal); the sync is enforced by a drift-guard test in ``tests/coach`` (which is
allowed to import plan_spec) rather than an import here.
"""

from __future__ import annotations

from .rule_filter import MAX_WEEKLY_RAMP_RATIO


# OPT-A: the deterministic ``run_rule_filter`` HARD rules, stated up-front in the
# generation prompt so the generator emits rule-clean output on the FIRST try
# instead of learning each threshold via an expensive rule_filter→feedback→regen
# loop. These mirror the 5 enforced HARD rules in
# ``coach.graphs.generation.rule_filter`` (weekly_progression / long_run_share /
# intensity_distribution / rest_days / injury_conflict). The week-over-week ramp
# cap is sourced from ``MAX_WEEKLY_RAMP_RATIO`` so the prompt can't drift from the
# gate it must satisfy — a drift-guard test asserts the two stay equal.
WEEKLY_HARD_RULES = f"""\
【每周安全硬约束——违反的周会被 rule_filter 自动拒绝、触发整阶段重做，务必一次满足】
1. 周量渐进（weekly_progression）：普通负荷周跑步总里程 ≤ 上一个**负荷周**的 {MAX_WEEKLY_RAMP_RATIO:.2f} 倍\
（即负荷周之间涨幅 ≤ {(MAX_WEEKLY_RAMP_RATIO - 1) * 100:.0f}%）。减量/恢复周往下走永远合规；\
减量周后的回升与减量前的最近负荷周比较，不与减量谷底比较。满足方式：按逐周表 target km 渐进，\
恢复周降 20-30%，恢复后回到不超过上一负荷周 10% 的训练量。
2. 长跑占比（long_run_share）：当周最长一次跑 ≤ 当周跑步总里程的 35%（当周有 ≥2 次跑步时强制）。\
满足方式：长跑里程不超过周量的 1/3，其余里程拆到 easy/质量日。
3. 强度分布（intensity_distribution，80/20 极化）：高强度（Z4-Z5：VO2max/间歇，配速快于阈值）的\
总时间 ≤ 周跑步总时间的 20%。满足方式：每周至多 1-2 次质量课，其余全部 easy/long/MP，\
质量课的快段时长加总控制在 20% 以内。
4. 休息日（rest_days）：每周至少 1 个完整休息日（该天无任何 run/strength/cross 课）。\
满足方式：7 天里留出 ≥1 天彻底不排训练。
5. 伤病禁忌（injury_conflict）：不得安排与已记录伤病冲突的力量动作\
（膝 ↔ 深蹲/弓步/squat/lunge；腰背 ↔ 硬拉/deadlift；踝 ↔ 跳跃/plyo）。\
满足方式：若上下文列出伤病，避开对应动作，换非冲突的替代动作。
6. 跨阶段衔接安全（phase_transition，SEASON 级 run_season_rule_filter 校验）：\
每周实际跑量必须**贴近、绝不超过**逐周表对应行的 `目标周量`；**第 1 周尤其不得超过**\
逐周表第 1 行的 target——该值已按上一阶段工作量×{MAX_WEEKLY_RAMP_RATIO:.2f} 算好，\
超过会触发跨阶段 boundary 拒绝、整阶段重做。\
满足方式：各周里程命中各自 target、不要上探超过；第 1 周宁可略低也不要踩着 target 上限往上凑。
7. 目标周量命中（weekly_target_volume）：每周跑步总里程必须在逐周表 `目标周量` 的 ±1km 内，\
不能自行多加或少排。满足方式：把 run session 的 `total_distance_m` 加总后对齐 target；\
若分配后差距 >1km，调整 easy/shakeout 里程，而不是改变核心课强度。
"""


# The run/strength `spec` schema — emitted ONLY in structured mode. The
# generation LLM must produce a watch-pushable NormalizedRunWorkout /
# NormalizedStrengthWorkout per run/strength session, using the injected
# pace_targets (never invented). Field names mirror ``stride_core.workout_spec``;
# a drift-guard test parses the examples below through the real model. (We do NOT
# import ``plan_parser.prompts`` — that would drag ``stride_storage.sqlite`` into
# the coach-core import graph, forbidden by the coach-no-storage-impl contract.
# The one source of truth is the ``workout_spec`` model, validated by the test.)
RUN_STRENGTH_SPEC_SCHEMA = """\
【结构化 spec schema —— run / strength session 的 `spec` 字段按此输出，可直接推手表】
配速单位一律秒/km（4:00/km = 240），距离单位米，时长单位秒。配速 / 心率一律用**下方注入的
pace_targets**，绝不自行编造。

NormalizedRunWorkout（run session 的 spec）：
{
  "schema": "run-workout/v1",
  "name": "<课名，如 'Easy 10K' / '巡航 5×1600'>",
  "date": "YYYY-MM-DD",            // 与所在 session 同日
  "note": null,
  "blocks": [ <WorkoutBlock>, ... ]
}
WorkoutBlock = {"repeat": <int≥1>, "steps": [ <WorkoutStep>, ... ]}
  // repeat==1 = 线性段（warmup / 连续 tempo / cooldown）；repeat>1 = 间歇组（work+recovery 重复 N 次）
WorkoutStep = {
  "step_kind": "warmup|work|recovery|cooldown|rest",
  "duration": {"kind": "distance_m|time_s|open", "value": <number；open 时省略/为 null>},
  "target":   {"kind": "pace_s_km|hr_bpm|power_w|open", "low": <number>, "high": <number>},  // open 只写 kind
  "hr_cap_bpm": <int，可选：仅当计划给了 HR 上限时写整数 bpm，不要塞进 note>,
  "note": null
}

例·轻松跑 Easy 10K（单 block 单 step）：
{"schema":"run-workout/v1","name":"Easy 10K","date":"2026-06-15","blocks":[
  {"repeat":1,"steps":[{"step_kind":"work","duration":{"kind":"distance_m","value":10000},
   "target":{"kind":"pace_s_km","low":360,"high":330}}]}]}

例·间歇 6×800m @间歇配速 + 60s 慢跑（warmup / repeat 组 / cooldown 各一 block）：
{"schema":"run-workout/v1","name":"6x800m","date":"2026-06-18","blocks":[
  {"repeat":1,"steps":[{"step_kind":"warmup","duration":{"kind":"distance_m","value":2000},
   "target":{"kind":"pace_s_km","low":420,"high":380}}]},
  {"repeat":6,"steps":[
    {"step_kind":"work","duration":{"kind":"distance_m","value":800},"target":{"kind":"pace_s_km","low":245,"high":235}},
    {"step_kind":"recovery","duration":{"kind":"time_s","value":60},"target":{"kind":"open"}}]},
  {"repeat":1,"steps":[{"step_kind":"cooldown","duration":{"kind":"distance_m","value":2000},
   "target":{"kind":"pace_s_km","low":420,"high":380}}]}]}

MP 长跑 / 变速跑：单 block（repeat=1）多 step，warmup→Z2→MP 段依次排列。

NormalizedStrengthWorkout（strength session 的 spec）：
{
  "schema": "strength-workout/v1",
  "name": "<课名>",
  "date": "YYYY-MM-DD",
  "exercises": [
    {"canonical_id":"<动作 id，如 goblet_squat>","display_name":"<中文名>",
     "sets":<int≥1>,"target_kind":"reps|time_s","target_value":<int≥1>,
     "rest_seconds":<int≥0>,"note":null,"provider_id":"<COROS T-code，可选，如 T1301>"}
  ]
}

spec 硬要求：
- run 的 `spec.blocks` 里所有 step 的 distance_m 加总应 ≈ 该 session 的 `total_distance_m`（含 warmup/cooldown）。
- 配速的 [low, high] 必须取自注入的 pace_targets 对应区间（easy / threshold / interval / marathon 等），不得自编。
- `rest` / `cross` / `note` 的 `spec` 必须为 `null`。
"""


def _spec_field_line(structured: bool) -> str:
    if structured:
        return (
            '  "spec": <NormalizedRunWorkout | NormalizedStrengthWorkout>,   '
            "// run/strength 必须给结构化 spec（schema 见下方）；rest/cross/note 为 null"
        )
    return (
        '  "spec": null,                     '
        "// 【硬约束】本阶段课程为 aspirational，spec 必须为 null（不推手表结构化课）"
    )


def _spec_hard_rules(structured: bool) -> str:
    if structured:
        return (
            "- **每个 run / strength session 必须给出可直接推手表的结构化 `spec`**"
            "（run → NormalizedRunWorkout，strength → NormalizedStrengthWorkout，schema 见文末），\n"
            "  配速 / 心率 / 组数一律用**下方注入的 pace_targets**，绝不自行编造；\n"
            "  `rest` / `cross` / `note` 的 `spec` 必须为 `null`。里程在每周 volume_targets 预算内分配。"
        )
    return (
        "- 所有 session 的 `spec` 必须为 `null`（aspirational 计划，不生成可推手表的结构化课）。\n"
        "- 跑步日的配速/心率/组数写进 `summary` / `notes_md` 文字，**用下方注入的 pace_targets**，\n"
        "  绝不自行编配速；里程在每周 volume_targets 预算内分配。"
    )


def weekly_plan_fields_contract(*, structured: bool = False) -> str:
    """The WeeklyPlan field-shape body both composers embed.

    ``structured=False`` (default) → aspirational plan: every ``spec`` is ``null``
    (used by S1 season-skeleton generation). ``structured=True`` → each run/
    strength session must carry a watch-pushable ``NormalizedRunWorkout`` /
    ``NormalizedStrengthWorkout`` ``spec`` (used by the coach single-week
    executable generation), and the run/strength spec schema is appended.

    Field names mirror ``stride_core.plan_spec`` / ``workout_spec``; the sync is
    enforced by drift-guard tests in ``tests/coach`` (which may import the model).
    """
    spec_schema_block = ("\n\n" + RUN_STRENGTH_SPEC_SCHEMA) if structured else ""
    return f"""\
单个 WeeklyPlan 对象（将被 `WeeklyPlan.from_dict` 直接解析）结构如下：

{{
  "schema": "weekly-plan/v1",
  "week_folder": "<本周文件夹名，原样回填，见下方周框架>",
  "sessions": [ <PlannedSession>, ... ],
  "nutrition": [ <PlannedNutrition>, ... ],
  "notes_md": "<本周整体说明 markdown，可选>"
}}

PlannedSession（**默认每个训练日只排 1 节**，同一天最多 1 条 session；仅当下方注入的
用户请求明确要求"某天两练/早晚双跑/加一节"时，才为那一天额外排第 2 条 session，
用 session_index 0/1 区分。不要在用户没要求时自作主张排双练）：
{{
  "schema": "plan-session/v1",
  "date": "YYYY-MM-DD",            // ISO 日期，必填
  "session_index": 0,               // 当天第一节为 0；同日第二节才用 1（仅用户要求双练时）
  "kind": "run|strength|rest|cross|note",
  "summary": "<简短用户可见标签，如 '专项长跑 32km（后 16km @ MP）'>",
{_spec_field_line(structured)}
  "notes_md": "<该课的配速/心率/组数/理由，markdown，可选>",
  "total_distance_m": 32000,        // 跑步课填米；非跑步可为 null
  "total_duration_s": null,         // 预计时长（秒），可为 null
  "scheduled_workout_id": null      // 始终 null（推手表后才回填）
}}

PlannedNutrition（每个有营养安排的日期一条；本周营养以 nutrition 列表承载）：
{{
  "schema": "plan-nutrition/v1",
  "date": "YYYY-MM-DD",
  "kcal_target": 2600,              // 可为 null
  "carbs_g": 360, "protein_g": 130, "fat_g": 70, "water_ml": 2500,  // 均可为 null
  "meals": [
    {{
      "name": "早餐",               // 早餐/午餐/晚餐/加餐
      "time_hint": "7:30",          // 可为 null
      "kcal": 600, "carbs_g": 90, "protein_g": 25, "fat_g": 12,     // 均可为 null
      "items_md": "燕麦 80g + 鸡蛋 2 个 + 香蕉 1 根"                  // 自由文本，可为 null
    }}
  ],
  "notes_md": "<当日营养说明，可选>"
}}

【单周硬约束】
- **每天默认 1 节训练**：同一 `date` 默认只有一条 session。只有当注入的用户请求明确要求
  某天双练（早晚双跑 / 两练 / 再加一节）时，才在该天排第 2 条 session（session_index=1），
  其余天保持每天 1 节。绝不在无请求时把一天拆成两节。
{_spec_hard_rules(structured)}
- `week_folder` 原样回填该周给出的字符串。
- 日期落在该周的 7 天窗口内。{spec_schema_block}
"""


# Aspirational (spec=null) body — the default both composers used before the
# structured-generation change. Kept as a module constant for back-compat + the
# existing drift-guard test.
WEEKLY_PLAN_FIELDS_CONTRACT = weekly_plan_fields_contract(structured=False)
