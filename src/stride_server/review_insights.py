"""Rule-based insight engine for weekly review (M2 T12).

No LLM. Generates up to 3 Insight objects from aggregated weekly data.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Insight:
    type: str   # "completion" | "load" | "rpe" | "streak"
    level: str  # "positive" | "warning" | "neutral"
    text: str


def generate_insights(
    summary: dict,
    tsb_series: list[dict],
    last_n_weeks_completion: list[float] | None = None,
) -> list[Insight]:
    """Generate up to 3 insights from weekly summary.

    Args:
        summary: The weekly summary dict (completion_rate, avg_rpe, etc.).
        tsb_series: List of dicts with keys 'date', 'tsb', 'ati', 'cti'.
                    May be empty if daily_health has no data for the week.
        last_n_weeks_completion: Optional list of prior-week completion rates
                                  (oldest first, most recent last) for streak detection.

    Returns:
        List of Insight objects, at most 3.
    """
    insights: list[Insight] = []

    # ── 1. Completion rate ────────────────────────────────────────────────
    completion_rate: float | None = summary.get("completion_rate")
    total_planned: int = summary.get("total_sessions_planned") or 0
    if completion_rate is not None and total_planned > 0:
        pct = round(completion_rate * 100)
        if completion_rate >= 0.9:
            insights.append(Insight(
                type="completion",
                level="positive",
                text=f"本周完成率 {pct}%，主要课型全部完成，训练执行出色！",
            ))
        elif completion_rate < 0.6:
            insights.append(Insight(
                type="completion",
                level="warning",
                text=f"本周完成率 {pct}%，请关注训练负担或日程安排，尽量保持连贯性。",
            ))
        else:
            insights.append(Insight(
                type="completion",
                level="neutral",
                text=f"本周完成率 {pct}%，整体尚可，可进一步提升计划执行率。",
            ))

    # ── 2. Training load / TSB ────────────────────────────────────────────
    if tsb_series:
        last_tsb: float = tsb_series[-1].get("tsb") or 0.0
        if last_tsb < -25:
            insights.append(Insight(
                type="load",
                level="warning",
                text=f"TSB 周末降至 {round(last_tsb, 1)}，累积疲劳较高，建议下周安排主动恢复日。",
            ))
        elif last_tsb > 15:
            insights.append(Insight(
                type="load",
                level="warning",
                text=f"TSB 周末为 +{round(last_tsb, 1)}，当前状态偏轻松，注意减量不要过度，保持训练刺激。",
            ))
        else:
            insights.append(Insight(
                type="load",
                level="neutral",
                text=f"TSB 周末为 {round(last_tsb, 1)}，负荷处于正常范围，状态平稳。",
            ))

    # ── 3. RPE ────────────────────────────────────────────────────────────
    avg_rpe: float | None = summary.get("avg_rpe")
    if avg_rpe is not None and len(insights) < 3:
        if avg_rpe >= 8.0:
            insights.append(Insight(
                type="rpe",
                level="warning",
                text=f"平均 RPE {round(avg_rpe, 1)}，整体强度偏高，注意恢复质量与睡眠。",
            ))
        elif avg_rpe <= 4.0:
            insights.append(Insight(
                type="rpe",
                level="neutral",
                text=f"平均 RPE {round(avg_rpe, 1)}，整体偏轻松，可适度增加训练挑战。",
            ))
        else:
            insights.append(Insight(
                type="rpe",
                level="neutral",
                text=f"平均 RPE {round(avg_rpe, 1)}，强度适中，与计划难度吻合。",
            ))

    # ── 4. Streak (optional, replaces RPE slot only when len < 3) ─────────
    if last_n_weeks_completion and len(insights) < 3:
        # Count how many consecutive weeks (from the end) hit >= 0.85
        streak = 0
        for rate in reversed(last_n_weeks_completion):
            if rate >= 0.85:
                streak += 1
            else:
                break
        # Include current week in the streak count
        current_ok = (completion_rate or 0) >= 0.85
        if current_ok:
            streak += 1
        if streak >= 3:
            insights.append(Insight(
                type="streak",
                level="positive",
                text=f"连续 {streak} 周完成率达 85% 以上，训练稳定性出色，继续保持！",
            ))

    return insights[:3]
