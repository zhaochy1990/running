"""Pydantic + TypedDict schemas shared across coach graphs."""

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
from .job import CoachJob, JobStage, JobStatus, JobType
from .review import ReviewClass, ReviewIssue, ReviewReport, Severity, Verdict
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
    "CoachJob",
    "JobStage",
    "JobStatus",
    "JobType",
    "ReviewClass",
    "ReviewIssue",
    "ReviewReport",
    "Severity",
    "Verdict",
    "ToolResult",
]
