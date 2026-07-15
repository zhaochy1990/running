"""Pre-generation intake and history analysis for S1 master plans.

This module is adapter/server-side: it reads per-user JSON content and the
watch-synced SQLite DB, and optionally uses a cheap LLM role to extract
structured fields from a free-form athlete message. The master-plan generator
consumes the deterministic history block as extra prompt evidence before the
large S1 generation call.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import date as date_cls
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage

from coach.runtime.llm_factory import CoachLLMUnavailable
from coach.runtime.messages import extract_text
from stride_core.pb_records import (
    DISTANCE_ORDER,
    load_personal_bests,
    personal_bests_at_or_before,
)
from stride_core.timefmt import today_shanghai

from .content_store import read_json

logger = logging.getLogger(__name__)

_DISTANCE_TO_KEY = {"5K": "5k", "10K": "10k", "HM": "hm", "FM": "fm"}
_KEY_TO_DISTANCE = {value: key for key, value in _DISTANCE_TO_KEY.items()}
_RACE_DISTANCE_LABELS = {"5K": "5K", "10K": "10K", "HM": "半马", "FM": "全马"}
_RUNNING_AGES = {"lt_6m", "6m_1y", "1y_3y", "3y_plus"}
_WEEKLY_KM_BUCKETS = {"lt_20", "20_40", "40_60", "60_plus"}
_PB_DISTANCES = {"5K", "10K", "HM", "FM"}


def read_current_goal(user_id: str) -> dict[str, Any] | None:
    item = read_json(f"{user_id}/training_goal.json")
    if item is None:
        return None
    data, _ = item
    if isinstance(data, dict) and isinstance(data.get("current"), dict):
        return data["current"]
    return None


def read_current_profile(user_id: str) -> dict[str, Any] | None:
    item = read_json(f"{user_id}/running_profile.json")
    if item is None:
        return None
    data, _ = item
    if isinstance(data, dict) and isinstance(data.get("current"), dict):
        return data["current"]
    return None


def build_intake_context(user_id: str, *, as_of: date_cls | None = None) -> dict[str, Any]:
    """Return the deterministic intake state and historical race analysis."""
    as_of = as_of or today_shanghai()
    goal = read_current_goal(user_id)
    profile = read_current_profile(user_id)
    history = build_history_analysis(user_id, as_of=as_of)
    return {
        "goal": goal,
        "profile": profile,
        "history": history,
        "prompt_block": format_history_prompt_block(history),
    }


def build_history_analysis(user_id: str, *, as_of: date_cls | None = None) -> dict[str, Any]:
    """Analyze real PBs and recent race-like efforts from the synced DB.

    The DB may legitimately be empty before the user's first full sync. In that
    case the response still has stable keys and a clear `data_available=false`.
    """
    as_of = as_of or today_shanghai()
    empty = {
        "data_available": False,
        "as_of_date": as_of.isoformat(),
        "pbs": [],
        "recent_races": [],
        "summary": "尚未读取到手表历史比赛数据",
    }
    db = None
    try:
        from stride_storage.sqlite.database import Database

        db = Database(user=user_id)
        pb_map = personal_bests_at_or_before(load_personal_bests(db), as_of)
        pbs = _personal_bests_to_response(pb_map, as_of=as_of)
        races = [
            _race_row_to_response(row, as_of=as_of)
            for row in db.list_race_effort_activities(
                as_of_date=as_of.isoformat(),
                limit=6,
            )
        ]
        summary = _history_summary(pbs, races)
        return {
            "data_available": bool(pbs or races),
            "as_of_date": as_of.isoformat(),
            "pbs": pbs,
            "recent_races": races,
            "summary": summary,
        }
    except Exception as exc:  # noqa: BLE001 - intake must not block setup
        logger.warning("master_plan_intake history failed user=%s: %s", user_id, exc)
        return empty
    finally:
        if db is not None:
            try:
                db.close()
            except Exception:  # noqa: BLE001
                pass


def format_history_prompt_block(history: dict[str, Any] | None) -> str:
    """Render pre-generation race/PB analysis for the S1 user prompt."""
    if not history or not history.get("data_available"):
        return "Pre-generation race/PB analysis: no synced race/PB data available yet."
    lines = ["Pre-generation race/PB analysis (deterministic; use as evidence):"]
    pbs = history.get("pbs") or []
    if pbs:
        lines.append("- Real PB anchors from synced watch data:")
        for pb in pbs:
            age = pb.get("days_since")
            age_text = f", {age} days ago" if age is not None else ""
            lines.append(
                "  "
                f"{pb.get('distance')}: {pb.get('time')} on {pb.get('achieved_at')}"
                f"{age_text}; source={pb.get('source')}; activity={pb.get('activity_name') or 'unknown'}"
            )
    races = history.get("recent_races") or []
    if races:
        lines.append("- Recent race-like efforts:")
        for race in races[:4]:
            lines.append(
                "  "
                f"{race.get('date')} {race.get('name') or race.get('distance_label')}: "
                f"{race.get('distance_km')}km in {race.get('duration')} "
                f"({race.get('pace')}/km, HR {race.get('avg_hr') or 'n/a'}); "
                f"{race.get('days_since')} days ago"
            )
    lines.append(f"- Summary: {history.get('summary') or 'n/a'}")
    return "\n".join(lines)


def extract_intake_fields(message: str, context: dict[str, Any] | None = None) -> dict[str, Any]:
    """Use the cheap/orchestrator LLM role to extract intake fields.

    Raises CoachLLMUnavailable or provider exceptions to the route, which will
    render a graceful fallback. The returned payload is normalized and contains
    only fields with useful values.
    """
    system = """You extract structured running-plan intake fields from Chinese or English text.
