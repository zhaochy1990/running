"""Job handler registrations.

Each submodule registers one or more handlers via ``@job_handler``. Importing
this package imports them all (see ``stride_server.jobs.__main__``). PR1 shipped
the infra with no business handlers; ``hello`` is a trivial smoke-test handler,
the onboarding-pipeline handler lands separately.
"""

from __future__ import annotations

from . import hello  # noqa: F401  (registers the hello_world handler)
from . import onboarding  # noqa: F401  (registers the onboarding pipeline steps)
