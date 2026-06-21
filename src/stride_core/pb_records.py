"""Canonical personal-best / best-effort detection.

The primary source is a continuous timeseries segment for each canonical
distance. Activity-level distance matching is kept as a fallback for legacy
rows or providers without usable timeseries.
"""

from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from stride_core.models import RUN_SPORT_IDS
from stride_core.running_calibration.segments import best_distance_candidates
from stride_core.timefmt import utc_iso_to_shanghai_iso

logger = logging.getLogger(__name__)

# sync_meta key recording that a PB scan has run for this DB (even when it found
# zero qualifying activities). Lets load_personal_bests distinguish "never
# scanned" from "scanned, genuinely empty" so a PB-less user isn't re-scanned
# (~7s) on every read.
_PB_SCAN_META_KEY = "personal_bests_scanned"


CANONICAL_RACE_DISTANCES: dict[str, float] = {
    "5K": 5000.0,
    "10K": 10000.0,
    "half": 21097.5,
    "full": 42195.0,
}

# Display-only superset used by the /pbs route. 1K/3K are intentionally NOT in
# CANONICAL_RACE_DISTANCES: the Daniels VDOT formula has no short-distance guard
# (see compute_pb_vdot_for_segment), so feeding 1K/3K into the ability model
# would inflate VO2max. Keep them on the display path only.
PB_DISPLAY_DISTANCES: dict[str, float] = {
    "1K": 1000.0,
    "3K": 3000.0,
    **CANONICAL_RACE_DISTANCES,
}

DISTANCE_ORDER = ["1K", "3K", "5K", "10K", "HM", "FM"]

_DISPLAY_DISTANCE_BY_RACE_TYPE = {
    "1K": "1K",
    "3K": "3K",
    "5K": "5K",
    "10K": "10K",
    "half": "HM",
    "full": "FM",
}

_RACE_TYPE_BY_DISPLAY_DISTANCE = {
    display: race_type for race_type, display in _DISPLAY_DISTANCE_BY_RACE_TYPE.items()
}

ACTIVITY_DISTANCE_TOLERANCE_M: dict[str, tuple[float, float]] = {
    "1K": (950.0, 1050.0),
    "3K": (2900.0, 3100.0),
    "5K": (4800.0, 5200.0),
    "10K": (9800.0, 10200.0),
    "HM": (20800.0, 21300.0),
    "FM": (41800.0, 42400.0),
}

# Physiological speed ceiling for PB candidates. A GPS dropout-and-reacquire can
# teleport the distance track (e.g. 997 m credited in 31 s ≈ 32 m/s), producing
# an absurdly fast "segment" that is NOT bounded by a watch pause. The men's 1K
# world record is ~7.58 m/s, so any candidate averaging faster than this over a
# canonical distance (≥1 km) is a tracking glitch, not a run — drop it. The
# margin above WR guarantees no real human effort is ever rejected.
MAX_PLAUSIBLE_SPEED_MPS = 8.0


@dataclass(frozen=True)
class BestEffortCandidate:
    distance: str
    race_type: str
    distance_m: float
    duration_s: float
    achieved_at: str
    label_id: str
    source: str
    segment_start_s: float | None = None
    segment_end_s: float | None = None

    def history_point(self) -> dict[str, Any]:
        point: dict[str, Any] = {
            "date": self.achieved_at,
            "best_so_far_sec": self.duration_s,
            "label_id": self.label_id,
            "source": self.source,
        }
        if self.segment_start_s is not None:
            point["segment_start_s"] = self.segment_start_s
        if self.segment_end_s is not None:
            point["segment_end_s"] = self.segment_end_s
        return point

    def pb_entry(self, history: list[dict[str, Any]]) -> dict[str, Any]:
        entry: dict[str, Any] = {
            "distance": self.distance,
            "race_type": self.race_type,
            "pb_time_sec": self.duration_s,
            "achieved_at": self.achieved_at,
            "label_id": self.label_id,
            "source": self.source,
            "history": history,
        }
        if self.segment_start_s is not None:
            entry["segment_start_s"] = self.segment_start_s
        if self.segment_end_s is not None:
            entry["segment_end_s"] = self.segment_end_s
        return entry


