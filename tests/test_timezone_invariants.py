"""Invariants enforced on the codebase to prevent silent UTC↔Shanghai
drift bugs from coming back.

The rules:

1. Server routes never compare `activities.date` (or other UTC-ISO timestamp
   columns) against a `YYYY-MM-DD` literal without converting first via
   ``datetime(date, '+8 hours')`` / ``SHANGHAI_DAY_SQL``. The naive
   comparison is off by up to 8 hours and silently misclassifies the
   00:00–07:59 Shanghai window onto the wrong calendar day.

2. Server code never calls ``date.today()`` or ``datetime.now()`` without
   an explicit ``tz=`` argument. On Azure Container Apps the process clock
   is UTC, so the bare call drifts.

3. Activity rows leaving the API have their `date` field converted to
   Shanghai ISO at the serialization boundary (see ``stride_core/timefmt``).

These rules are also documented in ``stride_core/timefmt.py`` and in
``CLAUDE.md`` under "Timezone discipline".

The whitelist below names files that have been audited by a human and
demonstrably do the right thing despite matching one of the forbidden
regexes (e.g. they live inside ``timefmt.py`` itself, or they manipulate
columns that are already Shanghai-local like ``daily_health.date`` /
``weekly_plan.date_from``).

If your CI fails on this test, the fix is almost always one of:
- import + use ``SHANGHAI_DAY_SQL`` from ``stride_core.timefmt``
- import + use ``today_shanghai()`` from ``stride_core.timefmt``
- add the file to ``WHITELIST`` only after another engineer has signed off
  that the column being compared is genuinely Shanghai-local, not UTC.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "src"
SERVER_ROUTES = SRC / "stride_server" / "routes"

# Files allowed to use the otherwise-forbidden patterns. Each entry must be
# accompanied by a reason — drive-by additions to this list should be
# rejected at code review.
WHITELIST: dict[str, str] = {
    # The helper module itself defines the canonical forms.
    "stride_core/timefmt.py": "defines the canonical Shanghai helpers",
    # Plan tables (`weekly_plan.date_from`, `planned_session.date`) and the
    # health daily tables (`daily_health.date`) store Shanghai-local
    # YYYY-MM-DD strings, not UTC ISO — comparing them directly is correct.
    "stride_server/routes/plan.py": "operates on Shanghai-local YYYY-MM-DD plan tables; uses Shanghai TZ helper internally",
    "stride_server/routes/ability.py": "uses explicit _SHANGHAI_TZ; calls datetime(date, '+8 hours') in ability.py core",
    "stride_server/routes/health.py": "queries daily_health.date which is YYYYMMDD Shanghai-local already",
    "stride_server/notifications/plan_reminder_job.py": "uses explicit SHANGHAI_TZ throughout",
    # Sync writes — these convert COROS UTC API → UTC ISO for storage.
    "coros_sync/sync.py": "writes raw UTC timestamps from the COROS API",
    "stride_server/commentary_ai.py": "uses datetime(date, '+8 hours') in SQL where needed",
}


def _read(p: Path) -> str:
    return p.read_text(encoding="utf-8", errors="replace")


def _strip_comments(text: str) -> str:
    """Remove ``# ...`` comments so the invariant regexes don't trip on
    docstring / comment references like ``# date.today() drifts on UTC``.

    Approximates "comment" as "any ``#`` that isn't preceded by an unbalanced
    quote on the same line". Triple-quoted SQL strings don't contain ``#``,
    so this is good enough for our patterns.
    """
    out: list[str] = []
    for line in text.splitlines():
        # Skip if the line contains an unbalanced quote before #, indicating
        # # is likely inside a string literal.
        h = line.find("#")
        if h < 0:
            out.append(line)
            continue
        prefix = line[:h]
        if prefix.count('"') % 2 == 1 or prefix.count("'") % 2 == 1:
            out.append(line)
            continue
        out.append(prefix)
    return "\n".join(out)


def _rel(p: Path) -> str:
    return p.relative_to(SRC).as_posix()


def _iter_py(root: Path):
    return [p for p in root.rglob("*.py") if "__pycache__" not in p.parts]


# ── Rule 1: no naive `date >= 'YYYY-MM-DD'` SQL on UTC-ISO columns ─────────

# Looks for SQL fragments that compare a bare `date` column with a parameter
# placeholder OR with `datetime('now', ...)` — neither converts the LHS into
# Shanghai-local first. False positives are dampened by requiring the
# activities/laps table neighborhood.
_NAIVE_SQL_RE = re.compile(
    r"""WHERE\s+(?:[a-z_]+\.)?date\s*(?:>=|<=|>|<|=|BETWEEN)\s*"""
    r"""(?:\?|datetime\(\s*['"]now)""",
    re.IGNORECASE,
)
_SAFE_SQL_RE = re.compile(
    r"""datetime\(\s*(?:[a-z_]+\.)?date\s*,\s*['"]\+8\s*hours['"]""",
    re.IGNORECASE,
)


def test_no_naive_utc_iso_date_comparison_in_routes():
    """SQL touching activities.date must convert to Shanghai before comparing.

    A line like ``WHERE date >= ?`` is the canonical bug. The replacement is
    ``WHERE date(datetime(date, '+8 hours')) >= ?`` (via SHANGHAI_DAY_SQL).
    """
    offenders: list[str] = []
    for path in _iter_py(SERVER_ROUTES):
        rel = _rel(path)
        if rel in WHITELIST:
            continue
        text = _strip_comments(_read(path))
        # Allow files that also use the safe pattern (the route may have a
        # mix of activities.date queries and other columns).
        has_naive = _NAIVE_SQL_RE.search(text)
        if not has_naive:
            continue
        # If we find a naive comparison AND it's specifically near the word
        # "activities" (the UTC-storing table), flag it.
        for m in _NAIVE_SQL_RE.finditer(text):
            window = text[max(0, m.start() - 200): m.end() + 200]
            if "activities" in window.lower() and not _SAFE_SQL_RE.search(window):
                line_no = text[: m.start()].count("\n") + 1
                offenders.append(f"{rel}:{line_no}: {m.group(0)!r}")
    assert not offenders, (
        "Naive UTC-ISO date comparisons found. Replace with "
        "`date(datetime(date, '+8 hours'))` or SHANGHAI_DAY_SQL.\n"
        + "\n".join(offenders)
    )


# ── Rule 2: no `date.today()` / `datetime.now()` without tz= ──────────────

_DATE_TODAY_RE = re.compile(r"\bdate\.today\(\s*\)")
_DATETIME_NOW_RE = re.compile(r"\bdatetime\.now\(\s*\)")  # bare, no tz=


def test_no_naive_clock_calls_in_src():
    """``date.today()`` and ``datetime.now()`` (no tz) drift on UTC servers.
    Use ``today_shanghai()`` (from ``stride_core.timefmt``) or pass ``tz=``."""
    offenders: list[str] = []
    for path in _iter_py(SRC):
        rel = _rel(path)
        if rel in WHITELIST:
            continue
        text = _strip_comments(_read(path))
        for m in _DATE_TODAY_RE.finditer(text):
            line_no = text[: m.start()].count("\n") + 1
            offenders.append(f"{rel}:{line_no}: date.today()")
        for m in _DATETIME_NOW_RE.finditer(text):
            line_no = text[: m.start()].count("\n") + 1
            offenders.append(f"{rel}:{line_no}: datetime.now() (missing tz=)")
    assert not offenders, (
        "Naive clock calls found. Use today_shanghai() or pass tz=.\n"
        + "\n".join(offenders)
    )


# ── Rule 4: no `[:10]` slicing on a UTC-ISO `date` field in routes/ ───────

# Catches two common shapes:
#   a["date"][:10]
#   (a.get("date") or "")[:10]    /   a.get("date").something[:10]
# Both yield a UTC-local YYYY-MM-DD, mis-bucketing the 00:00–07:59 Shanghai
# window onto the prior calendar day. The fix is to route the value through
# ``utc_iso_to_shanghai_iso(...)`` before slicing.
_DATE_DICT_SLICE_RE = re.compile(
    r"""\[\s*['"]date['"]\s*\]\s*\[\s*:\s*10\s*\]"""
)
_DATE_GET_SLICE_RE = re.compile(
    r"""\.get\(\s*['"]date['"]\s*\)[^\n]*?\[\s*:\s*10\s*\]"""
)
_SAFE_SLICE_RE = re.compile(r"""utc_iso_to_shanghai_iso\(""")


def test_no_naive_slice_on_activity_date_in_routes():
    """``a["date"][:10]`` returns the UTC calendar day, not Shanghai —
    activities recorded between 00:00 and 07:59 Shanghai (16:00–23:59 UTC the
    day before) are silently misfiled. Route the value through
    ``utc_iso_to_shanghai_iso(...)`` from ``stride_core.timefmt`` first."""
    offenders: list[str] = []
    for path in _iter_py(SERVER_ROUTES):
        rel = _rel(path)
        if rel in WHITELIST:
            continue
        text = _strip_comments(_read(path))
        for regex in (_DATE_DICT_SLICE_RE, _DATE_GET_SLICE_RE):
            for m in regex.finditer(text):
                # Allow the safe pattern when the match is preceded on the
                # same line by ``utc_iso_to_shanghai_iso(``.
                line_start = text.rfind("\n", 0, m.start()) + 1
                line_end = text.find("\n", m.end())
                if line_end < 0:
                    line_end = len(text)
                line = text[line_start:line_end]
                if _SAFE_SLICE_RE.search(line):
                    continue
                line_no = text[: m.start()].count("\n") + 1
                offenders.append(f"{rel}:{line_no}: {m.group(0)!r}")
    assert not offenders, (
        "Naive `[:10]` slice on a UTC-ISO `date` field. Wrap with "
        "`utc_iso_to_shanghai_iso(...)` from `stride_core.timefmt` before "
        "slicing, or the Shanghai 00:00–07:59 window gets misfiled.\n"
        + "\n".join(offenders)
    )


# ── Rule 3: the timefmt module exposes the documented helpers ─────────────


def test_timefmt_api_surface():
    """If someone deletes or renames a helper the documentation references,
    catch it here before a route silently breaks."""
    from stride_core import timefmt

    for name in (
        "SHANGHAI_TZ",
        "SHANGHAI_DAY_SQL",
        "utc_iso_to_shanghai_iso",
        "shanghai_day_str",
        "today_shanghai",
        "shanghai_day_to_utc_range",
        "shanghai_week_range",
    ):
        assert hasattr(timefmt, name), f"stride_core.timefmt is missing {name}"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
