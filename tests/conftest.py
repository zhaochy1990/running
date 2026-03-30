"""Shared test fixtures."""

import pytest

from coros_sync.db import Database


@pytest.fixture
def db(tmp_path):
    """In-memory-like SQLite database for testing."""
    db_path = tmp_path / "test.db"
    with Database(db_path) as database:
        yield database
