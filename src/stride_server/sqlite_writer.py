"""In-process serialization for long per-user SQLite writers.

The API Container App owns dedicated training-load rollout shards. A per-user
lock prevents a sync and a shard from writing the same ``coros.db`` concurrently
inside that process. SQLite still provides the final cross-revision/process lock;
callers translate transient lock errors into retryable HTTP responses.
"""

from __future__ import annotations

from contextlib import contextmanager
from threading import Lock
from typing import Iterator

_LOCKS_GUARD = Lock()
_USER_LOCKS: dict[str, Lock] = {}


def _lock_for(user: str) -> Lock:
    with _LOCKS_GUARD:
        return _USER_LOCKS.setdefault(user, Lock())


def invalidate_training_load_backfill_progress(user: str) -> None:
    """Invalidate a resumable load snapshot before writing watch source data."""
    from stride_storage.sqlite.database import Database

    with Database(user=user) as db:
        db.clear_training_load_backfill_progress()


@contextmanager
def try_user_sqlite_writer(user: str) -> Iterator[bool]:
    """Try to become the API process's sole long-running writer for ``user``."""
    lock = _lock_for(user)
    acquired = lock.acquire(blocking=False)
    try:
        yield acquired
    finally:
        if acquired:
            lock.release()
