"""LangChain tool definitions for the STRIDE coach agent."""

from __future__ import annotations

import json
from typing import Any

from stride_core.db import Database
from stride_core.source import DataSource

from .context import (
    load_ability_context,
    load_coach_context,
    load_health_context,
    load_inbody_context,
    load_recent_activities,
    load_week_context,
    load_weekly_volume,
    maybe_sync_user,
)


def _json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, default=str)


def build_tools(user: str, source: DataSource | None = None) -> list[Any]:
    """Build LangChain tools bound to a single authenticated STRIDE user."""
    try:
        from langchain_core.tools import StructuredTool
    except ImportError:
        return []

    def sync_latest() -> str:
        return _json(maybe_sync_user(user, source, enabled=True))

    def coach_context(folder: str | None = None) -> str:
        return _json(load_coach_context(user, folder=folder, source=source, sync_before=False))

    def week_context(folder: str) -> str:
        db = Database(user=user)
        try:
            return _json(load_week_context(user, folder, db))
        finally:
            db.close()

    def recent_activities(limit: int = 80) -> str:
        db = Database(user=user)
        try:
            return _json(load_recent_activities(db, limit=limit))
        finally:
            db.close()

    def health_context(days: int = 120) -> str:
        db = Database(user=user)
        try:
            return _json(load_health_context(db, days=days))
        finally:
            db.close()

    def weekly_volume(weeks: int = 12) -> str:
        db = Database(user=user)
        try:
            return _json(load_weekly_volume(db, weeks=weeks))
        finally:
            db.close()

    def inbody_context() -> str:
        db = Database(user=user)
        try:
            return _json(load_inbody_context(db))
        finally:
            db.close()

    def ability_context(limit: int = 80) -> str:
        db = Database(user=user)
        try:
            return _json(load_ability_context(db, limit=limit))
        finally:
            db.close()

    return [
        StructuredTool.from_function(sync_latest, name="sync_latest", description="Sync latest COROS data for the user."),
        StructuredTool.from_function(coach_context, name="coach_context", description="Load full STRIDE coaching context."),
        StructuredTool.from_function(week_context, name="week_context", description="Load a selected training week's plan, feedback, and activities."),
        StructuredTool.from_function(recent_activities, name="recent_activities", description="Load recent activity summaries."),
        StructuredTool.from_function(health_context, name="health_context", description="Load fatigue, PMC, HRV, and dashboard health context."),
        StructuredTool.from_function(weekly_volume, name="weekly_volume", description="Load weekly running volume trend."),
        StructuredTool.from_function(inbody_context, name="inbody_context", description="Load latest InBody context."),
        StructuredTool.from_function(ability_context, name="ability_context", description="Load running ability model snapshots."),
    ]
