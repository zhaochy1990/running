"""Storage access invariants for the MySQL migration path.

Upper server layers should not reach into SQLite connections or pass raw SQL
through ``Database.query``. Existing call sites are legacy migration debt; this
test freezes that debt so new upper-layer SQL does not creep in while we move
each use case behind ``stride_storage`` APIs.
"""

from __future__ import annotations

import re
from collections import Counter
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "src"
SERVER = SRC / "stride_server"

DIRECT_SQL_RE = re.compile(
    r"\b(?:db\._conn|conn)\.(?:execute|executemany|executescript)\s*\("
    r"|\bdb\.query\s*\("
)

# Legacy upper-layer SQL budget. Do not add to this map for new code. When a
# file is refactored to use storage APIs, lower or remove its entry.
LEGACY_DIRECT_SQL_BUDGET: dict[str, int] = {
    "stride_server/coach_adapters/continuity_analyzer.py": 4,
    "stride_server/coach_adapters/phase_detector.py": 1,
    "stride_server/coach_adapters/season_orchestrator.py": 3,
    "stride_server/coach_adapters/specialist_tools.py": 1,
    "stride_server/coach_adapters/tool_impls/read_impls.py": 14,
    "stride_server/commentary_ai.py": 7,
    "stride_server/master_plan_generator.py": 13,
    "stride_server/notifications/plan_reminder_job.py": 1,
    "stride_server/phase_summary.py": 2,
    "stride_server/routes/ability.py": 1,
    "stride_server/routes/account.py": 1,
    "stride_server/routes/activities.py": 8,
    "stride_server/routes/generate.py": 1,
    "stride_server/routes/health.py": 10,
    "stride_server/routes/home.py": 5,
    "stride_server/routes/onboarding.py": 1,
    "stride_server/routes/plan.py": 5,
    "stride_server/routes/plan_variants.py": 4,
    "stride_server/routes/predictions.py": 6,
    "stride_server/routes/review.py": 4,
    "stride_server/routes/teams.py": 2,
    "stride_server/routes/watch.py": 2,
    "stride_server/routes/weeks.py": 3,
}


def _iter_server_py() -> list[Path]:
    return [p for p in SERVER.rglob("*.py") if "__pycache__" not in p.parts]


def test_upper_layers_do_not_add_direct_sql_access() -> None:
    actual: Counter[str] = Counter()
    locations: list[str] = []

    for path in _iter_server_py():
        rel = path.relative_to(SRC).as_posix()
        text = path.read_text(encoding="utf-8", errors="replace")
        for match in DIRECT_SQL_RE.finditer(text):
            actual[rel] += 1
            line_no = text[: match.start()].count("\n") + 1
            locations.append(f"{rel}:{line_no}")

    new_files = sorted(set(actual) - set(LEGACY_DIRECT_SQL_BUDGET))
    exceeded = {
        rel: (actual[rel], LEGACY_DIRECT_SQL_BUDGET[rel])
        for rel in actual
        if rel in LEGACY_DIRECT_SQL_BUDGET
        and actual[rel] > LEGACY_DIRECT_SQL_BUDGET[rel]
    }

    assert not new_files and not exceeded, (
        "Upper-layer direct SQL access must go through stride_storage APIs. "
        "Refactor new uses into storage methods instead of increasing the "
        "legacy budget.\n"
        f"New files: {new_files}\n"
        f"Exceeded budgets: {exceeded}\n"
        "Current locations:\n" + "\n".join(locations)
    )
