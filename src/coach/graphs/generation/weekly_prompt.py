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
from .weekly_plan_contract import weekly_plan_fields_contract


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


def _weekly_plan_json_contract(*, structured: bool = False) -> str:
    """The single-week contract = the shared WeeklyPlan field body wrapped in
    this composer's sentinel + the "emit exactly one object, JSON only" envelope.

    ``structured`` toggles aspirational (spec=null) vs watch-pushable
    (run/strength carry a structured spec) session bodies.
    """
    return f"""\
=== {WEEKLY_PLAN_JSON_CONTRACT_SENTINEL} ===
你必须**只**输出一个合法的 JSON 对象（无 markdown 代码围栏、无解释文字、无前后缀），
该对象将被 `WeeklyPlan.from_dict` 直接解析。

{weekly_plan_fields_contract(structured=structured)}
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
    structured: bool = False,
) -> str:
    """Compose the single-week generation system prompt.

    ``pace_targets`` and ``volume_targets`` are **required** (keyword-only, no
    default) — the athlete's real pace table and volume budget must always be
    injected. ``context_block`` is a pre-rendered string (continuity signals +
    prior-week tail + injuries) supplied by the caller; pass ``""`` if empty.
    ``structured`` toggles aspirational (spec=null) vs watch-pushable output.
    """
    specialist = get_specialist(phase)

    return f"""\
你是专业马拉松训练教练，负责生成**单周**结构化训练计划。当前阶段：{specialist.name}。

{_weekly_plan_json_contract(structured=structured)}

{specialist.guidance}

【必传上下文——本运动员真实数据，必须使用，不得编造】
配速表（pace_targets，s/km，用这些数字）：{pace_targets.render()}
量预算（volume_targets，在此预算内分配课程）：{volume_targets.render()}

{context_block}

{_render_week_framing(week_meta)}
"""
