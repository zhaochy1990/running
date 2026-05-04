"""Multi-variant weekly plan API.

Five protected endpoints for the multi-variant feature (see
`.omc/plans/multi-variant-weekly-plans.md` § "后端 — API routes"):

  POST   /api/{user}/plan/{folder}/variants       — append-only ingest
  GET    /api/{user}/plan/{folder}/variants       — list + ratings + selectability
  POST   /api/{user}/plan/variants/{vid}/rate     — upsert ratings (per-user)
  POST   /api/{user}/plan/{folder}/select         — promote variant to canonical
  DELETE /api/{user}/plan/{folder}/variants       — clear all variants for a week

All endpoints sit under `protected_user` in `app.py` (Bearer + path-user
verification). The `select` route uses Step 1's
`db.select_weekly_plan_variant` which runs the FALLBACK promote design
(per Step 0 spike Phase B exp 2 outcome — no re-stitch; all prior_map
entries are marked `abandoned_by_promote_at`).
"""
from __future__ import annotations

import json
import logging
import sqlite3
from typing import Any

from fastapi import APIRouter, Body, HTTPException, Query, Request, Response

from stride_core.plan_spec import (
    SUPPORTED_SCHEMA_VERSION,
    WeeklyPlan,
)

from ..deps import get_db, get_plan_state_store

logger = logging.getLogger(__name__)
router = APIRouter()


# Cap on the markdown body of a variant. Same threshold as routes/plan.py
# (64 KiB) — defensive against prompt-injection / cost runaway.
_MAX_VARIANT_MD_BYTES = 64 * 1024


# ─────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────


def _selectability(row) -> tuple[bool, str | None]:
    """Mirror the rules `select_weekly_plan_variant` enforces server-side
    so the GET response can pre-disable the select button in the UI.
    """
    if row["superseded_at"] is not None:
        return False, "superseded"
    if row["variant_parse_status"] != "fresh":
        return False, "parse_failed"
    if row["schema_version"] != SUPPORTED_SCHEMA_VERSION:
        return False, "schema_outdated"
    return True, None


def _structured_payload(structured_json: str | None) -> tuple[list, list]:
    """Decode the variant's structured JSON into (sessions, nutrition)
    lists for the GET response. Returns ([], []) on null / invalid.
    """
    if not structured_json:
        return [], []
    try:
        data = json.loads(structured_json)
    except json.JSONDecodeError:
        return [], []
    return data.get("sessions") or [], data.get("nutrition") or []


def _ratings_for_user(plan_store, variant_id: int, user: str) -> tuple[dict[str, int], str | None]:
    """Aggregate this user's ratings for a variant into a dict keyed by
    dimension. Comments are kept in the most recent row's `comment`.
    Returns ({}, None) if the user hasn't rated this variant.
    """
    rs = plan_store.get_variant_ratings(variant_id)
    user_rows = [r for r in rs if r["rated_by"] == user]
    if not user_rows:
        return {}, None
    out: dict[str, int] = {}
    comment: str | None = None
    for r in user_rows:
        out[r["dimension"]] = r["score"]
        if r["comment"]:
            comment = r["comment"]
    return out, comment


# ─────────────────────────────────────────────────────────────────────────
# POST /api/{user}/plan/{folder}/variants — append-only ingest
# ─────────────────────────────────────────────────────────────────────────


