"""S2 weekly plan judge — see ``docs/coach-eval_S2.md``.

The judge evaluates one generated ``WeeklyPlan`` against a frozen S2 fixture:
master-plan phase, previous plans/feedback, recent recovery/load signals, and
the user's request. Deterministic safety remains in L1; this L2 prompt focuses
on training judgement that hard rules cannot reliably capture.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Literal, get_args

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage

from coach.runtime.messages import extract_text

from .judge_utils import (
    clean_compact,
    json_compact,
    matches_expected,
    model_name,
    parse_judge_output,
)
from .schemas import AxisScore, JudgeScore

logger = logging.getLogger(__name__)

JUDGE_PROMPT_VERSION = "s2-v1"


S2Axis = Literal[
    "schema_validity",
    "safety_load",
    "progression",
    "phase_fit",
    "signal_response",
    "injury_safety",
    "weekly_distribution",
    "nutrition_alignment",
    "request_handling",
]
S2_AXES: tuple[str, ...] = get_args(S2Axis)


S2_JUDGE_SYSTEM_PROMPT = """你是 STRIDE 周训练计划（S2）离线评估员。

给定一个生成出的 WeeklyPlan，以及冻结 fixture 的上下文，对以下 9 个 axis 各打 1-5 分（或 null = N/A）：

- schema_validity       — WeeklyPlan 字段、日期、session/nutrition 结构是否可解析且用户可执行
- safety_load           — 周量、长跑、强度、休息是否安全；是否避免 spike + flat
- progression           — 是否自然承接上 1-2 周计划与反馈，不机械加量或硬补漏跑
- phase_fit             — 是否匹配当前 master plan 阶段（base/build/peak/taper/recovery）
- signal_response       — 是否响应 HRV/RHR/sleep/PMC 信号；坏信号时应降强度或改 Z2
- injury_safety         — 是否避开 injury 冲突动作/课型，并给出监控或替代
- weekly_distribution   — 周内压力分布是否合理，硬课间隔、长跑位置、休息日是否顺
- nutrition_alignment   — 营养是否随跑步日/长跑日/力量日/恢复日调整
- request_handling      — 是否回应 user_request_md；无用户请求时 score=null（N/A）

评分约定：
- 5 = 完全满足该 axis 的所有评估点
- 4 = 满足主要评估点，只有轻微缺失
- 3 = 部分满足但有明显缺口
- 2 = 多处不达标或训练学风险偏高
- 1 = 严重违反 / 危险 / 完全忽略上下文
- null = axis 不适用

overall_verdict 取值：
- "pass"     — 所有适用 axis ≥ fixture.expected.soft_rubric 中各 axis 的 min_score，且无 anti_pattern
- "marginal" — 部分 axis 低于 min_score 但不构成明显危险
- "fail"     — schema_validity invalid / 触发 anti_pattern / safety_load < 3 / signal_response < 3（当 fixture 有坏恢复信号）/ injury_safety < 3（当 fixture 有伤病）

S2 特别提醒：
- 评估时间尺度是一周。你要看这 7 天是否可执行，而不是只看周量总数。
- HRV 连续下行、RHR 上升、睡眠下降、ATL/CTL > 1.25 时，不应安排两个硬质量课；通常最多保留一个轻量质量刺激或全部改 Z2。
- 用户要求加量/保强度但身体信号差时，高分计划应该解释取舍并给安全折中，不是盲从。
- 出差/可训练天数受限时，不能把少数几天塞爆；宁可保核心课 + 长跑/有氧，牺牲次要课。
- recovery/taper 周应主动降负荷；build/peak 周才需要更明确的专项刺激。
- nutrition_alignment 不要求餐单华丽，但要和当天训练压力匹配：长跑/质量课补碳，力量后蛋白，恢复/休息日不过度补碳。

输出必须是严格 JSON（用 `---BEGIN_JUDGE---` 和 `---END_JUDGE---` 哨兵包裹）：

---BEGIN_JUDGE---
{
  "axes": [
    {"axis": "schema_validity", "score": 5, "rationale": "...", "anti_patterns_hit": []},
    {"axis": "safety_load", "score": 4, "rationale": "...", "anti_patterns_hit": []},
    {"axis": "progression", "score": 4, "rationale": "...", "anti_patterns_hit": []},
    {"axis": "phase_fit", "score": 5, "rationale": "...", "anti_patterns_hit": []},
    {"axis": "signal_response", "score": 5, "rationale": "...", "anti_patterns_hit": []},
    {"axis": "injury_safety", "score": 5, "rationale": "...", "anti_patterns_hit": []},
    {"axis": "weekly_distribution", "score": 4, "rationale": "...", "anti_patterns_hit": []},
    {"axis": "nutrition_alignment", "score": 4, "rationale": "...", "anti_patterns_hit": []},
    {"axis": "request_handling", "score": null, "rationale": "user_request_md 缺省 → N/A", "anti_patterns_hit": []}
  ],
  "overall_verdict": "pass",
  "overall_rationale": "1-3 句总体说明"
}
---END_JUDGE---

