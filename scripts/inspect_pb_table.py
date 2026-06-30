"""Print the current vo2max_pb table for a user."""
from __future__ import annotations
import argparse, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))
from stride_core.db import USER_DATA_DIR
from stride_storage.sqlite.database import Database
from stride_core.ability import _decayed_pb_vdot, PB_MAX_AGE_MONTHS, PB_DECAY_PCT_PER_MONTH

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
parser.add_argument("--today", default=None,
                    help="ISO date for decay calculation (defaults to today)")
args = parser.parse_args()

today_iso = args.today
if today_iso is None:
    from datetime import date
    today_iso = date.today().isoformat()

db = Database(user=_resolve(args.profile))
rows = db.fetch_vo2max_pbs()
print(f"=== vo2max_pb table (today={today_iso}) ===")
print(f"decay rate: {PB_DECAY_PCT_PER_MONTH*100:.1f}%/month, max age: {PB_MAX_AGE_MONTHS} months")
print()
print(f"  {'rt':<5} {'vdot':>6} {'decayed':>8} {'dist':>7} {'dur':>8} {'date':<11} {'label':<20}")
print(f"  {'-'*5} {'-'*6} {'-'*8} {'-'*7} {'-'*8} {'-'*11} {'-'*20}")
for r in rows:
    d = dict(r)
    decayed = _decayed_pb_vdot(d["vdot"], d["pb_date"], today_iso)
    print(
        f"  {d['race_type']:<5} {d['vdot']:6.2f} {decayed:8.2f} "
        f"{d['distance_m']:7.0f} {d['duration_s']:8.0f} "
        f"{d['pb_date']:<11} {d['label_id']:<20}"
    )

print()
best = max((_decayed_pb_vdot(dict(r)["vdot"], dict(r)["pb_date"], today_iso) for r in rows), default=0.0)
print(f"highest decayed PB VDOT: {best:.2f}")
db.close()
