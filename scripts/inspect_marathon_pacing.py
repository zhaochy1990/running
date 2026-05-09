"""Diagnostic: inspect marathon pacing for the v7 well-paced gate.

For each full marathon (41-43.5km / 2-6h) in the user's DB, compute
the second-half / first-half avg-pace ratio. Anything >= 1.15 is
rejected by ``_is_well_paced_marathon`` and won't enroll as a PB.
"""
from __future__ import annotations
import argparse, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from stride_core.db import USER_DATA_DIR, Database
from stride_core.ability import (
    _is_well_paced_marathon, _distance_to_meters, MARATHON_DNF_PACE_RATIO,
    _marathon_time_to_vdot_table,
)

_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

def _resolve(profile: str) -> str:
    if _UUID4_RE.match(profile):
        return profile
    af = USER_DATA_DIR / ".slug_aliases.json"
    if af.exists():
        try:
            return json.loads(af.read_text(encoding="utf-8")).get(profile, profile)
        except Exception:
            pass
    return profile


parser = argparse.ArgumentParser()
parser.add_argument("-P", "--profile", required=True)
args = parser.parse_args()

db = Database(user=_resolve(args.profile))
conn = db._conn

# Find all marathons
rows = conn.execute(
    "SELECT label_id, sport_type, date, distance_m, duration_s, train_type "
    "FROM activities ORDER BY date DESC"
).fetchall()
marathons = []
for r in rows:
    d_raw = float(r["distance_m"] or 0)
    d_m = _distance_to_meters(d_raw, r["sport_type"])
    if 41000 <= d_m <= 43500 and 7200 <= (r["duration_s"] or 0) <= 21600:
        marathons.append(r)

print(f"Found {len(marathons)} marathon-distance activities")
print(f"Well-paced threshold: second/first avg pace < {MARATHON_DNF_PACE_RATIO}")
print()

for r in marathons:
    label_id = r["label_id"]
    laps = [
        dict(x) for x in conn.execute(
            "SELECT lap_index, distance_m, duration_s, avg_pace, exercise_type "
            "FROM laps WHERE label_id = ? ORDER BY lap_index",
            (label_id,),
        ).fetchall()
    ]
    activity = {**dict(r), "laps": laps}
    well_paced = _is_well_paced_marathon(activity)
    finish_min = (r["duration_s"] or 0) / 60.0
    table_vdot = _marathon_time_to_vdot_table(float(r["duration_s"] or 0))
    half = len(laps) // 2
    p1_list = [lp.get("avg_pace") for lp in laps[:half] if lp.get("avg_pace") and lp.get("avg_pace") > 0]
    p2_list = [lp.get("avg_pace") for lp in laps[half:] if lp.get("avg_pace") and lp.get("avg_pace") > 0]
    p1 = sum(p1_list) / len(p1_list) if p1_list else 0
    p2 = sum(p2_list) / len(p2_list) if p2_list else 0
    ratio = p2 / p1 if p1 > 0 else 0
    finish_str = f"{int(finish_min // 60)}:{int(finish_min % 60):02d}"
    status = "ADMIT" if well_paced else "REJECT"
    print(
        f"  [{status}] {r['date'][:10]} {finish_str} "
        f"dist={d_m:.0f}m laps={len(laps)} p1={p1:.1f} p2={p2:.1f} "
        f"ratio={ratio:.3f} table_vdot={table_vdot:.1f} id={label_id}"
    )

db.close()
