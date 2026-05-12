"""POST-activity feedback endpoints (D7 screen).

PUT  /api/{user}/activities/{label_id}/feedback  — upsert structured feedback
GET  /api/{user}/activities/{label_id}/feedback  — read feedback (null fields when absent)

Separate from activities.sport_note, which is the COROS-synced raw note field.
"""

from __future__ import annotations

import json
import logging
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, status
from pydantic import BaseModel, field_validator, model_validator

from ..deps import get_db

logger = logging.getLogger(__name__)

router = APIRouter()

# ── Request / Response models ──────────────────────────────────────────────────

class FeedbackBody(BaseModel):
    rpe: int
    mood_tags: list[str] = []
    note: str | None = None

    @field_validator("rpe")
    @classmethod
    def _rpe_range(cls, v: int) -> int:
        if not (1 <= v <= 10):
            raise ValueError("rpe must be between 1 and 10")
        return v

    @field_validator("mood_tags")
    @classmethod
    def _tags_limit(cls, v: list[str]) -> list[str]:
        if len(v) > 10:
            raise ValueError("mood_tags must have at most 10 items")
        for tag in v:
            if len(tag) > 32:
                raise ValueError(f"mood_tag '{tag[:10]}...' exceeds 32 characters")
        return v

    @field_validator("note")
    @classmethod
    def _note_limit(cls, v: str | None) -> str | None:
        if v is not None and len(v) > 200:
            raise ValueError("note must be at most 200 characters")
        return v


class FeedbackResponse(BaseModel):
    label_id: str
    rpe: int | None
    mood_tags: list[str] | None
    note: str | None
    updated_at: str | None


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.put("/api/{user}/activities/{label_id}/feedback", response_model=FeedbackResponse)
def put_feedback(
    user: str,
    label_id: str,
    body: FeedbackBody,
):
    """Upsert structured post-activity feedback for an activity."""
    db = get_db(user)
    try:
        mood_tags_json = json.dumps(body.mood_tags, ensure_ascii=False)
        db._conn.execute(
            """
            INSERT INTO activity_feedback (label_id, rpe, mood_tags, note, created_at, updated_at)
            VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(label_id) DO UPDATE SET
                rpe        = excluded.rpe,
                mood_tags  = excluded.mood_tags,
                note       = excluded.note,
                updated_at = datetime('now')
            """,
            (label_id, body.rpe, mood_tags_json, body.note),
        )
        db._conn.commit()

        row = db._conn.execute(
            "SELECT label_id, rpe, mood_tags, note, updated_at FROM activity_feedback WHERE label_id = ?",
            (label_id,),
        ).fetchone()
    finally:
        db.close()

    if row is None:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Feedback write failed")

    return FeedbackResponse(
        label_id=row["label_id"],
        rpe=row["rpe"],
        mood_tags=json.loads(row["mood_tags"]) if row["mood_tags"] else [],
        note=row["note"],
        updated_at=row["updated_at"],
    )


@router.get("/api/{user}/activities/{label_id}/feedback", response_model=FeedbackResponse)
def get_feedback(
    user: str,
    label_id: str,
):
    """Read post-activity feedback. Returns null fields when no record exists (never 404)."""
    db = get_db(user)
    try:
        row = db._conn.execute(
            "SELECT label_id, rpe, mood_tags, note, updated_at FROM activity_feedback WHERE label_id = ?",
            (label_id,),
        ).fetchone()
    finally:
        db.close()

    if row is None:
        return FeedbackResponse(
            label_id=label_id,
            rpe=None,
            mood_tags=None,
            note=None,
            updated_at=None,
        )

    return FeedbackResponse(
        label_id=row["label_id"],
        rpe=row["rpe"],
        mood_tags=json.loads(row["mood_tags"]) if row["mood_tags"] else [],
        note=row["note"],
        updated_at=row["updated_at"],
    )
