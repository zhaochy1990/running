"""Per-phase doctrine reviewer — the LLM half of the Stage-3b hybrid review.

Deterministic season rules (T3) are the other half. This module judges a whole
**phase**'s generated weeks against:

* the phase specialist's coach doctrine (``get_specialist(phase_type)`` — the
  Stage-3a registry), and
* the master-plan phase's **focus** string + any quantifiable **milestone**,

so a "rule-clean but wrong-character" phase (e.g. a ``speed`` phase with no real
Z5 work) gets caught. The reviewer emits ``pass | revise | block`` (``auto_fix``
is accepted from the LLM but softened — see :func:`parse_phase_review`).

The review is **per-phase**, not per-week: one LLM call judges the whole week
set. Per-week safety is already gated deterministically by ``run_rule_filter``
inside the Stage-3a per-week graph, so an LLM review per week would be wasteful.

This module is **core**: prompt strings + parsing only, NO LLM call, NO DB. The
Stage-3b orchestrator (T5) drives the LLM via the adapter
(:func:`stride_server.coach_adapters.phase_review_adapter.review_phase`) and
stores the result in ``PhaseWeeks.review``.

Import boundary (``.importlinter`` Contract 1): ``coach.*`` +
``stride_core.{master_plan,plan_spec}`` only — no infra.
"""

from __future__ import annotations

from coach.schemas import PhaseReview
from coach.schemas.review import ReviewReport

from .graph import parse_reviewer_xml
from .phase_specialists import get_specialist


# ---------------------------------------------------------------------------
# Week summarisation (compact — keep the prompt small)
# ---------------------------------------------------------------------------


def _summarize_week(week: dict, *, index: int) -> str:
    """One compact line per week: folder, run km, key session summaries.

    Derived from the WeeklyPlan dict (``sessions`` list). Run-only km matches
    how ``rule_filter`` / continuity threading count distance (``kind == "run"``)
    so the reviewer sees the same volume the deterministic layer used.
    """
    folder = str(week.get("week_folder") or f"week {index}")
    sessions = week.get("sessions") or []
    run_km = (
        sum(
            (s.get("total_distance_m") or 0)
            for s in sessions
            if s.get("kind") == "run"
        )
        / 1000.0
    )
    # Order by (date, session_index) so the key-session list reads chronologically.
    ordered = sorted(
        sessions,
        key=lambda s: (str(s.get("date") or ""), int(s.get("session_index") or 0)),
    )
    summaries = [
        (s.get("summary") or "").strip()
        for s in ordered
        if (s.get("summary") or "").strip()
    ]
    key_block = "；".join(summaries) if summaries else "（无课次摘要）"
    return f"- {folder}（约 {run_km:.0f}km）：{key_block}"


def _summarize_weeks(weeks: list[dict]) -> str:
    """Compact multi-line summary of the phase's generated weeks."""
    if not weeks:
        return "（本阶段未生成任何周计划）"
    return "\n".join(
        _summarize_week(w, index=i + 1) for i, w in enumerate(weeks)
    )


# ---------------------------------------------------------------------------
# Prompt builder
# ---------------------------------------------------------------------------


