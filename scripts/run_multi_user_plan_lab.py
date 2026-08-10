#!/usr/bin/env python3
"""Run a local multi-user S1/S2 plan-generation lab.

The lab intentionally uses the production generation graph for master plans,
then feeds the resulting ``MasterPlan.weeks`` skeleton into the season/weekly
orchestrator. It writes every artifact under ``tmp/testing`` so prompt changes
can be compared without touching production stores.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


_REPO_ROOT = Path(__file__).resolve().parents[1]
_SRC = _REPO_ROOT / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from coach.graphs.generation.graph import build_generation_graph
from coach.graphs.generation.master_rule_filter import run_master_rule_filter
from coach_eval.master_weekly_quality import (
    evaluate_master_weekly_quality,
    report_to_dict as master_weekly_report_to_dict,
)
from coach_eval.weekly_quality import (
    evaluate_season_quality,
    report_to_dict as weekly_report_to_dict,
)
from stride_core.master_plan import MasterPlan
from stride_server.coach_adapters.master_plan_adapter import (
    apply_master_patches,
    generate_master_plan,
    load_master_context,
    master_reviewer,
)
from stride_server.coach_adapters.season_orchestrator import generate_season
from stride_server.master_plan_generator import _normalize_for_prompt


logger = logging.getLogger(__name__)

DEFAULT_USERS = ("zhaochaoyi", "lvge", "dehua", "dingchentao")
DEFAULT_SEASON_START = "2026-05-04"

_USER_GOALS: dict[str, dict[str, Any]] = {
    "zhaochaoyi": {
        "goal_id": "lab-2026-fall-zhaochaoyi",
        "race_distance": "FM",
        "target_finish_time": "2:50:00",
        "race_date": "2026-10-18",
        "weekly_training_days": 5,
        "race_name": "西安马拉松",
    },
    "lvge": {
        "goal_id": "lab-2026-fall-lvge",
        "race_distance": "FM",
        "target_finish_time": "2:50:00",
        "race_date": "2026-10-18",
        "weekly_training_days": 5,
        "race_name": "西安马拉松",
    },
    "dehua": {
        "goal_id": "lab-2026-fall-dehua",
        "race_distance": "FM",
        "target_finish_time": "2:53:00",
        "race_date": "2026-10-18",
        "weekly_training_days": 5,
        "race_name": "马拉松目标赛",
    },
    "dingchentao": {
        "goal_id": "lab-2026-fall-dingchentao",
        "race_distance": "FM",
        "target_finish_time": "2:47:00",
        "race_date": "2026-10-18",
        "weekly_training_days": 5,
        "race_name": "西安马拉松",
    },
}


@dataclass(frozen=True)
class LabUser:
    slug: str
    user_id: str


@dataclass(frozen=True)
class UserLabResult:
    slug: str
    user_id: str
    ok: bool
    master_plan: dict[str, Any] | None
    master_weekly_quality: dict[str, Any] | None
    season_bundle: dict[str, Any] | None
    weekly_quality: dict[str, Any] | None
    metadata: dict[str, Any]
    error: str | None = None


def _json_default(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json")
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, default=_json_default),
        encoding="utf-8",
    )


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _read_aliases(data_dir: Path) -> dict[str, str]:
    alias_path = data_dir / ".slug_aliases.json"
    if not alias_path.exists():
        return {}
    return json.loads(alias_path.read_text(encoding="utf-8"))


def resolve_users(slugs: list[str], *, data_dir: Path | None = None) -> list[LabUser]:
    data_dir = data_dir or (_REPO_ROOT / "data")
    aliases = _read_aliases(data_dir)
    users: list[LabUser] = []
    for slug in slugs:
        raw = slug.strip()
        if not raw:
            continue
        user_id = aliases.get(raw, raw)
        users.append(LabUser(slug=raw, user_id=user_id))
    return users


def build_goal(slug: str, *, season_start: str) -> dict[str, Any]:
    if slug not in _USER_GOALS:
        raise KeyError(f"no lab goal configured for {slug!r}")
    goal = dict(_USER_GOALS[slug])
    goal["season_start"] = season_start
    goal["as_of_date"] = season_start
    norm_goal, _profile = _normalize_for_prompt(goal, None)
    goal.update(norm_goal)
    return goal


def build_rule_filter_kwargs(goal: dict[str, Any], profile: dict[str, Any] | None = None) -> dict[str, Any]:
    norm_goal, norm_profile = _normalize_for_prompt(goal, profile)
    kwargs: dict[str, Any] = {
        "target_race": {
            "distance": norm_goal.get("distance"),
            "goal_time_s": norm_goal.get("goal_time_s"),
            "race_date": norm_goal.get("race_date"),
        },
        "season_window": {
            "start_date": norm_goal.get("season_start") or norm_goal.get("as_of_date"),
            "end_date": norm_goal.get("race_date"),
        },
    }
    if norm_profile and norm_profile.get("prs"):
        kwargs["prs"] = norm_profile["prs"]
    if norm_profile and norm_profile.get("weekly_run_days_max") is not None:
        kwargs["weekly_run_days_max"] = norm_profile["weekly_run_days_max"]
    return kwargs


def _level_from_context(context: dict[str, Any]) -> float:
    fitness = context.get("fitness_state") or {}
    for key in ("chronic_load", "ctl"):
        value = fitness.get(key)
        if isinstance(value, (int, float)) and value > 0:
            return float(value)
    return 60.0


def _season_context(
    *,
    user: LabUser,
    goal: dict[str, Any],
    master_context: dict[str, Any],
) -> dict[str, Any]:
    norm_goal, _profile = _normalize_for_prompt(goal, None)
    return {
        **master_context,
        "user_id": user.user_id,
        "goal": norm_goal,
        "level": _level_from_context(master_context),
        "continuity": master_context.get("continuity"),
    }


def should_generate_weekly(final_state: dict[str, Any]) -> bool:
    return final_state.get("final_verdict") != "block" and isinstance(
        final_state.get("final_artifact"), dict
    )


def generate_user_lab(user: LabUser, *, season_start: str) -> UserLabResult:
    t0 = time.perf_counter()
    goal = build_goal(user.slug, season_start=season_start)
    profile = None
    state: dict[str, Any] = {
        "job_id": "",
        "user_id": user.user_id,
        "plan_type": "master",
        "input_payload": {"goal": goal, "profile": profile},
    }
    metadata: dict[str, Any] = {
        "slug": user.slug,
        "user_id": user.user_id,
        "season_start": season_start,
        "goal": goal,
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        graph = build_generation_graph(
            load_context=load_master_context,
            generator=generate_master_plan,
            reviewer=master_reviewer,
            apply_patches=apply_master_patches,
            rule_filter=run_master_rule_filter,
            rule_filter_kwargs=build_rule_filter_kwargs(goal, profile),
        )
        final_state = graph.invoke(state)
        metadata["final_verdict"] = final_state.get("final_verdict")
        metadata["generation_iterations"] = final_state.get("generation_iterations")
        metadata["rule_filter_history"] = final_state.get("rule_filter_history")

        artifact = final_state.get("final_artifact")
        if not isinstance(artifact, dict):
            raise RuntimeError("generation produced no final_artifact")
        master_plan = MasterPlan.model_validate(artifact)
        master_quality = evaluate_master_weekly_quality(master_plan)

        if not should_generate_weekly(final_state):
            metadata["elapsed_s"] = round(time.perf_counter() - t0, 1)
            metadata["completed_at"] = datetime.now(timezone.utc).isoformat()
            return UserLabResult(
                slug=user.slug,
                user_id=user.user_id,
                ok=False,
                master_plan=master_plan.model_dump(mode="json"),
                master_weekly_quality=master_weekly_report_to_dict(master_quality),
                season_bundle=None,
                weekly_quality=None,
                metadata=metadata,
                error="master_generation_blocked",
            )

        master_context = load_master_context(state)
        season_context = _season_context(user=user, goal=goal, master_context=master_context)
        injuries = []
        continuity = master_context.get("continuity")
        if isinstance(continuity, dict):
            injuries = [str(x) for x in continuity.get("injuries") or []]
        bundle = generate_season(master_plan, season_context, injuries=injuries)
        weekly_quality = evaluate_season_quality(master_plan, bundle)

        metadata["elapsed_s"] = round(time.perf_counter() - t0, 1)
        metadata["completed_at"] = datetime.now(timezone.utc).isoformat()
        return UserLabResult(
            slug=user.slug,
            user_id=user.user_id,
            ok=master_quality.ok and weekly_quality.ok,
            master_plan=master_plan.model_dump(mode="json"),
            master_weekly_quality=master_weekly_report_to_dict(master_quality),
            season_bundle=bundle.model_dump(mode="json", by_alias=True),
            weekly_quality=weekly_report_to_dict(weekly_quality),
            metadata=metadata,
        )
    except Exception as exc:  # noqa: BLE001 - lab must keep other users running
        logger.exception("lab failed for user=%s", user.slug)
        metadata["elapsed_s"] = round(time.perf_counter() - t0, 1)
        metadata["completed_at"] = datetime.now(timezone.utc).isoformat()
        return UserLabResult(
            slug=user.slug,
            user_id=user.user_id,
            ok=False,
            master_plan=None,
            master_weekly_quality=None,
            season_bundle=None,
            weekly_quality=None,
            metadata=metadata,
            error=f"{type(exc).__name__}: {exc}",
        )


def write_user_artifacts(out_dir: Path, user: LabUser, result: UserLabResult) -> None:
    user_dir = out_dir / user.slug
    if result.master_plan is not None:
        _write_json(user_dir / "master_plan.json", result.master_plan)
    if result.master_weekly_quality is not None:
        _write_json(user_dir / "master_weekly_quality.json", result.master_weekly_quality)
    if result.season_bundle is not None:
        _write_json(user_dir / "season_bundle.json", result.season_bundle)
    if result.weekly_quality is not None:
        _write_json(user_dir / "weekly_quality.json", result.weekly_quality)
    _write_json(
        user_dir / "summary.json",
        {
            "slug": result.slug,
            "user_id": result.user_id,
            "ok": result.ok,
            "error": result.error,
            "metadata": result.metadata,
            "master_weekly_issue_count": len((result.master_weekly_quality or {}).get("issues") or []),
            "weekly_issue_count": len((result.weekly_quality or {}).get("issues") or []),
        },
    )


def load_existing_result(out_dir: Path, user: LabUser) -> UserLabResult | None:
    user_dir = out_dir / user.slug
    summary_path = user_dir / "summary.json"
    if not summary_path.exists():
        return None
    summary = _read_json(summary_path)

    def optional_json(name: str) -> dict[str, Any] | None:
        path = user_dir / name
        return _read_json(path) if path.exists() else None

    return UserLabResult(
        slug=str(summary.get("slug") or user.slug),
        user_id=str(summary.get("user_id") or user.user_id),
        ok=bool(summary.get("ok")),
        master_plan=optional_json("master_plan.json"),
        master_weekly_quality=optional_json("master_weekly_quality.json"),
        season_bundle=optional_json("season_bundle.json"),
        weekly_quality=optional_json("weekly_quality.json"),
        metadata=dict(summary.get("metadata") or {}),
        error=summary.get("error"),
    )


def _write_index(out_dir: Path, results: list[UserLabResult]) -> None:
    _write_json(
        out_dir / "summary.json",
        {
            "ok": all(r.ok for r in results),
            "users_total": len(results),
            "users_ok": sum(1 for r in results if r.ok),
            "users": [
                {
                    "slug": r.slug,
                    "user_id": r.user_id,
                    "ok": r.ok,
                    "error": r.error,
                    "elapsed_s": r.metadata.get("elapsed_s"),
                    "master_weekly_issue_count": len((r.master_weekly_quality or {}).get("issues") or []),
                    "weekly_issue_count": len((r.weekly_quality or {}).get("issues") or []),
                }
                for r in results
            ],
        },
    )


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--users", default=",".join(DEFAULT_USERS), help="Comma-separated slugs or UUIDs.")
    parser.add_argument("--season-start", default=DEFAULT_SEASON_START, help="Frozen replay start/as_of date.")
    parser.add_argument("--out", default=None, help="Output directory under tmp/testing by default.")
    parser.add_argument("--skip-existing", action="store_true", help="Reuse user artifacts already present under --out.")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    args = parse_args(argv)
    slugs = [s.strip() for s in str(args.users).split(",") if s.strip()]
    users = resolve_users(slugs)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = Path(args.out) if args.out else _REPO_ROOT / "tmp" / "testing" / "multi_user_plan_lab" / stamp
    if not out_dir.is_absolute():
        out_dir = (_REPO_ROOT / out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    results: list[UserLabResult] = []
    for user in users:
        if args.skip_existing:
            existing = load_existing_result(out_dir, user)
            if existing is not None:
                logger.info("lab: skipping existing user=%s ok=%s", user.slug, existing.ok)
                results.append(existing)
                continue
        logger.info("lab: generating user=%s (%s)", user.slug, user.user_id)
        result = generate_user_lab(user, season_start=args.season_start)
        write_user_artifacts(out_dir, user, result)
        results.append(result)
        logger.info("lab: user=%s ok=%s elapsed=%ss", user.slug, result.ok, result.metadata.get("elapsed_s"))
    _write_index(out_dir, results)
    print(f"Wrote lab artifacts to {out_dir}")
    return 0 if all(r.ok for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
