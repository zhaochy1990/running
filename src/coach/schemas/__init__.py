"""Pydantic + TypedDict schemas shared across coach graphs.

Evaluation schemas (``AxisScore`` / ``JudgeScore`` / ``EvalReport`` /
``FixtureRunOutcome`` / ``aggregate_axis_avg``) previously lived here but
moved out to the dev-only :mod:`coach_eval.schemas` package. The eval
framework is offline-only and must not be importable from production
runtime code (enforced by ``.importlinter``).
"""

from .conversation import (
    AssistantPart,
    ConversationState,
    Message,
    PartKind,
    Role,
    Scope,
    TextPhase,
    ToolCall,
    assistant_parts_from_message,
)
from .continuity import ContinuitySignals
from .job import CoachJob, JobStage, JobStatus, JobType
from .review import ReviewClass, ReviewIssue, ReviewReport, Severity, Verdict
from .season_bundle import PhaseReview, PhaseWeeks, SeasonPlanBundle
from .specialist_context import PaceTargets, VolumeTargets, fmt_pace_s_km
from .tool_result import ToolResult

__all__ = [
    "AssistantPart",
    "ConversationState",
    "Message",
    "PartKind",
    "Role",
    "Scope",
    "TextPhase",
    "ToolCall",
    "assistant_parts_from_message",
    "ContinuitySignals",
    "CoachJob",
    "JobStage",
    "JobStatus",
    "JobType",
    "ReviewClass",
    "ReviewIssue",
    "ReviewReport",
    "Severity",
    "Verdict",
    "PhaseReview",
    "PhaseWeeks",
    "SeasonPlanBundle",
    "PaceTargets",
    "VolumeTargets",
    "fmt_pace_s_km",
    "ToolResult",
]
