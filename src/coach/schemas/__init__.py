"""Pydantic + TypedDict schemas shared across coach graphs."""

from .conversation import ConversationState, Message, Role, Scope, ToolCall
from .job import CoachJob, JobStage, JobStatus, JobType
from .review import ReviewClass, ReviewIssue, ReviewReport, Severity, Verdict
from .tool_result import ToolResult

__all__ = [
    "ConversationState",
    "Message",
    "Role",
    "Scope",
    "ToolCall",
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
