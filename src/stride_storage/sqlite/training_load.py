"""Read-only SQLite helpers for training-load rollout."""

from __future__ import annotations

from pathlib import Path
import sqlite3


_SOURCE_TABLES = ("activities", "daily_health")


def has_training_load_source(db_path: Path) -> bool:
    """Return whether an existing database contains rollout source data.

    SQLite may create coordination sidecars when reading a live WAL database.
    ``immutable=1`` is intentionally not used because these files can change.
    """
    uri = f"{db_path.resolve().as_uri()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    try:
        conn.execute("PRAGMA query_only=ON")
        tables = {
            str(row[0])
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        for table in _SOURCE_TABLES:
            if table in tables and conn.execute(
                f"SELECT 1 FROM {table} LIMIT 1"
            ).fetchone():
                return True
        return False
    finally:
        conn.close()