def detect_personal_bests(
    db: Any, *, distances: dict[str, float] = CANONICAL_RACE_DISTANCES,
) -> dict[str, dict[str, Any]]:
    """Return best-effort PBs keyed by display distance.

    Rows are scanned chronologically so each entry includes a best-so-far
    history. The returned shape is API-ready but intentionally lives in core so
    HTTP routes, coach tools, and ability code consume the same detector.
    """
    placeholders = ",".join("?" * len(RUN_SPORT_IDS))
    rows = db._conn.execute(
        f"""SELECT label_id, name, sport_type, date, distance_m, duration_s, pauses
            FROM activities
            WHERE sport_type IN ({placeholders})
              AND duration_s IS NOT NULL
              AND duration_s > 0
            ORDER BY date ASC, label_id ASC""",
        tuple(RUN_SPORT_IDS),
    ).fetchall()

    best_by_distance: dict[str, float] = {}
    current_entry: dict[str, dict[str, Any]] = {}
    history_by_distance: dict[str, list[dict[str, Any]]] = {}

    for row in rows:
        candidates = best_effort_candidates_for_activity(db, row, distances=distances)
        for candidate in sorted(candidates, key=lambda c: DISTANCE_ORDER.index(c.distance)):
            previous = best_by_distance.get(candidate.distance)
            if previous is not None and candidate.duration_s >= previous:
                continue
            best_by_distance[candidate.distance] = candidate.duration_s
            history = history_by_distance.setdefault(candidate.distance, [])
            history.append(candidate.history_point())
            current_entry[candidate.distance] = candidate.pb_entry(history)

    return current_entry


def persist_personal_bests(db: Any) -> dict[str, dict[str, Any]]:
    """Recompute PBs via detect_personal_bests and upsert into ``personal_bests``.

    Called from the post-sync pipeline so the expensive chronological best-effort
    scan runs once per sync, not on every read. Stores the full display superset
    (1K/3K/5K/10K/HM/FM via PB_DISPLAY_DISTANCES) so the same table backs the
    /pbs route, the coach get_pbs tool, AND the master-plan generator. Returns the
    freshly-detected dict (semantically equal to ``detect_personal_bests``; the
    JSON round-trip coerces float/tuple→list). The UPSERT writes exactly today's
    full scan, so a deleted activity legitimately recomputes a row lower — only
    the best-so-far *within* the current activity set is kept.
    """
    pbs = detect_personal_bests(db, distances=PB_DISPLAY_DISTANCES)
    conn = db._conn
    for distance, entry in pbs.items():
        conn.execute(
            """INSERT INTO personal_bests
                   (distance, pb_time_sec, achieved_at, source, entry_json, updated_at)
               VALUES (?, ?, ?, ?, ?, datetime('now'))
               ON CONFLICT(distance) DO UPDATE SET
                   pb_time_sec = excluded.pb_time_sec,
                   achieved_at = excluded.achieved_at,
                   source      = excluded.source,
                   entry_json  = excluded.entry_json,
                   updated_at  = excluded.updated_at""",
            (
                distance,
                float(entry.get("pb_time_sec")) if entry.get("pb_time_sec") is not None else None,
                entry.get("achieved_at"),
                entry.get("source"),
                json.dumps(entry, ensure_ascii=False),
            ),
        )
    conn.commit()
    # Record the scan ran (even with zero PBs) so load_personal_bests doesn't
    # re-scan a PB-less user on every read. Best-effort: the marker is an
    # optimization, never worth failing a successful persist over.
    try:
        db.set_meta(_PB_SCAN_META_KEY, str(len(pbs)))
    except Exception:  # noqa: BLE001
        logger.warning("persist_personal_bests: scan marker write failed", exc_info=True)
    return pbs


def personal_bests_scanned(db: Any) -> bool:
    """True if a PB scan has been recorded for this DB (see _PB_SCAN_META_KEY)."""
    try:
        return db.get_meta(_PB_SCAN_META_KEY) is not None
    except Exception:  # noqa: BLE001
        return False


def load_personal_bests(db: Any) -> dict[str, dict[str, Any]]:
    """Read persisted PBs, self-healing ONCE if the table was never scanned.

    The canonical reader for the /pbs route, coach get_pbs tool, and master-plan
    generator. Unlike a bare ``fetch or persist``, a user with genuinely zero
    qualifying activities is recorded as scanned, so this does NOT re-run the ~7s
    chronological scan on every call.
    """
    pbs = fetch_personal_bests(db)
    if pbs or personal_bests_scanned(db):
        return pbs
    return persist_personal_bests(db)


