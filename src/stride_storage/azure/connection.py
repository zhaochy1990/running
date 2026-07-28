"""Optional shared-key connection string for Azure Storage (Table/Queue/Blob).

When ``STRIDE_AZURE_STORAGE_CONNECTION_STRING`` is set, the Table/Queue/Blob
client factories authenticate with that connection string (shared key) instead
of ``endpoint + DefaultAzureCredential``. This is what lets the app talk to a
local **Azurite** emulator, which does not accept AAD tokens.

Prod leaves it unset and keeps using managed identity via
:func:`stride_storage.azure.credentials.get_credential`. The read is a cheap
``os.environ`` lookup (no caching) so tests can toggle it with ``monkeypatch``.
"""

from __future__ import annotations

import os

ENV_VAR = "STRIDE_AZURE_STORAGE_CONNECTION_STRING"


def get_storage_connection_string() -> str | None:
    """Return the configured storage connection string, or ``None`` if unset.

    A blank / whitespace-only value is treated as unset.
    """
    value = (os.environ.get(ENV_VAR) or "").strip()
    return value or None
