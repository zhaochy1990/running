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
1. 周量渐进（weekly_progression）：每周跑步总里程 ≤ 上一周的 {MAX_WEEKLY_RAMP_RATIO:.2f} 倍\
（即每周环比涨幅 ≤ {(MAX_WEEKLY_RAMP_RATIO - 1) * 100:.0f}%）。减量/恢复周往下走永远合规。\
满足方式：按逐周表 target km 渐进，绝不单周跳涨。
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
"""


# The WeeklyPlan field-shape body — the inner contract both composers share.
# Single curly braces (this is NOT an f-string): callers may embed it directly.
#
# Field names below mirror ``stride_core.plan_spec``. Keep in sync if that
# schema moves; the drift-guard test will fail loudly otherwise.
WEEKLY_PLAN_FIELDS_CONTRACT = """\
单个 WeeklyPlan 对象（将被 `WeeklyPlan.from_dict` 直接解析）结构如下：

{
  "schema": "weekly-plan/v1",
  "week_folder": "<本周文件夹名，原样回填，见下方周框架>",
  "sessions": [ <PlannedSession>, ... ],
  "nutrition": [ <PlannedNutrition>, ... ],
  "notes_md": "<本周整体说明 markdown，可选>"
}

PlannedSession（每个训练日一条；同日双练用 session_index 0/1 区分）：
{
  "schema": "plan-session/v1",
  "date": "YYYY-MM-DD",            // ISO 日期，必填
  "session_index": 0,               // 同日第一节为 0，依次递增
  "kind": "run|strength|rest|cross|note",
  "summary": "<简短用户可见标签，如 '专项长跑 32km（后 16km @ MP）'>",
  "spec": null,                     // 【硬约束】本阶段课程为 aspirational，spec 必须为 null（不推手表结构化课）
  "notes_md": "<该课的配速/心率/组数/理由，markdown，可选>",
  "total_distance_m": 32000,        // 跑步课填米；非跑步可为 null
  "total_duration_s": null,         // 预计时长（秒），可为 null
  "scheduled_workout_id": null      // 始终 null（推手表后才回填）
}

PlannedNutrition（每个有营养安排的日期一条；本周营养以 nutrition 列表承载）：
{
  "schema": "plan-nutrition/v1",
  "date": "YYYY-MM-DD",
  "kcal_target": 2600,              // 可为 null
  "carbs_g": 360, "protein_g": 130, "fat_g": 70, "water_ml": 2500,  // 均可为 null
  "meals": [
    {
      "name": "早餐",               // 早餐/午餐/晚餐/加餐
      "time_hint": "7:30",          // 可为 null
      "kcal": 600, "carbs_g": 90, "protein_g": 25, "fat_g": 12,     // 均可为 null
      "items_md": "燕麦 80g + 鸡蛋 2 个 + 香蕉 1 根"                  // 自由文本，可为 null
    }
  ],
  "notes_md": "<当日营养说明，可选>"
}

【单周硬约束】
- 所有 session 的 `spec` 必须为 `null`（aspirational 计划，不生成可推手表的结构化课）。
- 跑步日的配速/心率/组数写进 `summary` / `notes_md` 文字，**用下方注入的 pace_targets**，
  绝不自行编配速；里程在每周 volume_targets 预算内分配。
- `week_folder` 原样回填该周给出的字符串。
- 日期落在该周的 7 天窗口内。
"""
