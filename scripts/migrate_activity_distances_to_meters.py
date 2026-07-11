"""Audit and migrate activity/lap distances to meter storage.

Provider facts used by this migration:

* COROS activity summary/detail distances arrive as provider-specific large raw
  integers; STRIDE's adapter historically converted them to kilometers before
  writing ``activities.distance_m`` and ``laps.distance_m``.
* Garmin API activity and lap distances arrive in meters; STRIDE's Garmin
  adapter also historically divided them by 1000 before writing the same
  columns.

The target canonical storage is now literal meters for ``activities.distance_m``
and ``laps.distance_m``. Plan rows (``planned_session.total_distance_m``) and
timeseries cumulative distances are not touched here.

Examples:

    PYTHONIOENCODING=utf-8 python scripts/migrate_activity_distances_to_meters.py audit --all
    PYTHONIOENCODING=utf-8 python scripts/migrate_activity_distances_to_meters.py migrate --all
    PYTHONIOENCODING=utf-8 python scripts/migrate_activity_distances_to_meters.py migrate -P gaohan --execute
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


_REPO = Path(__file__).resolve().parents[1]
_DEFAULT_DATA = _REPO / "data"
_MIGRATION_FLAG = "distance_units_activities_laps_meters_v1"
_KM_UPPER_BOUND = 500.0


@dataclass(frozen=True)
class DbTarget:
    profile: str
    user_id: str
    db_path: Path


def _load_aliases(data_root: Path) -> dict[str, str]:
    aliases_path = data_root / ".slug_aliases.json"
    if not aliases_path.exists():
        return {}
    data = json.loads(aliases_path.read_text(encoding="utf-8"))
    return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}


def _resolve_profile(raw: str, aliases: dict[str, str], data_root: Path) -> DbTarget:
    user_id = aliases.get(raw, raw)
    return DbTarget(profile=raw, user_id=user_id, db_path=data_root / user_id / "coros.db")


def _all_targets(aliases: dict[str, str], data_root: Path) -> list[DbTarget]:
    alias_by_user = {v: k for k, v in aliases.items()}
    out: list[DbTarget] = []
    if not data_root.exists():
        return out
    for child in sorted(data_root.iterdir()):
        if not child.is_dir():
            continue
        db_path = child / "coros.db"
        if not db_path.exists():
            continue
        user_id = child.name
        out.append(DbTarget(profile=alias_by_user.get(user_id, user_id), user_id=user_id, db_path=db_path))
    return out


def _dicts(rows: Iterable[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(row) for row in rows]


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _near_ratio(value: float | None, target: float, *, source_distance: float) -> bool:
    if value is None or value <= 0 or target <= 0:
        return False
    ratio = value / target
    if source_distance < 1.0:
        return 0.5 <= ratio <= 2.0
    return 0.8 <= ratio <= 1.25


def _looks_like_legacy_km(
    row: sqlite3.Row | dict[str, Any],
    *,
    distance_key: str = "distance_m",
    pace_key: str,
) -> bool:
    """Return True when a row's distance is almost certainly kilometers.

    The decisive signal is pace consistency:
    * legacy km row: ``duration_s / distance_m`` matches pace seconds/km.
    * canonical meter row: ``duration_s / (distance_m / 1000)`` matches pace.

    If pace is absent, fall back to plausible speed. This catches cycling rows
    and older rows with sparse pace data while still avoiding sub-500m rows in a
    post-migration DB.
    """
    distance = _to_float(row[distance_key])
    if distance is None or distance <= 0 or distance >= _KM_UPPER_BOUND:
        return False
    duration = _to_float(row["duration_s"])
    if duration is None or duration <= 0:
        return False

    pace = _to_float(row.get(pace_key) if isinstance(row, dict) else row[pace_key])
    if pace is not None and pace > 0:
        pace_if_km = duration / distance
        pace_if_m = duration / (distance / 1000.0)
        rel_km = abs(pace_if_km - pace) / pace
        rel_m = abs(pace_if_m - pace) / pace
        return rel_km <= 0.25 and rel_m > 5.0

    hours = duration / 3600.0
    if hours <= 0:
        return False
    speed_if_km = distance / hours
    speed_if_m = (distance / 1000.0) / hours
    return 2.0 <= speed_if_km <= 90.0 and speed_if_m < 2.0


def _has_table(conn: sqlite3.Connection, table: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table,),
    ).fetchone() is not None


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    if not _has_table(conn, table):
        return set()
    return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})")}


def _select_col(
    columns: set[str],
    name: str,
    *,
    table_alias: str | None = None,
    alias: str | None = None,
    default: str = "NULL",
) -> str:
    out_name = alias or name
    if name not in columns:
        return f"{default} AS {out_name}"
    prefix = f"{table_alias}." if table_alias else ""
    return f"{prefix}{name} AS {out_name}"


def _get_meta(conn: sqlite3.Connection, key: str) -> str | None:
    if not _has_table(conn, "sync_meta"):
        return None
    row = conn.execute("SELECT value FROM sync_meta WHERE key = ?", (key,)).fetchone()
    return str(row[0]) if row else None


def _set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS sync_meta (
            key TEXT PRIMARY KEY,
            value TEXT
        )
        """
    )
    conn.execute(
        "INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)",
        (key, value),
    )