@router.post("/api/{user}/plan/{folder}/variants")
def post_variant(user: str, folder: str, payload: dict = Body(...)):
    """Ingest a single variant from the local CLI.

    Body shape:
      {
        "schema_version": int,
        "model_id": str,
        "content_md": str,
        "structured": dict | None,        # WeeklyPlan.to_dict(); None → parse_failed
        "generation_metadata": dict | None
      }
    """
    schema_version = payload.get("schema_version")
    model_id = payload.get("model_id")
    content_md = payload.get("content_md")
    structured = payload.get("structured")
    generation_metadata = payload.get("generation_metadata")

    if not isinstance(schema_version, int):
        raise HTTPException(status_code=422, detail="schema_version (int) required")
    if not isinstance(model_id, str) or not model_id.strip():
        raise HTTPException(status_code=422, detail="model_id (non-empty str) required")
    if not isinstance(content_md, str):
        raise HTTPException(status_code=422, detail="content_md (str) required")
    if structured is not None and not isinstance(structured, dict):
        raise HTTPException(status_code=422, detail="structured must be a dict or null")
    if generation_metadata is not None and not isinstance(generation_metadata, dict):
        raise HTTPException(status_code=422, detail="generation_metadata must be a dict or null")

    if len(content_md.encode("utf-8")) > _MAX_VARIANT_MD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"content_md exceeds {_MAX_VARIANT_MD_BYTES} bytes",
        )

    if schema_version != SUPPORTED_SCHEMA_VERSION:
        raise HTTPException(
            status_code=426,
            detail={
                "error": "schema_version_mismatch",
                "client_version": schema_version,
                "server_version": SUPPORTED_SCHEMA_VERSION,
                "hint": "请升级 coros-sync 到与服务端一致的 schema_version",
            },
        )

    # Validate `structured` strictly via WeeklyPlan.from_dict. When it's
    # None the variant is recorded as parse_failed (still browsable, but
    # unselectable).
    sessions_count = 0
    nutrition_days = 0
    structured_json: str | None = None
    variant_parse_status = "parse_failed"
    if structured is not None:
        try:
            plan = WeeklyPlan.from_dict(structured)
        except (KeyError, ValueError, TypeError) as e:
            raise HTTPException(
                status_code=400,
                detail={"error": "invalid_structured_plan", "reason": str(e)},
            )
        if plan.week_folder != folder:
            raise HTTPException(
                status_code=400,
                detail={
                    "error": "structured_week_folder_mismatch",
                    "expected": folder,
                    "got": plan.week_folder,
                },
            )
        sessions_count = len(plan.sessions)
        nutrition_days = len(plan.nutrition)
        structured_json = json.dumps(plan.to_dict())
        variant_parse_status = "fresh"

    db = get_db(user)
    plan_store = get_plan_state_store(user)
    try:
        # Capture the prior active variant id for this (week, model) BEFORE
        # the helper supersedes it — the response advertises which row got
        # demoted so the UI can show "your previous claude variant was
        # archived".
        # NOTE: variant-management queries via raw SQL on `db._conn` are
        # pre-existing tech debt; folding them into the store is a separate
        # follow-up. They stay route-local for this commit so the
        # diff focuses on the abstracted call sites only.
        prior = db._conn.execute(
            """SELECT id FROM weekly_plan_variant
                   WHERE week_folder = ? AND model_id = ?
                     AND superseded_at IS NULL""",
            (folder, model_id),
        ).fetchone()
        prior_id = prior["id"] if prior else None

        variant_id = plan_store.insert_weekly_plan_variant(
            week_folder=folder,
            model_id=model_id,
            content_md=content_md,
            structured_json=structured_json,
            schema_version=schema_version,
            variant_parse_status=variant_parse_status,
            generation_metadata_json=json.dumps(generation_metadata)
            if generation_metadata is not None else None,
        )

        # variant_index = position among active rows for this week (1-based
        # from creation order — i.e., the "Nth fresh variant").
        index_row = db._conn.execute(
            """SELECT COUNT(*) AS n FROM weekly_plan_variant
                   WHERE week_folder = ? AND superseded_at IS NULL
                     AND id <= ?""",
            (folder, variant_id),
        ).fetchone()
        variant_index = (index_row["n"] - 1) if index_row else 0

        resp: dict[str, Any] = {
            "variant_id": variant_id,
            "variant_index": variant_index,
            "variant_parse_status": variant_parse_status,
            "sessions_count": sessions_count,
            "nutrition_days": nutrition_days,
        }
        if prior_id is not None:
            resp["superseded_variant_id"] = prior_id
        return resp
    finally:
        plan_store.close()
        db.close()


# ─────────────────────────────────────────────────────────────────────────
# GET /api/{user}/plan/{folder}/variants — list with ratings + selectability
# ─────────────────────────────────────────────────────────────────────────


