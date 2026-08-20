"""Shared test helper: a deterministic, rule-clean fake weekly generator.

The executable week is normally produced by the LLM specialist generator
(``generate_phase_validated``). Tests that exercise ``build_weekly_plan`` (or the
``/plan/weeks/generate`` route) without a live LLM install this fake, which
echoes the requested weekly target as a rule-clean one-session-per-day week
(Mon rest / Tue E 20% / Wed T 15% / Thu E 20% / Fri I 12% / Sat strength /
Sun long 33% — ≥1 rest day, long run ≤35%).
"""

from __future__ import annotations

from datetime import date, timedelta

from stride_core.plan_spec import PlannedSession, SessionKind, WeeklyPlan

_DAY_PLAN = [
    ("rest", "休息日", 0.00, None),
    ("run", "E 轻松跑", 0.20, "Z2"),
    ("run", "T 节奏跑（4:45-5:00/km）", 0.15, "Z3"),
    ("run", "E 轻松跑", 0.20, "Z2"),
    ("run", "I 间歇跑（4:15-4:30/km）", 0.12, "Z5"),
    ("strength", "力量训练", 0.00, None),
    ("run", "E 长距离跑", 0.33, "Z2"),
]


def fake_week_plan_dict(folder: str, week_start: date, target_km: float) -> dict:
    """Build a rule-clean 7-day WeeklyPlan dict summing runs to ``target_km``."""
    sessions: list[PlannedSession] = []
    for offset, (kind_str, label, frac, hr) in enumerate(_DAY_PLAN):
        day = (week_start + timedelta(days=offset)).isoformat()
        distance_m = round(target_km * frac * 1000) if frac > 0 else None
        summary = f"{label}（{round(target_km * frac)}K）" if frac > 0 else label
        kind = (
            SessionKind.RUN
            if kind_str == "run"
            else SessionKind.STRENGTH
            if kind_str == "strength"
            else SessionKind.REST
        )
        sessions.append(
            PlannedSession(
                date=day,
                session_index=0,
                kind=kind,
                summary=summary,
                spec=None,
                notes_md=f"目标心率：{hr}。" if hr else None,
                total_distance_m=distance_m,
                total_duration_s=round(distance_m * 0.33) if distance_m else None,
            )
        )
    return WeeklyPlan(
        week_folder=folder,
        sessions=tuple(sessions),
        nutrition=(),
        notes_md=f"LLM 生成（target={target_km:.1f}km）。",
    ).to_dict()


def install_fake_weekly_generator(monkeypatch, *, capture: dict | None = None) -> None:
    """Patch ``generate_phase_validated`` to echo a rule-clean week for the target."""

    def _fake(phase, week_metas, context, injuries=None, **kwargs):
        meta = week_metas[0]
        if capture is not None:
            capture["phase"] = phase
            capture["meta"] = meta
            capture["context"] = context
            capture["user_request"] = kwargs.get("user_request")
            capture["structured"] = kwargs.get("structured")
        week_start = date.fromisoformat(meta.week_folder[:10])
        return [
            fake_week_plan_dict(
                meta.week_folder, week_start, float(meta.target_weekly_km)
            )
        ]

    monkeypatch.setattr(
        "stride_server.coach_adapters.phase_specialist_adapter."
        "generate_phase_validated",
        _fake,
    )
