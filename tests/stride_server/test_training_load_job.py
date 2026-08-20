"""Architecture guard for the dedicated training-load rollout job type."""

from __future__ import annotations


def test_training_load_backfill_is_not_a_worker_handler() -> None:
    from stride_server.jobs.handlers import ensure_handlers_registered
    from stride_server.jobs.registry import get_handler

    ensure_handlers_registered()

    assert get_handler("training_load_backfill") is None