Return strict JSON only. Supported keys:
race_name string, race_distance one of 5K/10K/HM/FM/trail, race_date YYYY-MM-DD,
target_finish_time H:MM:SS or null, weekly_training_days integer 3-6,
running_age one of lt_6m/6m_1y/1y_3y/3y_plus,
current_weekly_km one of lt_20/20_40/40_60/60_plus,
pb_distance one of 5K/10K/HM/FM, pb_time H:MM:SS, injuries array of short strings,
finish_only boolean or null, injury_free boolean or null.
Set finish_only=true only when the athlete explicitly says they only want to finish
or have no time goal. Set injury_free=true only when they explicitly say they have
no injuries. Use null for unknown values and do not invent facts."""
    compact_context = {
        "current_goal": (context or {}).get("goal"),
        "current_profile": (context or {}).get("profile"),
        "history_summary": ((context or {}).get("history") or {}).get("summary"),
    }
    user = json.dumps(
        {"message": message, "context": compact_context},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    llm = _get_lightweight_llm()
    raw = llm.invoke([SystemMessage(content=system), HumanMessage(content=user)])
    text = extract_text(getattr(raw, "content", raw)).strip()
    parsed = _parse_json_object(text)
    if not isinstance(parsed, dict):
        raise ValueError("intake_extract_parse_failed")
    return _normalise_extracted_fields(parsed)


def fallback_extract_intake_fields(message: str) -> dict[str, Any]:
    """Tiny deterministic extractor used when the lightweight LLM is absent."""
    text = message.strip()
    out: dict[str, Any] = {}
    dist = _normalise_distance(text)
    if dist:
        out["race_distance"] = dist
    date_match = re.search(r"(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})", text)
    if date_match:
        y, m, d = date_match.groups()
        out["race_date"] = f"{int(y):04d}-{int(m):02d}-{int(d):02d}"
    days_match = re.search(r"(?:每周|一周|周)[^0-9三四五六]{0,10}([3-6三四五六])\s*(?:天|次)", text)
    if days_match:
        out["weekly_training_days"] = _cn_digit(days_match.group(1))
    time_match = re.search(r"(?:sub[-\s]?)?(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?", text, re.I)
    if time_match:
        h, m, s = time_match.groups()
        out["target_finish_time"] = f"{int(h)}:{int(m):02d}:{int(s or 0):02d}"
    if _has_non_negated_match(
        text,
        r"仅(?:需|求)?完赛|只(?:要|求)?完赛|完赛即可|不设.{0,6}(?:成绩|时间)|finish[-\s]?only|no time goal",
    ):
        out["finish_only"] = True
    if _has_non_negated_match(
        text,
        r"没有(?:任何)?伤病|无伤病|injury[-\s]?free",
    ):
        out["injury_free"] = True
    return _normalise_extracted_fields(out)


def _has_non_negated_match(text: str, pattern: str) -> bool:
    for match in re.finditer(pattern, text, re.I):
        clause_start = max(
            text.rfind(mark, 0, match.start())
            for mark in ("。", "！", "？", ";", "；", ",", "，")
        )
        prefix = text[clause_start + 1:match.start()]
        if re.search(r"不|没|未|非|否|无|\bnot\b|n't\b", prefix, re.I):
            continue
        return True
    return False


def _get_lightweight_llm() -> Any:
    try:
        from .coach_runtime import get_orchestrator_llm

        return get_orchestrator_llm()
    except CoachLLMUnavailable:
        raise
    except Exception:
        logger.debug("orchestrator intake llm unavailable; trying commentary", exc_info=True)
        from .coach_runtime import get_commentary_llm

        return get_commentary_llm()


def _personal_bests_to_response(pb_map: dict[str, dict[str, Any]], *, as_of: date_cls) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for distance in DISTANCE_ORDER:
        if distance not in _DISTANCE_TO_KEY:
            continue
        entry = pb_map.get(distance)
        if not isinstance(entry, dict):
            continue
        seconds = _float_or_none(entry.get("pb_time_sec"))
        achieved_at = _date_or_none(entry.get("achieved_at"))
        rows.append({
            "distance": distance,
            "time": _format_seconds(seconds),
            "time_seconds": seconds,
            "achieved_at": achieved_at,
            "days_since": _days_since(achieved_at, as_of),
            "source": entry.get("source"),
            "label_id": entry.get("label_id"),
            "activity_name": entry.get("name"),
        })
    return rows


def _race_row_to_response(row: Any, *, as_of: date_cls) -> dict[str, Any]:
    distance_km = round(float(row["distance_m"] or 0.0) / 1000.0, 2)
    duration_s = _float_or_none(row["duration_s"])
    date_value = str(row["shanghai_date"] or "")[:10]
    return {
        "label_id": row["label_id"],
        "name": row["name"],
        "date": date_value,
        "days_since": _days_since(date_value, as_of),
        "distance_km": distance_km,
        "distance_label": _distance_label(distance_km),
        "duration": _format_seconds(duration_s),
        "duration_seconds": duration_s,
        "pace": _format_pace(row["avg_pace_s_km"] or _pace_from(distance_km, duration_s)),
        "avg_hr": row["avg_hr"],
        "max_hr": row["max_hr"],
        "training_load": row["training_load"],
        "train_kind": row["train_kind"],
    }


def _history_summary(pbs: list[dict[str, Any]], races: list[dict[str, Any]]) -> str:
    if not pbs and not races:
        return "尚未读取到手表历史比赛数据"
    bits: list[str] = []
    fm = next((pb for pb in pbs if pb.get("distance") == "FM"), None)
    hm = next((pb for pb in pbs if pb.get("distance") == "HM"), None)
    if fm:
        age = fm.get("days_since")
        bits.append(f"全马 PB {fm.get('time')}（{fm.get('achieved_at')}，距今 {age if age is not None else '?'} 天）")
    if hm:
        age = hm.get("days_since")
        bits.append(f"半马 PB {hm.get('time')}（{hm.get('achieved_at')}，距今 {age if age is not None else '?'} 天）")
    if races:
        r = races[0]
        bits.append(
            f"最近比赛样本 {r.get('date')} {r.get('distance_label')} "
            f"{r.get('duration')}，配速 {r.get('pace')}/km"
        )
    return "；".join(bits) if bits else "已有历史 PB/比赛数据，可作为目标现实性参考"


def _normalise_extracted_fields(data: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    race_name = data.get("race_name")
    if isinstance(race_name, str) and race_name.strip():
        out["race_name"] = race_name.strip()
    race_date = _normalise_iso_date(data.get("race_date"))
    if race_date is not None:
        out["race_date"] = race_date
    target_finish_time = _normalise_hms(
        data.get("target_finish_time"),
        allow_hour_minute=True,
    )
    if target_finish_time is not None:
        out["target_finish_time"] = target_finish_time
    pb_time = _normalise_hms(data.get("pb_time"))
    if pb_time is not None:
        out["pb_time"] = pb_time
    running_age = data.get("running_age")
    if isinstance(running_age, str) and running_age.strip() in _RUNNING_AGES:
        out["running_age"] = running_age.strip()
    current_weekly_km = data.get("current_weekly_km")
    if isinstance(current_weekly_km, str) and current_weekly_km.strip() in _WEEKLY_KM_BUCKETS:
        out["current_weekly_km"] = current_weekly_km.strip()
    pb_distance = data.get("pb_distance")
    if isinstance(pb_distance, str) and pb_distance.strip() in _PB_DISTANCES:
        out["pb_distance"] = pb_distance.strip()
    distance = data.get("race_distance")
    if isinstance(distance, str):
        dist = _normalise_distance(distance)
        if dist:
            out["race_distance"] = dist
    days = data.get("weekly_training_days")
    if isinstance(days, (int, float)) and 3 <= int(days) <= 6:
        out["weekly_training_days"] = int(days)
    injuries = data.get("injuries")
    if isinstance(injuries, list):
        clean = [str(item).strip() for item in injuries if str(item).strip()]
        if clean:
            out["injuries"] = clean[:6]
    if data.get("finish_only") is True:
        out["target_finish_time"] = None
    if data.get("injury_free") is True:
        out["injuries"] = ["none"]
    return out


def _normalise_iso_date(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        return date_cls.fromisoformat(value.strip()).isoformat()
    except ValueError:
        return None


def _normalise_hms(value: Any, *, allow_hour_minute: bool = False) -> str | None:
    if not isinstance(value, str):
        return None
    pattern = (
        r"(\d{1,2}):(\d{2})(?::(\d{2}))?"
        if allow_hour_minute
        else r"(\d{1,2}):(\d{2}):(\d{2})"
    )
    match = re.fullmatch(pattern, value.strip())
    if match is None:
        return None
    hours = int(match.group(1))
    minutes = int(match.group(2))
    seconds = int(match.group(3) or 0)
    if minutes >= 60 or seconds >= 60 or hours + minutes + seconds == 0:
        return None
    return f"{hours}:{minutes:02d}:{seconds:02d}"


def _normalise_distance(raw: str) -> str | None:
    text = raw.strip().lower()
    if any(token in text for token in ("半马", "半程", "half marathon", " hm")):
        return "HM"
    if any(token in text for token in ("全马", "全程", "马拉松", "marathon", " fm")):
        return "FM"
    if any(token in text for token in ("10k", "10 km", "10公里", "十公里")):
        return "10K"
    if any(token in text for token in ("5k", "5 km", "5公里", "五公里")):
        return "5K"
    if any(token in text for token in ("trail", "ultra", "越野")):
        return "trail"
    if text in {"5k", "5 km", "5公里"}:
        return "5K"
    if text in {"10k", "10 km", "10公里"}:
        return "10K"
    if text in {"hm", "half", "half marathon", "半马", "半程", "半程马拉松"}:
        return "HM"
    if text in {"fm", "full", "marathon", "全马", "马拉松", "全程马拉松"}:
        return "FM"
    if text in {"trail", "ultra", "越野"}:
        return "trail"
    return None


def _cn_digit(raw: str) -> int:
    mapped = {"三": 3, "四": 4, "五": 5, "六": 6}.get(raw)
    if mapped is not None:
        return mapped
    return int(raw)


def _parse_json_object(text: str) -> Any | None:
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    match = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass
    start = text.find("{")
    if start == -1:
        return None
    try:
        parsed, _ = json.JSONDecoder().raw_decode(text[start:])
        return parsed
    except json.JSONDecodeError:
        return None


def _format_seconds(value: float | None) -> str | None:
    if value is None or value <= 0:
        return None
    total = int(round(value))
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _format_pace(value: Any) -> str | None:
    seconds = _float_or_none(value)
    if seconds is None or seconds <= 0:
        return None
    total = int(round(seconds))
    return f"{total // 60}:{total % 60:02d}"


def _pace_from(distance_km: float, duration_s: float | None) -> float | None:
    if not duration_s or distance_km <= 0:
        return None
    return duration_s / distance_km


def _distance_label(distance_km: float) -> str:
    windows = (("5K", 4.8, 5.3), ("10K", 9.8, 10.5), ("HM", 20.8, 21.8), ("FM", 41.8, 43.5))
    for label, low, high in windows:
        if low <= distance_km <= high:
            return _RACE_DISTANCE_LABELS[label]
    return f"{distance_km:g}K"


def _float_or_none(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _date_or_none(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text[:10] if text else None


def _days_since(value: str | None, as_of: date_cls) -> int | None:
    if not value:
        return None
    try:
        days = (as_of - date_cls.fromisoformat(value[:10])).days
        return days if days >= 0 else None
    except ValueError:
        return None


__all__ = [
    "build_history_analysis",
    "build_intake_context",
    "extract_intake_fields",
    "fallback_extract_intake_fields",
    "format_history_prompt_block",
    "read_current_goal",
    "read_current_profile",
]
