"""SQLite per-user data-directory path constants.

The ``Database`` class (schema, upserts, queries) lives in
``stride_storage.sqlite.database``; import it from there. This module keeps
only the path constants (``USER_DATA_DIR`` / ``DB_PATH`` / ``PROJECT_ROOT`` /
``DATA_DIR`` / ``_parse_week_folder_dates``).

They stay HERE — not in ``stride_storage`` — because they are the canonical
location that callers + tests already read and monkeypatch
(``setattr(stride_core.db, "USER_DATA_DIR", tmp)``), and they are pure
(pathlib/regex) so keeping them in ``stride_core`` pulls no storage
implementation into core. ``stride_storage.sqlite.database`` reads them back
lazily at call time (``_paths()``), so a monkeypatch is observed and there is
no import-time cycle. This module imports nothing from ``stride_storage``.
"""

from __future__ import annotations

import re as _re
from pathlib import Path

from platformdirs import user_data_dir

DATA_DIR = Path(user_data_dir("coros-sync"))
DB_PATH = DATA_DIR / "coros.db"

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
USER_DATA_DIR = PROJECT_ROOT / "data"

_WEEK_FOLDER_RE = _re.compile(r"^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})")


def _parse_week_folder_dates(folder: str) -> tuple[str, str] | None:
    """Parse week_folder 'YYYY-MM-DD_MM-DD(...)' -> (start_iso, end_iso) or None.

    Used by ``upsert_planned_sessions`` / ``upsert_planned_nutrition`` to
    delete by date range rather than week_folder string match, which sweeps
    away orphan rows from earlier reparse runs that used a different
    week_folder spelling for the same calendar week.
    """
    m = _WEEK_FOLDER_RE.match(folder)
    if not m:
        return None
    year, smonth, sday, emonth, eday = m.groups()
    start = f"{year}-{smonth}-{sday}"
    # End date: same year, end MM-DD. Handle year wrap (e.g.
    # 2026-12-29_01-04) by checking if end month < start month.
    end_year = int(year) + (1 if int(emonth) < int(smonth) else 0)
    end = f"{end_year:04d}-{emonth}-{eday}"
    return (start, end)
