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
from .weekly_plan_contract import WEEKLY_HARD_RULES, WEEKLY_PLAN_FIELDS_CONTRACT


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
# Milestone block (the phase's owned milestone(s) — generator design target)
# ---------------------------------------------------------------------------


def _render_milestone_block(milestone_summary: str) -> str:
    """Render the phase's milestone target the generator MUST design toward.

    The reviewer already checks the phase against this same milestone summary;
    injecting it here (it was previously ONLY in the reviewer prompt) tells the
    generator the target on the FIRST try, so it designs the phase's long-run
    progression / deload placement toward the milestone instead of learning it
    via a review-driven regen.
    """
    return f"""\
【本阶段 milestone（生成时必须朝它设计）】
本阶段需要达成的阶段末目标（reviewer 会用它评审，请直接对齐它生成）：
{milestone_summary}
长跑距离、质量课进度、减量周安放都要朝这些目标推进——阶段末必须命中。

【milestone 落地硬要求】
- 每个 milestone 都必须在其日期所在自然周生成一个可见的具体 session，summary/notes_md 写出目标、metric/数值和执行标准；不能只在阶段说明里泛泛提到。
- long_run/race_pace milestone：对应周长跑必须达到目标距离/MP 段。
- test_run/race milestone：对应周必须有测试/比赛或明确的控制跑安排。
- strength_test milestone：对应周必须有 strength 或 note session，写清目标动作、次数/组数、左右侧、测试标准和通过/停止条件；不能只写“力量维护”。
- body_composition milestone：对应周必须有 nutrition/strength/recovery 行动和复测安排。
"""


def _render_key_session_rotation(phase_type: PhaseType) -> str:
    """Phase-specific key-session rotation guard.

    Safety gates catch load errors, but they do not catch a physiologically
    stale phase where every week repeats the same interval pattern. Render this
    as prompt doctrine so phase-at-once generation deliberately varies the core
    stimulus while staying inside each week's volume budget.
    """
    pools = {
        PhaseType.BASE: "阈值引入 2k * 3-4、短坡技术跑、渐进 z2 长跑；基础期不排 Z5 大课",
        PhaseType.BUILD: "阈值巡航 2k * 4-5、tempo 连续跑、MP 中长课、CV/10k 1k 组；按周轮换，不连续复制同一结构",
        PhaseType.SPEED: "VO2max 1k 组、400m 短间歇、60-90s 短坡、5K 测试/控制跑；高区课型按周轮换",
        PhaseType.PEAK: "MP 长跑不同结构（如后段 MP、分段 MP、连续 MP）、中周 MP、少量阈值保鲜；不每周复制同一 MP 模板",
        PhaseType.TAPER: "短 MP 唤醒、少量 strides、比赛周节奏触感；不安排大容量质量课",
        PhaseType.RECOVERY: "easy、mobility、力量维护；无质量课",
    }
    pool = pools.get(phase_type, pools[PhaseType.BASE])
    return f"""\
【核心课轮换（训练质量要求）】
- 本阶段的质量课 / 长跑核心刺激必须逐周有进展和变化，**不要连续两周复制同一种主课结构**。
- 允许的轮换池：{pool}。
- 如果某周是 DELOAD/减量周，删除质量课；可保留 easy、mobility、力量维护，或只在 milestone 周安排低风险测试。
- 每周仍只保留 1-2 个核心刺激，其余跑量用 z1-z2/easy 承接，不能为了轮换而增加额外硬课。
"""


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
    milestone_summary: str | None = None,
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
        milestone_summary: optional one-line summary of the phase's owned
            milestone target(s) — the SAME render the reviewer uses (single
            source via the adapter's ``_render_milestone_summary``). When
            present, the prompt injects a 【本阶段 milestone】 block and the
            holistic long-run instruction references it concretely so the
            generator designs toward the target on the first try. Omitted
            cleanly (no dangling label) when ``None``.
        feedback: optional (regen only) — a string block listing what to FIX in
            the regenerated phase. When present, the prompt instructs the LLM to
            explicitly address each item; when absent, no feedback section.
    """
    specialist = get_specialist(phase_type)
    n_weeks = len(week_specs)

    milestone_block = (
        _render_milestone_block(milestone_summary) if milestone_summary else ""
    )
    feedback_block = _render_feedback(feedback) if feedback else ""

    return f"""\
你是专业马拉松训练教练，负责一次性生成**整个阶段**（共 {n_weeks} 周）的结构化训练计划。\
当前阶段：{specialist.name}。

{_render_phase_contract(n_weeks)}

{specialist.guidance}

{milestone_block}\
【阶段整体设计要求（phase-at-once 的核心——逐周贪心生成做不到的）】
- 跨周推进长跑：把长跑距离沿各周渐进，到阶段末**达到上方【本阶段 milestone】给出的目标**（如长跑达 21km / 30km 含 MP 段）；没有 milestone 时按 doctrine 自然递进。
- 按 is_deload 标记安放减量周：在标记为 DELOAD 的周**必须删除质量课**（这是硬性要求，不是建议），仅保留 easy + mobility/力量维护。
- 保持 doctrine 规定的强度分布（三区占比），不要把质量集中到单周 spike。
- 用逐周表注入的 volume_targets 预算命中每周目标周量；绝不自行编配速 / 里程。
- 比赛周也要贴近逐周表目标周量：若 race 本身低于目标周量 2km 以上，安排 2-4km 赛前 shakeout/激活跑补足；不要用“比赛日不额外加跑”把整周周量压到 race distance。

{_render_key_session_rotation(phase_type)}
{WEEKLY_HARD_RULES}
【必传上下文——本运动员真实数据，必须使用，不得编造】
配速表（pace_targets，s/km，全阶段共用，用这些数字）：{pace_targets.render()}

{context_block}

{_render_week_table(week_specs)}

{feedback_block}"""
