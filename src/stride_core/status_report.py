"""Deterministic starter status report generator.

Produces a one-page markdown snapshot of a user's profile, recent activities,
current fitness, and fatigue. No LLM calls; no external API.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .db import USER_DATA_DIR, Database

_SHANGHAI = timezone(timedelta(hours=8))


def _utc_to_shanghai(utc_dt: datetime) -> datetime:
    return utc_dt.astimezone(_SHANGHAI)


def _today_shanghai() -> str:
    return _utc_to_shanghai(datetime.now(timezone.utc)).strftime("%Y-%m-%d")


def _pace_fmt(s_per_km: float | None) -> str:
    if not s_per_km or s_per_km <= 0:
        return "—"
    mins, secs = divmod(int(s_per_km), 60)
    return f"{mins}:{secs:02d}/km"


def _duration_fmt(seconds: float | None) -> str:
    if not seconds:
        return "—"
    s = int(seconds)
    h, rem = divmod(s, 3600)
    m, sc = divmod(rem, 60)
    if h:
        return f"{h}h {m}m"
    return f"{m}m {sc}s"


def _render_activities(db: Database) -> list[str]:
    today = _today_shanghai()
    cutoff = (
        datetime.strptime(today, "%Y-%m-%d") - timedelta(days=14)
    ).strftime("%Y-%m-%d")
    rows = db.query(
        """SELECT distance_m, duration_s, avg_pace_s_km, avg_hr
           FROM activities WHERE date >= ? ORDER BY date DESC""",
        (cutoff,),
    )
    if not rows:
        return ["- No activities in the last 14 days"]
    count = len(rows)
    # `distance_m` column is misleadingly named — it actually stores km
    # (per coros_sync.models, distance from API is divided down to km).
    total_km = sum((r["distance_m"] or 0) for r in rows)
    total_dur = sum((r["duration_s"] or 0) for r in rows)
    paces = [r["avg_pace_s_km"] for r in rows if r["avg_pace_s_km"]]
    hrs = [r["avg_hr"] for r in rows if r["avg_hr"]]
    avg_pace = sum(paces) / len(paces) if paces else None
    avg_hr = round(sum(hrs) / len(hrs)) if hrs else None
    return [
        f"- **Activities**: {count}",
        f"- **Total distance**: {total_km:.1f} km",
        f"- **Total duration**: {_duration_fmt(total_dur)}",
        f"- **Avg pace**: {_pace_fmt(avg_pace)}",
        f"- **Avg HR**: {avg_hr if avg_hr else '—'} bpm",
    ]


def _render_fitness(db: Database) -> list[str]:
    rows = db.query(
        "SELECT running_level, aerobic_score FROM dashboard WHERE id = 1"
    )
    if not rows:
        return ["- Fitness data not yet available"]
    d = rows[0]
    running_level = d["running_level"]
    aerobic = d["aerobic_score"]
    return [
        f"- **Running level**: {running_level:.1f}" if running_level else "- **Running level**: —",
        f"- **Aerobic score**: {aerobic:.1f}" if aerobic else "- **Aerobic score**: —",
    ]


def _render_fatigue(db: Database) -> list[str]:
    rows = db.query(
        "SELECT date, fatigue, training_load_state, rhr "
        "FROM daily_health ORDER BY date DESC LIMIT 1"
    )
    if not rows:
        return ["- Health data not yet available"]
    h = rows[0]
    fatigue = h["fatigue"]
    state = h["training_load_state"] or "—"
    rhr = h["rhr"]
    return [
        f"- **Date**: {h['date']}",
        f"- **Fatigue**: {fatigue if fatigue is not None else '—'}",
        f"- **Training load**: {state}",
        f"- **RHR**: {rhr if rhr else '—'} bpm",
    ]


def generate_starter_status(
    user_id: str,
    data_root: Path | None = None,
) -> str:
    """Generate a starter status markdown for user_id and write to status.md.

    Returns the markdown string. Never raises — missing data renders as
    "Not set" / "not yet available" rather than crashing.
    """
    root = data_root or USER_DATA_DIR
    user_dir = root / user_id

    lines: list[str] = ["# STRIDE Status Report\n"]

    # Profile section
    profile_file = user_dir / "profile.json"
    lines.append("## Profile\n")
    try:
        profile = json.loads(profile_file.read_text(encoding="utf-8")) if profile_file.exists() else {}
    except Exception:
        profile = {}
    if profile:
        display_name = profile.get("display_name") or "—"
        target_race = profile.get("target_race") or "—"
        target_distance = profile.get("target_distance") or "—"
        target_race_date = profile.get("target_race_date") or "—"
        target_time = profile.get("target_time") or "—"
        weekly_mileage = profile.get("weekly_mileage_km")
        mileage_str = f"{weekly_mileage:.0f} km/week" if weekly_mileage else "Not set"
        lines += [
            f"- **Name**: {display_name}",
            f"- **Target race**: {target_race} ({target_distance}) on {target_race_date}, goal {target_time}",
            f"- **Weekly mileage target**: {mileage_str}",
        ]
    else:
        lines.append("- Profile not set")
    lines.append("")

    # DB-backed sections — each rendered independently so one failure doesn't cascade
    db_path = user_dir / "coros.db"
    db: Database | None = None
    if db_path.exists():
        try:
            db = Database(db_path=db_path)
        except Exception:
            db = None

    lines.append("## Last 14 Days\n")
    if db is not None:
        try:
            lines += _render_activities(db)
        except Exception:
            lines.append("- No activities in the last 14 days")
    else:
        lines.append("- No activities in the last 14 days")
    lines.append("")

    lines.append("## Current Fitness\n")
    if db is not None:
        try:
            lines += _render_fitness(db)
        except Exception:
            lines.append("- Fitness data not yet available")
    else:
        lines.append("- Fitness data not yet available")
    lines.append("")

    lines.append("## Recent Fatigue\n")
    if db is not None:
        try:
            lines += _render_fatigue(db)
        except Exception:
            lines.append("- Health data not yet available")
    else:
        lines.append("- Health data not yet available")

    if db is not None:
        try:
            db.close()
        except Exception:
            pass

    lines.append("")
    lines.append(
        f"*Generated at {_utc_to_shanghai(datetime.now(timezone.utc)).strftime('%Y-%m-%d %H:%M')} (Shanghai)*"
    )

    markdown = "\n".join(lines)
    status_path = user_dir / "status.md"
    status_path.parent.mkdir(parents=True, exist_ok=True)
    status_path.write_text(markdown, encoding="utf-8")
    return markdown