def _summarize(conn: sqlite3.Connection) -> dict[str, Any]:
    activity_candidates = _activity_candidates(conn)
    lap_candidates = _lap_candidates(conn)
    activity_summary = _activity_summary(conn)
    lap_summary = _lap_summary(conn)
    return {
        "migration_flag": _get_meta(conn, _MIGRATION_FLAG),
        "activity_summary": activity_summary,
        "activity_candidates": len(activity_candidates),
        "activity_candidate_samples": activity_candidates[:20],
        "lap_summary": lap_summary,
        "lap_candidates": len(lap_candidates),
        "lap_candidate_samples": lap_candidates[:20],
    }


def _candidate_counts(conn: sqlite3.Connection) -> tuple[int, int]:
    return len(_activity_candidates(conn)), len(_lap_candidates(conn))


def _activity_candidates(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    columns = _columns(conn, "activities")
    if not {"distance_m", "duration_s"}.issubset(columns):
        return []
    select_cols = [
        "rowid",
        _select_col(columns, "label_id"),
        _select_col(columns, "date"),
        _select_col(columns, "provider"),
        _select_col(columns, "sport_type"),
        _select_col(columns, "sport_name"),
        _select_col(columns, "name"),
        "distance_m",
        "duration_s",
        _select_col(columns, "avg_pace_s_km"),
    ]
    order_terms = [c for c in ("date", "label_id") if c in columns]
    order_sql = ", ".join(f"{c} DESC" for c in order_terms) or "rowid DESC"
    rows = conn.execute(
        f"""
        SELECT {', '.join(select_cols)}
        FROM activities
        WHERE distance_m > 0 AND distance_m < ?
        ORDER BY {order_sql}
        """,
        (_KM_UPPER_BOUND,),
    ).fetchall()
    return [dict(row) for row in rows if _activity_row_needs_meter_migration(conn, row)]


def _activity_row_needs_meter_migration(conn: sqlite3.Connection, row: sqlite3.Row) -> bool:
    distance = _to_float(row["distance_m"])
    label_id = row["label_id"] if "label_id" in row.keys() else None
    if distance is None or distance <= 0 or distance >= _KM_UPPER_BOUND:
        return False
    if not label_id:
        return _looks_like_legacy_km(row, pace_key="avg_pace_s_km")

    # Legacy COROS timeseries may still be centimetres. Compare the
    # cumulative max against both legacy shapes so this remains correct whether
    # the auxiliary timeseries migration has already run or not.
    # Same-scale checks come first to keep the script idempotent for short reps
    # and heavily paused activities.
    ts_cols = _columns(conn, "timeseries")
    if {"label_id", "distance"}.issubset(ts_cols):
        ts_row = conn.execute(
            "SELECT MAX(distance) AS max_distance FROM timeseries WHERE label_id = ?",
            (label_id,),
        ).fetchone()
        ts_max = _to_float(ts_row["max_distance"] if ts_row else None)
        if ts_max:
            if (
                _near_ratio(ts_max, distance, source_distance=distance)
                or _near_ratio(ts_max, distance * 100.0, source_distance=distance)
            ):
                return False
            if (
                _near_ratio(ts_max, distance * 100000.0, source_distance=distance)
                or _near_ratio(ts_max, distance * 1000.0, source_distance=distance)
            ):
                return True

    # Some prod rows already had lap distances migrated to metres while the
    # activity summary remained in kilometres. If laps add up near distance*1000,
    # the activity row is still legacy km even when pace is absent/misleading.
    # Conversely, if laps already add up near distance, the activity row is
    # already metres and must not be multiplied again even if duration includes
    # long paused time that makes the pace heuristic look km-like.
    lap_cols = _columns(conn, "laps")
    if {"label_id", "distance_m"}.issubset(lap_cols):
        lap_row = conn.execute(
            "SELECT SUM(distance_m) AS total FROM laps WHERE label_id = ? AND distance_m > 0",
            (label_id,),
        ).fetchone()
        lap_total = _to_float(lap_row["total"] if lap_row else None)
        if _near_ratio(lap_total, distance * 1000.0, source_distance=distance):
            return True
        if _near_ratio(lap_total, distance, source_distance=distance):
            return False

    return _looks_like_legacy_km(row, pace_key="avg_pace_s_km")


def _activity_summary(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    columns = _columns(conn, "activities")
    if "distance_m" not in columns:
        return []
    provider_expr = "coalesce(provider, '')" if "provider" in columns else "''"
    sport_expr = "sport_type" if "sport_type" in columns else "NULL"
    return _dicts(conn.execute(
        f"""
        SELECT {provider_expr} AS provider,
               {sport_expr} AS sport_type,
               count(*) AS rows,
               round(min(distance_m), 3) AS min_distance_m,
               round(max(distance_m), 3) AS max_distance_m,
               sum(CASE WHEN distance_m > 0 AND distance_m < ? THEN 1 ELSE 0 END) AS sub_500_rows,
               sum(CASE WHEN distance_m >= ? THEN 1 ELSE 0 END) AS ge_500_rows
        FROM activities
        GROUP BY provider, sport_type
        ORDER BY provider, sport_type
        """,
        (_KM_UPPER_BOUND, _KM_UPPER_BOUND),
    ))


def _lap_candidates(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    lap_columns = _columns(conn, "laps")
    if not {"distance_m", "duration_s"}.issubset(lap_columns):
        return []
    activity_columns = _columns(conn, "activities")
    can_join_activity = "label_id" in lap_columns and "label_id" in activity_columns
    select_cols = [
        "l.rowid AS rowid",
        _select_col(lap_columns, "label_id", table_alias="l"),
        _select_col(activity_columns, "date", table_alias="a") if can_join_activity else "NULL AS date",
        _select_col(activity_columns, "provider", table_alias="a") if can_join_activity else "NULL AS provider",
        _select_col(activity_columns, "sport_type", table_alias="a") if can_join_activity else "NULL AS sport_type",
        _select_col(lap_columns, "lap_index", table_alias="l"),
        _select_col(lap_columns, "lap_type", table_alias="l"),
        "l.distance_m AS distance_m",
        "l.duration_s AS duration_s",
        _select_col(lap_columns, "avg_pace", table_alias="l"),
    ]
    join_sql = "LEFT JOIN activities a ON a.label_id = l.label_id" if can_join_activity else ""
    order_terms = []
    if can_join_activity and "date" in activity_columns:
        order_terms.append("a.date DESC")
    if "label_id" in lap_columns:
        order_terms.append("l.label_id DESC")
    if "lap_index" in lap_columns:
        order_terms.append("l.lap_index ASC")
    order_sql = ", ".join(order_terms) or "l.rowid DESC"
    rows = conn.execute(
        f"""
        SELECT {', '.join(select_cols)}
        FROM laps l
        {join_sql}
        WHERE l.distance_m > 0 AND l.distance_m < ?
        ORDER BY {order_sql}
        """,
        (_KM_UPPER_BOUND,),
    ).fetchall()
    return [
        dict(row) for row in rows
        if _lap_row_needs_meter_migration(conn, row)
    ]


def _lap_row_needs_meter_migration(conn: sqlite3.Connection, row: sqlite3.Row) -> bool:
    if _looks_like_legacy_km(row, pace_key="avg_pace"):
        return True
    distance = _to_float(row["distance_m"])
    label_id = row["label_id"] if "label_id" in row.keys() else None
    if distance is None or distance <= 0 or distance >= _KM_UPPER_BOUND or not label_id:
        return False

    ts_cols = _columns(conn, "timeseries")
    if {"label_id", "distance"}.issubset(ts_cols):
        ts_row = conn.execute(
            "SELECT COUNT(*) AS samples, MAX(distance) AS max_distance FROM timeseries WHERE label_id = ?",
            (label_id,),
        ).fetchone()
        ts_max = _to_float(ts_row["max_distance"] if ts_row else None)
        lap_count_row = conn.execute(
            "SELECT COUNT(*) AS n FROM laps WHERE label_id = ? AND distance_m > 0",
            (label_id,),
        ).fetchone()
        lap_count = int(lap_count_row["n"] or 0) if lap_count_row else 0
        if ts_max and lap_count == 1:
            if (
                _near_ratio(ts_max, distance, source_distance=distance)
                or _near_ratio(ts_max, distance * 100.0, source_distance=distance)
            ):
                return False
            if (
                _near_ratio(ts_max, distance * 100000.0, source_distance=distance)
                or _near_ratio(ts_max, distance * 1000.0, source_distance=distance)
            ):
                return True

    activity_cols = _columns(conn, "activities")
    if {"label_id", "distance_m"}.issubset(activity_cols):
        activity_row = conn.execute(
            "SELECT distance_m FROM activities WHERE label_id = ?",
            (label_id,),
        ).fetchone()
        activity_distance = _to_float(activity_row["distance_m"] if activity_row else None)
        lap_total_row = conn.execute(
            "SELECT SUM(distance_m) AS total FROM laps WHERE label_id = ? AND distance_m > 0",
            (label_id,),
        ).fetchone()
        lap_total = _to_float(lap_total_row["total"] if lap_total_row else None)
        if activity_distance and _near_ratio(lap_total * 1000.0 if lap_total else None, activity_distance, source_distance=distance):
            return True
        if activity_distance and _near_ratio(lap_total, activity_distance, source_distance=distance):
            return False

    return False


def _lap_summary(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    columns = _columns(conn, "laps")
    if "distance_m" not in columns:
        return [{
            "rows": 0,
            "min_distance_m": None,
            "max_distance_m": None,
            "sub_500_rows": None,
            "ge_500_rows": None,
        }]
    return _dicts(conn.execute(
        """
        SELECT count(*) AS rows,
               round(min(distance_m), 3) AS min_distance_m,
               round(max(distance_m), 3) AS max_distance_m,
               sum(CASE WHEN distance_m > 0 AND distance_m < ? THEN 1 ELSE 0 END) AS sub_500_rows,
               sum(CASE WHEN distance_m >= ? THEN 1 ELSE 0 END) AS ge_500_rows
        FROM laps
        """,
        (_KM_UPPER_BOUND, _KM_UPPER_BOUND),
    ))


def _migrate(conn: sqlite3.Connection) -> dict[str, int | str]:
    activity_candidates = _activity_candidates(conn)
    lap_candidates = _lap_candidates(conn)
    if _get_meta(conn, _MIGRATION_FLAG):
        if not activity_candidates and not lap_candidates:
            return {
                "status": "already_migrated",
                "activity_candidates_remaining": 0,
                "lap_candidates_remaining": 0,
                "activities_updated": 0,
                "laps_updated": 0,
            }
        status = "migrated_remaining"
    else:
        status = "migrated"
    with conn:
        conn.executemany(
            "UPDATE activities SET distance_m = ? WHERE rowid = ? AND distance_m = ?",
            [
                (float(row["distance_m"]) * 1000.0, int(row["rowid"]), float(row["distance_m"]))
                for row in activity_candidates
            ],
        )
        conn.executemany(
            "UPDATE laps SET distance_m = ? WHERE rowid = ? AND distance_m = ?",
            [
                (float(row["distance_m"]) * 1000.0, int(row["rowid"]), float(row["distance_m"]))
                for row in lap_candidates
            ],
        )
        _set_meta(conn, _MIGRATION_FLAG, "1")
    return {
        "status": status,
        "activities_updated": len(activity_candidates),
        "laps_updated": len(lap_candidates),
    }


def _print_report(target: DbTarget, report: dict[str, Any]) -> None:
    print(f"\n[{target.profile}] {target.user_id}")
    print(f"db: {target.db_path}")
    print(f"migration_flag: {report.get('migration_flag') or ''}")
    print(f"activity_candidates: {report.get('activity_candidates', 0)}")
    print("activities by provider/sport:")
    for row in report["activity_summary"]:
        print("  " + json.dumps(row, ensure_ascii=False, sort_keys=True))
    print("activity candidate samples (currently <500, likely km pre-migration):")
    for row in report["activity_candidate_samples"][:10]:
        print("  " + json.dumps(row, ensure_ascii=False, sort_keys=True))
    print("laps:")
    print(f"  lap_candidates: {report.get('lap_candidates', 0)}")
    for row in report["lap_summary"]:
        print("  " + json.dumps(row, ensure_ascii=False, sort_keys=True))
    print("lap candidate samples (currently <500, likely km pre-migration):")
    for row in report["lap_candidate_samples"][:10]:
        print("  " + json.dumps(row, ensure_ascii=False, sort_keys=True))


def _connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    return conn


def _backup(path: Path) -> Path:
    backup = path.with_suffix(path.suffix + ".distance-units-backup")
    i = 1
    while backup.exists():
        backup = path.with_suffix(path.suffix + f".distance-units-backup-{i}")
        i += 1
    with sqlite3.connect(str(path)) as source, sqlite3.connect(str(backup)) as dest:
        source.backup(dest)
    return backup


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    def add_targets(p: argparse.ArgumentParser) -> None:
        p.add_argument("-P", "--profile", action="append", default=[], help="User UUID or slug")
        p.add_argument("--all", action="store_true", help="Scan every data/*/coros.db")
        p.add_argument("--data-root", default=str(_DEFAULT_DATA), help="Directory containing user_id/coros.db folders")

    audit_p = sub.add_parser("audit", help="Read-only unit distribution report")
    add_targets(audit_p)
    migrate_p = sub.add_parser("migrate", help="Convert km-like activity/lap rows to meters")
    add_targets(migrate_p)
    migrate_p.add_argument("--execute", action="store_true", help="Write migration; default is dry-run")
    migrate_p.add_argument("--no-backup", action="store_true", help="Skip .distance-units-backup copy")
    args = parser.parse_args()

    data_root = Path(args.data_root).resolve()
    aliases = _load_aliases(data_root)
    targets = _all_targets(aliases, data_root) if args.all else [
        _resolve_profile(p, aliases, data_root) for p in args.profile
    ]
    if not targets:
        parser.error("provide -P/--profile or --all")

    for target in targets:
        if not target.db_path.exists():
            print(f"\n[{target.profile}] missing db: {target.db_path}")
            continue
        conn = _connect(target.db_path)
        try:
            before = _summarize(conn)
            _print_report(target, before)
            if args.command != "migrate":
                continue
            if not args.execute:
                a_count, l_count = _candidate_counts(conn)
                print(f"dry-run: would update activities={a_count}, laps={l_count}")
                continue
            backup = None if args.no_backup else _backup(target.db_path)
            if backup is not None:
                print(f"backup: {backup}")
            result = _migrate(conn)
            print("migration_result: " + json.dumps(result, ensure_ascii=False, sort_keys=True))
            after = _summarize(conn)
            print("after:")
            _print_report(target, after)
        finally:
            conn.close()


if __name__ == "__main__":
    main()