def fetch_personal_bests(db: Any) -> dict[str, dict[str, Any]]:
    """Read persisted PBs from ``personal_bests`` keyed by display distance.

    Returns the same shape as ``detect_personal_bests`` (the full entry incl.
    history + segment offsets, reconstructed from ``entry_json``), so the /pbs
    route, coach get_pbs tool, and master-plan generator can swap a live scan for
    this cheap indexed read (≤6 rows). Empty dict when the table is absent or
    empty — prefer ``load_personal_bests`` when a value should be seeded on first
    read.
    """
    try:
        rows = db._conn.execute(
            "SELECT distance, entry_json FROM personal_bests"
        ).fetchall()
    except sqlite3.OperationalError:
        return {}  # table absent on a pre-migration DB — expected, silent
    except Exception:  # noqa: BLE001 — corruption / locked / closed conn: surface it
        logger.warning("fetch_personal_bests: unexpected DB error", exc_info=True)
        return {}
    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        try:
            out[r["distance"]] = json.loads(r["entry_json"])
        except (ValueError, TypeError):
            continue
    return out


def best_effort_candidates_for_activity(
    db: Any,
    activity: Mapping[str, Any],
    *,
    include_activity_fallback: bool = True,
    distances: dict[str, float] = CANONICAL_RACE_DISTANCES,
) -> list[BestEffortCandidate]:
    label_id = str(_get(activity, "label_id") or "")
    if not label_id:
        return []
    date_disp = _normalise_date(str(_get(activity, "date") or ""))
    out: list[BestEffortCandidate] = []

    try:
        ts_rows = db.fetch_timeseries(label_id)
    except Exception:  # noqa: BLE001 - best-effort reader for route/tool paths
        ts_rows = []
    if ts_rows and len(ts_rows) >= 2:
        ts_norm = normalize_timeseries_units(
            ts_rows,
            activity_distance_m=_activity_distance_to_meters(
                float(_get(activity, "distance_m") or 0.0),
            ),
        )
        if len(ts_norm) >= 2:
            pauses = parse_pauses(_get(activity, "pauses"), t0=ts_rows[0]["timestamp"])
            for race_type, segment in best_distance_candidates(
                ts_norm, pauses, distances,
            ).items():
                out.append(BestEffortCandidate(
                    distance=_DISPLAY_DISTANCE_BY_RACE_TYPE[race_type],
                    race_type=race_type,
                    distance_m=segment.distance_m,
                    duration_s=float(segment.duration_s),
                    achieved_at=date_disp,
                    label_id=label_id,
                    source="segment",
                    segment_start_s=float(segment.start_s),
                    segment_end_s=float(segment.end_s),
                ))

    if include_activity_fallback:
        allowed = {_DISPLAY_DISTANCE_BY_RACE_TYPE[rt] for rt in distances}
        out.extend(_activity_level_candidates(activity, date_disp, label_id, allowed))

    # Drop physically-impossible candidates: a GPS teleport (distance dropout +
    # reacquire) can credit ~1 km in a few seconds, yielding a sub-human "PB" that
    # no pause bounds. Anything faster than MAX_PLAUSIBLE_SPEED_MPS over a
    # canonical distance is a tracking glitch, not a run.
    out = [
        c for c in out
        if c.duration_s > 0 and (c.distance_m / c.duration_s) <= MAX_PLAUSIBLE_SPEED_MPS
    ]

    best: dict[str, BestEffortCandidate] = {}
    for candidate in out:
        current = best.get(candidate.distance)
        if current is None or candidate.duration_s < current.duration_s:
            best[candidate.distance] = candidate
    return [best[d] for d in DISTANCE_ORDER if d in best]


