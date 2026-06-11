"""Weekly JSON contract + system-prompt composer (Stage-3a Task 2).

Assembles the single-week generation system prompt from four parts:

1. the shared ``WeeklyPlan`` JSON contract (schema/field instructions +
   "emit aspirational spec=null" + "valid JSON only" + a stable sentinel),
2. the phase specialist's guidance + emphasis (via ``get_specialist``),
3. the **必传上下文**: the injected ``pace_targets`` + ``volume_targets``
   renders, then the caller's pre-rendered ``context_block`` (continuity +
   prior-week tail + injuries),
4. the week framing from ``week_meta``.

Pure string/schema composition — no DB, no LLM, no network. ``coach.*`` core
boundary: only ``stride_core.master_plan`` (PhaseType) is imported for typing;
the contract text mirrors ``stride_core.plan_spec`` field names but does not
import it at runtime (kept as a TYPE_CHECKING-only reference for documentation).
"""

from __future__ import annotations

from dataclasses import dataclass

from stride_core.master_plan import PhaseType

from coach.schemas.specialist_context import PaceTargets, VolumeTargets

from .phase_specialists import get_specialist


# ---------------------------------------------------------------------------
# Week framing input
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class WeekMeta:
    """Minimal framing for the week being generated.

    Rendered into the "week framing" part of the prompt by the composer.
    Populated by the adapter caller (Task 3+).
    """

    phase_position: str   # e.g. "build week 3/7"
    week_folder: str      # ISO week folder, e.g. "2026-06-15_06-21(W3)"
    target_weekly_km: float


# ---------------------------------------------------------------------------
# Shared WeeklyPlan-JSON contract
# ---------------------------------------------------------------------------

# Stable header the rule-filter / tests assert on. Bump the version when the
# contract's field instructions change non-back-compatibly.
WEEKLY_PLAN_JSON_CONTRACT_SENTINEL = "WEEKLY_PLAN_JSON_CONTRACT/v1"


# Field names below mirror ``stride_core.plan_spec`` (WeeklyPlan /
# PlannedSession / PlannedNutrition / Meal). Keep in sync if that schema moves.
_WEEKLY_PLAN_JSON_CONTRACT = f"""\
=== {WEEKLY_PLAN_JSON_CONTRACT_SENTINEL} ===
你必须**只**输出一个合法的 JSON 对象（无 markdown 代码围栏、无解释文字、无前后缀），
该对象将被 `WeeklyPlan.from_dict` 直接解析。结构如下：

{{
  "schema": "weekly-plan/v1",
  "week_folder": "<本周文件夹名，原样回填，见下方周框架>",
  "sessions": [ <PlannedSession>, ... ],
  "nutrition": [ <PlannedNutrition>, ... ],
  "notes_md": "<本周整体说明 markdown，可选>"
}}

PlannedSession（每个训练日一条；同日双练用 session_index 0/1 区分）：
{{
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

【硬约束】
- 所有 session 的 `spec` 必须为 `null`（aspirational 计划，不生成可推手表的结构化课）。
- 跑步日的配速/心率/组数写进 `summary` / `notes_md` 文字，**用下方注入的 pace_targets**，
  绝不自行编配速；里程在下方 volume_targets 预算内分配。
- `week_folder` 原样回填周框架里给出的字符串。
- 日期落在周框架给出的 7 天窗口内。
- 输出**仅** JSON，无任何其他文字。
=== END {WEEKLY_PLAN_JSON_CONTRACT_SENTINEL} ===
"""


def _render_week_framing(week_meta: WeekMeta) -> str:
    return f"""\
【本周框架】
- 阶段定位: {week_meta.phase_position}
- week_folder（原样回填到 JSON）: {week_meta.week_folder}
- 目标周量: {week_meta.target_weekly_km} km
"""


def build_weekly_system_prompt(
    *,
    phase: PhaseType,
    week_meta: WeekMeta,
    pace_targets: PaceTargets,
    volume_targets: VolumeTargets,
    context_block: str,
) -> str:
    """Compose the single-week generation system prompt.

    ``pace_targets`` and ``volume_targets`` are **required** (keyword-only, no
    default) — the athlete's real pace table and volume budget must always be
    injected. ``context_block`` is a pre-rendered string (continuity signals +
    prior-week tail + injuries) supplied by the caller; pass ``""`` if empty.
    """
    specialist = get_specialist(phase)

    return f"""\
你是专业马拉松训练教练，负责生成**单周**结构化训练计划。当前阶段：{specialist.name}。

{_WEEKLY_PLAN_JSON_CONTRACT}

{specialist.guidance}

【必传上下文——本运动员真实数据，必须使用，不得编造】
配速表（pace_targets，s/km，用这些数字）：{pace_targets.render()}
量预算（volume_targets，在此预算内分配课程）：{volume_targets.render()}

{context_block}

{_render_week_framing(week_meta)}
"""
