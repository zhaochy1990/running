"""Freeze legacy raw-SQL access outside stride_storage.

Only stride_storage owns database queries. Existing upper-layer access is
legacy migration debt, so this test records the exact debt instead of allowing
new SQL to hide behind a stale upper bound.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parent.parent
SRC = REPO_ROOT / "src"
STORAGE = SRC / "stride_storage"

SQL_CALL_METHODS = frozenset({"execute", "executemany", "executescript", "query"})

# Exact legacy debt after rebasing onto origin/master. Do not add entries for
# new code. Moving a query into stride_storage must remove or lower its entry.
LEGACY_DIRECT_SQL_BUDGET: dict[str, int] = {
    "coros_sync/ability_cli.py": 1,
    "coros_sync/adapter.py": 1,
    "coros_sync/sync.py": 1,
    "garmin_sync/adapter.py": 1,
    "stride_core/ability.py": 6,
    "stride_core/ability_hook.py": 6,
    "stride_core/analyze.py": 7,
    "stride_core/export.py": 1,
    "stride_core/pb_records.py": 3,
    "stride_core/post_sync.py": 3,
    "stride_core/training_load/adapter.py": 9,
    "stride_server/coach_adapters/continuity_analyzer.py": 4,
    "stride_server/coach_adapters/phase_detector.py": 1,
    "stride_server/coach_adapters/season_orchestrator.py": 3,
    "stride_server/coach_adapters/specialist_tools.py": 1,
    "stride_server/coach_adapters/tool_impls/read_impls.py": 4,
    "stride_server/commentary_ai.py": 7,
    "stride_server/master_plan_generator.py": 13,
    "stride_server/phase_summary.py": 2,
    "stride_server/routes/ability.py": 1,
    "stride_server/routes/account.py": 2,
    "stride_server/routes/activities.py": 8,
    "stride_server/routes/health.py": 10,
    "stride_server/routes/home.py": 5,
    "stride_server/routes/onboarding.py": 1,
    "stride_server/routes/plan_variants.py": 2,
    "stride_server/routes/predictions.py": 6,
    "stride_server/routes/review.py": 4,
    "stride_server/routes/teams.py": 2,
    "stride_server/routes/watch.py": 2,
    "stride_server/routes/weeks.py": 3,
}


def _direct_sql_lines(source: str, *, filename: str = "<unknown>") -> list[int]:
    """Return AST line numbers for raw-SQL calls, independent of variable names."""
    tree = ast.parse(source, filename=filename)
    sqlite_modules: set[str] = set()
    sqlite_connects: set[str] = set()

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name == "sqlite3":
                    sqlite_modules.add(alias.asname or alias.name)
        elif isinstance(node, ast.ImportFrom) and node.module == "sqlite3":
            for alias in node.names:
                if alias.name == "connect":
                    sqlite_connects.add(alias.asname or alias.name)

    lines: list[int] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        function = node.func
        if isinstance(function, ast.Attribute):
            if function.attr in SQL_CALL_METHODS:
                lines.append(node.lineno)
            elif (
                function.attr == "connect"
                and isinstance(function.value, ast.Name)
                and function.value.id in sqlite_modules
            ):
                lines.append(node.lineno)
        elif isinstance(function, ast.Name) and function.id in sqlite_connects:
            lines.append(node.lineno)
    return sorted(lines)


def _iter_upper_layer_python_files() -> list[Path]:
    return sorted(
        path
        for path in SRC.rglob("*.py")
        if STORAGE not in path.parents and "__pycache__" not in path.parts
    )


def _current_direct_sql() -> dict[str, list[int]]:
    actual: dict[str, list[int]] = {}
    for path in _iter_upper_layer_python_files():
        lines = _direct_sql_lines(
            path.read_text(encoding="utf-8", errors="replace"),
            filename=str(path),
        )
        if lines:
            actual[path.relative_to(SRC).as_posix()] = lines
    return actual


@pytest.mark.parametrize(
    "source",
    [
        'database._conn.execute("SELECT 1")',
        'connection.execute("SELECT 1")',
        'cursor.executemany("INSERT INTO t VALUES (?)", rows)',
        'store.db.query("SELECT 1")',
        'import sqlite3 as sql\nsql.connect("db.sqlite")',
        'from sqlite3 import connect as open_db\nopen_db("db.sqlite")',
    ],
)
def test_detector_rejects_variable_name_bypasses(source: str) -> None:
    assert _direct_sql_lines(source) == [2 if "\n" in source else 1]


def test_detector_allows_storage_api_calls() -> None:
    source = "repository.fetch_rows()\nstore.get_planned_sessions()"
    assert _direct_sql_lines(source) == []


def test_non_storage_packages_do_not_add_direct_sql_access() -> None:
    actual = _current_direct_sql()
    actual_counts = {path: len(lines) for path, lines in actual.items()}

    assert actual_counts == LEGACY_DIRECT_SQL_BUDGET, (
        "Raw SQL outside stride_storage must be moved behind a storage API. "
        "Do not add or preserve spare budget when legacy calls are removed.\n"
        f"Expected exact legacy debt: {LEGACY_DIRECT_SQL_BUDGET}\n"
        f"Actual direct SQL: {actual_counts}\n"
        "Current locations:\n"
        + "\n".join(
            f"{path}:{line}"
            for path, lines in actual.items()
            for line in lines
        )
    )
