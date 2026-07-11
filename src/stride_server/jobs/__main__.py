"""Worker process entrypoint: ``python -m stride_server.jobs``.

Deployed as a second container command on the same image. Imports the handler
modules (so their ``@job_handler`` registrations fire) then runs the worker
loop forever.
"""

from __future__ import annotations

import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("stride_server.jobs")


def _register_handlers() -> None:
    """Import handler modules for their registration side effects.

    Handlers live in ``stride_server.jobs.handlers.*`` and self-register via the
    ``@job_handler`` decorator. Import failures are logged, not fatal, so one
    broken handler doesn't take the whole worker down.
    """
    try:
        import stride_server.jobs.handlers  # noqa: F401
    except Exception:  # noqa: BLE001
        logger.exception("failed importing job handlers")


def main() -> None:
    from stride_server.jobs import build_worker, registered_types

    _register_handlers()
    logger.info("registered job handlers: %s", registered_types())
    build_worker().run_forever()


if __name__ == "__main__":
    main()
