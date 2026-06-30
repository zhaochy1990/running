"""Diagnose a user's sync state — recent activities, sync_meta, daily_health,
auth state, config presence."""
from __future__ import annotations
import argparse, json, re, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))
from stride_core.db import USER_DATA_DIR
from stride_storage.sqlite.database import Database

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

uuid = _resolve(args.profile)
print(f"=== sync state for {args.profile} ({uuid}) ===")
print()

user_dir = USER_DATA_DIR / uuid
print(f"data dir: {user_dir}")
if not user_dir.exists():
    print("  MISSING")
    sys.exit(1)
print("  files:")
for f in sorted(user_dir.iterdir()):
    print(f"    {f.name}  ({f.stat().st_size} bytes)")
print()

config_path = user_dir / "config.json"
if config_path.exists():
    try:
        c = json.loads(config_path.read_text(encoding="utf-8"))
        masked = {k: ("***" if k.lower() in ("password", "password_md5", "token") else v)
                  for k, v in c.items()}
        print(f"config.json:")
        for k, v in masked.items():
            print(f"  {k}: {v}")
    except Exception as e:
        print(f"config.json: PARSE FAILED ({e})")
else:
    print("config.json: MISSING (cannot sync from COROS)")
print()

db = Database(user=uuid)
conn = db._conn

print("--- sync_meta ---")
try:
    rows = conn.execute("SELECT key, value FROM sync_meta").fetchall()
    for r in rows:
        print(f"  {r['key']}: {r['value']}")
    if not rows:
        print("  (empty)")
except Exception as e:
    print(f"  ERROR: {e}")
print()

print("--- recent activities (last 5) ---")
try:
    rows = conn.execute(
        "SELECT label_id, date, sport_type, distance_m, duration_s "
        "FROM activities ORDER BY date DESC LIMIT 5"
    ).fetchall()
    for r in rows:
        print(f"  {r['date'][:19]} sport={r['sport_type']} dist={r['distance_m']} dur={r['duration_s']} id={r['label_id']}")
    if not rows:
        print("  (no activities)")
except Exception as e:
    print(f"  ERROR: {e}")
print()

print("--- recent daily_health (last 5 days) ---")
try:
    rows = conn.execute(
        "SELECT date, rhr, fatigue, ati, cti, training_load_state "
        "FROM daily_health ORDER BY date DESC LIMIT 5"
    ).fetchall()
    for r in rows:
        print(f"  {r['date']} rhr={r['rhr']} fatigue={r['fatigue']} ati={r['ati']} cti={r['cti']} state={r['training_load_state']}")
    if not rows:
        print("  (no daily_health)")
except Exception as e:
    print(f"  ERROR: {e}")
print()

print("--- ability_snapshot (last 3 dates × levels) ---")
try:
    rows = conn.execute(
        "SELECT date, level, dimension, value FROM ability_snapshot "
        "WHERE date IN (SELECT DISTINCT date FROM ability_snapshot ORDER BY date DESC LIMIT 3) "
        "ORDER BY date DESC, level, dimension"
    ).fetchall()
    if not rows:
        print("  (no ability_snapshot)")
    for r in rows:
        print(f"  {r['date']} {r['level']:6} {r['dimension']:25} {r['value']}")
except Exception as e:
    print(f"  ERROR: {e}")
db.close()
