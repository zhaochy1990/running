from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any

from stride_core.timefmt import today_shanghai
from stride_storage.interfaces.season_plan import CanonicalSeasonPlanDataUnavailable

CONTRACT_VERSION = "mysql-season-plan-context-v1"
_RUN_TYPES = (100, 101, 102, 103, 104, 600, 601, 8001, 8002, 8003, 8004, 8005)
_COVERAGE = ("complete", "partial", "rest_confirmed")
_SHANGHAI = timezone(timedelta(hours=8))
CANONICAL_MYSQL_PROBE_SQL = "SELECT 1 AS ready"


def probe_canonical_mysql(engine: Any) -> None:
    """Run the read-only connectivity probe for the canonical MySQL reader."""
    try:
        try:
            from sqlalchemy import text
        except ImportError:
            text = lambda value: value  # type: ignore[assignment]
        with engine.connect() as connection:
            connection.execute(text(CANONICAL_MYSQL_PROBE_SQL))
    except Exception as exc:  # noqa: BLE001 — normalize external DB boundary
        raise CanonicalSeasonPlanDataUnavailable(
            "canonical MySQL season-plan reader is unavailable"
        ) from exc


def _day(value: Any) -> date | None:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(_SHANGHAI).date()
    if isinstance(value, date):
        return value
    raw = str(value or "")
    for fmt in ("%Y-%m-%d", "%Y%m%d"):
        try:
            return datetime.strptime(raw[:10] if fmt == "%Y-%m-%d" else raw[:8], fmt).date()
        except ValueError:
            pass
    return None


def _monday(value: date) -> date:
    return value - timedelta(days=value.weekday())


