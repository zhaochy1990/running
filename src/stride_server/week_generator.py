"""Rule-based single-week training plan generator.

Generates a WeeklyPlan from defaults + last-week completion signals.
No LLM calls, no TRAINING_PLAN.md dependency — purely deterministic rules.
"""

from __future__ import annotations

from datetime import date, timedelta

from stride_core.plan_spec import PlannedSession, SessionKind, WeeklyPlan

# ── Constants ─────────────────────────────────────────────────────────────────

_DEFAULT_BASE_KM: float = 40.0

# Day-of-week offsets (0=Mon … 6=Sun) → session configuration.
# Each entry: (kind, label, distance_fraction, pace_hint, hr_zone, notes_md)
# distance_fraction is a fraction of weekly base km (0 for non-running days).
_DAY_PLAN: list[tuple[str, str, float, str | None, str | None, str | None]] = [
    # Mon — rest
    ("rest",     "休息日",                     0.00,  None,                None, None),
    # Tue — E medium run 20%
    ("run",      "E 轻松跑",                   0.20,  "5:30-6:00/km",      "Z2", "轻松有氧，保持对话配速。"),
    # Wed — T tempo run 15%
    ("run",      "T 节奏跑",                   0.15,  "4:45-5:00/km",      "Z3", "阈值配速，能说短句即可。"),
    # Thu — E medium run 20%
    ("run",      "E 轻松跑",                   0.20,  "5:30-6:00/km",      "Z2", "恢复性轻松跑。"),
    # Fri — I intervals 12% (short but intense)
    ("run",      "I 间歇跑",                   0.12,  "4:15-4:30/km",      "Z5", "400m×6-8，组间慢跑 200m。"),
    # Sat — strength (not counted in weekly km)
    ("strength", "力量训练",                   0.00,  None,                None, "核心 + 臀腿力量，40-50min。"),
    # Sun — E long run 33% (below the repo's <35% hard gate)
    ("run",      "E 长距离跑",                 0.33,  "5:45-6:15/km",      "Z2", "全程有氧，后半段维持配速。"),
]

# Estimated pace in s/km for each session type (used to calculate duration).
_PACE_S_PER_KM: dict[str, float] = {
    "E":  330.0,   # ~5:30/km
    "T":  292.0,   # ~4:52/km
    "I":  262.0,   # ~4:22/km
}

# ── Folder helpers ────────────────────────────────────────────────────────────


def week_folder(week_start: date) -> str:
    """Return the folder string for a Monday week_start.

    Format: ``YYYY-MM-DD_MM-DD``
    """
    week_end = week_start + timedelta(days=6)
    return f"{week_start.isoformat()}_{week_end.month:02d}-{week_end.day:02d}"


# ── Core generator ────────────────────────────────────────────────────────────


def generate_week_plan(
    user_id: str,  # noqa: ARG001 — reserved for future per-user personalisation
    week_start: date,
    base_distance_km: float | None,
    last_week_summary: dict | None,
) -> tuple[WeeklyPlan, float]:
    """Rule-based single-week generator.

    Args:
        user_id: User UUID (reserved for future per-user personalisation).
        week_start: Must be a Monday (weekday() == 0).
        base_distance_km: Explicit override. When None, derived from
            last_week_summary or defaulted to 40 km.
        last_week_summary: Optional dict with keys:
            ``completed_sessions`` (int),
            ``total_sessions`` (int),
            ``total_distance_km`` (float),
            ``avg_rpe`` (float | None).

    Weekly distance decision logic:
        1. If base_distance_km is given explicitly → use it.
        2. If last_week_summary is given:
           - completion_rate = completed / total (default 1.0 if total == 0)
           - completion_rate >= 0.8 AND avg_rpe <= 6 → base × 1.05 (max +10%)
           - completion_rate < 0.6 → base × 0.90
           - otherwise → maintain last week's distance
        3. No last-week data → default 40 km.

    Session layout (7 days):
        Mon: rest
        Tue: E medium (~18%)
        Wed: T tempo (~13%)
        Thu: E medium (~18%)
        Fri: I intervals (~5%)
        Sat: strength (not counted in weekly km)
        Sun: E long (~33%)
    """
    # ── Step 1: determine base distance ──────────────────────────────────────
    if base_distance_km is not None:
        total_km = float(base_distance_km)
    elif last_week_summary is not None:
        last_km = float(last_week_summary.get("total_distance_km") or _DEFAULT_BASE_KM)
        completed = int(last_week_summary.get("completed_sessions") or 0)
        total = int(last_week_summary.get("total_sessions") or 0)
        avg_rpe = last_week_summary.get("avg_rpe")

        completion_rate = (completed / total) if total > 0 else 1.0

        if completion_rate >= 0.8 and (avg_rpe is None or float(avg_rpe) <= 6.0):
            # Good week → progress, but cap at +10%
            increase = min(last_km * 0.05, last_km * 0.10)
            total_km = last_km + increase
        elif completion_rate < 0.6:
            total_km = last_km * 0.90
        else:
            total_km = last_km
    else:
        total_km = _DEFAULT_BASE_KM

    # Round to nearest 0.5 km for clean numbers.
    total_km = round(total_km * 2) / 2

    # ── Step 2: build sessions ────────────────────────────────────────────────
    folder = week_folder(week_start)
    sessions: list[PlannedSession] = []

    for day_offset, (kind_str, label, frac, pace_hint, hr_zone, notes_md) in enumerate(_DAY_PLAN):
        day_date = (week_start + timedelta(days=day_offset)).isoformat()
        distance_m: float | None = None
        duration_s: float | None = None
        summary = label

        if kind_str == "run" and frac > 0:
            distance_m = round(total_km * frac * 1000)
            distance_km_this = total_km * frac
            # pick pace constant by label prefix
            if label.startswith("T"):
                pace_s = _PACE_S_PER_KM["T"]
            elif label.startswith("I"):
                pace_s = _PACE_S_PER_KM["I"]
            else:
                pace_s = _PACE_S_PER_KM["E"]
            duration_s = round(distance_km_this * pace_s)

            # Build human-readable summary: "E 8K 轻松跑" style
            km_label = f"{round(distance_km_this)}K" if distance_km_this >= 1 else f"{int(distance_m)}m"
            # For tempo/interval include target pace
            if pace_hint:
                summary = f"{label}（{km_label}，{pace_hint}）"
            else:
                summary = f"{label}（{km_label}）"

            # Annotate notes with hr zone
            if hr_zone and notes_md:
                notes_md = f"目标心率：{hr_zone}。{notes_md}"
            elif hr_zone:
                notes_md = f"目标心率：{hr_zone}。"

        kind = SessionKind.RUN if kind_str == "run" else (
            SessionKind.STRENGTH if kind_str == "strength" else SessionKind.REST
        )

        session = PlannedSession(
            date=day_date,
            session_index=0,
            kind=kind,
            summary=summary,
            spec=None,           # rule-engine output is aspirational, not pushable
            notes_md=notes_md,
            total_distance_m=distance_m,
            total_duration_s=duration_s,
        )
        sessions.append(session)

    plan = WeeklyPlan(
        week_folder=folder,
        sessions=tuple(sessions),
        nutrition=(),
        notes_md=f"规则引擎生成（base={total_km:.1f}km）。",
    )
    return plan, total_km
