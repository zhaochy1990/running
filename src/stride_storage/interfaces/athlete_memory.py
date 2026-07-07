"""Athlete memory storage — backend interface (Tier A).

Dict-based Protocol; the typed ``AthleteMemory`` (de)serialisation lives in the
``AthleteMemoryStore`` facade. Pure typing — no I/O import.
"""

from __future__ import annotations

from typing import Any, Protocol


class AthleteMemoryBackend(Protocol):
    def upsert(self, user_id: str, memory: dict[str, Any]) -> None: ...
    def list_for_user(self, user_id: str) -> list[dict[str, Any]]: ...
    def delete(self, user_id: str, memory_id: str) -> None: ...
