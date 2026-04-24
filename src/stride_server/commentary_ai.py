"""Assemble context, call Azure OpenAI (GPT-4.1), upsert commentary.

Context blocks (all fed on every call):
  1. 运动员档案 (static per-user config, optional)
  2. 当前训练阶段 (parsed from TRAINING_PLAN.md)
  3. 活动主数据 (activities table + weather + sport_note)
  4. 心率区间分布 (zones table)
  5. 训练分段 (laps lap_type='type2')
  6. HR 曲线下采样 (timeseries → 1 point/min)
  7. 活动当日 daily_health 快照 (fatigue / TSB / RHR)
  8. 最新 InBody 快照 (inbody_scan latest)
  9. 最近 4 周跑量趋势 (activities aggregated by week)
 10. 本周计划 plan.md 节选 (logs/<week>/plan.md)
 11. 同类活动近期 commentary (activity_commentary by sport_type)

All context comes from the local DB + filesystem — no extra COROS API calls.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from stride_core.db import USER_DATA_DIR, Database
from stride_core.models import pace_str, sport_name

from .aoai_client import AOAIUnavailable, get_client, get_deployment, is_enabled

logger = logging.getLogger(__name__)

SHANGHAI_TZ = timezone(timedelta(hours=8))


# ============================================================================
# System prompt — cached; describes role + format + guardrails.
# ============================================================================

SYSTEM_PROMPT = """你是一位经验丰富的马拉松教练，正在点评跑者的单次训练。
以**中文**撰写一段简洁的 commentary，字数不超过 200 字。

**结构**：
1. 开头一句判决：本次训练执行得怎么样、是否达到计划目的
2. 1-2 个具体数据观察（HR 纪律、配速控制、区间分布、分段质量等）
3. 结尾给出下一步建议（这次训练对未来 1-2 天意味着什么）

