"""Verify the canonical Daniels VDOT → marathon-time table against the
underlying Daniels formulas (`daniels_vo2_required` + `daniels_pct_vo2max`).

For each VDOT in the file's table, numerically solve the equilibrium
    pct(T) * VDOT == vo2_required(42195, T)   (T in seconds)
via bisection over T in [60 min, 600 min].

Print (VDOT, file_T_min, computed_T_min, delta_min) to expose any
systematic miscalibration in the published table.
"""
from __future__ import annotations

import math
import sys
import os

# Make the repo's src/ importable when run as `python spike/verify_daniels_table.py`.
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.normpath(os.path.join(HERE, "..", "src"))
if SRC not in sys.path:
    sys.path.insert(0, SRC)

from stride_core.ability import (  # noqa: E402
    DANIELS_VDOT_TO_MARATHON_S,
    daniels_pct_vo2max,
    daniels_vo2_required,
)


MARATHON_M = 42195.0


def equilibrium_residual(vdot: float, time_s: float) -> float:
    """f(T) = pct(T)*VDOT − vo2_required(42195, T).

    At the equilibrium time T*, f(T*) = 0. f is monotonically increasing in T:
    longer T → pct↑ (left side ↑) and slower v → vo2_required↓ (right side ↓).
    """
    pct = daniels_pct_vo2max(time_s)
    vo2 = daniels_vo2_required(MARATHON_M, time_s)
    return pct * vdot - vo2


def solve_marathon_time_s(vdot: float) -> float:
    """Bisection over [60 min, 600 min] to find T such that residual(VDOT, T)=0."""
    lo = 60 * 60.0
    hi = 600 * 60.0
    f_lo = equilibrium_residual(vdot, lo)
    f_hi = equilibrium_residual(vdot, hi)
    # f_lo should be negative (T too small → pct·VDOT < vo2_req: VDOT must work
    # too hard at marathon pace), f_hi positive.
    if f_lo == 0:
        return lo
    if f_hi == 0:
        return hi
    if f_lo * f_hi > 0:
        raise RuntimeError(
            f"VDOT {vdot}: bracket failure (f({lo})={f_lo:.3f}, f({hi})={f_hi:.3f})"
        )
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        f_mid = equilibrium_residual(vdot, mid)
        if abs(f_mid) < 1e-9 or (hi - lo) < 1e-3:
            return mid
        if f_lo * f_mid < 0:
            hi, f_hi = mid, f_mid
        else:
            lo, f_lo = mid, f_mid
    return 0.5 * (lo + hi)


def hms(total_s: float) -> str:
    s = int(round(total_s))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}"


def main() -> int:
    print(f"{'VDOT':>4}  {'file_T (s)':>10}  {'file_T':>9}  "
          f"{'formula_T (s)':>13}  {'formula_T':>9}  {'delta_min':>10}")
    print("-" * 70)
    deltas: list[float] = []
    for vdot in sorted(DANIELS_VDOT_TO_MARATHON_S.keys()):
        file_t = DANIELS_VDOT_TO_MARATHON_S[vdot]
        formula_t = solve_marathon_time_s(float(vdot))
        delta_s = file_t - formula_t
        deltas.append(delta_s)
        print(f"{vdot:>4}  {file_t:>10}  {hms(file_t):>9}  "
              f"{formula_t:>13.1f}  {hms(formula_t):>9}  "
              f"{delta_s/60:>+10.2f}")
    avg_delta_min = sum(deltas) / len(deltas) / 60.0
    print("-" * 70)
    print(f"avg delta_min = {avg_delta_min:+.2f} min  (file − formula)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
