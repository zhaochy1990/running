"""Assemble context, call Azure OpenAI (GPT-4.1), upsert commentary.

Context blocks (all fed on every call):
  1. 运动员档案 (static per-user config, optional)
  2. 当前训练阶段 (parsed from TRAINING_PLAN.md)
  3. 活动主数据 (activities table + weather + sport_note)
  4. 心率区间分布 (zones table)
  5. 训练分段 (laps lap_type='type2')
  6. HR 曲线下采样 (timeseries → 1 point/min)
  7. 活动当日 daily_health 快照 (fatigue / TSB / RHR)
  7b. 个体基线 (LTHR / max HR, RunningCalibrationRepository — single source)
  8. 最新身体成分快照 (body_composition_scan latest)
  9. 最近 4 周跑量趋势 (activities aggregated by week)
 10. 本周计划 plan.md 节选 (logs/<week>/plan.md)
 11. 同类活动近期 commentary (activity_commentary by sport_type)

All context comes from the local DB + filesystem — no extra COROS API calls.
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from coach.runtime.llm_factory import CoachLLMUnavailable
from coach.runtime.messages import extract_text
from coach.schemas import CommentaryPromptContext
from coach.skills import render_fragment, render_skill
from stride_core.db import USER_DATA_DIR, Database
from stride_core.models import pace_str, sport_name
from stride_core.timefmt import utc_iso_to_shanghai_iso

from .content_store import list_week_folders as content_week_folders
from .content_store import read_json as read_content_json
from .content_store import read_text as read_content_text

logger = logging.getLogger(__name__)


# Back-compat alias — historical callers (`routes/activities.py`,
# `coros_sync/sync.py`) imported ``AOAIUnavailable`` from the old
# ``aoai_client`` sibling. After consolidation to coach.runtime the
# canonical exception is ``CoachLLMUnavailable``; the alias keeps the
# call-sites stable.
AOAIUnavailable = CoachLLMUnavailable


def is_enabled() -> bool:
    """Feature flag for activity-commentary auto-gen.

    Preserves the legacy ``AOAI_COMMENTARY_ENABLED`` env semantics so dev
    boxes that never set it stay silent. When ``True``, the actual LLM call
    can still fail with :class:`CoachLLMUnavailable` if
    ``config/coach.toml`` ``[commentary]`` is a placeholder.
    """
    return os.environ.get("AOAI_COMMENTARY_ENABLED", "").lower() == "true"


def get_deployment() -> str:
    """Return the commentary deployment id for the ``generated_by`` DB stamp.

    Sourced from ``config/coach.toml`` ``[commentary].deployment`` so dev /
    prod can swap deployments without touching code.
    """
    from coach.runtime.config import load_config

    return load_config().commentary.deployment

SHANGHAI_TZ = timezone(timedelta(hours=8))


# ============================================================================
# System prompt — the static doctrine now lives in the coach `commentary`
# skill (coach/skills/commentary/SKILL.md), mirroring S1/S2/S3. Rendered once
# with an empty context (zero ${...} placeholders → byte-identical across all
# calls, so the Azure prompt-cache prefix stays warm). Exposed as SYSTEM_PROMPT
# for the adapter + the prompt-invariant tests.
# ============================================================================

SYSTEM_PROMPT = render_skill("commentary", {})


# ============================================================================
# Context helpers
# ============================================================================

def get_athlete_profile(user: str) -> dict[str, Any] | None:
    """Load per-user profile from Blob or data/{user_id}/profile.json if present."""
    item = read_content_json(f"{user}/profile.json")
    if item is not None:
        data, source = item
        if isinstance(data, dict):
            logger.info("commentary profile read for %s source=%s", user, source)
            return data
        logger.warning("Profile for %s is not a JSON object (source=%s)", user, source)
        return None

    path = USER_DATA_DIR / user / "profile.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        logger.warning("Failed to load profile for %s: %s", user, e)
        return None


def _read_user_text(user: str, relative_path: str) -> str | None:
    item = read_content_text(f"{user}/{relative_path}")
    if item is not None:
        return item.content

    path = USER_DATA_DIR / user / relative_path
    if not path.exists():
        return None
    return path.read_text(encoding="utf-8")


def _list_user_week_folders(user: str) -> list[str]:
    folders = set(content_week_folders(user))
    logs_dir = USER_DATA_DIR / user / "logs"
    if logs_dir.exists():
        folders.update(d.name for d in logs_dir.iterdir() if d.is_dir())
    return sorted(folders, reverse=True)


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
    text = _read_user_text(user, "TRAINING_PLAN.md")
    if text is None:
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
    for folder_name in sorted(_list_user_week_folders(user)):
        m = folder_re.match(folder_name)
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
                text = _read_user_text(user, f"logs/{folder_name}/plan.md")
                if text is not None:
                    return text
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
    row = db.latest_body_composition_scan()
    if row is None:
        return None
    scan = dict(row)
    segs = db.get_body_composition_segments(scan["scan_date"])
    scan["segments"] = [dict(s) for s in segs]
    return scan


def get_calibration_baseline(db: Database, as_of_ymd: str | None) -> dict[str, Any] | None:
    """Athlete HR baselines (LTHR, max HR) from the canonical calibration reader.

    Single source per CLAUDE.md "Athlete baseline metrics" rule — read via
    ``RunningCalibrationRepository.fetch_latest``, never inline-recomputed or
    parsed from profile free-text. ``as_of_ymd`` (``YYYY-MM-DD``) scopes to the
    calibration that was current on the activity date. Returns ``None`` for new
    users with no snapshot yet (the prompt then falls back to Z5/Z6 only).
    """
    try:
        from stride_core.running_calibration.sqlite_connector import (
            SQLiteRunningCalibrationRepository,
        )

        as_of = date.fromisoformat(as_of_ymd[:10]) if as_of_ymd and len(as_of_ymd) >= 10 else None
        snap = SQLiteRunningCalibrationRepository(db).fetch_latest(as_of_date=as_of)
    except Exception as e:  # noqa: BLE001
        # A new user / empty table returns None *without* raising; reaching here
        # means a real fault (schema drift, fetch bug). Log it like the sibling
        # calibration consumers instead of silently dropping the baseline block.
        logger.warning("commentary calibration fetch failed: %s", e, exc_info=True)
        return None
    if snap is None:
        return None
    out: dict[str, Any] = {}
    if snap.threshold_hr is not None:
        out["threshold_hr"] = round(snap.threshold_hr)
        # CalibrationConfidence is a str-Enum; .value is the canonical label.
        # Suppress the noisy/uninformative "none" level.
        conf = getattr(snap.threshold_hr_confidence, "value", None)
        if conf and conf != "none":
            out["threshold_hr_confidence"] = conf
    max_hr = snap.observed_max_hr or snap.hrmax_estimate
    if max_hr is not None:
        out["max_hr"] = round(max_hr)
    return out or None


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

    # 7. daily_health on activity date. daily_health.date is Shanghai-local
    # YYYYMMDD, so key off the Shanghai-local activity day (timezone-discipline
    # HARD rule) — a raw-UTC slice mis-picks the prior day for 00:00-07:59 CST.
    # This same Shanghai day also scopes the calibration as-of below.
    activity_ymd = (utc_iso_to_shanghai_iso(activity.get("date")) or (activity.get("date") or ""))[:10]
    activity_ymd_compact = activity_ymd.replace("-", "")
    health_rows = db.query(
        "SELECT date, fatigue, ati, cti, rhr, training_load_ratio, training_load_state "
        "FROM daily_health WHERE date <= ? ORDER BY date DESC LIMIT 1",
        (activity_ymd_compact,),
    )
    health = dict(health_rows[0]) if health_rows else None
    if health and health.get("ati") is not None and health.get("cti") is not None:
        health["tsb"] = round(health["cti"] - health["ati"], 1)

    # 7b. athlete HR baselines (LTHR / max HR) — canonical calibration reader,
    # scoped to the same Shanghai-local activity day.
    calibration = get_calibration_baseline(db, activity_ymd or None)

    # 8. latest inbody
    inbody = get_latest_inbody(db)

    # 9. 4-week volume trend
    volume = get_weekly_volume_trend(db, weeks=4)

    # 10. plan.md excerpt
    plan = get_week_plan_excerpt(user, activity["date"])

    # 11. prior same-sport commentaries
    prior = get_prior_commentaries(db, activity["sport_type"], label_id, limit=2)

    # ----- Assemble the per-activity context for the `commentary` skill's
    # user_prompt.md. The static doctrine lives in SYSTEM_PROMPT (the skill);
    # here we build only the variable blocks the template injects. Activity
    # block FIRST for salience, background block last.
    now_cst = datetime.now(tz=SHANGHAI_TZ)
    now_cst_str = now_cst.strftime("%Y-%m-%d (%A) %H:%M CST")

    # Days-since-activity line (lets the model pick foresight vs retrospective).
    days_ago_line = ""
    try:
        act_date_str = activity.get("date", "")
        if "T" in act_date_str:
            act_dt = datetime.fromisoformat(act_date_str.replace("Z", "+00:00"))
        elif len(act_date_str) == 8:
            act_dt = datetime.strptime(act_date_str, "%Y%m%d").replace(tzinfo=SHANGHAI_TZ)
        else:
            act_dt = datetime.fromisoformat(act_date_str).replace(tzinfo=SHANGHAI_TZ)
        days_ago = (now_cst.date() - act_dt.astimezone(SHANGHAI_TZ).date()).days
        if days_ago == 0:
            days_ago_line = "- 本次活动发生于**今天**"
        elif days_ago == 1:
            days_ago_line = "- 本次活动发生于**昨天**"
        else:
            days_ago_line = (
                f"- 本次活动距今 **{days_ago} 天**"
                f"（活动日：{act_dt.astimezone(SHANGHAI_TZ).strftime('%Y-%m-%d')}）"
            )
    except Exception:
        pass

    # ----- Activity block: core metrics + HR zones + training laps + HR curve.
    act: list[str] = []
    act.append(f"- 日期：{_fmt_iso_shanghai(activity.get('date'))}")
    act.append(f"- 名称：{activity.get('name') or '(无)'}")
    act.append(f"- 运动类型：{sport_name(activity.get('sport_type', 0))}")
    if activity.get("distance_m"):
        act.append(f"- 距离：{activity['distance_m']:.2f} km")
    if activity.get("duration_s"):
        mins = int(activity["duration_s"]) // 60
        secs = int(activity["duration_s"]) % 60
        act.append(f"- 时长：{mins // 60}:{mins % 60:02d}:{secs:02d}")
    if activity.get("avg_pace_s_km"):
        act.append(f"- 均配：{_fmt_pace(activity['avg_pace_s_km'])}")
    if activity.get("avg_hr"):
        act.append(f"- 均 HR：{activity['avg_hr']}，max HR：{activity.get('max_hr') or '—'}")
    if activity.get("training_load") is not None:
        act.append(f"- Training Load：{activity['training_load']}")
    if activity.get("vo2max"):
        act.append(f"- VO2max：{activity['vo2max']}")
    if activity.get("aerobic_effect") is not None or activity.get("anaerobic_effect") is not None:
        act.append(
            f"- Aerobic Effect：{activity.get('aerobic_effect', '—')} | "
            f"Anaerobic Effect：{activity.get('anaerobic_effect', '—')}"
        )
    if activity.get("temperature") is not None:
        act.append(
            f"- 天气：{activity.get('temperature')}°C，湿度 "
            f"{activity.get('humidity', '—')}%，体感 {activity.get('feels_like', '—')}°C"
        )
    if activity.get("sport_note"):
        act.append(f"- 用户训练反馈（sport_note）：{activity['sport_note']}")
    if activity.get("feel_type") is not None:
        feel_map = {1: "很好", 2: "好", 3: "一般", 4: "差", 5: "很差"}
        act.append(f"- feel_type：{feel_map.get(activity['feel_type'], activity['feel_type'])}")

    act.append("")
    act.append("## 心率区间分布")
    if zones:
        for z in zones:
            if z.get("duration_s"):
                act.append(f"- Z{z['zone_index']}：{z['duration_s']}s（{z.get('percent', 0)}%）")
    else:
        act.append("- （无 zones 数据）")

    if training_laps:
        act.append("")
        act.append("## 训练分段（type2 laps，非 autoKm）")
        for l in training_laps:
            act.append(
                f"- #{l['lap_index']}：{l.get('distance_m', 0):.2f} km，"
                f"{_fmt_pace(l.get('avg_pace'))}，HR {l.get('avg_hr', '—')}/{l.get('max_hr', '—')}"
            )

    if hr_series:
        act.append("")
        act.append("## HR 曲线（下采样 ~1 点/分钟）")
        act.append(json.dumps([h for h in hr_series if h is not None]))

    # ----- Background block: profile / phase / daily-health / calibration /
    # body-composition / 4-week volume / weekly-plan excerpt / prior commentary.
    bg: list[str] = []
    if profile:
        bg.append("## 运动员档案")
        for k, v in profile.items():
            bg.append(f"- {k}: {v}")
        bg.append("")

    if phase:
        bg.append("## 当前训练阶段")
        bg.append(f"- {phase['phase']}（{phase['start']} — {phase['end']}）")
        bg.append("")

    if health:
        bg.append("## 活动当日身体状态")
        parts = []
        if health.get("fatigue") is not None: parts.append(f"疲劳 {health['fatigue']}")
        if health.get("tsb") is not None: parts.append(f"TSB {health['tsb']:+}")
        if health.get("ati") is not None: parts.append(f"ATI {health['ati']}")
        if health.get("cti") is not None: parts.append(f"CTI {health['cti']}")
        if health.get("rhr") is not None: parts.append(f"RHR {health['rhr']}")
        if health.get("training_load_state"): parts.append(f"负荷状态 {health['training_load_state']}")
        if health.get("training_load_ratio") is not None: parts.append(f"负荷比 {health['training_load_ratio']}")
        bg.append("- " + "，".join(parts))
        bg.append("")

    if calibration:
        bg.append("## 个体基线（来自校准，单一可信源）")
        cparts = []
        if calibration.get("threshold_hr") is not None:
            c = f"阈值 HR (LTHR) {calibration['threshold_hr']}"
            if calibration.get("threshold_hr_confidence"):
                c += f"（置信度 {calibration['threshold_hr_confidence']}）"
            cparts.append(c)
        if calibration.get("max_hr") is not None:
            cparts.append(f"max HR {calibration['max_hr']}")
        if cparts:
            bg.append("- " + "，".join(cparts))
        bg.append("")

    if volume:
        bg.append("## 最近 4 周跑量（不含本次活动当日之后）")
        for v in volume:
            bg.append(f"- {v['week']}：{v['km']} km，{v['runs']} 次，avg HR {v.get('avg_hr', '—')}")
        bg.append("")

    if inbody:
        bg.append("## 最新体测快照")
        bg.append(
            f"- {inbody['scan_date']}：体重 {inbody['weight_kg']} kg，"
            f"BF% {inbody['body_fat_pct']}，SMM {inbody['smm_kg']} kg，"
            f"内脏脂肪等级 {inbody['visceral_fat_level']}"
        )
        for sg in inbody.get("segments", []):
            bg.append(
                f"  - {sg['segment']}：lean {sg['lean_mass_kg']} kg "
                f"({sg.get('lean_pct_of_standard', '—')}%), fat {sg['fat_mass_kg']} kg "
                f"({sg.get('fat_pct_of_standard', '—')}%)"
            )
        bg.append("")

    if plan:
        bg.append("## 本周计划（plan.md 原文）")
        # Cap to 4000 chars to be safe on token budget
        if len(plan) > 4000:
            plan = plan[:4000] + "\n...[truncated]..."
        bg.append(plan)
        bg.append("")

    if prior:
        bg.append("## 近期同类活动 commentary（风格锚点）")
        for pc in prior:
            bg.append(f"### {pc.get('date', '—')} — {pc.get('name') or '(无名)'}")
            bg.append(pc.get("commentary") or "")
            bg.append("")

    ctx = CommentaryPromptContext(
        now_cst=now_cst_str,
        days_ago_line=days_ago_line,
        activity_block="\n".join(act),
        background_block="\n".join(bg).rstrip(),
    )
    user_message = render_fragment("commentary/user_prompt.md", ctx.model_dump())

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
    """Make a single LLM call, return the generated text.

    Raises ``CoachLLMUnavailable`` if feature is off / deps missing /
    ``coach.toml`` misconfigured. Raises ``LookupError`` if activity not found.

    Uses ``coach.runtime.get_commentary_llm()`` so the role-to-model binding
    is driven by ``config/coach.toml``. The system-message ``cache_control``
    block is preserved by passing ``content=list[dict]`` to
    ``SystemMessage`` — langchain ``AzureChatOpenAI`` forwards content blocks
    as-is, so Azure prompt-cache hit rate is unchanged.
    """
    if not is_enabled():
        raise CoachLLMUnavailable("AOAI_COMMENTARY_ENABLED is not 'true'")

    # Lazy import keeps module load free of coach.runtime singletons.
    from .coach_runtime import get_commentary_llm

    llm = get_commentary_llm()
    owned = False
    if db is None:
        db = Database(user=user)
        owned = True
    try:
        messages = build_prompt(user, label_id, db)
    finally:
        if owned:
            db.close()

    # Convert OpenAI dict messages → langchain. Content can be ``str`` (user
    # message) or ``list[dict]`` with ``cache_control`` blocks (system message).
    lc_messages = []
    for m in messages:
        content = m["content"]
        if m["role"] == "system":
            lc_messages.append(SystemMessage(content=content))
        else:
            lc_messages.append(HumanMessage(content=content))

    resp = llm.invoke(lc_messages)
    text = extract_text(getattr(resp, "content", resp))
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
