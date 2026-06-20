#!/usr/bin/env python3
"""Compare master-plan sweep results across two (or more) test rounds.

Each round is a directory holding ``master_plan_<model>.json`` files produced by
``scripts/gen_my_master_plan.py`` under a model-sweep. This tool extracts the
structural signals we care about for the S1 redesign and prints a side-by-side
diff so multi-round regressions / improvements are obvious.

Signals per model:
  * start_date + is-Monday (natural-week alignment)
  * end_date / total_weeks
  * phase count + phase-type sequence (entry phase must be the detector's pick)
  * taper length (weeks in the taper phase)
  * milestone count
  * weekly volume bands (hard-coded-volume regression check)
  * output language of free-text fields (must stay Chinese)

Usage
-----
    $env:PYTHONIOENCODING="utf-8"; python scripts/compare_master_plan_rounds.py \
        --round "data/<uid>/testing/runs/round-01_..." \
        --round "data/<uid>/testing/runs/round-02_..."

The last --round is treated as "current"; earlier ones as baselines.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
from pathlib import Path

CJK = re.compile(r"[一-鿿]")


def _weekday_name(d: str) -> str:
    try:
        wd = dt.date.fromisoformat(d).weekday()
        return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][wd]
    except Exception:  # noqa: BLE001
        return "?"


def _weeks_between(a: str, b: str) -> int:
    """Inclusive whole-week count. end_date is the last (inclusive) day, so a
    Mon→Sun 2-week block spans 13 *day-diff* days = (13+1)/7 = 2 weeks."""
    try:
        da, db = dt.date.fromisoformat(a), dt.date.fromisoformat(b)
        return round(((db - da).days + 1) / 7)
    except Exception:  # noqa: BLE001
        return 0


def _has_chinese_freetext(plan: dict) -> bool:
    """True if any free-text/user-facing field carries Chinese (expected)."""
    chunks: list[str] = []
    for p in plan.get("phases", []):
        chunks += [str(p.get("name", "")), str(p.get("focus", ""))]
    for m in plan.get("milestones", []):
        chunks += [str(m.get("description", "")), str(m.get("label", ""))]
    for tp in plan.get("training_principles", []) or []:
        chunks.append(str(tp))
    return any(CJK.search(c) for c in chunks)


def summarize(path: Path) -> dict | None:
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        return {"error": f"{type(exc).__name__}: {exc}"}
    phases = d.get("phases", [])
    taper = next(
        (p for p in phases if (p.get("phase_type") or "").lower() == "taper"), None
    )
    taper_weeks = _weeks_between(taper["start_date"], taper["end_date"]) if taper else 0
    start = d.get("start_date", "?")
    return {
        "start": start,
        "start_wd": _weekday_name(start),
        "end": d.get("end_date", "?"),
        "total_weeks": d.get("total_weeks"),
        "n_phases": len(phases),
        "seq": "→".join((p.get("phase_type") or "?") for p in phases),
        "entry": (phases[0].get("phase_type") if phases else "?"),
        "taper_weeks": taper_weeks,
        "n_milestones": len(d.get("milestones", [])),
        "bands": [
            (p.get("weekly_distance_km_low"), p.get("weekly_distance_km_high"))
            for p in phases
        ],
        "zh": _has_chinese_freetext(d),
        "gen_by": d.get("generated_by", "?"),
    }


def collect(round_dir: Path) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for f in sorted(round_dir.glob("master_plan_*.json")):
        model = f.stem.replace("master_plan_", "")
        out[model] = summarize(f) or {"error": "empty"}
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--round", action="append", required=True, dest="rounds")
    args = ap.parse_args()

    rounds = [Path(r) for r in args.rounds]
    data = [(r.name, collect(r)) for r in rounds]

    all_models = sorted({m for _, c in data for m in c})

    print("=" * 100)
    print("MASTER-PLAN ROUND COMPARISON")
    for i, (name, _) in enumerate(data):
        tag = "BASELINE" if i < len(data) - 1 else "CURRENT"
        print(f"  [{tag}] {name}")
    print("=" * 100)

    # Per-model side-by-side
    for model in all_models:
        print(f"\n■ {model}")
        for name, c in data:
            s = c.get(model)
            if not s:
                print(f"    {name[:34]:<34}  (absent)")
                continue
            if "error" in s:
                print(f"    {name[:34]:<34}  ERROR: {s['error']}")
                continue
            flags = []
            if s["start_wd"] != "Mon":
                flags.append(f"⚠NOT-MON({s['start_wd']})")
            if s["entry"] != "speed":
                flags.append(f"⚠entry={s['entry']}")
            if not s["zh"]:
                flags.append("⚠NO-CHINESE")
            if s["taper_weeks"] > 2:
                flags.append(f"⚠taper={s['taper_weeks']}w")
            flagstr = ("  " + " ".join(flags)) if flags else ""
            print(
                f"    {name[:34]:<34}  start={s['start']}({s['start_wd']}) "
                f"end={s['end']} wks={s['total_weeks']} ph={s['n_phases']} "
                f"taper={s['taper_weeks']}w ms={s['n_milestones']} zh={'Y' if s['zh'] else 'N'}"
                f"{flagstr}"
            )
            print(f"        seq: {s['seq']}")
            print(f"        bands(km): {s['bands']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