def _num(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _seconds(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value) if value > 0 else None
    if not isinstance(value, str):
        return None
    bits = value.strip().split(":")
    try:
        values = [float(bit) for bit in bits]
    except ValueError:
        return None
    if len(values) == 2:
        h, m, s = 0.0, values[0], values[1]
    elif len(values) == 3:
        h, m, s = values
    else:
        return None
    return h * 3600 + m * 60 + s if m < 60 and s < 60 else None


class MySQLSeasonPlanReader:
    contract_version = CONTRACT_VERSION

    def __init__(self, engine: Any) -> None:
        self._engine = engine

    def _rows(self, sql: str, **params: Any) -> list[dict[str, Any]]:
        try:
            try:
                from sqlalchemy import text
            except ImportError:
                text = lambda value: value  # type: ignore[assignment]
            with self._engine.connect() as connection:
                result = connection.execute(text(sql), params)
                return [dict(row) for row in result.mappings().all()]
        except Exception as exc:  # noqa: BLE001 — normalize external DB boundary
            raise CanonicalSeasonPlanDataUnavailable("canonical MySQL season-plan context is unavailable") from exc

    def _one(self, sql: str, **params: Any) -> dict[str, Any] | None:
        rows = self._rows(sql, **params)
        return rows[0] if rows else None

    def read_goal(self, user_id: str, *, goal_id: str | None = None) -> dict[str, Any] | None:
        where = "user_id = :user_id AND status = 'active'"
        params: dict[str, Any] = {"user_id": user_id}
        if goal_id:
            where += " AND goal_id = :goal_id"
            params["goal_id"] = goal_id
        row = self._one(f"SELECT goal_id, race_date, race_distance, race_name, target_finish_time, weekly_training_days, available_time_slots, strength_willingness, race_location, race_timezone FROM race_goal WHERE {where} LIMIT 1", **params)
        if row is None:
            return None
        goal = {"goal_id": str(row["goal_id"]), "id": str(row["goal_id"]), "type": "race", "race_date": row.get("race_date"), "race_distance": row.get("race_distance"), "race_name": row.get("race_name"), "target_finish_time": row.get("target_finish_time"), "weekly_training_days": row.get("weekly_training_days"), "available_time_slots": row.get("available_time_slots") or [], "strength_willingness": row.get("strength_willingness"), "location": row.get("race_location"), "timezone": row.get("race_timezone") or "Asia/Shanghai"}
        goal["goal_time_s"] = _seconds(goal.get("target_finish_time"))
        goal["distance"] = {"5K": "5k", "10K": "10k", "HM": "hm", "FM": "fm", "trail": "ultra"}.get(str(goal.get("race_distance")), str(goal.get("race_distance") or "").lower())
        return goal

    def read(self, user_id: str, *, goal_id: str | None = None, as_of: date | None = None) -> dict[str, Any]:
        as_of = as_of or today_shanghai()
        goal = self.read_goal(user_id, goal_id=goal_id)
        if goal is None:
            raise CanonicalSeasonPlanDataUnavailable("canonical race goal not found")
        profile = self._one("SELECT display_name, dob, sex, height_cm, weight_kg FROM user_profile WHERE user_id = :user_id LIMIT 1", user_id=user_id) or {}
        profile = {key: value for key, value in profile.items() if value is not None}
        profile.update({"weekly_training_days": goal.get("weekly_training_days"), "weekly_run_days_max": goal.get("weekly_training_days")})
        ids = ",".join(map(str, _RUN_TYPES))
        activities = self._rows(f"SELECT label_id, name, sport_type, date, distance_m, duration_s, avg_hr, train_kind, train_type, sport, provider FROM activities WHERE user_id = :user_id AND sport_type IN ({ids}) AND DATE(date + INTERVAL 8 HOUR) <= :as_of ORDER BY date, label_id", user_id=user_id, as_of=as_of.isoformat())
        health = [row for row in self._rows("SELECT date, rhr, sleep_total_s, provider FROM daily_health WHERE user_id = :user_id ORDER BY date", user_id=user_id) if (_day(row.get("date")) or date.min) <= as_of]
        hrv = [row for row in self._rows("SELECT date, provider, last_night_avg, weekly_avg FROM daily_hrv WHERE user_id = :user_id ORDER BY date", user_id=user_id) if (_day(row.get("date")) or date.min) <= as_of]
        loads = self._rows("SELECT date, training_dose, acute_load, chronic_load, form, load_ratio, coverage_status, algorithm_version FROM daily_training_load WHERE user_id = :user_id AND date <= :as_of ORDER BY date", user_id=user_id, as_of=as_of.isoformat())
        calibration = self._one("SELECT id, as_of_date, threshold_hr, threshold_speed_mps, rhr_baseline, observed_max_hr, hrmax_estimate, high_hr_reference, critical_power_w, critical_speed_mps, d_prime_m, riegel_k, endurance_index, speed_index, threshold_hr_confidence, threshold_speed_confidence, hrmax_confidence, speed_duration_confidence, source_json FROM running_calibration_snapshot WHERE user_id = :user_id AND as_of_date <= :as_of ORDER BY as_of_date DESC, id DESC LIMIT 1", user_id=user_id, as_of=as_of.isoformat())
        if calibration is None:
            raise CanonicalSeasonPlanDataUnavailable("canonical running calibration snapshot is unavailable")
        pbs = self._rows("SELECT distance, pb_time_sec FROM personal_bests WHERE user_id = :user_id ORDER BY distance", user_id=user_id)
        pb_seconds = {"5K": "5k", "10K": "10k", "HM": "hm", "FM": "fm"}
        pb_seconds = {pb_seconds[row["distance"]]: float(row["pb_time_sec"]) for row in pbs if row.get("distance") in pb_seconds}
        history = self._history(activities, health, hrv, loads, calibration)
        fitness = self._fitness(health, hrv, loads, calibration)
        return {"contract_version": CONTRACT_VERSION, "goal": goal, "profile": profile, "history": history, "fitness_state": fitness, "pb_seconds": pb_seconds, "calibration": calibration, "body_composition": self._body(profile), "continuity": self._continuity(activities, loads, as_of)}

    def _history(self, activities: list[dict[str, Any]], health: list[dict[str, Any]], hrv: list[dict[str, Any]], loads: list[dict[str, Any]], calibration: dict[str, Any]) -> dict[str, Any]:
        buckets: dict[date, dict[str, Any]] = {}
        for row in activities:
            day = _day(row.get("date"))
            if day is None: continue
            item = buckets.setdefault(_monday(day), {"week_start": _monday(day).isoformat(), "distance_km": 0.0, "hours": 0.0, "avg_pace_s_km": None, "avg_hr": None, "ctl": None, "atl": None, "training_load_ratio": None, "form": None, "dose": 0.0, "dose_coverage_status": None, "rhr": None, "hrv": None, "n_runs": 0, "n_long": 0, "n_speed": 0, "n_race": 0})
            km = (_num(row.get("distance_m")) or 0) / 1000
            duration = _num(row.get("duration_s")) or 0
            item["distance_km"] += km; item["hours"] += duration / 3600; item["n_runs"] += 1
            item["n_long"] += int(km >= 20)
            item["n_speed"] += int(str(row.get("train_kind") or "").lower() in {"interval", "threshold", "vo2max", "anaerobic"})
            item["n_race"] += int(str(row.get("train_kind") or "").lower() == "race")
            if duration and row.get("avg_hr") is not None:
                item["_hr"] = item.get("_hr", 0) + float(row["avg_hr"]) * duration; item["_hr_d"] = item.get("_hr_d", 0) + duration
        for row in loads:
            day = _day(row.get("date"))
            if day is None: continue
            item = buckets.setdefault(_monday(day), {"week_start": _monday(day).isoformat(), "distance_km": 0.0, "hours": 0.0, "avg_pace_s_km": None, "avg_hr": None, "ctl": None, "atl": None, "training_load_ratio": None, "form": None, "dose": 0.0, "dose_coverage_status": None, "rhr": None, "hrv": None, "n_runs": 0, "n_long": 0, "n_speed": 0, "n_race": 0})
            if row.get("coverage_status") in _COVERAGE:
                item["dose"] += _num(row.get("training_dose")) or 0; item["dose_coverage_status"] = "partial" if row.get("coverage_status") == "partial" else item["dose_coverage_status"] or "complete"
            item["ctl"] = _num(row.get("chronic_load")); item["atl"] = _num(row.get("acute_load")); item["form"] = _num(row.get("form")); item["training_load_ratio"] = _num(row.get("load_ratio"))
        for row in health:
            day = _day(row.get("date"))
            if day is not None and row.get("rhr") is not None: buckets.setdefault(_monday(day), {"week_start": _monday(day).isoformat()})["rhr"] = _num(row.get("rhr"))
        for row in hrv:
            day = _day(row.get("date"))
            if day is not None and row.get("last_night_avg") is not None: buckets.setdefault(_monday(day), {"week_start": _monday(day).isoformat()})["hrv"] = _num(row.get("last_night_avg"))
        for item in buckets.values():
            if item.get("distance_km"): item["avg_pace_s_km"] = item["hours"] * 3600 / item["distance_km"]
            if item.get("_hr_d"): item["avg_hr"] = item["_hr"] / item["_hr_d"]
            item.pop("_hr", None); item.pop("_hr_d", None)
        ordered = sorted(buckets.values(), key=lambda item: item["week_start"])[-16:]
        return {"monthly_km": [], "max_weekly_km": round(max((item.get("distance_km", 0) for item in ordered), default=0), 1), "total_activities": len(activities), "weekly_profile": ordered, "threshold_speed_mps": _num(calibration.get("threshold_speed_mps"))}

    def _fitness(self, health: list[dict[str, Any]], hrv: list[dict[str, Any]], loads: list[dict[str, Any]], calibration: dict[str, Any]) -> dict[str, Any]:
        valid = [row for row in loads if row.get("coverage_status") in _COVERAGE]; latest = valid[-1] if valid else {}
        rhr = _num(calibration.get("rhr_baseline")) or next((_num(row.get("rhr")) for row in reversed(health) if row.get("rhr") is not None), None)
        hrv_value = next((_num(row.get("last_night_avg")) for row in reversed(hrv) if row.get("last_night_avg") is not None), None)
        ctl = _num(latest.get("chronic_load")); atl = _num(latest.get("acute_load")); form = _num(latest.get("form"))
        return {"ctl": ctl, "atl": atl, "tsb": form, "rhr": rhr, "hrv": hrv_value, "hrv_date": next((row.get("date") for row in reversed(hrv) if row.get("last_night_avg") is not None), None), "training_load_ratio": _num(latest.get("load_ratio")), "summary": "体能数据暂无"}

    def _body(self, profile: dict[str, Any]) -> dict[str, Any] | None:
        weight = _num(profile.get("weight_kg")); height = _num(profile.get("height_cm"))
        if weight is None: return None
        bmi = round(weight / ((height / 100) ** 2), 2) if height and height > 0 else None
        return {"scan_date": None, "weight_kg": weight, "body_fat_pct": None, "smm_kg": None, "fat_mass_kg": None, "bmr_kcal": None, "bmi": bmi}

    def _continuity(self, activities: list[dict[str, Any]], loads: list[dict[str, Any]], as_of: date) -> dict[str, Any]:
        weeks: defaultdict[date, float] = defaultdict(float); longest = 0.0; last_race: date | None = None
        for row in activities:
            day = _day(row.get("date"))
            if day is None: continue
            km = (_num(row.get("distance_m")) or 0) / 1000; weeks[_monday(day)] += km; longest = max(longest, km)
            if str(row.get("train_kind") or "").lower() == "race": last_race = max(last_race or day, day)
        valid = [row for row in loads if row.get("coverage_status") in _COVERAGE]; latest = valid[-1] if valid else {}; ctl = _num(latest.get("chronic_load")); atl = _num(latest.get("acute_load")); ratio = atl / ctl if ctl else None
        zone = "减量过多" if ratio is not None and ratio < .75 else "比赛就绪" if ratio is not None and ratio < .9 else "维持期" if ratio is not None and ratio <= 1.1 else "提升期" if ratio is not None and ratio <= 1.25 else "过度负荷" if ratio is not None else None
        return {"days_since_last_race": (as_of-last_race).days if last_race else None, "post_race_recovery_status": "no_recent_race" if not last_race else "recovered" if (as_of-last_race).days >= 21 else "recovering", "recent_aerobic_weeks": sum(value >= 30 for value in list(weeks.values())[-8:]), "recent_volume_trend": "unknown", "recent_longest_run_km": longest or None, "recent_quality_sessions_per_week": 0.0, "current_form_zone": zone, "current_chronic_load": ctl, "return_from_layoff": False, "macro_cycle": "unknown", "season_context": "", "injuries": []}
