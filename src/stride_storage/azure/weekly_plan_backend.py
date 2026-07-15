"""Structured WeeklyPlan storage backends (Azure Table + JSON file).

The current plan and its audit history are deliberately different stores:
``strideweeklyplan`` holds one current entity per ``(user_id, week_folder)``;
``strideweeklyversions`` remains the append-only Coach adjustment history.
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from stride_core import db as core_db
from stride_core.plan_spec import WeeklyPlan
from stride_core.timefmt import parse_week_folder_dates
from stride_storage.azure.backend_select import choose_backend
from stride_storage.azure.table_backend import AzureTableConnection
from stride_storage.interfaces.config import WeeklyPlanStorageConfig
from stride_storage.interfaces.weekly_plan import WeeklyPlanStore

DEFAULT_TABLE_NAME = "strideweeklyplan"
MAX_TABLE_STRING_UTF16_BYTES = 64 * 1024


def _plans_file() -> Path:
    return core_db.USER_DATA_DIR / ".weekly_plans.json"


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _bounds(plan: WeeklyPlan) -> tuple[str, str]:
    bounds = parse_week_folder_dates(plan.week_folder)
    if bounds is None:
        raise ValueError(f"invalid weekly plan folder {plan.week_folder!r}")
    return bounds


def _canonical_plan(plan: WeeklyPlan) -> WeeklyPlan:
    """Validate invariants shared by every canonical storage backend."""
    date_from, date_to = _bounds(plan)
    identities: set[tuple[str, int]] = set()
    for session in plan.sessions:
        if not date_from <= session.date <= date_to:
            raise ValueError(
                f"session {session.date}/{session.session_index} is outside "
                f"weekly plan {plan.week_folder!r}"
            )
        identity = (session.date, session.session_index)
        if identity in identities:
            raise ValueError(f"duplicate planned session identity {identity!r}")
        identities.add(identity)
    for nutrition in plan.nutrition:
        if not date_from <= nutrition.date <= date_to:
            raise ValueError(
                f"nutrition {nutrition.date} is outside weekly plan {plan.week_folder!r}"
            )
    return replace(
        plan,
        sessions=tuple(
            replace(session, scheduled_workout_id=None) for session in plan.sessions
        ),
    )


def _plan_json(plan: WeeklyPlan) -> str:
    payload = json.dumps(plan.to_dict(), ensure_ascii=False, separators=(",", ":"))
    # Azure Table string properties are capped at 64 KiB encoded as UTF-16.
    if len(payload.encode("utf-16-le")) > MAX_TABLE_STRING_UTF16_BYTES:
        raise ValueError("weekly plan JSON exceeds Azure Table 64 KiB property limit")
    return payload


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class FileWeeklyPlanStore(WeeklyPlanStore):
    """JSON-file backend for local development and tests."""

    def __init__(self) -> None:
        self._lock = threading.Lock()

    def save_plan(
        self, user_id: str, plan: WeeklyPlan, *, generated_by: str | None = None,
        source_hash: str | None = None,
    ) -> None:
        plan = _canonical_plan(plan)
        date_from, date_to = _bounds(plan)
        with self._lock:
            data = _read_json(_plans_file())
            data.setdefault(user_id, {})[plan.week_folder] = {
                "date_from": date_from,
                "date_to": date_to,
                "generated_by": generated_by,
                "source_hash": source_hash,
                "updated_at": _now_iso(),
                "plan": json.loads(_plan_json(plan)),
            }
            _write_json(_plans_file(), data)

    def get_plan(self, user_id: str, folder: str) -> WeeklyPlan | None:
        raw = _read_json(_plans_file()).get(user_id, {}).get(folder)
        if not isinstance(raw, dict) or not isinstance(raw.get("plan"), dict):
            return None
        return WeeklyPlan.from_dict(raw["plan"])

    def get_generated_by(self, user_id: str, folder: str) -> str | None:
        raw = _read_json(_plans_file()).get(user_id, {}).get(folder)
        if not isinstance(raw, dict):
            return None
        value = raw.get("generated_by")
        return str(value) if value is not None else None

    def get_source_hash(self, user_id: str, folder: str) -> str | None:
        raw = _read_json(_plans_file()).get(user_id, {}).get(folder)
        if not isinstance(raw, dict):
            return None
        value = raw.get("source_hash")
        return str(value) if value is not None else None

    def get_current_plan(self, user_id: str, on_date: str) -> WeeklyPlan | None:
        rows = _read_json(_plans_file()).get(user_id, {})
        matches = [
            raw
            for raw in rows.values()
            if isinstance(raw, dict)
            and str(raw.get("date_from", "")) <= on_date <= str(raw.get("date_to", ""))
        ]
        if not matches:
            return None
        latest = max(matches, key=lambda raw: str(raw.get("updated_at", "")))
        plan = latest.get("plan")
        return WeeklyPlan.from_dict(plan) if isinstance(plan, dict) else None

    def list_plans(self, user_id: str) -> list[WeeklyPlan]:
        rows = _read_json(_plans_file()).get(user_id, {})
        valid = [
            raw
            for raw in rows.values()
            if isinstance(raw, dict) and isinstance(raw.get("plan"), dict)
        ]
        valid.sort(key=lambda raw: str(raw.get("date_from", "")), reverse=True)
        return [WeeklyPlan.from_dict(raw["plan"]) for raw in valid]

    def delete_user(self, user_id: str) -> int:
        with self._lock:
            data = _read_json(_plans_file())
            bucket = data.pop(user_id, {})
            if bucket:
                _write_json(_plans_file(), data)
            return len(bucket) if isinstance(bucket, dict) else 0


class AzureTableWeeklyPlanStore(WeeklyPlanStore):
    """Azure Table backend: PartitionKey=user_id, RowKey=week_folder."""

    def __init__(self, account_url: str, table_name: str) -> None:
        self._plans = AzureTableConnection(account_url, table_name)

    def save_plan(
        self, user_id: str, plan: WeeklyPlan, *, generated_by: str | None = None,
        source_hash: str | None = None,
    ) -> None:
        from azure.data.tables import UpdateMode

        plan = _canonical_plan(plan)
        date_from, date_to = _bounds(plan)
        entity = {
            "PartitionKey": user_id,
            "RowKey": plan.week_folder,
            "kind": "plan",
            "date_from": date_from,
            "date_to": date_to,
            "plan_json": _plan_json(plan),
            "updated_at": _now_iso(),
        }
        if generated_by is not None:
            entity["generated_by"] = generated_by
        if source_hash is not None:
            entity["source_hash"] = source_hash
        self._plans.table().upsert_entity(entity, mode=UpdateMode.REPLACE)

    def get_plan(self, user_id: str, folder: str) -> WeeklyPlan | None:
        from azure.core.exceptions import ResourceNotFoundError

        try:
            entity = self._plans.table().get_entity(
                partition_key=user_id, row_key=folder
            )
        except ResourceNotFoundError:
            return None
        return WeeklyPlan.from_dict(json.loads(entity["plan_json"]))

    def get_generated_by(self, user_id: str, folder: str) -> str | None:
        from azure.core.exceptions import ResourceNotFoundError

        try:
            entity = self._plans.table().get_entity(
                partition_key=user_id, row_key=folder
            )
        except ResourceNotFoundError:
            return None
        value = entity.get("generated_by")
        return str(value) if value is not None else None

    def get_source_hash(self, user_id: str, folder: str) -> str | None:
        from azure.core.exceptions import ResourceNotFoundError

        try:
            entity = self._plans.table().get_entity(
                partition_key=user_id, row_key=folder
            )
        except ResourceNotFoundError:
            return None
        value = entity.get("source_hash")
        return str(value) if value is not None else None

    def get_current_plan(self, user_id: str, on_date: str) -> WeeklyPlan | None:
        entities = list(
            self._plans.table().query_entities(
                (
                    "PartitionKey eq @pk and kind eq @kind "
                    "and date_from le @day and date_to ge @day"
                ),
                parameters={"pk": user_id, "kind": "plan", "day": on_date},
            )
        )
        if not entities:
            return None
        entities.sort(key=lambda row: str(row.get("updated_at", "")), reverse=True)
        return WeeklyPlan.from_dict(json.loads(entities[0]["plan_json"]))

    def list_plans(self, user_id: str) -> list[WeeklyPlan]:
        entities = list(
            self._plans.table().query_entities(
                "PartitionKey eq @pk and kind eq @kind",
                parameters={"pk": user_id, "kind": "plan"},
            )
        )
        entities.sort(key=lambda row: str(row.get("date_from", "")), reverse=True)
        return [WeeklyPlan.from_dict(json.loads(row["plan_json"])) for row in entities]

    def delete_user(self, user_id: str) -> int:
        rows = list(
            self._plans.table().query_entities(
                "PartitionKey eq @pk", parameters={"pk": user_id}
            )
        )
        for row in rows:
            self._plans.table().delete_entity(
                partition_key=row["PartitionKey"], row_key=row["RowKey"]
            )
        return len(rows)


def store_from_config(config: WeeklyPlanStorageConfig) -> WeeklyPlanStore:
    account_url = config.table_account_url.strip()
    table_name = config.table_name.strip() or DEFAULT_TABLE_NAME
    return choose_backend(
        account_url,
        azure_factory=lambda: AzureTableWeeklyPlanStore(account_url, table_name),
        file_factory=FileWeeklyPlanStore,
    )
