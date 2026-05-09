"""Diagnostic: scan a user's activities and report what would be PB-classified."""
import argparse, json, re, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))
from stride_core.db import USER_DATA_DIR, Database
from stride_core.models import RUN_SPORT_IDS
from stride_core.ability import classify_race_type, compute_pb_vdot_for_activity, _distance_to_meters

_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)

def _resolve_profile(profile: str) -> str:
    if _UUID4_RE.match(profile):
        return profile
    aliases_file = USER_DATA_DIR / ".slug_aliases.json"
    if aliases_file.exists():
        try:
            aliases = json.loads(aliases_file.read_text(encoding="utf-8"))
            if profile in aliases:
                return aliases[profile]
        except Exception:
            pass
    return profile

parser = argparse.ArgumentParser()
parser.add_argument("-P", "--profile", required=True)
args = parser.parse_args()

user_id = _resolve_profile(args.profile)
if user_id != args.profile:
    print(f"[resolved] {args.profile} -> {user_id}")
db = Database(user=user_id)
conn = db._conn
sports = ",".join(str(s) for s in RUN_SPORT_IDS)
rows = conn.execute(
    f"SELECT label_id, date, distance_m, duration_s, train_type, sport_type "
    f"FROM activities WHERE sport_type IN ({sports}) ORDER BY date DESC"
).fetchall()
print(f"total running activities: {len(rows)}")
print()
print("=== distance distribution ===")
buckets = {"<1km": 0, "1-4km": 0, "4-7km": 0, "7-12km": 0, "12-25km": 0, "25-50km": 0, ">50km": 0}
for r in rows:
    d = float(r["distance_m"] or 0)
    d_m = _distance_to_meters(d, r["sport_type"])
    if d_m < 1000: buckets["<1km"] += 1
    elif d_m < 4000: buckets["1-4km"] += 1
    elif d_m < 7000: buckets["4-7km"] += 1
    elif d_m < 12000: buckets["7-12km"] += 1
    elif d_m < 25000: buckets["12-25km"] += 1
    elif d_m < 50000: buckets["25-50km"] += 1
    else: buckets[">50km"] += 1
for k, v in buckets.items():
    print(f"  {k}: {v}")
print()
print("=== activities in race-distance bands ===")
hits = 0
for r in rows:
    d_raw = float(r["distance_m"] or 0)
    d_m = _distance_to_meters(d_raw, r["sport_type"])
    rt = classify_race_type(d_m)
    if rt is None:
        continue
    hits += 1
    print(f"  [{rt}] {r['date'][:10]} dist_m={d_m:.0f} dur={r['duration_s']} train={r['train_type']} id={r['label_id']}")
print(f"\ntotal in race bands: {hits}")
print()
print("=== compute_pb_vdot_for_activity hits ===")
ok = 0
for r in rows:
    activity = dict(r)
    activity["laps"] = [
        dict(x) for x in conn.execute(
            "SELECT lap_index, distance_m, duration_s, avg_pace, exercise_type "
            "FROM laps WHERE label_id = ? ORDER BY lap_index",
            (activity["label_id"],),
        ).fetchall()
    ]
    pb = compute_pb_vdot_for_activity(activity)
    if pb is None:
        continue
    ok += 1
    print(f"  [{pb[0]}] {r['date'][:10]} vdot={pb[1]:.2f} dist={r['distance_m']} dur={r['duration_s']} laps={len(activity['laps'])}")
print(f"\ntotal PB candidates: {ok}")
db.close()
