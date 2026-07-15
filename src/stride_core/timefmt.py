"""Asia/Shanghai timezone conversion — the canonical (and only) place that
knows how to bridge UTC (DB storage) and Asia/Shanghai (user-facing display).

Invariants enforced by this codebase:

- ``activities.date`` and other ISO 8601 timestamp columns in ``coros.db``
  store **UTC** (e.g. ``2026-05-09T10:46:47.600000+00:00``).
- All user-facing day/week classification is **Asia/Shanghai (UTC+8, no DST)**.
- Never compare a UTC ISO timestamp directly against a ``YYYY-MM-DD`` literal —
  the comparison is off by up to 8 hours and silently misclassifies activities
  that occur in the 00:00–07:59 Shanghai window. Use :data:`SHANGHAI_DAY_SQL`
  inside SQL, or :func:`shanghai_day_to_utc_range` in Python.
- Never call ``date.today()`` or ``datetime.now()`` without an explicit
  ``tz=`` argument; on Azure Container Apps the process is UTC and the result
  silently drifts. Use :func:`today_shanghai` instead.

The pytest invariant ``tests/test_timezone_invariants.py`` greps the codebase
for these forbidden patterns and fails CI if they leak back in.
"""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta, timezone

SHANGHAI_TZ = timezone(timedelta(hours=8))

# SQL fragment that converts a UTC-stored ``date`` column into a Shanghai-local
# ``YYYY-MM-DD`` for day/week-boundary comparisons. Drop in wherever you'd
# otherwise have written ``WHERE date >= ?`` against a Shanghai-day literal:
#
#     f"WHERE {SHANGHAI_DAY_SQL} BETWEEN ? AND ?"  with ("2026-05-04", "2026-05-10")
SHANGHAI_DAY_SQL = "date(datetime(date, '+8 hours'))"


def utc_iso_to_shanghai_iso(s: str | None) -> str | None:
    """Convert a UTC ISO 8601 string to Asia/Shanghai ISO 8601 (with ``+08:00``).

    The instant in time is preserved — only the offset notation changes, so
    ``new Date(value)`` on the frontend still resolves to the same moment.
    Returns the input unchanged when it can't be parsed or is empty; this is
    a serialization helper, not a validator.

    >>> utc_iso_to_shanghai_iso("2026-05-08T16:30:00+00:00")
    '2026-05-09T00:30:00+08:00'
    >>> utc_iso_to_shanghai_iso("2026-05-09T10:46:47.600000+00:00")
    '2026-05-09T18:46:47.600000+08:00'
    """
    if not s:
        return s
    try:
        cleaned = s.replace("Z", "+00:00") if s.endswith("Z") else s
        dt = datetime.fromisoformat(cleaned)
    except ValueError:
        return s
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(SHANGHAI_TZ).isoformat()


def shanghai_day_str(value: str | None) -> str:
    """Shanghai calendar day (``YYYY-MM-DD``) for a UTC ISO timestamp.

    The canonical replacement for ``activity["date"][:10]`` / ``raw[:10]``
    patterns in route serializers — those silently drop activities recorded
    in the 00:00–07:59 Shanghai window onto the prior calendar day. Returns
    ``""`` for None/empty input. Unparseable input falls back to the first
    10 characters, matching the prior in-line behavior.

    >>> shanghai_day_str("2026-05-08T18:00:00+00:00")
    '2026-05-09'
    >>> shanghai_day_str(None)
    ''
    """
    return (utc_iso_to_shanghai_iso(value) or "")[:10]


def today_shanghai() -> date:
    """Today's calendar date in Asia/Shanghai. Replaces ``date.today()``,
    which returns the server's TZ — on Azure Container Apps that's UTC, so
    every weekly-stats query was off by 8 hours."""
    return datetime.now(SHANGHAI_TZ).date()


def shanghai_day_to_utc_range(yyyy_mm_dd: str) -> tuple[str, str]:
    """Map a Shanghai calendar day to the UTC ISO range ``[start, end)`` that
    covers it. Use when scanning a UTC-indexed table by Shanghai-day boundary
    without resorting to ``datetime(date, '+8 hours')`` SQL:

        start, end = shanghai_day_to_utc_range("2026-05-09")
        cur.execute("SELECT ... WHERE date >= ? AND date < ?", (start, end))

    >>> shanghai_day_to_utc_range("2026-05-09")
    ('2026-05-08T16:00:00+00:00', '2026-05-09T16:00:00+00:00')
    """
    start_local = datetime.fromisoformat(yyyy_mm_dd).replace(tzinfo=SHANGHAI_TZ)
    end_local = start_local + timedelta(days=1)
    return (
        start_local.astimezone(timezone.utc).isoformat(),
        end_local.astimezone(timezone.utc).isoformat(),
    )


def shanghai_week_range(yyyy_mm_dd_from: str, yyyy_mm_dd_to: str) -> tuple[str, str]:
    """Inclusive Shanghai-day range → half-open UTC ISO range covering the
    whole week. ``date_from`` and ``date_to`` are both Shanghai-local
    ``YYYY-MM-DD`` strings (matching the format used in week-folder names)."""
    start_utc, _ = shanghai_day_to_utc_range(yyyy_mm_dd_from)
    _, end_utc = shanghai_day_to_utc_range(yyyy_mm_dd_to)
    return start_utc, end_utc


_WEEK_FOLDER_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})(?:\([^/\\]*\))?")


def parse_week_folder_dates(folder_name: str) -> tuple[str, str] | None:
    """Parse a week-folder name → its inclusive Shanghai-day bounds.

    ``'2026-04-13_04-19(赛后恢复)'`` → ``('2026-04-13', '2026-04-19')``.

    Canonical single source for week-folder date bounds (``stride_server.deps.
    parse_week_dates`` delegates here; ``coach.*`` / ``stride_core`` callers that
    can't import the server use this directly). ``re.fullmatch`` anchors both
    ends so path-traversal-flavored inputs (``..%2f``) are rejected, and the
    optional ``(...)`` tag may hold anything but a path separator. Weeks that
    cross New Year infer the end year from the month/day rollover."""
    m = _WEEK_FOLDER_RE.fullmatch(folder_name)
    if not m:
        return None
    year = int(m.group(1))
    sm, sd = int(m.group(2)), int(m.group(3))
    em, ed = int(m.group(4)), int(m.group(5))
    end_year = year + 1 if (em, ed) < (sm, sd) else year
    return f"{year}-{sm:02d}-{sd:02d}", f"{end_year}-{em:02d}-{ed:02d}"
