"""Phase-level (phase-at-once) system-prompt composer (PA-T2).

Where ``weekly_prompt.build_weekly_system_prompt`` asks the LLM for ONE week,
this composer asks for an ENTIRE phase's weeks in a single batch — the whole
point being that a phase-holistic generator can do what a per-week greedy one
missed: progress the long run across the weeks toward the phase milestone, place
the deload week(s), keep the doctrine's intensity distribution, and stay inside
each week's volume budget.

The composed prompt instructs the LLM to emit::

    {"schema": "phase-weeks/v1", "weeks": [<WeeklyPlan>, …]}

with **exactly N** weeks (N = ``len(week_specs)``), week ``i`` matching
``week_specs[i]`` (folder + ~target km), each an aspirational ``spec=null``
WeeklyPlan.

Reuse:
- the WeeklyPlan field-shape body from ``weekly_plan_contract`` (shared with the
  single-week composer — the phase contract = that body wrapped in a
  ``{"weeks":[…×N]}`` envelope + a distinct ``PHASE_WEEKS_JSON_CONTRACT/v1``
  sentinel),
- the specialist doctrine via ``get_specialist`` (the holistic phase design),
- ``PaceTargets`` / ``VolumeTargets`` renders.

Pure string/schema composition — no DB, no LLM, no network, no parsing of LLM
output (the batch PARSER lives in the adapter, PA-T3). ``coach.*`` core
boundary: only ``stride_core.master_plan`` (PhaseType) + ``coach.*``.
"""

from __future__ import annotations

from dataclasses import dataclass

from stride_core.master_plan import PhaseType

from coach.schemas.specialist_context import PaceTargets, VolumeTargets

from .phase_specialists import get_specialist
from .weekly_plan_contract import WEEKLY_PLAN_FIELDS_CONTRACT


# ---------------------------------------------------------------------------
# Per-week framing input
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PhaseWeekSpec:
    """One week's framing + volume budget inside a phase-at-once request.

    The composer renders one ``week_specs`` entry per row of the per-week table
    so the LLM knows exactly how many weeks to emit, each week's folder + target
    km + volume budget, and which weeks are deloads. Populated by the adapter
    caller (PA-T3); this is pure framing data.
    """

    week_index: int            # 1-based position within the phase
    n_weeks: int               # total weeks in the phase (for the "i/N" framing)
    week_folder: str           # ISO week folder, e.g. "2026-06-15_06-21(W1)"
    target_weekly_km: float
    volume: VolumeTargets      # this week's volume budget (long_run/quality/easy)
    is_deload: bool = False    # deload/recovery week -> REMOVE quality sessions


# ---------------------------------------------------------------------------
# Phase-batch JSON contract
# ---------------------------------------------------------------------------

# Stable header the batch parser / tests assert on. Distinct from the per-week
# sentinel. Bump the version when the envelope's instructions change
# non-back-compatibly.
PHASE_WEEKS_JSON_CONTRACT_SENTINEL = "PHASE_WEEKS_JSON_CONTRACT/v1"


def _render_phase_contract(n_weeks: int) -> str:
    """The phase batch contract = the shared WeeklyPlan field body wrapped in a
    ``{"weeks":[ … × N ]}`` envelope + an explicit "exactly N weeks, week i
    matches spec i" instruction.
    """
    return f"""\
=== {PHASE_WEEKS_JSON_CONTRACT_SENTINEL} ===
你必须**只**输出一个合法的 JSON 对象（无 markdown 代码围栏、无解释文字、无前后缀），
该对象是整个阶段的「批量周计划」信封，结构如下：

{{
  "schema": "phase-weeks/v1",
  "weeks": [ <WeeklyPlan>, ... ]   // 必须 exactly {n_weeks} 个元素（恰好 {n_weeks} 周）
}}

`weeks` 数组里第 i 个 WeeklyPlan 必须对应下方「逐周计划表」第 i 行：原样回填该行的
`week_folder`，里程贴近该行的目标周量，并在该行注入的 volume_targets 预算内分配课程。

{WEEKLY_PLAN_FIELDS_CONTRACT}

【批量硬约束】
- `weeks` 数组长度必须 exactly {n_weeks}（恰好 {n_weeks} 周），不多不少；顺序与逐周表一致。
- 每个 week 的 `week_folder` 原样回填逐周表对应行给出的字符串。
- 输出**仅**这个 JSON 信封对象，无任何其他文字。
=== END {PHASE_WEEKS_JSON_CONTRACT_SENTINEL} ===
"""