def normalize_timeseries_units(
    rows: Sequence[Any],
    *,
    activity_distance_m: float | None = None,
) -> list[tuple[float, float]]:
    """Convert raw timeseries rows to ``(elapsed_s, distance_m)`` tuples.

    Timestamp is stored as centiseconds. COROS distance is centimetres, while
    Garmin detail rows use metres; ``activity_distance_m`` lets us distinguish
    the distance unit without provider-specific branches.
    """
    filtered = [(r["timestamp"], r["distance"]) for r in rows
                if r["timestamp"] is not None and r["distance"] is not None]
    if not filtered:
        return []
    monotonic: list[tuple[float, float]] = []
    last_dist = -float("inf")
    for ts, dist in filtered:
        if dist < last_dist:
            continue
        monotonic.append((ts, dist))
        last_dist = dist
    if not monotonic:
        return []
    t0 = monotonic[0][0]
    distance_scale = _distance_scale(monotonic, activity_distance_m)
    return [((ts - t0) / 100.0, dist / distance_scale) for ts, dist in monotonic]


def _distance_scale(
    monotonic: Sequence[tuple[float, float]],
    activity_distance_m: float | None,
) -> float:
    if not monotonic:
        return 100.0
    if activity_distance_m is None or activity_distance_m <= 0:
        return 100.0
    raw_span = monotonic[-1][1] - monotonic[0][1]
    if raw_span <= 0:
        return 100.0
    ratio = raw_span / activity_distance_m
    return 100.0 if ratio > 10.0 else 1.0


def parse_pauses(raw: Any, t0: float) -> list[tuple[float, float]]:
    """Parse activity pause JSON into activity-relative seconds."""
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        return []
    out: list[tuple[float, float]] = []
    for entry in data:
        try:
            start_abs = entry["start_ts"]
            end_abs = entry["end_ts"]
        except (KeyError, TypeError):
            continue
        if start_abs is None or end_abs is None:
            continue
        start_s = (start_abs - t0) / 100.0
        end_s = (end_abs - t0) / 100.0
        if end_s <= start_s:
            continue
        out.append((start_s, end_s))
    return out


def _activity_level_candidates(
    activity: Mapping[str, Any],
    date_disp: str,
    label_id: str,
    allowed_display: set[str],
) -> list[BestEffortCandidate]:
    distance_raw = _get(activity, "distance_m") or 0.0
    duration_s = _get(activity, "duration_s") or 0.0
    if duration_s <= 0:
        return []
    distance_m = _activity_distance_to_meters(float(distance_raw))
    out: list[BestEffortCandidate] = []
    for display, (low, high) in ACTIVITY_DISTANCE_TOLERANCE_M.items():
        if display not in allowed_display:
            continue
        if not (low <= distance_m <= high):
            continue
        race_type = _RACE_TYPE_BY_DISPLAY_DISTANCE[display]
        out.append(BestEffortCandidate(
            distance=display,
            race_type=race_type,
            distance_m=PB_DISPLAY_DISTANCES[race_type],
            duration_s=float(duration_s),
            achieved_at=date_disp,
            label_id=label_id,
            source="activity",
        ))
    return out


def _activity_distance_to_meters(distance: float) -> float:
    if distance <= 0:
        return 0.0
    return distance * 1000.0 if distance < 500 else distance


def _normalise_date(raw: str) -> str:
    if not raw:
        return raw
    if "T" in raw or (len(raw) > 10 and raw[10] == " "):
        shanghai = utc_iso_to_shanghai_iso(raw)
        if shanghai and shanghai != raw:
            return shanghai[:10]
    if len(raw) == 8 and raw.isdigit():
        return f"{raw[:4]}-{raw[4:6]}-{raw[6:]}"
    return raw[:10]


def _get(obj: Mapping[str, Any] | Any, key: str) -> Any:
    if isinstance(obj, Mapping):
        return obj.get(key)
    try:
        return obj[key]
    except Exception:  # noqa: BLE001 - sqlite rows and test doubles vary
        return getattr(obj, key, None)


__all__ = [
    "BestEffortCandidate",
    "ACTIVITY_DISTANCE_TOLERANCE_M",
    "CANONICAL_RACE_DISTANCES",
    "PB_DISPLAY_DISTANCES",
    "DISTANCE_ORDER",
    "best_effort_candidates_for_activity",
    "detect_personal_bests",
    "fetch_personal_bests",
    "load_personal_bests",
    "personal_bests_scanned",
    "normalize_timeseries_units",
    "parse_pauses",
    "persist_personal_bests",
]
