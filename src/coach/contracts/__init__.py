"""Coach orchestrator contracts (§3–§4) — pure pydantic, core layer.

The typed handshake between the orchestrator brain (Resolver / Supervisor /
dispatcher / Aggregator) and the domain specialists. No infrastructure imports;
``proposal`` reuses the ``stride_core`` diff primitives only.
"""

from __future__ import annotations

from .artifact import ArtifactRef
from .target import TargetKind, TargetRef
from .specialist import (
    ScopedContext,
    SpecialistCard,
    SpecialistResult,
    SpecialistStatus,
    SpecialistTask,
    UsageStats,
)
from .resolver import (
    Ambiguity,
    IntentHit,
    ResolverDraft,
    ResolverOutput,
    TargetHint,
)
from .plan import CallPlan, SpecialistCall
from .turn import ProposalCard, Turn, TurnResponse
from .memory import AthleteMemory, MemoryKind, MemoryStatus, MemoryWrite
from .registry import SpecialistEntry, SpecialistRegistry, SpecialistRunner

__all__ = [
    # target
    "TargetKind",
    "TargetRef",
    # specialist
    "ArtifactRef",
    "ScopedContext",
    "SpecialistCard",
    "SpecialistResult",
    "SpecialistStatus",
    "SpecialistTask",
    "Turn",
    "UsageStats",
    # resolver
    "Ambiguity",
    "IntentHit",
    "ResolverDraft",
    "ResolverOutput",
    "TargetHint",
    # plan
    "CallPlan",
    "SpecialistCall",
    # turn
    "ProposalCard",
    "TurnResponse",
    # registry
    "SpecialistEntry",
    "SpecialistRegistry",
    "SpecialistRunner",
    # memory
    "AthleteMemory",
    "MemoryKind",
    "MemoryStatus",
    "MemoryWrite",
]
