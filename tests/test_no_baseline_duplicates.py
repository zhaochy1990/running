"""Guard against future duplication of athlete-baseline computations.

See CLAUDE.md HARD rule 'Athlete baseline metrics — single source'.

If you are adding a new file that legitimately needs an inline RHR / hrmax
computation with a different semantic (like the onboarding seed value),
add it to the WHITELIST below with a one-line justification.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).parent.parent
SRC = REPO_ROOT / "src"


# Files allowed to contain RHR P10 patterns (the canonical implementation).
WHITELIST_RHR_P10 = {
    "stride_core/running_calibration/core.py",  # canonical estimate_rhr_baseline
}

# Files allowed to contain a hrmax-from-history computation.
WHITELIST_HRMAX_LOCAL = {
    "stride_core/running_calibration/core.py",      # canonical estimate_hrmax_profile
    "stride_core/running_calibration/segments.py",  # uses hrmax_estimate as input, not as computation
}

# Onboarding's P25/30d seed-value computation is intentionally different from
# the trained baseline (P10/90d). Documented exception in CLAUDE.md.
ONBOARDING_SEED = "stride_server/routes/onboarding.py"


def _walk_py(root: Path):
    for p in root.rglob("*.py"):
        if any(part in {"__pycache__"} for part in p.parts):
            continue
        yield p


def test_no_inline_rhr_p10_outside_running_calibration():
    """Forbids inline 'SELECT rhr FROM daily_health' + sort + P10-index patterns
    outside the canonical computation.
    """
    pattern_select_rhr = re.compile(
        r"SELECT\s+rhr\s+FROM\s+daily_health", re.IGNORECASE
    )
    pattern_p10_idx = re.compile(
        r"len\([^)]+\)\s*\*\s*0\.1"
    )
    offenders: list[str] = []
    for path in _walk_py(SRC):
        rel = path.relative_to(SRC).as_posix()
        if rel in WHITELIST_RHR_P10 or rel == ONBOARDING_SEED:
            continue
        text = path.read_text(encoding="utf-8")
        if pattern_select_rhr.search(text) and pattern_p10_idx.search(text):
            offenders.append(rel)
    assert not offenders, (
        f"Found inline RHR-P10 computation outside running_calibration: {offenders}. "
        "Replace with: SQLiteRunningCalibrationRepository(db).fetch_latest().rhr_baseline. "
        "See CLAUDE.md 'Athlete baseline metrics — single source'."
    )


def test_no_local_estimate_hrmax_function():
    """Forbids any `def _estimate_hrmax(` outside running_calibration."""
    pattern = re.compile(r"def\s+_estimate_hrmax\s*\(")
    offenders: list[str] = []
    for path in _walk_py(SRC):
        rel = path.relative_to(SRC).as_posix()
        if rel in WHITELIST_HRMAX_LOCAL:
            continue
        if pattern.search(path.read_text(encoding="utf-8")):
            offenders.append(rel)
    assert not offenders, (
        f"Found `_estimate_hrmax` outside running_calibration: {offenders}. "
        "Use running_calibration.estimate_hrmax_profile or "
        "SQLiteRunningCalibrationRepository(db).fetch_latest().hrmax_estimate."
    )


def test_no_local_estimate_critical_power():
    pattern = re.compile(r"def\s+_estimate_critical_power\s*\(")
    offenders: list[str] = []
    for path in _walk_py(SRC):
        rel = path.relative_to(SRC).as_posix()
        if rel == "stride_core/running_calibration/core.py":
            continue
        if pattern.search(path.read_text(encoding="utf-8")):
            offenders.append(rel)
    assert not offenders, (
        f"Found `_estimate_critical_power` outside running_calibration: {offenders}."
    )


def test_no_hr_max_185_magic_default():
    """The hardcoded `hr_max: int = 185` default in compute_ability_snapshot
    is gone — any reintroduction must go through review.
    """
    pattern = re.compile(r"hr_max\s*:\s*int\s*=\s*185")
    offenders: list[str] = []
    for path in _walk_py(SRC):
        if pattern.search(path.read_text(encoding="utf-8")):
            offenders.append(path.relative_to(SRC).as_posix())
    assert not offenders, (
        f"Reintroduced `hr_max: int = 185` magic default in {offenders}. "
        "Use `hr_max: int | None = None` + `_resolve_hr_max(db, date)`."
    )
