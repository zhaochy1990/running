"""CoachEvent — a trusted, server-emitted receipt in a coach thread (§ backend).

Events are *not* model turns and must never masquerade as a ``SystemMessage``.
They are recorded on their own checkpoint channel and surfaced to the client as
``role="event"`` history rows, and projected into later orchestrator context so
the coach knows what the user actually committed to (applied / abandoned a
proposal).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from .target import TargetRef

CoachEventType = Literal[
    "weekly_plan_applied",
    "master_plan_applied",
    "proposal_abandoned",
]
CoachEventStatus = Literal["applied", "abandoned"]


class CoachEvent(BaseModel):
    """A durable, system-authored receipt appended to a coach thread."""

    type: CoachEventType
    status: CoachEventStatus
    created_at: str
    summary: str = ""
    target: TargetRef | None = None
    # Free-form structured detail (folder, plan_id, version, applied op ids…)
    detail: dict = Field(default_factory=dict)

    def to_history_row(self) -> dict:
        """The public ``role="event"`` shape for the session-history endpoint."""
        return {
            "role": "event",
            "event_type": self.type,
            "status": self.status,
            "created_at": self.created_at,
            "summary": self.summary,
            "detail": self.detail,
        }
