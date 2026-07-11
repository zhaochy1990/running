"""Job handler registrations.

Each submodule registers one or more handlers via ``@job_handler``. Importing
this package imports them all (see ``stride_server.jobs.__main__``). PR1 ships
the infra with no business handlers; the onboarding-pipeline handler lands in a
follow-up PR.
"""

from __future__ import annotations
