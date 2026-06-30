"""Reusable Azure Table connection — lazy, thread-safe, create-table-once.

Collapses the identical ``_get_client`` blocks that every Table-backed store
(likes / master_plan / athlete_memory / notifications / coach persistence)
re-implemented. Uses the shared :func:`get_credential`.

The ``azure-*`` imports live inside :meth:`AzureTableConnection.table` so that
constructing the connection object (and importing this module) stays
azure-free until the first real network use.
"""

from __future__ import annotations

import logging
import threading
from typing import Any

from stride_storage.azure.credentials import get_credential

logger = logging.getLogger(__name__)


class AzureTableConnection:
    """Lazy handle to one Azure Table.

    The first call to :meth:`table` constructs a ``TableServiceClient`` with
    the shared credential, attempts a one-time ``create_table`` (tolerating
    "already exists"), and caches the resulting ``TableClient``.
    """

    def __init__(self, account_url: str, table_name: str) -> None:
        self._account_url = account_url
        self._table_name = table_name
        self._client: Any | None = None
        self._lock = threading.Lock()

    def table(self) -> Any:
        if self._client is not None:
            return self._client
        with self._lock:
            if self._client is not None:
                return self._client
            from azure.core.exceptions import ResourceExistsError
            from azure.data.tables import TableServiceClient

            service = TableServiceClient(
                endpoint=self._account_url,
                credential=get_credential(),
            )
            try:
                service.create_table(self._table_name)
            except ResourceExistsError:
                pass
            except Exception as exc:  # noqa: BLE001 — log + proceed with client
                logger.warning(
                    "azure table create_table failed (assuming it exists) "
                    "table=%s: %s",
                    self._table_name,
                    exc,
                )
            self._client = service.get_table_client(self._table_name)
            return self._client
