"""Job handler registrations.

Each submodule defines one or more handlers via ``@job_handler`` (fires at
import time). ``ensure_handlers_registered`` re-registers them idempotently so
app/worker startup repopulates the registry even after tests have cleared it
(the handler modules stay import-cached, so a re-import won't re-run the
decorator). PR1 shipped the infra with only the ``hello`` smoke-test handler;
the onboarding-pipeline steps land here.
"""

from __future__ import annotations

from . import hello  # noqa: F401  (registers the hello_world handler)
from . import onboarding  # noqa: F401  (registers the onboarding pipeline steps)
from ..registry import ensure_registered


def ensure_handlers_registered() -> None:
    """Idempotently (re)register every job handler. Safe to call repeatedly."""
    ensure_registered(hello.HELLO_JOB_TYPE, hello.handle_hello)
    ensure_registered("onboarding_full_sync", onboarding.handle_full_sync)
    ensure_registered("onboarding_calibration", onboarding.handle_calibration)
    ensure_registered("onboarding_backfill", onboarding.handle_backfill)
