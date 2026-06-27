"""Athlete long-term memory contracts (§5.3, §4.5) — pure pydantic, core layer.

``AthleteMemory`` is a single persistent fact the athlete stated in chat
(injury / constraint / preference / goal / life_event / equipment) that should
survive across sessions and feed future planning. ``MemoryWrite`` is the Memory
Writer's per-fact decision (add / update / resolve).

User-spoken → per CLAUDE.md storage rule these are **forbidden in coros.db**;
they live in Azure Table (dev JSON) via ``AthleteMemoryStore`` — distinct from
algorithmic calibration baselines and the onboarding questionnaire.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

MemoryKind = Literal["injury", "constraint", "preference", "goal", "life_event", "equipment"]
MemoryStatus = Literal["active", "resolved", "expired"]


class AthleteMemory(BaseModel):
    """One persistent athlete fact (§5.3)."""

    id: str
    kind: MemoryKind
    content: str                       # normalised fact: "现迁昆明高原训练，海拔~1900m"
    status: MemoryStatus = "active"
    salience: float = 0.5              # injection-budget ranking weight (0–1)
    affects: list[str] = Field(default_factory=list)  # e.g. ["training_load","pace_target"]
    evidence: str = ""                 # raw quote for traceability
    source_session: str = ""
    created_at: str = ""
    updated_at: str = ""
    expires_at: str | None = None      # soft constraints may expire


class MemoryWrite(BaseModel):
    """Memory Writer's decision for one extracted fact (§4.5).

    ``add`` = new memory; ``update`` = revise an existing one (matched by the
    deterministic dedup pass); ``resolve`` = mark an existing memory resolved
    (e.g. "跟腱已恢复" → the old injury). ``memory.id`` identifies the target for
    update/resolve.
    """

    op: Literal["add", "update", "resolve"]
    memory: AthleteMemory
    confidence: float = 0.5
