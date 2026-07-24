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
boundary: only ``stride_core.master_plan`` (PhaseType) is imported for typing.
The shared WeeklyPlan field-shape body lives in ``weekly_plan_contract`` (also
reused by the phase-at-once composer); its field names mirror
``stride_core.plan_spec`` but it does not import it at runtime. The
contract/plan_spec sync is enforced by a drift-guard test in ``tests/coach``.
"""

from __future__ import annotations

from dataclasses import dataclass

from stride_core.master_plan import PhaseType

from coach.schemas.specialist_context import PaceTargets, VolumeTargets

from .phase_specialists import get_specialist
from .weekly_plan_contract import WEEKLY_PLAN_FIELDS_CONTRACT


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


# The shared WeeklyPlan field-shape body lives in ``weekly_plan_contract``
# (reused by the phase-at-once composer). This single-week contract wraps it in
# this composer's sentinel + the "emit exactly one object, JSON only" envelope.
_WEEKLY_PLAN_JSON_CONTRACT = f"""\
=== {WEEKLY_PLAN_JSON_CONTRACT_SENTINEL} ===
你必须**只**输出一个合法的 JSON 对象（无 markdown 代码围栏、无解释文字、无前后缀），
该对象将被 `WeeklyPlan.from_dict` 直接解析。

{WEEKLY_PLAN_FIELDS_CONTRACT}
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


# Fixed nutrition-generation instruction. Emitted ONLY when the caller supplies a
# non-empty ``nutrition_baseline_block`` (the athlete's real body-composition
# baseline numbers). Kept out of the shared contract so the S2 phase / eval paths
# — which do not pass a baseline — are byte-for-byte unchanged.
_NUTRITION_INSTRUCTION = """\
【营养生成要求——用下方真实体测基线为本周每一天生成 nutrition】
- 为本周 7 天每天生成一条 PlannedNutrition（date 落在本周 7 天窗口内）。
- kcal_target / carbs_g / protein_g / fat_g / water_ml 依据下方基线换算：训练日在基线
  热量上按当天课型强度适度增量、休息日用基线热量；宏量按下方蛋白/碳水/脂肪百分比拆分。
- 每天给出 meals（正餐 + 训练日的训练前/中/后补给），items_md 用具体食物且贴合当天课型。
- 严格使用下方注入的基线数字，不要凭空编造 BMR/TDEE 或宏量占比。"""


def build_weekly_system_prompt(
    *,
    phase: PhaseType,
    week_meta: WeekMeta,
    pace_targets: PaceTargets,
    volume_targets: VolumeTargets,
    context_block: str,
    nutrition_baseline_block: str = "",
) -> str:
    """Compose the single-week generation system prompt.

    ``pace_targets`` and ``volume_targets`` are **required** (keyword-only, no
    default) — the athlete's real pace table and volume budget must always be
    injected. ``context_block`` is a pre-rendered string (continuity signals +
    prior-week tail + injuries) supplied by the caller; pass ``""`` if empty.

    ``nutrition_baseline_block`` is an optional pre-rendered string carrying the
    athlete's real body-composition nutrition baseline (kcal + macro split +
    source note). When non-empty, a fixed nutrition-generation instruction plus
    the baseline is injected so the LLM emits the ``nutrition`` list from real
    data. Default ``""`` leaves the prompt (and the S2 phase / eval callers that
    never pass it) unchanged — they emit no nutrition.
    """
    specialist = get_specialist(phase)

    nutrition_section = (
        f"{_NUTRITION_INSTRUCTION}\n{nutrition_baseline_block}\n"
        if nutrition_baseline_block
        else ""
    )

    return f"""\
你是专业马拉松训练教练，负责生成**单周**结构化训练计划。当前阶段：{specialist.name}。

{_WEEKLY_PLAN_JSON_CONTRACT}

{specialist.guidance}

【必传上下文——本运动员真实数据，必须使用，不得编造】
配速表（pace_targets，s/km，用这些数字）：{pace_targets.render()}
量预算（volume_targets，在此预算内分配课程）：{volume_targets.render()}

{context_block}

{nutrition_section}{_render_week_framing(week_meta)}
"""
