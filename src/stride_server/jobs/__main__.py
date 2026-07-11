"""Worker process entrypoint: ``python -m stride_server.jobs``.

Deployed as a second container command on the same image. Imports the handler
modules (so their ``@job_handler`` registrations fire) then runs the worker
loop forever.
"""

from __future__ import annotations

import logging


def _configure_logging() -> None:
    """INFO for our code, WARNING for chatty Azure SDK HTTP logging.

    The azure-* SDKs log every request/response (URL + all headers) at INFO via
    ``azure.core.pipeline.policies.http_logging_policy``. On a worker that polls
    the queue every couple seconds that floods the logs and buries our own
    startup / job lines, so we raise those loggers to WARNING.
    """
    logging.basicConfig(level=logging.INFO)
    for noisy in ("azure", "azure.core.pipeline.policies.http_logging_policy", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


_configure_logging()
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
