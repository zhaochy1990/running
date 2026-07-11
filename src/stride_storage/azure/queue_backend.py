"""Azure Storage Queue backend for the async-job queue layer.

Mirrors ``azure/blob_backend.py`` / ``azure/table_backend.py``: all ``azure.*``
imports are lazy (inside functions) so importing this module stays azure-free,
and the shared :func:`get_credential` is reused.

Message body is a small JSON pointer ``{"job_id", "user_id"}`` — the full state
lives in the JobStore. Retry is native: an un-deleted message reappears after
the visibility timeout; ``dequeue_count`` past the poison ceiling routes to the
poison queue (handled by the worker, which owns the ceiling policy).
"""

from __future__ import annotations

import base64
import json
from functools import lru_cache
from typing import Any

from stride_storage.azure.credentials import get_credential
from stride_storage.interfaces.jobs import QueueMessage


@lru_cache(maxsize=4)
def _get_queue_client(account_url: str, queue_name: str) -> Any:
    """Cached ``QueueClient`` for ``(account_url, queue_name)``; creates queue once."""
    from azure.core.exceptions import ResourceExistsError
    from azure.storage.queue import QueueClient

    client = QueueClient(
        account_url=account_url, queue_name=queue_name, credential=get_credential()
    )
    try:
        client.create_queue()
    except ResourceExistsError:
        pass
    return client


def reset_queue_client_cache() -> None:
    """Test helper — drop cached queue clients."""
    _get_queue_client.cache_clear()


def _encode(job_id: str, user_id: str) -> str:
    # Base64 keeps the body safe regardless of the queue's message-encoding policy.
    raw = json.dumps({"job_id": job_id, "user_id": user_id}, ensure_ascii=False)
    return base64.b64encode(raw.encode("utf-8")).decode("ascii")


def _decode(body: str) -> dict[str, str]:
    try:
        raw = base64.b64decode(body).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        raw = body  # tolerate a plain-JSON body
    return json.loads(raw)


class AzureStorageQueue:
    """``JobQueue`` over Azure Storage Queue."""

    def __init__(self, *, account_url: str, queue_name: str) -> None:
        self._account_url = account_url
        self._queue_name = queue_name

    def _client(self) -> Any:
        return _get_queue_client(self._account_url, self._queue_name)

    def enqueue(self, *, job_id: str, user_id: str, delay_s: int = 0) -> None:
        self._client().send_message(
            _encode(job_id, user_id),
            visibility_timeout=delay_s if delay_s > 0 else None,
        )

    def receive(
        self, *, max: int = 1, visibility_timeout_s: int = 300
    ) -> list[QueueMessage]:
        msgs = self._client().receive_messages(
            max_messages=max, visibility_timeout=visibility_timeout_s
        )
        out: list[QueueMessage] = []
        for m in msgs:
            data = _decode(m.content)
            out.append(
                QueueMessage(
                    job_id=data["job_id"],
                    user_id=data["user_id"],
                    receipt=(m.id, m.pop_receipt),
                    dequeue_count=int(getattr(m, "dequeue_count", 1) or 1),
                )
            )
        return out

    def delete(self, message: QueueMessage) -> None:
        msg_id, pop_receipt = message.receipt
        self._client().delete_message(msg_id, pop_receipt)