def build_phase_review_prompt(
    *,
    phase_type: str,
    phase_focus: str,
    milestone_summary: str | None,
    weeks: list[dict],
) -> str:
    """Build the Chinese per-phase reviewer system prompt.

    Args:
        phase_type: the phase's ``PhaseType`` value string (``"base"`` /
            ``"build"`` / ``"speed"`` / ``"peak"`` / ``"taper"`` /
            ``"recovery"``). Used to pull the specialist doctrine.
        phase_focus: the master-plan ``Phase.focus`` string.
        milestone_summary: a one-line natural-language milestone target (with
            any quantifiable metric/target_value/comparator already rendered),
            or ``None`` when the phase owns no milestone.
        weeks: the phase's generated weeks as WeeklyPlan dicts.

    The prompt instructs the LLM to judge whether the weeks deliver the phase's
    physiological character + progress toward the milestone, and to emit the
    same XML review envelope :func:`parse_reviewer_xml` consumes.
    """
    specialist = get_specialist_safe(phase_type)
    doctrine = specialist.guidance if specialist else "（无对应阶段专家 doctrine）"
    name = specialist.name if specialist else phase_type

    milestone_block = (
        f"【本阶段量化里程碑（须评估周计划是否朝它推进）】\n{milestone_summary}"
        if milestone_summary
        else "【本阶段量化里程碑】\n（本阶段无显式里程碑——只按阶段生理特征评估）"
    )

    weeks_block = _summarize_weeks(weeks)

    return f"""\
你是 STRIDE 的「阶段评审专家」，负责对一个**完整训练阶段**已生成的周计划集合做
整体把关——判断这些周是否真正交付了该阶段应有的**生理特征**，并朝该阶段的
**重点 / 里程碑**推进。

逐周的安全性（周量爬升、长跑占比、伤病冲突、硬日间隔）已由上游确定性 rule_filter
逐周校验过；**你不重复做逐周安全检查**。你只做一件事：站在阶段层面，判断这一整组
周「像不像」这个阶段——例如 speed 阶段必须有真正的 Z5 VO2max / 短间歇刺激，base
阶段不该出现大容量高区质量，peak 阶段应由 MP 主导。一个「规则干净但性质错位」的
阶段（如 speed 阶段没有任何真正 Z5 课）必须被你抓出来。

================ 阶段专家 doctrine（{name}）================
{doctrine}

================ 本阶段 master-plan 定位 ================
【阶段类型】{phase_type}（{name}）
【阶段重点 focus】{phase_focus}

{milestone_block}

================ 已生成的周计划（逐周摘要）================
{weeks_block}

================ 你的评审任务 ================
对照上面的阶段专家 doctrine + 阶段重点 + 里程碑，判断这组周计划是否真正交付了本
阶段的生理特征与进展。重点看：
1. 强度分布是否匹配阶段（base 金字塔 / build 偏阈值 / speed 两极化高区 / peak MP
   主导 / taper-recovery 取消大容量质量）；
2. 关键刺激是否到位（该阶段的标志性课程是否真实出现，而非挂名）；
3. 周-周进展是否朝阶段目标 / 里程碑推进（量 / 质的渐进合理）。

================ 输出格式（严格遵守）================
只输出如下 XML，不要任何额外文字：

<review>
  <verdict>pass|revise|block</verdict>
  <commentary>用中文简述判断依据（1-3 句）</commentary>
  <issues>[{{"review_class": "phase_fit", "severity": "error|warning|info", "message": "具体问题"}}]</issues>
</review>

verdict 含义：
- pass：这组周计划符合本阶段生理特征，且朝重点 / 里程碑推进——可放行。
- revise：性质基本对但有实质缺口（如关键刺激密度不足 / 进展停滞），需重生本阶段。
- block：与本阶段性质严重错位（如 speed 阶段无任何真 Z5 课），必须重生本阶段。

issues 是一个 JSON 列表，每项 review_class 用 "phase_fit" / "progression" /
"safety_load" 之一，severity 用 "error" / "warning" / "info"。无问题时给 []。"""


def get_specialist_safe(phase_type: str):
    """Look up the specialist by ``phase_type`` string; return ``None`` on an
    unknown type rather than raising — a review prompt should degrade to a
    doctrine-less judgment rather than crash the season."""
    from stride_core.master_plan import PhaseType

    try:
        return get_specialist(PhaseType(phase_type))
    except (ValueError, KeyError):
        return None


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------


def parse_phase_review(raw: str) -> PhaseReview:
    """Parse the reviewer XML into the slim :class:`PhaseReview`.

    Reuses :func:`parse_reviewer_xml` (the shared envelope parser) to get a
    :class:`ReviewReport`, then maps it down to the season-facing
    ``PhaseReview`` (verdict + commentary + issues).

    Verdict mapping:
    * ``pass`` / ``revise`` / ``block`` pass through unchanged.
    * ``auto_fix`` is **softened to ``pass``**: at per-phase granularity there is
      no patch-apply step (``PhaseReview`` deliberately drops
      ``suggested_patches``), so an "auto-fixable" verdict means only minor
      issues — keep the weeks, surface the issues in commentary/issues.
    * A **malformed / unparseable** ``raw`` makes ``parse_reviewer_xml`` fall
      back to ``block``; for a phase review that's a "review unavailable, can't
      confirm" situation rather than a genuine doctrine violation, so we
      **soften the parse-failure ``block`` to ``revise``** — the orchestrator
      should regenerate/retry the phase, not hard-fail the whole season on an
      LLM formatting hiccup. (A genuine LLM ``<verdict>block</verdict>`` is
      preserved as ``block``; only the parser's fallback is softened, and only
      when the raw carried no recognisable ``<verdict>`` tag.)
    * A **present-but-invalid** verdict value (e.g. ``<verdict>foo</verdict>``)
      is intentionally left as ``block`` — a model that emitted a verdict tag
      with garbage content is treated as a real regenerate signal, not a
      formatting hiccup. Only a *wholly-absent* ``<verdict>`` tag is softened to
      ``revise``; a present tag (even with an unrecognised value) means the
      model spoke, so we honour the worst-case ``block`` ``parse_reviewer_xml``
      assigned it.
    """
    report: ReviewReport = parse_reviewer_xml(raw)
    verdict = report.verdict

    if verdict == "auto_fix":
        verdict = "pass"

    # Distinguish a real <verdict>block</verdict> from the parser's garbage
    # fallback: the fallback fires only when no <verdict> tag was found.
    if verdict == "block" and not _raw_has_verdict_tag(raw):
        verdict = "revise"

    return PhaseReview(
        verdict=verdict,
        commentary_md=report.commentary_md,
        issues=report.issues,
    )


def _raw_has_verdict_tag(raw: str) -> bool:
    """True iff ``raw`` carries a recognisable ``<verdict>...</verdict>`` tag."""
    import re

    return re.search(r"<verdict>\s*\S", raw, re.DOTALL) is not None
