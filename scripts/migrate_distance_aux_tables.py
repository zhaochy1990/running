"""Audit and migrate auxiliary distance columns to canonical metres.

This complements ``migrate_activity_distances_to_meters.py``. The activity/lap
columns were already migrated separately; this script fixes the auxiliary data
quality issues discovered in prod dumps:

* ``timeseries.distance``: legacy COROS rows stored cumulative centimetres.
  Canonical storage is cumulative metres.
* ``vo2max_pb.distance_m``: some historical PB-memory rows stored race distance
  in kilometres (5.0, 10.0, 42.45) despite the ``*_m`` suffix.

Examples:

    PYTHONIOENCODING=utf-8 python scripts/migrate_distance_aux_tables.py audit --all
    PYTHONIOENCODING=utf-8 python scripts/migrate_distance_aux_tables.py migrate --all --execute
    PYTHONIOENCODING=utf-8 python scripts/migrate_distance_aux_tables.py migrate -P gaohan --execute
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any


_REPO = Path(__file__).resolve().parents[1]
_DEFAULT_DATA = _REPO / "data"
_TIMESERIES_FLAG = "distance_units_timeseries_meters_v1"
_VO2MAX_PB_FLAG = "distance_units_vo2max_pb_meters_v1"
_CANONICAL_RACE_DISTANCE_M = {
    "1k": 1000.0,
    "3k": 3000.0,
    "5k": 5000.0,
    "10k": 10000.0,
    "half": 21097.5,
    "hm": 21097.5,
    "full": 42195.0,
    "fm": 42195.0,
}


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


def _connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(path))
    conn.row_factory = sqlite3.Row
    return conn


def _backup(path: Path) -> Path:
    backup = path.with_suffix(path.suffix + ".aux-distance-units-backup")
    i = 1
    while backup.exists():
        backup = path.with_suffix(path.suffix + f".aux-distance-units-backup-{i}")
        i += 1
    with sqlite3.connect(str(path)) as source, sqlite3.connect(str(backup)) as dest:
        source.backup(dest)
    return backup


def _has_table(conn: sqlite3.Connection, table: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table,),
    ).fetchone() is not None


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    if not _has_table(conn, table):
        return set()
    return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})")}


def _get_meta(conn: sqlite3.Connection, key: str) -> str | None:
    if not _has_table(conn, "sync_meta"):
        return None
    row = conn.execute("SELECT value FROM sync_meta WHERE key = ?", (key,)).fetchone()
    return str(row[0]) if row else None


def _set_meta(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        """CREATE TABLE IF NOT EXISTS sync_meta (
            key TEXT PRIMARY KEY,
            value TEXT
        )"""
    )
    conn.execute("INSERT OR REPLACE INTO sync_meta (key, value) VALUES (?, ?)", (key, value))


def _dicts(rows: list[sqlite3.Row] | sqlite3.Cursor) -> list[dict[str, Any]]:
    return [dict(row) for row in rows]


def _timeseries_legacy_labels(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    activity_cols = _columns(conn, "activities")
    timeseries_cols = _columns(conn, "timeseries")
    if (
        "label_id" not in activity_cols
        or "distance_m" not in activity_cols
        or "label_id" not in timeseries_cols
        or "distance" not in timeseries_cols
    ):
        return []
    provider_filter = "AND lower(coalesce(a.provider, 'coros')) = 'coros'" if "provider" in activity_cols else ""
    rows = conn.execute(
        f"""SELECT a.label_id AS label_id,
                  a.distance_m AS activity_distance_m,
                  COUNT(t.distance) AS samples,
                  MAX(t.distance) AS max_timeseries_distance,
                  MAX(t.distance) / a.distance_m AS ratio
           FROM activities a
           JOIN timeseries t ON t.label_id = a.label_id AND t.distance IS NOT NULL
           WHERE a.distance_m IS NOT NULL
             AND a.distance_m > 0
             {provider_filter}
           GROUP BY a.label_id, a.distance_m
           -- Two legacy shapes are expected:
           --   * activity metres + timeseries centimetres -> ratio ~= 100
           --   * activity kilometres + timeseries centimetres -> ratio ~= 100000
           -- After migration, the second shape becomes ratio ~= 1000 because
           -- the activity row is still km-like; do not divide it again.
           HAVING (ratio BETWEEN 40 AND 250) OR ratio >= 20000
           ORDER BY ratio DESC"""
    ).fetchall()
    return _dicts(rows)


def _timeseries_summary(conn: sqlite3.Connection) -> dict[str, Any]:
    if not _has_table(conn, "timeseries") or "distance" not in _columns(conn, "timeseries"):
        return {"rows": 0, "nonnull": 0, "min": None, "max": None}
    row = conn.execute(
        """SELECT COUNT(*) AS rows,
                  SUM(CASE WHEN distance IS NOT NULL THEN 1 ELSE 0 END) AS nonnull,
                  MIN(distance) AS min,
                  MAX(distance) AS max
           FROM timeseries"""
    ).fetchone()
    return dict(row)


def _vo2max_pb_legacy_rows(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    cols = _columns(conn, "vo2max_pb")
    if not {"race_type", "distance_m"}.issubset(cols):
        return []
    rows = conn.execute(
        """SELECT rowid AS _rowid, race_type, distance_m, duration_s, vdot, pb_date, label_id
           FROM vo2max_pb
           WHERE distance_m > 0
             AND distance_m < 1000
             AND lower(race_type) IN ({})
           ORDER BY race_type, pb_date""".format(
            ",".join("?" for _ in _CANONICAL_RACE_DISTANCE_M)
        ),
        tuple(_CANONICAL_RACE_DISTANCE_M.keys()),
    ).fetchall()
    return _dicts(rows)


def _vo2max_pb_summary(conn: sqlite3.Connection) -> dict[str, Any]:
    if not _has_table(conn, "vo2max_pb") or "distance_m" not in _columns(conn, "vo2max_pb"):
        return {"rows": 0, "small_distance_rows": 0, "min": None, "max": None}
    row = conn.execute(
        """SELECT COUNT(*) AS rows,
                  SUM(CASE WHEN distance_m > 0 AND distance_m < 1000 THEN 1 ELSE 0 END) AS small_distance_rows,
                  MIN(distance_m) AS min,
                  MAX(distance_m) AS max
           FROM vo2max_pb"""
    ).fetchone()
    return dict(row)


def _summarize(conn: sqlite3.Connection) -> dict[str, Any]:
    legacy_labels = _timeseries_legacy_labels(conn)
    legacy_pb = _vo2max_pb_legacy_rows(conn)
    return {
        "timeseries_flag": _get_meta(conn, _TIMESERIES_FLAG),
        "vo2max_pb_flag": _get_meta(conn, _VO2MAX_PB_FLAG),
        "timeseries_summary": _timeseries_summary(conn),
        "timeseries_legacy_label_count": len(legacy_labels),
        "timeseries_legacy_labels": legacy_labels[:20],
        "vo2max_pb_summary": _vo2max_pb_summary(conn),
        "vo2max_pb_legacy_rows": len(legacy_pb),
        "vo2max_pb_legacy_samples": legacy_pb[:20],
    }


def _migrate_timeseries(conn: sqlite3.Connection) -> int:
    labels = _timeseries_legacy_labels(conn)
    with conn:
        for row in labels:
            conn.execute(
                """UPDATE timeseries
                   SET distance = distance / 100.0
                   WHERE label_id = ?
                     AND distance IS NOT NULL""",
                (row["label_id"],),
            )
        _set_meta(conn, _TIMESERIES_FLAG, "1")
    return len(labels)


def _migrate_vo2max_pb(conn: sqlite3.Connection) -> int:
    rows = _vo2max_pb_legacy_rows(conn)
    with conn:
        for row in rows:
            canonical = _CANONICAL_RACE_DISTANCE_M[str(row["race_type"]).lower()]
            conn.execute(
                "UPDATE vo2max_pb SET distance_m = ? WHERE rowid = ?",
                (canonical, row["_rowid"]),
            )
        _set_meta(conn, _VO2MAX_PB_FLAG, "1")
    return len(rows)


def _migrate(conn: sqlite3.Connection) -> dict[str, int | str]:
    return {
        "status": "migrated",
        "timeseries_labels_updated": _migrate_timeseries(conn),
        "vo2max_pb_rows_updated": _migrate_vo2max_pb(conn),
    }


def _print_report(target: DbTarget, report: dict[str, Any]) -> None:
    print(f"\n[{target.profile}] {target.user_id}")
    print(f"db: {target.db_path}")
    print(f"timeseries_flag: {report.get('timeseries_flag') or ''}")
    print(f"vo2max_pb_flag: {report.get('vo2max_pb_flag') or ''}")
    print("timeseries_summary: " + json.dumps(report["timeseries_summary"], ensure_ascii=False, sort_keys=True))
    print(f"timeseries_legacy_label_count: {report['timeseries_legacy_label_count']}")
    for row in report["timeseries_legacy_labels"][:10]:
        print("  " + json.dumps(row, ensure_ascii=False, sort_keys=True))
    print("vo2max_pb_summary: " + json.dumps(report["vo2max_pb_summary"], ensure_ascii=False, sort_keys=True))
    print(f"vo2max_pb_legacy_rows: {report['vo2max_pb_legacy_rows']}")
    for row in report["vo2max_pb_legacy_samples"][:10]:
        print("  " + json.dumps(row, ensure_ascii=False, sort_keys=True))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    def add_targets(p: argparse.ArgumentParser) -> None:
        p.add_argument("-P", "--profile", action="append", default=[], help="User UUID or slug")
        p.add_argument("--all", action="store_true", help="Scan every data/*/coros.db")
        p.add_argument("--data-root", default=str(_DEFAULT_DATA), help="Directory containing user_id/coros.db folders")

    audit_p = sub.add_parser("audit", help="Read-only auxiliary distance report")
    add_targets(audit_p)
    migrate_p = sub.add_parser("migrate", help="Convert auxiliary distance columns to metres")
    add_targets(migrate_p)
    migrate_p.add_argument("--execute", action="store_true", help="Write migration; default is dry-run")
    migrate_p.add_argument("--no-backup", action="store_true", help="Skip .aux-distance-units-backup copy")
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
                print(
                    "dry-run: would update "
                    f"timeseries_labels={before['timeseries_legacy_label_count']}, "
                    f"vo2max_pb_rows={before['vo2max_pb_legacy_rows']}"
                )
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
