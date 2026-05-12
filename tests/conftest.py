"""Shared test fixtures."""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

import pytest

from stride_core.db import Database


@pytest.fixture
def db(tmp_path):
    """In-memory-like SQLite database for testing."""
    db_path = tmp_path / "test.db"
    with Database(db_path) as database:
        yield database
