"""Per-week strength training tab data.

Returns the planned strength sessions for a given week joined with
muscle-activation diagrams + Chinese coaching descriptions from the
curated library at ``strength_illustrations/``.

The library is keyed by ``code`` (mostly COROS T-codes). A planned
exercise is matched by ``provider_id`` first, then falling back to
``canonical_id`` via a small mnemonic-alias map. No match → text-only
(image_url=None) but the exercise still renders with ``display_name`` +
sets/target.
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, HTTPException

from stride_core.plan_spec import SessionKind

from ..deps import get_plan_state_store, parse_week_dates
from ..strength_library import lookup as library_lookup

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/api/{user}/weeks/{folder}/strength")
def get_week_strength(user: str, folder: str):
    """Return the strength sessions for a week, each with image+text per exercise.

    Response shape::

        {
          "folder": "2026-05-04_05-10(P1W1)",
          "sessions": [
            {
              "date": "2026-05-04",
              "session_index": 0,
              "summary": "[STRIDE] 力量基线测试（11 项）",
              "notes_md": "...",
              "exercises": [
                {
                  "canonical_id": "single_leg_wall_sit",
                  "display_name": "单腿靠墙静蹲（左/右）",
                  "sets": 2,
                  "target_kind": "time_s",
                  "target_value": 60,
                  "rest_seconds": 30,
                  "note": null,
                  "code": "SL_WALLSIT",
                  "image_url": "/strength_illustrations/output/SL_WALLSIT/v1.png",
                  "name_zh": "单腿靠墙静蹲",
                  "key_points":      ["..."],
                  "muscle_focus":    ["..."],
                  "common_mistakes": ["..."]
                }, ...
              ]
            }, ...
          ]
        }
    """
    if not parse_week_dates(folder):
        raise HTTPException(status_code=400, detail="Invalid folder")

    plan_store = get_plan_state_store(user)
    try:
        date_from, date_to = parse_week_dates(folder)  # type: ignore[misc]
        rows = plan_store.get_planned_sessions(date_from=date_from, date_to=date_to)
    finally:
        plan_store.close()

    sessions = []
    for row in rows:
        if row["kind"] != SessionKind.STRENGTH.value:
            continue
        spec_json = row["spec_json"]
        if not spec_json:
            # Aspirational strength session — still surface the row so the
            # tab isn't empty when only a summary was authored.
            sessions.append({
                "date": row["date"],
                "session_index": row["session_index"],
                "summary": row["summary"],
                "notes_md": row["notes_md"],
                "exercises": [],
            })
            continue

        try:
            spec = json.loads(spec_json)
            raw_exercises = spec.get("exercises", []) or []
        except (ValueError, TypeError):
            logger.warning(
                "strength: bad spec_json on planned_session id=%s, skipping exercises",
                row["id"],
            )
            raw_exercises = []

        rendered = []
        for ex in raw_exercises:
            entry = library_lookup(
                provider_id=ex.get("provider_id"),
                canonical_id=ex.get("canonical_id"),
            )
            rendered.append({
                "canonical_id": ex.get("canonical_id"),
                "display_name": ex.get("display_name"),
                "sets": ex.get("sets"),
                "target_kind": ex.get("target_kind"),
                "target_value": ex.get("target_value"),
                "rest_seconds": ex.get("rest_seconds"),
                "note": ex.get("note"),
                # Library-joined fields (None / empty when unmatched):
                "code": entry.code if entry else None,
                "image_url": entry.image_url if entry else None,
                "name_zh": entry.name_zh if entry else None,
                "key_points": list(entry.key_points) if entry else [],
                "muscle_focus": list(entry.muscle_focus) if entry else [],
                "common_mistakes": list(entry.common_mistakes) if entry else [],
            })

        sessions.append({
            "date": row["date"],
            "session_index": row["session_index"],
            "summary": row["summary"],
            "notes_md": row["notes_md"],
            "exercises": rendered,
        })

    return {"folder": folder, "sessions": sessions}


__all__ = ["router"]
