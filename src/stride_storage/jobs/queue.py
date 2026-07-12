"""Dev queue backends + queue factory.

``InMemoryJobQueue`` is a dependency-free ``JobQueue`` for unit tests that
emulates the Azure semantics that matter: visibility timeout (a received-but-
not-deleted message reappears) and a per-message dequeue count (drives poison
detection).

``FileJobQueue`` provides the same dev semantics across processes. Local API
and worker processes do not share Python memory, so the factory uses the file
queue whenever Azure queue storage is not configured.
"""

from __future__ import annotations

import itertools
import json
import os
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
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


def _path_safe(component: str) -> str:
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in component)


class FileJobQueue(JobQueue):
    """Process-shared dev queue with Azure-like lease/retry semantics.

    The queue stores one JSON file per message under ``base_dir`` and uses an
    atomic directory lock for short critical sections. It is intentionally
    small: enough for local development and E2E smoke tests, while prod keeps
    using Azure Storage Queue.
    """

    def __init__(
        self,
        base_dir: str | Path,
        *,
        clock: Callable[[], float] | None = None,
        lock_timeout_s: float = 10.0,
    ) -> None:
        self._base = Path(base_dir)
        self._base.mkdir(parents=True, exist_ok=True)
        self._clock = clock or time.time
        self._lock_dir = self._base / ".lock"
        self._lock_timeout_s = lock_timeout_s

    @contextmanager
    def _lock(self):
        start = time.monotonic()
        while True:
            try:
                self._base.mkdir(parents=True, exist_ok=True)
                os.mkdir(self._lock_dir)
                break
            except FileExistsError:
                if time.monotonic() - start >= self._lock_timeout_s:
                    raise TimeoutError(f"timed out waiting for queue lock {self._lock_dir}")
                time.sleep(0.01)
        try:
            yield
        finally:
            try:
                os.rmdir(self._lock_dir)
            except FileNotFoundError:
                pass

    def _path(self, msg_id: str) -> Path:
        return self._base / f"{_path_safe(msg_id)}.json"

    def _write(self, path: Path, payload: dict[str, Any]) -> None:
        tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
        tmp.write_text(
            json.dumps(payload, ensure_ascii=False, sort_keys=True),
            encoding="utf-8",
        )
        os.replace(tmp, path)

    def _read_all(self) -> list[tuple[Path, dict[str, Any]]]:
        out: list[tuple[Path, dict[str, Any]]] = []
        for path in self._base.glob("*.json"):
            try:
                out.append((path, json.loads(path.read_text(encoding="utf-8"))))
            except (json.JSONDecodeError, OSError):
                continue
        return out

    def enqueue(self, *, job_id: str, partition_key: str, delay_s: int = 0) -> None:
        with self._lock():
            now = self._clock()
            msg_id = uuid.uuid4().hex
            self._write(
                self._path(msg_id),
                {
                    "id": msg_id,
                    "seq": int(now * 1_000_000_000),
                    "job_id": job_id,
                    "partition_key": partition_key,
                    "visible_at": now + max(0, delay_s),
                    "dequeue_count": 0,
                    "lease_token": None,
                },
            )

    def receive(
        self, *, max: int = 1, visibility_timeout_s: int = 300
    ) -> list[QueueMessage]:
        now = self._clock()
        out: list[QueueMessage] = []
        with self._lock():
            rows = sorted(
                self._read_all(),
                key=lambda item: (item[1].get("seq", 0), item[1].get("id", "")),
            )
            for path, msg in rows:
                if len(out) >= max:
                    break
                if float(msg.get("visible_at") or 0) > now:
                    continue
                dequeue_count = int(msg.get("dequeue_count") or 0) + 1
                lease_token = uuid.uuid4().hex
                msg["dequeue_count"] = dequeue_count
                msg["visible_at"] = now + visibility_timeout_s
                msg["lease_token"] = lease_token
                self._write(path, msg)
                out.append(
                    QueueMessage(
                        job_id=str(msg["job_id"]),
                        partition_key=str(msg["partition_key"]),
                        receipt={"id": str(msg["id"]), "lease_token": lease_token},
                        dequeue_count=dequeue_count,
                    )
                )
        return out

    def delete(self, message: QueueMessage) -> None:
        receipt = message.receipt if isinstance(message.receipt, dict) else {}
        msg_id = str(receipt.get("id") or "")
        lease_token = receipt.get("lease_token")
        if not msg_id:
            return
        with self._lock():
            path = self._path(msg_id)
            if not path.exists():
                return
            msg = json.loads(path.read_text(encoding="utf-8"))
            if msg.get("lease_token") != lease_token:
                return
            path.unlink()

    def extend_visibility(
        self, message: QueueMessage, *, visibility_timeout_s: int
    ) -> QueueMessage:
        receipt = message.receipt if isinstance(message.receipt, dict) else {}
        msg_id = str(receipt.get("id") or "")
        lease_token = receipt.get("lease_token")
        if not msg_id:
            return message
        with self._lock():
            path = self._path(msg_id)
            if not path.exists():
                return message
            msg = json.loads(path.read_text(encoding="utf-8"))
            if msg.get("lease_token") != lease_token:
                return message
            next_token = uuid.uuid4().hex
            msg["visible_at"] = self._clock() + visibility_timeout_s
            msg["lease_token"] = next_token
            self._write(path, msg)
            return QueueMessage(
                job_id=message.job_id,
                partition_key=message.partition_key,
                receipt={"id": msg_id, "lease_token": next_token},
                dequeue_count=message.dequeue_count,
            )

    # Test/introspection helper — not part of the JobQueue protocol.
    def depth(self) -> int:
        with self._lock():
            return len(list(self._base.glob("*.json")))


def queue_from_config(
    config: QueueStorageConfig,
    *,
    poison: bool = False,
) -> JobQueue:
    """Azure Storage Queue when ``queue_account_url`` is set, else dev files.

    ``poison=True`` returns the dead-letter queue instead of the main one.
    File-backed dev mode lets local API and worker processes share messages.

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
        file_factory=lambda: FileJobQueue(Path(config.file_backend_dir) / "queues" / name),
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
