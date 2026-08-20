"""Coach orchestrator contracts (§3–§4) — pure pydantic, core layer.

The typed handshake between the orchestrator brain (Resolver / Supervisor /
dispatcher / Aggregator) and the domain specialists. No infrastructure imports;
``proposals`` reuses the ``stride_core`` diff primitives only.
"""

from __future__ import annotations

from .target import TargetKind, TargetRef
from .review_context import (
    MAX_REVIEW_CONTEXT_BYTES,
    REVIEW_CONTEXT_KEY,
    ReviewContext,
    WeeklyCreateReviewContext,
)
from .events import CoachEvent, CoachEventStatus, CoachEventType
from .specialist import (
    ArtifactRef,
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
from .season_impact import SeasonImpact, SeasonImpactLevel
from .turn import ProposalCard, Turn, TurnResponse
from .memory import AthleteMemory, MemoryKind, MemoryStatus, MemoryWrite
from .registry import SpecialistEntry, SpecialistRegistry, SpecialistRunner

__all__ = [
    # target
    "TargetKind",
    "TargetRef",
    # review context
    "MAX_REVIEW_CONTEXT_BYTES",
    "REVIEW_CONTEXT_KEY",
    "ReviewContext",
    "WeeklyCreateReviewContext",
    # events
    "CoachEvent",
    "CoachEventStatus",
    "CoachEventType",
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
    # season impact
    "SeasonImpact",
    "SeasonImpactLevel",
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
