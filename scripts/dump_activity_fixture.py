#!/usr/bin/env python3
"""Dump one activity + its timeseries + pauses to a JSON fixture for tests.

Usage:
    python scripts/dump_activity_fixture.py -P zhaochaoyi 477783793625760045 \
        > tests/fixtures/segment_pb/activity_477783793625760045.json
"""
from __future__ import annotations
import argparse, json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from stride_core.db import Database  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-P", "--profile", required=True)
    ap.add_argument("--db-path", default=None,
                    help="Override DB path (else resolves to $PROJECT_ROOT/data/{profile}/coros.db).")
    ap.add_argument("label_id")
    args = ap.parse_args()

    if args.db_path:
        db = Database(db_path=args.db_path)
    else:
        db = Database(user=args.profile)
    con = db._conn
    con.row_factory = __import__("sqlite3").Row

    activity = dict(con.execute(
        "SELECT label_id, sport_type, date, distance_m, duration_s, "
        "avg_hr, max_hr, train_kind, train_type, pauses, provider "
        "FROM activities WHERE label_id = ?",
        (args.label_id,),
    ).fetchone())

    ts = [
        {"timestamp": r["timestamp"], "distance": r["distance"]}
        for r in con.execute(
            "SELECT timestamp, distance FROM timeseries "
            "WHERE label_id = ? ORDER BY timestamp ASC",
            (args.label_id,),
        )
    ]

    json.dump({"activity": activity, "timeseries": ts}, sys.stdout, indent=2)


if __name__ == "__main__":
    main()
