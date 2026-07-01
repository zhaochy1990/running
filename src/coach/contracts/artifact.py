"""Artifact references returned by specialists and the orchestrator."""

from __future__ import annotations

from pydantic import BaseModel


class ArtifactRef(BaseModel):
    """Reference to heavy output kept out of the orchestrator context (§3.3)."""

    id: str
    kind: str
    uri: str | None = None
    summary: str | None = None