仅输出哨兵包裹的 JSON 块，不要其他文字。
"""


def _compact_generated_plan(plan: dict) -> dict:
    if not isinstance(plan, dict):
        return plan
    compact: dict[str, object] = {
        key: plan.get(key)
        for key in ("schema", "week_folder", "notes_md")
        if key in plan
    }

    sessions: list[dict[str, object]] = []
    for session in plan.get("sessions") or []:
        if not isinstance(session, dict):
            continue
        item = {
            key: session.get(key)
            for key in (
                "date", "session_index", "kind", "summary", "notes_md",
                "total_distance_m", "total_duration_s",
            )
            if key in session
        }
        spec = session.get("spec")
        if isinstance(spec, dict):
            item["spec"] = spec
        sessions.append(clean_compact(item))
    compact["sessions"] = sessions

    nutrition: list[dict[str, object]] = []
    for item in plan.get("nutrition") or []:
        if not isinstance(item, dict):
            continue
        nutrition.append(clean_compact({
            key: item.get(key)
            for key in (
                "date", "kcal_target", "carbs_g", "protein_g", "fat_g",
                "water_ml", "notes_md",
            )
            if key in item
        }))
    compact["nutrition"] = nutrition
    return clean_compact(compact)


def _build_user_message(generated_plan: dict, fixture: dict) -> str:
    inp = fixture.get("input") or {}
    expected = fixture.get("expected") or {}
    scenario = fixture.get("description", "")
    compact_plan = _compact_generated_plan(generated_plan)

    context = {
        "user_profile": inp.get("user_profile") or {},
        "target_week_start": inp.get("target_week_start"),
        "week_folder": inp.get("week_folder"),
        "current_phase": inp.get("current_phase") or inp.get("user_profile", {}).get("phase"),
        "target_weekly_km": inp.get("target_weekly_km") or (inp.get("week_meta") or {}).get("target_weekly_km"),
        "prev_plans_md": inp.get("prev_plans_md") or [],
        "prev_feedback_md": inp.get("prev_feedback_md") or [],
        "recent_signals": inp.get("recent_signals") or {},
        "user_request_md": inp.get("user_request_md") or "<autonomous: no user request>",
    }

    return (
        f"<scenario>\n{scenario}\n</scenario>\n\n"
        f"<fixture_context>\n{json_compact(context)}\n</fixture_context>\n\n"
        f"<expected>\n{json_compact(expected)}\n</expected>\n\n"
        "<draft_weekly_plan_compact note=\"empty/null fields omitted; evaluate generated plan content below\">\n"
        f"{json_compact(compact_plan)}\n</draft_weekly_plan_compact>\n"
    )


def build_s2_judge_prompt_metadata(generated_plan: dict, fixture: dict) -> dict[str, int]:
    compact_plan = _compact_generated_plan(generated_plan)
    return {
        "judge_system_prompt_chars": len(S2_JUDGE_SYSTEM_PROMPT),
        "judge_user_prompt_chars": len(_build_user_message(generated_plan, fixture)),
        "judge_compact_plan_chars": len(json_compact(compact_plan)),
        "judge_original_plan_chars": len(json_compact(generated_plan)),
    }


def make_s2_judge(llm: BaseChatModel) -> Callable[[dict, dict], JudgeScore]:
    """Build an S2 judge callable bound to ``llm``."""

    judge_model_label = model_name(llm)

    def judge(generated_plan: dict, fixture: dict) -> JudgeScore:
        fixture_id = fixture.get("fixture_id", "<unknown>")
        expected = fixture.get("expected") or {}
        user_msg = _build_user_message(generated_plan, fixture)

        resp = llm.invoke([
            SystemMessage(content=S2_JUDGE_SYSTEM_PROMPT),
            HumanMessage(content=user_msg),
        ])
        raw = extract_text(resp.content)

        parsed = parse_judge_output(raw)
        if parsed is None:
            logger.warning("judge_s2 parse failed fixture=%s raw_len=%d", fixture_id, len(raw))
            return JudgeScore(
                fixture_id=fixture_id,
                scope="s2",
                axes=[],
                overall_verdict="fail",
                overall_rationale=f"judge_output_parse_failed (raw_len={len(raw)})",
                judge_model=judge_model_label,
                judge_prompt_version=JUDGE_PROMPT_VERSION,
            )

        axes: list[AxisScore] = []
        for ax in parsed.get("axes") or []:
            if not isinstance(ax, dict):
                continue
            axis_name = ax.get("axis")
            if axis_name not in S2_AXES:
                continue
            score = ax.get("score")
            if isinstance(score, bool):
                score = None
            if score is not None and not isinstance(score, int):
                try:
                    score = int(score)
                except (TypeError, ValueError):
                    score = None
            axes.append(AxisScore(
                axis=axis_name,
                score=score,
                rationale=str(ax.get("rationale", "")),
                matches_expected=matches_expected(axis_name, score, expected),
                anti_patterns_hit=list(ax.get("anti_patterns_hit") or []),
            ))

        verdict = parsed.get("overall_verdict", "fail")
        if verdict not in ("pass", "marginal", "fail"):
            verdict = "fail"

        return JudgeScore(
            fixture_id=fixture_id,
            scope="s2",
            axes=axes,
            overall_verdict=verdict,
            overall_rationale=str(parsed.get("overall_rationale", "")),
            judge_model=judge_model_label,
            judge_prompt_version=JUDGE_PROMPT_VERSION,
        )

    return judge