@router.get("/api/{user}/plan/{folder}/variants")
def list_variants(
    user: str,
    folder: str,
    include_superseded: bool = Query(default=False),
):
    plan_store = get_plan_state_store(user)
    try:
        rows = plan_store.get_weekly_plan_variants(
            folder, include_superseded=include_superseded,
        )
        wp = plan_store.get_weekly_plan_row(folder)
        selected_variant_id = None
        if wp is not None:
            try:
                selected_variant_id = wp["selected_variant_id"]
            except (IndexError, KeyError):
                selected_variant_id = None

        # Compute variant_index across ACTIVE rows only — superseded rows
        # don't get a position; mark theirs as None so UI can hide it.
        active_ids = [
            r["id"] for r in rows if r["superseded_at"] is None
        ]
        active_index = {vid: i for i, vid in enumerate(active_ids)}

        variants_payload: list[dict[str, Any]] = []
        for r in rows:
            sessions, nutrition = _structured_payload(r["structured_json"])
            ratings, comment = _ratings_for_user(plan_store, r["id"], user)
            selectable, reason = _selectability(r)
            v: dict[str, Any] = {
                "variant_id": r["id"],
                "variant_index": active_index.get(r["id"]),
                "model_id": r["model_id"],
                "schema_version": r["schema_version"],
                "variant_parse_status": r["variant_parse_status"],
                "content_md": r["content_md"],
                "sessions": sessions,
                "nutrition": nutrition,
                "ratings": ratings,
                "rating_comment": comment,
                "is_selected": (r["id"] == selected_variant_id),
                "generated_at": r["generated_at"],
                "generation_metadata": json.loads(r["generation_metadata_json"])
                if r["generation_metadata_json"] else None,
                "selectable": selectable,
            }
            if reason is not None:
                v["unselectable_reason"] = reason
            if r["superseded_at"] is not None:
                v["superseded_at"] = r["superseded_at"]
            variants_payload.append(v)

        return {
            "week_folder": folder,
            "selected_variant_id": selected_variant_id,
            "variants": variants_payload,
        }
    finally:
        plan_store.close()


# ─────────────────────────────────────────────────────────────────────────
# POST /api/{user}/plan/variants/{variant_id}/rate — upsert per-user ratings
# ─────────────────────────────────────────────────────────────────────────


_VALID_RATING_DIMENSIONS = frozenset(
    {"suitability", "structure", "nutrition", "difficulty", "overall"}
)


@router.post("/api/{user}/plan/variants/{variant_id}/rate")
def rate_variant(user: str, variant_id: int, payload: dict = Body(...)):
    ratings = payload.get("ratings")
    comment = payload.get("comment")
    if not isinstance(ratings, dict) or not ratings:
        raise HTTPException(
            status_code=422,
            detail="ratings (non-empty dict of dimension->score) required",
        )
    if comment is not None and not isinstance(comment, str):
        raise HTTPException(status_code=422, detail="comment must be str or null")

    for dim, score in ratings.items():
        if dim not in _VALID_RATING_DIMENSIONS:
            raise HTTPException(
                status_code=422,
                detail=f"unknown rating dimension {dim!r}; "
                       f"valid: {sorted(_VALID_RATING_DIMENSIONS)}",
            )
        if not isinstance(score, int) or not (1 <= score <= 5):
            raise HTTPException(
                status_code=422,
                detail=f"score for {dim!r} must be int 1..5, got {score!r}",
            )

    plan_store = get_plan_state_store(user)
    try:
        if plan_store.get_weekly_plan_variant(variant_id) is None:
            raise HTTPException(
                status_code=404,
                detail={"error": "variant_not_found", "variant_id": variant_id},
            )
        for dim, score in ratings.items():
            plan_store.upsert_variant_rating(
                variant_id, dim, score, comment=comment, rated_by=user,
            )
        current, current_comment = _ratings_for_user(plan_store, variant_id, user)
        return {
            "variant_id": variant_id,
            "ratings": current,
            "rating_comment": current_comment,
        }
    finally:
        plan_store.close()


