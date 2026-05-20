"""Manually trigger a user's sync to surface any underlying error.

Use case: prod cron / app-level sync hasn't fired for a user — run this
to invoke the same code path the API endpoint uses, but with the
exception printed instead of swallowed by the ``return {error: 'sync
failed'}`` shape.
"""
from __future__ import annotations
import argparse, json, logging, re, sys, traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
logger = logging.getLogger(__name__)
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))
from stride_core.db import USER_DATA_DIR
from stride_core.post_sync import run_post_sync_for_result

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
parser.add_argument("--full", action="store_true")
args = parser.parse_args()

uuid = _resolve(args.profile)
config_path = USER_DATA_DIR / uuid / "config.json"
if not config_path.exists():
    print(f"NO config.json at {config_path}")
    sys.exit(1)
config = json.loads(config_path.read_text(encoding="utf-8"))
provider = (config.get("provider") or "coros").lower()
print(f"user: {uuid}")
print(f"provider: {provider}")
print(f"full: {args.full}")
print()

if provider == "garmin":
    from garmin_sync.adapter import GarminDataSource
    source = GarminDataSource()
elif provider == "coros":
    from coros_sync.adapter import CorosDataSource
    source = CorosDataSource()
else:
    print(f"unsupported provider: {provider}")
    sys.exit(1)

print(f"is_logged_in: {source.is_logged_in(uuid)}")
print()

try:
    print("running sync...")
    result = source.sync_user(uuid, full=args.full)
    try:
        run_post_sync_for_result(
            user=uuid,
            provider=source.info.name,
            operation="sync",
            result=result,
        )
    except Exception:
        logger.exception("post-sync events failed for triggered sync user=%s", uuid)
    print(f"  activities: {result.activities}")
    print(f"  health: {result.health}")
    print("done.")
except Exception as e:
    print(f"FAILED: {type(e).__name__}: {e}")
    print()
    traceback.print_exc()
    sys.exit(2)