**约束**（必须遵守）：
- 使用 Markdown 粗体强调关键数字
- 必须引用用户上下文中的具体字段（不要泛泛而谈）
- **绝不**虚构或推断上下文里没有的指标
- 如果上下文中没有"本周计划"块，不要假装有计划参照
- 主要分析对象是"活动主数据"块；"背景信息"（InBody、4 周趋势、训练阶段）只在与本次训练直接相关时提及
- 不要用"很棒/不错"这种廉价鼓励，要像教练一样直接说到位
- 不要以"总体"、"总的来说"这类词收尾——结尾句本身就应当是结论
"""


# ============================================================================
# Context helpers
# ============================================================================

def get_athlete_profile(user: str) -> dict[str, Any] | None:
    """Load per-user profile from data/{user}/profile.json if present."""
    path = USER_DATA_DIR / user / "profile.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning("Failed to load profile for %s: %s", user, e)
        return None


# Matches either "4/27 — 6/21" (cross-month) or "4/20-26" (same month)
_PHASE_LINE_RE = re.compile(
    r"^\|\s*\**([^|*]+?)\**\s*\|\s*"
    r"\**(\d{1,2})/(\d{1,2})"
    r"\s*(?:[—\-~]|(?:\s-\s))\s*"
    r"(?:(\d{1,2})/)?(\d{1,2})\**"
)


def get_current_phase(user: str, activity_date: str) -> dict[str, Any] | None:
    """Parse TRAINING_PLAN.md for the phase matching activity_date.

    Matches the "时间线总览" table. Returns `{phase, start, end}` or None.
    Understands both cross-month (`4/27 — 6/21`) and same-month (`4/20-26`) ranges.
    """
    plan_path = USER_DATA_DIR / user / "TRAINING_PLAN.md"
    if not plan_path.exists():
        return None
    try:
        if "T" in activity_date:
            activity_dt = datetime.fromisoformat(activity_date.replace("Z", "+00:00"))
        elif len(activity_date) == 8:
            activity_dt = datetime.strptime(activity_date, "%Y%m%d")
        else:
            activity_dt = datetime.fromisoformat(activity_date)
        activity_d = activity_dt.astimezone(SHANGHAI_TZ).date() if activity_dt.tzinfo else activity_dt.date()
    except Exception:
        return None
    year = activity_d.year
    text = plan_path.read_text(encoding="utf-8", errors="ignore")
    in_timeline = False
    for line in text.splitlines():
        if "时间线总览" in line:
            in_timeline = True
            continue
        if in_timeline:
            if line.startswith("##"):
                break
            m = _PHASE_LINE_RE.match(line.strip())
            if m:
                label, sm, sd, em, ed = m.groups()
                try:
                    start = datetime(year, int(sm), int(sd)).date()
                    end_month = int(em) if em else int(sm)
                    end = datetime(year, end_month, int(ed)).date()
                    if start <= activity_d <= end:
                        return {"phase": label.strip(), "start": start.isoformat(), "end": end.isoformat()}
                except Exception:
                    continue
    return None


def get_week_plan_excerpt(user: str, activity_date: str) -> str | None:
    """Find the logs/<week>/plan.md whose folder date range covers activity_date.

    Returns the full plan.md content (it's already a weekly file, manageable size).
    """
    logs_dir = USER_DATA_DIR / user / "logs"
    if not logs_dir.exists():
        return None
    try:
        if "T" in activity_date:
            activity_dt = datetime.fromisoformat(activity_date.replace("Z", "+00:00"))
        elif len(activity_date) == 8:
            activity_dt = datetime.strptime(activity_date, "%Y%m%d")
        else:
            activity_dt = datetime.fromisoformat(activity_date)
        activity_d = activity_dt.astimezone(SHANGHAI_TZ).date() if activity_dt.tzinfo else activity_dt.date()
    except Exception:
        return None

    folder_re = re.compile(r"^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})")
    year = activity_d.year
    for folder in sorted(logs_dir.iterdir()):
        if not folder.is_dir():
            continue
        m = folder_re.match(folder.name)
        if not m:
            continue
        sy, sm, sd, em, ed = m.groups()
        try:
            start = datetime(int(sy), int(sm), int(sd)).date()
            end = datetime(int(sy) if int(em) >= int(sm) else int(sy) + 1, int(em), int(ed)).date()
            # Handle same-year wraps where end < start syntactically (rare)
            if end < start:
                end = datetime(int(sy), int(em), int(ed)).date()
            if start <= activity_d <= end:
                plan_md = folder / "plan.md"
                if plan_md.exists():
                    return plan_md.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
    return None


def downsample_timeseries(points: list[dict], target: int = 90) -> list[int | None]:
    """Return up to `target` HR values, evenly sampled from the timeseries.

    Input rows are dicts with heart_rate. We preserve None values where missing.
    """
    hrs = [p.get("heart_rate") for p in points]
    if len(hrs) <= target:
        return hrs
    step = len(hrs) / target
    out = []
    for i in range(target):
        idx = int(i * step)
        out.append(hrs[idx])
    return out


def get_prior_commentaries(
    db: Database, sport_type: int, current_label_id: str, limit: int = 2,
) -> list[dict[str, Any]]:
    rows = db.query(
        """SELECT a.label_id, a.date, a.name, ac.commentary
           FROM activity_commentary ac
           JOIN activities a ON a.label_id = ac.label_id
           WHERE a.sport_type = ? AND a.label_id != ?
           ORDER BY a.date DESC
           LIMIT ?""",
        (sport_type, current_label_id, limit),
    )
    return [dict(r) for r in rows]


def get_weekly_volume_trend(db: Database, weeks: int = 4) -> list[dict[str, Any]]:
    """Group run-type activities by ISO week (Shanghai time). Returns newest-first."""
    rows = db.query(
        f"""SELECT
                strftime('%Y-W%W', datetime(date, '+8 hours')) AS week,
                ROUND(SUM(distance_m), 1) AS km,
                COUNT(*) AS runs,
                ROUND(AVG(avg_hr), 0) AS avg_hr
            FROM activities
            WHERE date >= date('now', '-{weeks * 7 + 7} days')
              AND sport_name IN ('Run', 'Track Run', 'Indoor Run', 'Trail Run')
            GROUP BY week
            ORDER BY week DESC
            LIMIT ?""",
        (weeks,),
    )
    return [dict(r) for r in rows]


def get_latest_inbody(db: Database) -> dict[str, Any] | None:
    row = db.latest_inbody_scan()
    if row is None:
        return None
    scan = dict(row)
    segs = db.get_inbody_segments(scan["scan_date"])
    scan["segments"] = [dict(s) for s in segs]
    return scan


# ============================================================================
# Prompt builder
# ============================================================================

def _fmt_pace(sec_per_km: float | None) -> str:
    return pace_str(sec_per_km) or "—"


def _fmt_iso_shanghai(date_str: str | None) -> str:
    if not date_str:
        return "—"
    try:
        dt = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            return date_str
        return dt.astimezone(SHANGHAI_TZ).strftime("%Y-%m-%d %H:%M (CST)")
    except Exception:
        return date_str


def build_prompt(user: str, label_id: str, db: Database) -> list[dict[str, Any]]:
    """Assemble system + user messages. Raises LookupError if activity missing."""
    activity_rows = db.query("SELECT * FROM activities WHERE label_id = ?", (label_id,))
    if not activity_rows:
        raise LookupError(f"activity {label_id} not found")
    activity = dict(activity_rows[0])

    # 1. athlete profile
    profile = get_athlete_profile(user)

    # 2. training phase
    phase = get_current_phase(user, activity["date"])

    # 3. activity core — already have it

    # 4. zones
    zone_rows = db.query(
        "SELECT zone_type, zone_index, duration_s, percent FROM zones "
        "WHERE label_id = ? AND zone_type = 'heartRate' ORDER BY zone_index",
        (label_id,),
    )
    zones = [dict(z) for z in zone_rows]

    # 5. training laps (type2 only)
    lap_rows = db.query(
        "SELECT lap_index, distance_m, duration_s, avg_pace, avg_hr, max_hr "
        "FROM laps WHERE label_id = ? AND lap_type = 'type2' ORDER BY lap_index",
        (label_id,),
    )
    training_laps = [dict(l) for l in lap_rows]

    # 6. downsampled HR timeseries
    ts_rows = db.query(
        "SELECT heart_rate FROM timeseries WHERE label_id = ? ORDER BY rowid",
        (label_id,),
    )
    ts_points = [dict(t) for t in ts_rows]
    hr_series = downsample_timeseries(ts_points, target=90) if ts_points else None

    # 7. daily_health on activity date
    activity_ymd = activity["date"][:10] if activity["date"] and "T" in activity["date"] else activity["date"]
    try:
        activity_ymd_compact = activity_ymd.replace("-", "")
    except Exception:
        activity_ymd_compact = activity_ymd
    health_rows = db.query(
        "SELECT date, fatigue, ati, cti, rhr, training_load_ratio, training_load_state "
        "FROM daily_health WHERE date <= ? ORDER BY date DESC LIMIT 1",
        (activity_ymd_compact,),
    )
    health = dict(health_rows[0]) if health_rows else None
    if health and health.get("ati") is not None and health.get("cti") is not None:
        health["tsb"] = round(health["cti"] - health["ati"], 1)

    # 8. latest inbody
    inbody = get_latest_inbody(db)

    # 9. 4-week volume trend
    volume = get_weekly_volume_trend(db, weeks=4)

    # 10. plan.md excerpt
    plan = get_week_plan_excerpt(user, activity["date"])

    # 11. prior same-sport commentaries
    prior = get_prior_commentaries(db, activity["sport_type"], label_id, limit=2)

    # Assemble user message — activity FIRST for salience, background blocks last.
    lines: list[str] = []

    lines.append("# 本次活动数据（主要分析对象）")
    lines.append("")
    lines.append(f"- 日期：{_fmt_iso_shanghai(activity.get('date'))}")
    lines.append(f"- 名称：{activity.get('name') or '(无)'}")
    lines.append(f"- 运动类型：{sport_name(activity.get('sport_type', 0))}")
    if activity.get("distance_m"):
        lines.append(f"- 距离：{activity['distance_m']:.2f} km")
    if activity.get("duration_s"):
        mins = int(activity["duration_s"]) // 60
        secs = int(activity["duration_s"]) % 60
        lines.append(f"- 时长：{mins // 60}:{mins % 60:02d}:{secs:02d}")
    if activity.get("avg_pace_s_km"):
        lines.append(f"- 均配：{_fmt_pace(activity['avg_pace_s_km'])}")
    if activity.get("avg_hr"):
        lines.append(f"- 均 HR：{activity['avg_hr']}，max HR：{activity.get('max_hr') or '—'}")
    if activity.get("training_load") is not None:
        lines.append(f"- Training Load：{activity['training_load']}")
    if activity.get("vo2max"):
        lines.append(f"- VO2max：{activity['vo2max']}")
    if activity.get("aerobic_effect") is not None or activity.get("anaerobic_effect") is not None:
        lines.append(
            f"- Aerobic Effect：{activity.get('aerobic_effect', '—')} | "
            f"Anaerobic Effect：{activity.get('anaerobic_effect', '—')}"
        )
    if activity.get("temperature") is not None:
        lines.append(
            f"- 天气：{activity.get('temperature')}°C，湿度 "
            f"{activity.get('humidity', '—')}%，体感 {activity.get('feels_like', '—')}°C"
        )
    if activity.get("sport_note"):
        lines.append(f"- 用户训练反馈（sport_note）：{activity['sport_note']}")
    if activity.get("feel_type") is not None:
        feel_map = {1: "很好", 2: "好", 3: "一般", 4: "差", 5: "很差"}
        lines.append(f"- feel_type：{feel_map.get(activity['feel_type'], activity['feel_type'])}")

    lines.append("")
    lines.append("## 心率区间分布")
    if zones:
        for z in zones:
            if z.get("duration_s"):
                lines.append(
                    f"- Z{z['zone_index']}：{z['duration_s']}s（{z.get('percent', 0)}%）"
                )
    else:
        lines.append("- （无 zones 数据）")

    if training_laps:
        lines.append("")
        lines.append("## 训练分段（type2 laps，非 autoKm）")
        for l in training_laps:
            lines.append(
                f"- #{l['lap_index']}：{l.get('distance_m', 0):.2f} km，"
                f"{_fmt_pace(l.get('avg_pace'))}，HR {l.get('avg_hr', '—')}/{l.get('max_hr', '—')}"
            )

    if hr_series:
        lines.append("")
        lines.append("## HR 曲线（下采样 ~1 点/分钟）")
        lines.append(json.dumps([h for h in hr_series if h is not None]))

    lines.append("")
    lines.append("# 背景信息（辅助分析，非主角）")
    lines.append("")

    if profile:
        lines.append("## 运动员档案")
        for k, v in profile.items():
            lines.append(f"- {k}: {v}")
        lines.append("")

    if phase:
        lines.append("## 当前训练阶段")
        lines.append(f"- {phase['phase']}（{phase['start']} — {phase['end']}）")
        lines.append("")

    if health:
        lines.append("## 活动当日身体状态")
        parts = []
        if health.get("fatigue") is not None: parts.append(f"疲劳 {health['fatigue']}")
        if health.get("tsb") is not None: parts.append(f"TSB {health['tsb']:+}")
        if health.get("ati") is not None: parts.append(f"ATI {health['ati']}")
        if health.get("cti") is not None: parts.append(f"CTI {health['cti']}")
        if health.get("rhr") is not None: parts.append(f"RHR {health['rhr']}")
        if health.get("training_load_state"): parts.append(f"负荷状态 {health['training_load_state']}")
        if health.get("training_load_ratio") is not None: parts.append(f"负荷比 {health['training_load_ratio']}")
        lines.append("- " + "，".join(parts))
        lines.append("")

    if volume:
        lines.append("## 最近 4 周跑量（不含本次活动当日之后）")
        for v in volume:
            lines.append(f"- {v['week']}：{v['km']} km，{v['runs']} 次，avg HR {v.get('avg_hr', '—')}")
        lines.append("")

    if inbody:
        lines.append("## 最新 InBody 快照")
        lines.append(
            f"- {inbody['scan_date']}：体重 {inbody['weight_kg']} kg，"
            f"BF% {inbody['body_fat_pct']}，SMM {inbody['smm_kg']} kg，"
            f"内脏脂肪等级 {inbody['visceral_fat_level']}"
        )
        for s in inbody.get("segments", []):
            lines.append(
                f"  - {s['segment']}：lean {s['lean_mass_kg']} kg "
                f"({s.get('lean_pct_of_standard', '—')}%), fat {s['fat_mass_kg']} kg "
                f"({s.get('fat_pct_of_standard', '—')}%)"
            )
        lines.append("")

    if plan:
        lines.append("## 本周计划（plan.md 原文）")
        # Cap to 4000 chars to be safe on token budget
        if len(plan) > 4000:
            plan = plan[:4000] + "\n...[truncated]..."
        lines.append(plan)
        lines.append("")

    if prior:
        lines.append("## 近期同类活动 commentary（风格锚点）")
        for p in prior:
            lines.append(f"### {p.get('date', '—')} — {p.get('name') or '(无名)'}")
            lines.append(p.get("commentary") or "")
            lines.append("")

    user_message = "\n".join(lines)

    return [
        {
            "role": "system",
            "content": [
                {"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}
            ],
        },
        {"role": "user", "content": user_message},
    ]


# ============================================================================
# Generate + save
# ============================================================================

def generate_commentary(user: str, label_id: str, *, db: Database | None = None) -> str:
    """Make a single AOAI call, return the generated text.

    Raises AOAIUnavailable if feature is off / deps missing / env not set.
    Raises LookupError if activity not found.
    """
    client = get_client()
    deployment = get_deployment()
    owned = False
    if db is None:
        db = Database(user=user)
        owned = True
    try:
        messages = build_prompt(user, label_id, db)
    finally:
        if owned:
            db.close()

    response = client.chat.completions.create(
        model=deployment,
        messages=messages,
        temperature=0.6,
        max_tokens=600,
        timeout=45,
    )
    text = response.choices[0].message.content or ""
    return text.strip()


def regenerate_and_save(
    user: str, label_id: str, *, db: Database | None = None,
) -> dict[str, Any]:
    """Call AOAI and upsert the result. Returns the stored row dict.

    This is what the `/regenerate` endpoint and the sync hook both call.
    """
    text = generate_commentary(user, label_id, db=db)
    owned = False
    if db is None:
        db = Database(user=user)
        owned = True
    try:
        db.upsert_activity_commentary(label_id, text, generated_by=get_deployment())
        row = db.get_activity_commentary_row(label_id)
        return dict(row) if row else {"commentary": text}
    finally:
        if owned:
            db.close()


def maybe_generate_for_new_activity(user: str, label_id: str) -> None:
    """Fire-and-forget path called from sync.py.

    Skip silently if: AOAI disabled, commentary already exists, any error.
    Does not raise. Logs failures.
    """
    if not is_enabled():
        return
    try:
        db = Database(user=user)
        try:
            if db.activity_commentary_exists(label_id):
                logger.debug("commentary already exists for %s, skipping auto-gen", label_id)
                return
            regenerate_and_save(user, label_id, db=db)
            logger.info("AOAI auto-generated commentary for %s (user=%s)", label_id, user)
        finally:
            db.close()
    except AOAIUnavailable as e:
        logger.info("AOAI unavailable, skipping auto-gen for %s: %s", label_id, e)
    except Exception:
        logger.exception("AOAI auto-gen failed for %s (user=%s)", label_id, user)