# ─────────────────────────────────────────────────────────────────────────
# POST /api/{user}/plan/{folder}/select — promote variant to canonical
# ─────────────────────────────────────────────────────────────────────────


def _http_for_select_error(result: dict) -> HTTPException:
    """Map select_weekly_plan_variant's structured error envelope to
    canonical HTTP statuses.
    """
    err = result.get("error")
    if err == "selection_conflict":
        return HTTPException(
            status_code=409,
            detail={
                "error": err,
                "already_pushed_count": result.get("already_pushed_count"),
                "hint": result.get("hint"),
            },
        )
    if err == "variant_schema_outdated":
        return HTTPException(
            status_code=426,
            detail={
                "error": err,
                "variant_version": result.get("variant_version"),
                "server_version": result.get("server_version"),
                "hint": "请重新生成本周 variants",
            },
        )
    if err == "variant_not_found":
        return HTTPException(status_code=404, detail={"error": err,
                              "variant_id": result.get("variant_id")})
    if err in ("variant_wrong_week", "variant_parse_failed", "variant_superseded"):
        return HTTPException(status_code=400, detail=result)
    # Unknown error envelope — bubble as 500 so we notice in monitoring.
    return HTTPException(status_code=500, detail=result)


@router.post("/api/{user}/plan/{folder}/select")
def select_variant(
    user: str,
    folder: str,
    response: Response,
    payload: dict = Body(...),
):
    variant_id = payload.get("variant_id")
    force = payload.get("force", False)
    if not isinstance(variant_id, int):
        raise HTTPException(status_code=422, detail="variant_id (int) required")
    if not isinstance(force, bool):
        raise HTTPException(status_code=422, detail="force must be bool")

    plan_store = get_plan_state_store(user)
    try:
        try:
            result = plan_store.select_weekly_plan_variant(
                user=user, week_folder=folder, variant_id=variant_id, force=force,
            )
        except sqlite3.OperationalError as e:
            if "locked" in str(e).lower():
                # Phase B exp 3 path — surface as 409 with Retry-After.
                response.headers["Retry-After"] = "1"
                raise HTTPException(
                    status_code=409,
                    detail={
                        "error": "concurrent_select",
                        "retry_after_s": 1,
                        "hint": "another select is in progress — retry shortly",
                    },
                )
            raise

        if not result.get("ok"):
            raise _http_for_select_error(result)

        # Happy path. Includes no_change=true on idempotent re-select.
        return {
            "ok": True,
            "no_change": result.get("no_change", False),
            "week_folder": folder,
            "selected_variant_id": result["selected_variant_id"],
            "dropped_scheduled_workout_ids":
                result.get("dropped_scheduled_workout_ids", []),
        }
    finally:
        plan_store.close()


# ─────────────────────────────────────────────────────────────────────────
# DELETE /api/{user}/plan/{folder}/variants — clear all variants for a week
# ─────────────────────────────────────────────────────────────────────────


@router.delete("/api/{user}/plan/{folder}/variants")
def delete_variants(user: str, folder: str):
    db = get_db(user)
    plan_store = get_plan_state_store(user)
    try:
        # If the currently selected variant for this week is one of the
        # variants we're about to delete, null it out first so the
        # `weekly_plan.selected_variant_id` doesn't dangle.
        wp = plan_store.get_weekly_plan_row(folder)
        selected_id = None
        if wp is not None:
            try:
                selected_id = wp["selected_variant_id"]
            except (IndexError, KeyError):
                selected_id = None
        if selected_id is not None:
            row = db._conn.execute(
                "SELECT week_folder FROM weekly_plan_variant WHERE id = ?",
                (selected_id,),
            ).fetchone()
            if row is not None and row["week_folder"] == folder:
                db._conn.execute(
                    """UPDATE weekly_plan
                           SET selected_variant_id = NULL,
                               selected_at = NULL,
                               updated_at = datetime('now')
                       WHERE week = ?""",
                    (folder,),
                )
                db._conn.commit()

        deleted = plan_store.delete_weekly_plan_variants(folder)
        return {"deleted_variants": deleted}
    finally:
        plan_store.close()
        db.close()
