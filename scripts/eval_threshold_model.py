"""Non-destructive eval of the per-athlete threshold model vs the old 0.06.

Copies a user's coros.db to a temp file (never mutates the real DB), then for
as_of = today reports: old(0.06) vs new(per-athlete k) threshold speed, the
fitted curve (k / CS / D' / indices / confidence), the best-effort envelope, a
6-month drift comparison, and a leave-one-out check that predicts the athlete's
longest genuine effort from their shorter efforts under both exponents.

Usage:
    PYTHONPATH=src python scripts/eval_threshold_model.py <coros.db> [label] [as_of=YYYY-MM-DD]
"""

from __future__ import annotations

import os
import shutil
import sqlite3
import sys
import tempfile
from datetime import date, timedelta

import stride_core.running_calibration.core as core
from stride_core.running_calibration.core import (
    BEST_EFFORT_DURATIONS_S,
    estimate_running_calibration,
)
from stride_core.running_calibration.prediction import (
    fit_speed_duration_model,
    predict_race,
)
from stride_core.running_calibration.segments import best_speed_candidates
from stride_core.running_calibration.sqlite_connector import SQLiteRunningCalibrationRepository


def pace(mps: float | None) -> str:
    if not mps:
        return "n/a"
    s = 1000.0 / mps
    return f"{int(s // 60)}:{int(s % 60):02d}/km ({mps:.3f}mps)"


def _threshold(history, as_of, *, old: bool) -> tuple:
    """Return (threshold_speed, confidence, snapshot). old=True pins 0.06."""
    if old:
        saved = core.fit_speed_duration_model
        core.fit_speed_duration_model = lambda *a, **k: core._empty_model()
        try:
            snap = estimate_running_calibration(history, as_of)
        finally:
            core.fit_speed_duration_model = saved
    else:
        snap = estimate_running_calibration(history, as_of)
    return snap.threshold_speed_mps, snap.threshold_speed_confidence, snap


def _best_by_duration(history, as_of):
    recent = [a for a in history if as_of - timedelta(days=180) <= a.activity_date <= as_of]
    cands = best_speed_candidates(recent, BEST_EFFORT_DURATIONS_S)
    bbd: dict[float, object] = {}
    for c in cands:
        bucket = float(min(BEST_EFFORT_DURATIONS_S, key=lambda d: abs(d - c.duration_s)))
        ex = bbd.get(bucket)
        if ex is None or c.avg_speed_mps > ex.avg_speed_mps:
            bbd[bucket] = c
    return bbd


def main() -> None:
    db_path = sys.argv[1]
    label = sys.argv[2] if len(sys.argv) > 2 else db_path
    as_of = date.fromisoformat(sys.argv[3]) if len(sys.argv) > 3 else date(2026, 6, 28)

    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tmp:
        tmp_path = tmp.name
    shutil.copy2(db_path, tmp_path)
    conn = sqlite3.connect(tmp_path)
    try:
        repo = SQLiteRunningCalibrationRepository(conn)
        history = repo.fetch_history(as_of - timedelta(days=400), as_of)
        _report(label, as_of, history)
    finally:
        conn.close()
        try:
            os.unlink(tmp_path)  # close before unlink so Windows releases the handle
        except OSError:
            pass


def _report(label, as_of, history) -> None:
    print(f"=== {label} === as_of {as_of} | running activities in 400d: {len(history)}")
    if not history:
        print("  (no running history)")
        return

    bbd = _best_by_duration(history, as_of)
    print("best-effort envelope (180d):")
    for d in sorted(bbd):
        c = bbd[d]
        age = (as_of - c.activity.activity_date).days
        print(f"  {d/60:>4.0f}min {pace(c.avg_speed_mps):<22} {c.source:<11} {c.confidence.value:<6} age={age}d")

    model = fit_speed_duration_model(bbd, as_of)
    print(
        f"fitted model: k={model.riegel_k} conf={model.confidence.value} "
        f"CS={pace(model.critical_speed_mps)} D'={model.d_prime_m} "
        f"endurance_idx={model.endurance_index} speed_idx={model.speed_index}"
    )

    old_s, old_c, _ = _threshold(history, as_of, old=True)
    new_s, new_c, new_snap = _threshold(history, as_of, old=False)
    delta = (new_s - old_s) if (old_s and new_s) else None
    print(f"OLD(0.06):  threshold {pace(old_s)} conf={old_c.value}")
    print(f"NEW(per-k): threshold {pace(new_s)} conf={new_c.value}")
    if delta is not None:
        print(f"  delta_new_minus_old: {delta:+.3f} mps  ({'faster' if delta>0 else 'slower'} threshold)")

    # Race predictions from the fitted CS+D' model (no durability) for context.
    if model.critical_speed_mps:
        for dist, name in [(10000, "10K"), (21097, "HM"), (42195, "M")]:
            p = predict_race(model, dist)
            if p:
                print(f"  predict {name}: {int(p.time_s//60)}:{int(p.time_s%60):02d}  {pace(dist/p.time_s)}")

    # Leave-one-out: predict the longest >=30min real effort from shorter efforts.
    long_buckets = sorted(d for d in bbd if d >= 30 * 60)
    if long_buckets:
        target_d = long_buckets[-1]
        target = bbd[target_d]
        shorter = {d: c for d, c in bbd.items() if d < target_d}
        if len(shorter) >= 2:
            m_short = fit_speed_duration_model(shorter, as_of)
            k_new = m_short.riegel_k if m_short.riegel_k is not None else 0.06
            # project the fastest shorter effort to target duration under each k
            ref_d = max(shorter)
            ref = shorter[ref_d]
            def proj(k):
                return ref.avg_speed_mps * (ref_d / target_d) ** k
            pred_new = proj(k_new)
            pred_old = proj(0.06)
            actual = target.avg_speed_mps
            print(
                f"LOO[exponent-only] @ {target_d/60:.0f}min: actual {actual:.3f} | "
                f"old0.06 {pred_old:.3f} (err {abs(pred_old-actual):.3f}) | "
                f"new k={k_new:.3f} {pred_new:.3f} (err {abs(pred_new-actual):.3f})"
                f"  [projects fastest shorter effort with each exponent; CS+D' not used]"
            )

    # 6-month drift comparison.
    print("monthly drift (old vs new threshold):")
    for m in range(1, 7):
        mend = date(2026, m, 28)
        if mend > as_of:
            break
        hist_m = [a for a in history if a.activity_date <= mend]
        if not hist_m:
            continue
        o, oc, _ = _threshold(hist_m, mend, old=True)
        n, nc, _ = _threshold(hist_m, mend, old=False)
        print(f"  {mend}: old {pace(o):<22} new {pace(n):<22} (old {oc.value}/new {nc.value})")


if __name__ == "__main__":
    main()
