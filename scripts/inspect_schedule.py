"""One-shot diagnostic: list all entities on a date in COROS schedule."""
import sys
from coros_sync.client import CorosClient
from coros_sync.auth import Credentials

user = sys.argv[1] if len(sys.argv) > 1 else "f10bc353-01ab-4db1-af9f-d9305ea9a532"
date = sys.argv[2] if len(sys.argv) > 2 else "20260504"

creds = Credentials.load(user=user)
with CorosClient(creds, user=user) as client:
    data = client.query_schedule(date, date)
    schedule = data.get("data", {})
    print(f"plan_id: {schedule.get('id')}")
    print(f"top-level keys: {sorted(schedule.keys())}")
    programs = schedule.get("programs", []) or []
    print(f"\nprograms: {len(programs)}")
    import json as _json
    for i, p in enumerate(programs[:5]):
        print(f"  prog[{i}] id={p.get('id')} idInPlan={p.get('idInPlan')} name={str(p.get('name'))[:80]!r}")
    entities = schedule.get("entities", []) or []
    print(f"\nentities on {date}: {len(entities)}")
    for i, e in enumerate(entities):
        print(f"\n[{i}] happenDay={e.get('happenDay')} idInPlan={e.get('idInPlan')}")
        bars = e.get("exerciseBarChart", []) or []
        print(f"    exerciseBarChart len={len(bars)}")
        for j, b in enumerate(bars[:5]):
            name = b.get("name") or b.get("overview") or ""
            print(f"      bar[{j}] exerciseType={b.get('exerciseType')} name={name[:80]!r}")
        # Dump full entity keys + values
        import json as _json
        for k, v in sorted(e.items()):
            sv = _json.dumps(v, ensure_ascii=False, default=str)[:120]
            print(f"    {k}: {sv}")
