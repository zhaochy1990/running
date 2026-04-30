"""Workout push endpoints — translate-and-send to the user's bound watch.

The body is the JSON form of a `NormalizedRunWorkout` (see
`stride_core.workout_spec`). The adapter resolved by `get_source_for_user`
translates it into provider-specific payloads internally — this route is
provider-agnostic.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, status

from stride_core.source import Capability, DataSource, FeatureNotSupported
from stride_core.workout_spec import NormalizedRunWorkout

from ..bearer import require_bearer
from ..deps import get_source_for_user

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/api/{user}/workout/run")
def push_run_workout(
    user: str,
    body: dict[str, Any] = Body(...),
    source: DataSource = Depends(get_source_for_user),
    _claims: dict = Depends(require_bearer),
):
    """Push a `NormalizedRunWorkout` to the user's watch via the bound adapter.

    Request body is the JSON form of `NormalizedRunWorkout` (see
    `stride_core/workout_spec.py::NormalizedRunWorkout.from_dict`):

        {
          "name": "[STRIDE] Easy 5K",
          "date": "2026-05-07",        # ISO YYYY-MM-DD
          "note": null,
          "blocks": [
            {
              "repeat": 1,
              "steps": [
                {
                  "step_kind": "work",          # warmup | work | recovery | cooldown | rest
                  "duration": {"kind": "distance_m", "value": 5000},
                  "target":   {"kind": "open"},
                  "note": null
                }
              ]
            }
          ]
        }

    Response: `{ok, provider, provider_workout_id}`. The watch picks the
    workout up on its next sync.

    Errors:
      - 400 if the body fails NormalizedRunWorkout validation
      - 400 if the user's bound adapter doesn't declare PUSH_RUN_WORKOUT
      - 502 if the watch service rejects the push (auth expired, transient
        upstream failure, payload shape mismatch)
    """
    # Translate JSON body → strongly-typed NormalizedRunWorkout. The dataclass
    # constructors validate date format + non-empty blocks; surface as 400.
    try:
        workout = NormalizedRunWorkout.from_dict(body)
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid NormalizedRunWorkout body: {exc}",
        )

    if Capability.PUSH_RUN_WORKOUT not in source.info.capabilities:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"Provider {source.info.name!r} does not support pushing run workouts"
            ),
        )

    try:
        provider_workout_id = source.push_run_workout(user, workout)
    except FeatureNotSupported:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Provider {source.info.name!r} does not support pushing run workouts",
        )
    except Exception:
        # Auth / network / payload errors all collapse to 502 here. The
        # underlying cause stays in the server log; the route stays
        # provider-agnostic for the caller.
        logger.exception(
            "push_run_workout failed for user=%s provider=%s",
            user, source.info.name,
        )
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Could not push workout to watch service",
        )

    return {
        "ok": True,
        "provider": source.info.name,
        "provider_workout_id": provider_workout_id,
    }
