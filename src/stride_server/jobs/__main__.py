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
        from stride_server.jobs.handlers import ensure_handlers_registered

        ensure_handlers_registered()
    except Exception:  # noqa: BLE001
        logger.exception("failed importing job handlers")


def main() -> None:
    from stride_server.jobs import build_worker, registered_types
    from stride_server.jobs.pipelines import load_pipelines, registered_pipelines

    _register_handlers()
    logger.info("registered job handlers: %s", registered_types())
    # Load + validate pipeline defs AFTER handlers register (so the job_type
    # check sees them). Fail-fast: a bad definition must abort the worker, not
    # silently run without pipelines.
    load_pipelines()
    logger.info("loaded pipelines: %s", registered_pipelines())
    build_worker().run_forever()


if __name__ == "__main__":
    main()
