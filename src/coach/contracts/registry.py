"""SpecialistRegistry — the routing + dispatch table (§4.6, §6).

Holds every :class:`SpecialistCard` plus an opaque :class:`SpecialistRunner`
callable per id. Two consumers:

* the Resolver reads :meth:`ids` for its constrained-decoding enum and
  :meth:`cards` for the routing menu (description/tags/examples);
* the dispatcher reads :meth:`runner` to execute a call by id.

The runner is a plain callable (Protocol), so the core registry stays pure — the
adapter layer constructs runners (which touch the DB/LLM) and registers them,
keeping the ``coach.*`` import boundary intact.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from .specialist import SpecialistCard, SpecialistResult, SpecialistTask


@runtime_checkable
class SpecialistRunner(Protocol):
    """Executes a specialist: ``SpecialistTask`` → ``SpecialistResult``.

    Sync for the MVP single-call path; the dispatcher wraps it for parallel
    read fan-out when compound turns land (§4.6).
    """

    def __call__(self, task: SpecialistTask) -> SpecialistResult: ...


@dataclass(frozen=True)
class SpecialistEntry:
    card: SpecialistCard
    runner: SpecialistRunner | None = None


class SpecialistRegistry:
    """In-memory registry of specialist cards + runners."""

    def __init__(self) -> None:
        self._entries: dict[str, SpecialistEntry] = {}

    def register(
        self, card: SpecialistCard, runner: SpecialistRunner | None = None
    ) -> None:
        """Register (or replace) a specialist by its card id."""
        self._entries[card.id] = SpecialistEntry(card=card, runner=runner)

    def __contains__(self, specialist_id: object) -> bool:
        return specialist_id in self._entries

    def __len__(self) -> int:
        return len(self._entries)

    def ids(self) -> list[str]:
        """Registered specialist ids — the Resolver constrained-decoding enum."""
        return list(self._entries.keys())

    def cards(self) -> list[SpecialistCard]:
        """All cards — the routing menu for Resolver/Supervisor prompts."""
        return [entry.card for entry in self._entries.values()]

    def get_card(self, specialist_id: str) -> SpecialistCard:
        return self._require(specialist_id).card

    def get_runner(self, specialist_id: str) -> SpecialistRunner:
        entry = self._require(specialist_id)
        if entry.runner is None:
            raise KeyError(f"specialist {specialist_id!r} has no runner registered")
        return entry.runner

    def _require(self, specialist_id: str) -> SpecialistEntry:
        entry = self._entries.get(specialist_id)
        if entry is None:
            raise KeyError(f"unknown specialist id {specialist_id!r}")
        return entry
