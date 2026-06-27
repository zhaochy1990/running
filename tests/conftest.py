"""Shared test fixtures."""

import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "src")))

import pytest

from stride_core.db import Database


@pytest.fixture(autouse=True)
def _reset_auth_caches():
    """Isolate the process-global auth caches between tests.

    ``bearer`` memoises the resolved public key in module globals and
    ``load_server_config`` is ``@lru_cache``'d. Under pytest-xdist the
    distribution of tests across workers varies run-to-run, so a test that
    populates these caches (e.g. via its own ``monkeypatch.setattr`` on
    ``bearer._cached_public_key`` without also resetting the paired
    ``_cached_public_key_cache_key``, or via a stale ``load_server_config``
    cache) can silently leak the wrong key / config into the *next* test —
    surfacing as a flaky ``401`` ("Bearer verification is not configured" or
    "Invalid token") on a different test each run. Resetting before (and after)
    every test makes per-test env/monkeypatch setup authoritative.
    """
    import stride_server.bearer as bearer
    from stride_server.config.loader import clear_server_config_cache

    def _reset() -> None:
        clear_server_config_cache()
        bearer._cached_public_key = None
        bearer._cached_public_key_cache_key = None
        bearer._warned_open = False

    _reset()
    yield
    _reset()


@pytest.fixture
def db(tmp_path):
    """In-memory-like SQLite database for testing."""
    db_path = tmp_path / "test.db"
    with Database(db_path) as database:
        yield database
