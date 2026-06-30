"""Unified dev-file / prod-Azure backend selection.

Collapses the 8 copies of ``if account_url: azure else file`` that each store
carried. The ``file_factory`` is a caller-supplied callable so the file-only
path never touches the ``azure_factory`` (keeping offline/dev/test azure-free).
"""

from __future__ import annotations

from typing import Callable, TypeVar

T = TypeVar("T")


def choose_backend(
    account_url: str,
    *,
    azure_factory: Callable[[], T],
    file_factory: Callable[[], T],
) -> T:
    """Return the Azure backend when ``account_url`` is set, else the file one.

    Only the chosen factory is invoked, so the unused branch's imports/clients
    are never touched.
    """
    if (account_url or "").strip():
        return azure_factory()
    return file_factory()
