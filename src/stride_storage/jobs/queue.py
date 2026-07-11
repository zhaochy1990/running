"""Dev queue backend + queue factory.

``InMemoryJobQueue`` is a dependency-free ``JobQueue`` for tests/dev that
emulates the Azure semantics that matter: visibility timeout (a received-but-
not-deleted message reappears) and a per-message dequeue count (drives poison
detection). The factory picks Azure vs in-memory via ``choose_backend``.
"""

from __future__ import annotations

import itertools
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from stride_storage.azure.backend_select import choose_backend
from stride_storage.interfaces.jobs import JobQueue, QueueMessage, QueueStorageConfig


@dataclass
class _Msg:
    seq: int
    job_id: str
    partition_key: str
    visible_at: float
    dequeue_count: int = 0


class InMemoryJobQueue(JobQueue):
    """Thread-safe in-process queue with visibility-timeout retry semantics."""

    def __init__(self, *, clock: Callable[[], float] | None = None) -> None:
        self._lock = threading.Lock()
        self._seq = itertools.count(1)
        self._msgs: dict[int, _Msg] = {}
        self._clock = clock or time.monotonic

    def enqueue(self, *, job_id: str, partition_key: str, delay_s: int = 0) -> None:
        with self._lock:
            seq = next(self._seq)
            self._msgs[seq] = _Msg(
                seq=seq,
                job_id=job_id,
                partition_key=partition_key,
                visible_at=self._clock() + max(0, delay_s),
            )

    def receive(
        self, *, max: int = 1, visibility_timeout_s: int = 300
    ) -> list[QueueMessage]:
        now = self._clock()
        out: list[QueueMessage] = []
        with self._lock:
            for msg in sorted(self._msgs.values(), key=lambda m: m.seq):
                if len(out) >= max:
                    break
                if msg.visible_at > now:
                    continue
                msg.dequeue_count += 1
                msg.visible_at = now + visibility_timeout_s
                out.append(
                    QueueMessage(
                        job_id=msg.job_id,
                        partition_key=msg.partition_key,
                        receipt=msg.seq,
                        dequeue_count=msg.dequeue_count,
                    )
                )
        return out

    def delete(self, message: QueueMessage) -> None:
        with self._lock:
            self._msgs.pop(message.receipt, None)

    def extend_visibility(
        self, message: QueueMessage, *, visibility_timeout_s: int
    ) -> QueueMessage:
        with self._lock:
            msg = self._msgs.get(message.receipt)
            if msg is not None:
                msg.visible_at = self._clock() + visibility_timeout_s
        # The in-memory receipt (seq) is stable across renewals.
        return message

    # Test/introspection helper — not part of the JobQueue protocol.
    def depth(self) -> int:
        with self._lock:
            return len(self._msgs)


def queue_from_config(
    config: QueueStorageConfig,
    *,
    poison: bool = False,
) -> JobQueue:
    """Azure Storage Queue when ``queue_account_url`` is set, else in-memory.

    ``poison=True`` returns the dead-letter queue instead of the main one.
    In-memory dev mode shares one process-wide instance per (config, poison).

    This factory is the ONLY place that names a concrete ``JobQueue`` backend.
    To add a broker (Service Bus / Kafka / RabbitMQ), implement ``JobQueue``
    against it in ``stride_storage/azure`` (or a sibling), add a config field
    selecting it, and add a branch here — nothing above this function changes.
    """
    name = config.poison_queue_name if poison else config.queue_name

    def _azure() -> JobQueue:
        from stride_storage.azure.queue_backend import AzureStorageQueue

        return AzureStorageQueue(
            account_url=config.queue_account_url, queue_name=name
        )

    return choose_backend(
        config.queue_account_url,
        azure_factory=_azure,
        file_factory=lambda: _dev_queue(name),
    )


_DEV_QUEUES: dict[str, InMemoryJobQueue] = {}
_DEV_LOCK = threading.Lock()


def _dev_queue(name: str) -> InMemoryJobQueue:
    with _DEV_LOCK:
        q = _DEV_QUEUES.get(name)
        if q is None:
            q = InMemoryJobQueue()
            _DEV_QUEUES[name] = q
        return q


def reset_dev_queues() -> None:
    """Test helper — clear process-wide in-memory dev queues."""
    with _DEV_LOCK:
        _DEV_QUEUES.clear()