# ---------------------------------------------------------------------------
# Per-week table render
# ---------------------------------------------------------------------------


def _fmt_km(km: float) -> str:
    if float(km).is_integer():
        return f"{int(km)}km"
    return f"{km:g}km"


def _render_week_table(week_specs: list[PhaseWeekSpec]) -> str:
    n = len(week_specs)
    lines = ["【逐周计划表——按此生成 weeks 数组，顺序一一对应】"]
    for s in week_specs:
        deload = " 【DELOAD/减量周——删除质量课，仅 easy + mobility/力量维护】" if s.is_deload else ""
        lines.append(
            f"- 第 {s.week_index}/{s.n_weeks} 周 | week_folder（原样回填）: {s.week_folder} | "
            f"目标周量: {_fmt_km(s.target_weekly_km)} | 量预算: {s.volume.render()}{deload}"
        )
    lines.append(
        f"共 {n} 周——`weeks` 数组必须 exactly {n} 个元素，第 i 个对应上表第 i 行。"
    )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Feedback (regen) block
# ---------------------------------------------------------------------------


def _render_feedback(feedback: str) -> str:
    return f"""\
【上一轮问题——本次重生成必须逐条修复（fix these）】
下列问题来自上一轮 rule_filter 校验或 reviewer 评审。重新设计整个阶段时，必须**逐条**
针对性修复，不得遗漏：
{feedback}
"""


# ---------------------------------------------------------------------------
# Composer
# ---------------------------------------------------------------------------


def build_phase_system_prompt(
    *,
    phase_type: PhaseType,
    week_specs: list[PhaseWeekSpec],
    pace_targets: PaceTargets,
    context_block: str,
    feedback: str | None = None,
) -> str:
    """Compose the phase-at-once generation system prompt.

    Args:
        phase_type: routes to the specialist doctrine (the holistic phase design).
        week_specs: ordered, one per week — each carries the week's framing +
            volume budget; ``len(week_specs)`` is the exact week count N.
        pace_targets: the one athlete pace table (shared across all weeks) —
            rendered once. Required (keyword-only, no default).
        context_block: pre-rendered continuity + prior-phase tail + injuries
            string supplied by the caller; pass ``""`` if empty.
        feedback: optional (regen only) — a string block listing what to FIX in
            the regenerated phase. When present, the prompt instructs the LLM to
            explicitly address each item; when absent, no feedback section.
    """
    specialist = get_specialist(phase_type)
    n_weeks = len(week_specs)

    feedback_block = _render_feedback(feedback) if feedback else ""

    return f"""\
你是专业马拉松训练教练，负责一次性生成**整个阶段**（共 {n_weeks} 周）的结构化训练计划。\
当前阶段：{specialist.name}。

{_render_phase_contract(n_weeks)}

{specialist.guidance}

【阶段整体设计要求（phase-at-once 的核心——逐周贪心生成做不到的）】
- 跨周推进长跑：把长跑距离沿各周渐进，朝本阶段 milestone 目标距离推进（见 doctrine）。
- 按 is_deload 标记安放减量周：在标记为 DELOAD 的周**删除质量课**，仅保留 easy + mobility/力量维护。
- 保持 doctrine 规定的强度分布（三区占比），不要把质量集中到单周 spike。
- 用逐周表注入的 volume_targets 预算命中每周目标周量；绝不自行编配速 / 里程。

【必传上下文——本运动员真实数据，必须使用，不得编造】
配速表（pace_targets，s/km，全阶段共用，用这些数字）：{pace_targets.render()}

{context_block}

{_render_week_table(week_specs)}

{feedback_block}"""
