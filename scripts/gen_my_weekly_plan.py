#!/usr/bin/env python3
"""Generate a weekly training plan locally from an athlete's current data.

This script calls the same deterministic creation service used by the Coach
weekly-plan specialist. It reads the active master-plan week, recent completed
training, current STRIDE load, body composition, and nutrition preferences,
then builds and safety-validates a canonical ``WeeklyPlan``.

Nothing is persisted to ``WeeklyPlanStore`` and no Coach job is created. Each
result is written only to ``data/{user_id}/weekly_plan_draft.json`` unless an
output override is configured below.

Run::

    $env:PYTHONIOENCODING="utf-8"; python scripts/gen_my_weekly_plan.py

Set ``COACH_DEBUG=1`` for detailed generator logs. Before generating, sync the
athlete's data with ``python -m coros_sync -P <profile> sync``.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[1]
_SRC = _REPO_ROOT / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from stride_core.plan_spec import WeeklyPlan
from stride_core.timefmt import today_shanghai
from stride_server.weekly_plan_generator import (
    GeneratedWeeklyPlan,
    WeeklyPlanAlreadyExistsError,
    build_weekly_plan,
)


# ---------------------------------------------------------------------------
# EDIT ME — athletes + target weeks
# ---------------------------------------------------------------------------

# ``week_start`` must be a Monday in YYYY-MM-DD form. Set it to None to use the
# current Shanghai calendar week. ``base_distance_km=None`` lets the production
# generator resolve mileage from the active master plan, recent actual volume,
# and current STRIDE load. Set ``allow_existing=True`` only when intentionally
# drafting a replacement for a week already present in WeeklyPlanStore.
users: list[dict[str, Any]] = [
    {
        "user_id": "f10bc353-01ab-4db1-af9f-d9305ea9a532",
        "week_start": None,
        "base_distance_km": None,
        "allow_existing": False,
        # Optional output override. Defaults to
        # data/{user_id}/weekly_plan_draft.json.
        # "weekly_plan_out": "data/f10bc353-01ab-4db1-af9f-d9305ea9a532/weekly_plan_draft.json",
    },
]


DEBUG = os.environ.get("COACH_DEBUG") == "1"
logger = logging.getLogger(__name__)


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw)
    except ValueError:
        print(f"Ignoring invalid {name}={raw!r}; using {default}")
        return default


MAX_WORKERS = max(1, _env_int("WEEKLY_PLAN_MAX_WORKERS", 2))


def _current_week_start() -> date:
    today = today_shanghai()
    return today - timedelta(days=today.weekday())


def _parse_week_start(value: Any) -> date:
    if value is None:
        parsed = _current_week_start()
    elif isinstance(value, date):
        parsed = value
    elif isinstance(value, str):
        try:
            parsed = date.fromisoformat(value)
        except ValueError as exc:
            raise ValueError(
                f"week_start must use YYYY-MM-DD, got {value!r}"
            ) from exc
    else:
        raise ValueError(
            f"week_start must be a date, YYYY-MM-DD string, or None; got {value!r}"
        )
    if parsed.weekday() != 0:
        raise ValueError(f"week_start must be a Monday, got {parsed.isoformat()}")
    return parsed


def _base_distance(value: Any) -> float | None:
    if value is None:
        return None
    try:
        distance = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"base_distance_km must be numeric, got {value!r}") from exc
    if distance <= 0:
        raise ValueError("base_distance_km must be greater than zero")
    return distance


def _output_path_for_user(user_id: str, user_config: dict[str, Any]) -> Path:
    configured = user_config.get("weekly_plan_out") or os.environ.get(
        "WEEKLY_PLAN_OUT"
    )
    if configured:
        return Path(str(configured)).resolve()
    return _REPO_ROOT / "data" / user_id / "weekly_plan_draft.json"


def _generate_for_user(user_config: dict[str, Any]) -> int:
    user_id = str(user_config["user_id"])
    week_start = _parse_week_start(user_config.get("week_start"))
    base_distance_km = _base_distance(user_config.get("base_distance_km"))
    allow_existing = bool(user_config.get("allow_existing", False))

    print(
        f"Generating weekly plan for user={user_id!r}, "
        f"week_start={week_start.isoformat()} ..."
    )
    generated = build_weekly_plan(
        user_id=user_id,
        week_start=week_start,
        base_distance_km=base_distance_km,
        allow_existing=allow_existing,
    )

    payload = generated.plan.to_dict()
    plan = WeeklyPlan.from_dict(payload)
    out_path = _output_path_for_user(user_id, user_config)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps(plan.to_dict(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    try:
        shown_path = out_path.relative_to(_REPO_ROOT)
    except ValueError:
        shown_path = out_path
    run_sessions = [session for session in plan.sessions if session.kind.value == "run"]
    print(f"  Wrote draft → {shown_path}")
    print(
        f"  {plan.week_folder} | {generated.total_distance_km:.1f} km | "
        f"{len(run_sessions)} runs | {len(plan.sessions)} sessions"
    )
    for session in plan.sessions:
        print(f"    {session.date} [{session.kind.value}] {session.summary}")
    return 0


def _run_user_config(user_config: dict[str, Any]) -> tuple[str, int]:
    user_label = str(user_config.get("user_id") or "unknown")
    try:
        return user_label, _generate_for_user(user_config)
    except KeyError as exc:
        print(f"\n  Bad users entry for {user_label}: missing key {exc!s}")
    except WeeklyPlanAlreadyExistsError as exc:
        print(
            f"\n  Weekly plan already exists for {user_label}: {exc.folder}. "
            "Set allow_existing=True to generate a replacement draft."
        )
    except (OSError, ValueError) as exc:
        print(f"\n  Weekly-plan generation failed for {user_label}: {exc}")
    except Exception as exc:  # noqa: BLE001 — keep other configured users running
        print(f"\n  Unexpected error for {user_label}: {type(exc).__name__}: {exc}")
        logger.exception("weekly-plan generation failed for %s", user_label)
    return user_label, 1


def main() -> int:
    if not users:
        print("No users configured. Add entries to the users list.")
        return 1
    if len(users) > 1 and os.environ.get("WEEKLY_PLAN_OUT"):
        print(
            "WEEKLY_PLAN_OUT cannot be used with multiple users; "
            "set per-user weekly_plan_out instead."
        )
        return 1

    logging.basicConfig(
        level=logging.INFO if DEBUG else logging.WARNING,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        force=True,
    )
    failures: list[str] = []
    if DEBUG or MAX_WORKERS == 1 or len(users) == 1:
        for index, user_config in enumerate(users, start=1):
            print(f"\n========== USER {index}/{len(users)} ==========")
            user_label, rc = _run_user_config(user_config)
            if rc != 0:
                failures.append(user_label)
    else:
        worker_count = min(MAX_WORKERS, len(users))
        print(f"Running {len(users)} user(s) with max_workers={worker_count}")
        with ThreadPoolExecutor(max_workers=worker_count) as pool:
            future_to_index = {
                pool.submit(_run_user_config, user_config): index
                for index, user_config in enumerate(users, start=1)
            }
            for future in as_completed(future_to_index):
                index = future_to_index[future]
                try:
                    user_label, rc = future.result()
                except Exception as exc:  # pragma: no cover - defensive boundary
                    user_label = f"index={index}"
                    print(
                        f"\n  Unexpected worker error for {user_label}: "
                        f"{type(exc).__name__}: {exc}"
                    )
                    logger.exception("weekly-plan worker failed for %s", user_label)
                    rc = 1
                if rc != 0:
                    failures.append(user_label)

    if failures:
        print(f"\nCompleted with {len(failures)} failure(s): {', '.join(failures)}")
        return 1
    print(f"\nCompleted successfully for {len(users)} user(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
