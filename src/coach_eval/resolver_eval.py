"""Real-LLM regression evaluation for the orchestrator Resolver.

The Resolver is a classifier with an exact typed contract, so its fixtures are
graded deterministically rather than by a second LLM judge. The configured
orchestrator model is still the system under test: it produces a real
`ResolverDraft`, production `resolve` performs the deterministic pass, and
this module compares the resulting `ResolverOutput` with frozen expectations.

This module is dev-only and follows the same dependency direction as the rest
of :mod:`coach_eval`: it may import production core/adapters, never vice versa.
"""

from __future__ import annotations

import json
import subprocess
import time
from collections.abc import Sequence
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field

from coach.contracts import (
    ResolverDraft,
    ResolverOutput,
    SpecialistRegistry,
    TargetRef,
    Turn,
)
from coach.orchestrator.resolver import ResolverDraftFn, resolve
from stride_server.coach_adapters.orchestrator.season_plan import SEASON_PLAN_CARD
from stride_server.coach_adapters.orchestrator.status_insight import STATUS_INSIGHT_CARD
from stride_server.coach_adapters.orchestrator.weekly_plan import WEEKLY_PLAN_CARD


REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_FILE = REPO_ROOT / "tests" / "fixtures" / "coach_eval" / "resolver.yaml"
REPORT_DIR = REPO_ROOT / ".omc" / "eval" / "reports"


class ExpectedIntent(BaseModel):
    specialist_id: str
    action: Literal["read", "write"]
    min_confidence: float = Field(default=0.7, ge=0.0, le=1.0)


class ResolverFixtureInput(BaseModel):
    utterance: str
    conversation_window: list[Turn] = Field(default_factory=list)
    prior_target: TargetRef | None = None
    memory_context: str = ""
    # Deterministic stand-in for the adapter's DB-backed target resolver. It
    # lets fixtures test language understanding without querying user data or
    # depending on which real week/master plan happens to be active.
    target_resolution: TargetRef | None = None


class ResolverFixtureExpected(BaseModel):
    intents: list[ExpectedIntent]
    is_compound: bool
    active_target: TargetRef | None = None
    check_active_target: bool = True
    ambiguity_kind: Literal["intent", "target"] | None
    resolved_from: Literal["anaphora", "explicit", "default", "resolved"]
    self_ambiguity: bool | None = None


class ResolverFixture(BaseModel):
    fixture_id: str
    description: str
    tags: list[str] = Field(default_factory=list)
    input: ResolverFixtureInput
    expected: ResolverFixtureExpected


class ResolverFixtureResult(BaseModel):
    fixture_id: str
    description: str
    passed: bool
    latency_s: float
    failures: list[str] = Field(default_factory=list)
    draft: dict[str, Any] | None = None
    output: dict[str, Any] | None = None
    error: str | None = None


class ResolverEvalReport(BaseModel):
    run_id: str
    git_sha: str
    model: str
    fixtures_total: int
    fixtures_run: int
    fixtures_passed: int
    fixtures_failed: int
    per_fixture: list[ResolverFixtureResult]


def build_resolver_eval_registry() -> SpecialistRegistry:
    """Build the production routing catalog without constructing runners."""
    registry = SpecialistRegistry()
    registry.register(STATUS_INSIGHT_CARD)
    registry.register(WEEKLY_PLAN_CARD)
    registry.register(SEASON_PLAN_CARD)
    return registry


def load_resolver_fixtures(fixture_ids: Sequence[str] | None = None) -> list[ResolverFixture]:
    """Load and validate frozen Resolver fixtures in stable id order."""
    selected = set(fixture_ids or [])
    raw = yaml.safe_load(FIXTURE_FILE.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or not isinstance(raw.get("fixtures"), list):
        raise ValueError("resolver.yaml must contain a top-level fixtures list")

    all_fixtures = [ResolverFixture.model_validate(item) for item in raw["fixtures"]]
    all_ids = [fixture.fixture_id for fixture in all_fixtures]
    if len(all_ids) != len(set(all_ids)):
        raise ValueError("resolver.yaml contains duplicate fixture_id values")

    fixtures = [
        fixture
        for fixture in all_fixtures
        if not selected or fixture.fixture_id in selected
    ]

    found = {fixture.fixture_id for fixture in fixtures}
    missing = selected - found
    if missing:
        raise ValueError(f"unknown resolver fixture(s): {', '.join(sorted(missing))}")
    return sorted(fixtures, key=lambda fixture: fixture.fixture_id)


def _target_dict(target: TargetRef | None) -> dict[str, Any] | None:
    if target is None:
        return None
    return target.model_dump(exclude_none=True)


def grade_resolver_output(
    fixture: ResolverFixture,
    *,
    draft: ResolverDraft,
    output: ResolverOutput,
) -> list[str]:
    """Return exact contract mismatches; an empty list means pass."""
    failures: list[str] = []
    expected = fixture.expected

    actual_keys = sorted(
        (intent.specialist_id, intent.action) for intent in output.intents
    )
    expected_keys = sorted(
        (intent.specialist_id, intent.action) for intent in expected.intents
    )
    actual_by_key = {
        (intent.specialist_id, intent.action): intent for intent in output.intents
    }
    expected_by_key = {
        (intent.specialist_id, intent.action): intent for intent in expected.intents
    }
    if actual_keys != expected_keys:
        failures.append(
            "intents: "
            f"expected={expected_keys} actual={actual_keys}"
        )
    for key in set(actual_by_key) & set(expected_by_key):
        actual_confidence = actual_by_key[key].confidence
        minimum = expected_by_key[key].min_confidence
        if actual_confidence < minimum:
            failures.append(
                f"confidence {key[0]}/{key[1]}: expected>={minimum:.2f} "
                f"actual={actual_confidence:.2f}"
            )

    if output.is_compound != expected.is_compound:
        failures.append(
            f"is_compound: expected={expected.is_compound} actual={output.is_compound}"
        )

    if expected.check_active_target:
        actual_target = _target_dict(output.active_target)
        expected_target = _target_dict(expected.active_target)
        if actual_target != expected_target:
            failures.append(
                f"active_target: expected={expected_target} actual={actual_target}"
            )

    actual_ambiguity = output.ambiguity.kind if output.ambiguity is not None else None
    if actual_ambiguity != expected.ambiguity_kind:
        failures.append(
            f"ambiguity_kind: expected={expected.ambiguity_kind!r} "
            f"actual={actual_ambiguity!r}"
        )

    if output.resolved_from != expected.resolved_from:
        failures.append(
            f"resolved_from: expected={expected.resolved_from!r} "
            f"actual={output.resolved_from!r}"
        )

    if (
        expected.self_ambiguity is not None
        and draft.self_ambiguity != expected.self_ambiguity
    ):
        failures.append(
            f"self_ambiguity: expected={expected.self_ambiguity} "
            f"actual={draft.self_ambiguity}"
        )
    return failures


def run_resolver_fixture(
    fixture: ResolverFixture,
    *,
    draft_fn: ResolverDraftFn,
    registry: SpecialistRegistry | None = None,
) -> ResolverFixtureResult:
    """Run one frozen fixture through the real Resolver path."""
    captured: dict[str, ResolverDraft] = {}

    def _capturing_draft_fn(system_prompt: str, user_prompt: str) -> ResolverDraft:
        draft = draft_fn(system_prompt, user_prompt)
        captured["draft"] = draft
        return draft

    target_resolution = fixture.input.target_resolution
    target_resolver = (
        (lambda _target: target_resolution) if target_resolution is not None else None
    )
    started = time.monotonic()
    try:
        output = resolve(
            fixture.input.utterance,
            registry=registry or build_resolver_eval_registry(),
            draft_fn=_capturing_draft_fn,
            conversation_window=fixture.input.conversation_window,
            prior_target=fixture.input.prior_target,
            memory_context=fixture.input.memory_context,
            target_resolver=target_resolver,
        )
        draft = captured["draft"]
        failures = grade_resolver_output(fixture, draft=draft, output=output)
        return ResolverFixtureResult(
            fixture_id=fixture.fixture_id,
            description=fixture.description,
            passed=not failures,
            latency_s=round(time.monotonic() - started, 3),
            failures=failures,
            draft=draft.model_dump(exclude_none=True),
            output=output.model_dump(exclude_none=True),
        )
    except Exception as exc:  # noqa: BLE001 - report real provider failures verbatim
        return ResolverFixtureResult(
            fixture_id=fixture.fixture_id,
            description=fixture.description,
            passed=False,
            latency_s=round(time.monotonic() - started, 3),
            error=f"{type(exc).__name__}: {exc}",
        )


def _git_sha() -> str:
    try:
        return subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=REPO_ROOT,
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def run_resolver_evaluation(
    fixtures: Sequence[ResolverFixture],
    *,
    draft_fn: ResolverDraftFn,
    model: str,
) -> ResolverEvalReport:
    """Run fixtures sequentially, stopping after a provider/runtime error."""
    registry = build_resolver_eval_registry()
    results: list[ResolverFixtureResult] = []
    for fixture in fixtures:
        result = run_resolver_fixture(fixture, draft_fn=draft_fn, registry=registry)
        results.append(result)
        if result.error is not None:
            break

    passed = sum(result.passed for result in results)
    run_id = datetime.now(timezone.utc).isoformat().replace(":", "-")
    return ResolverEvalReport(
        run_id=run_id,
        git_sha=_git_sha(),
        model=model,
        fixtures_total=len(fixtures),
        fixtures_run=len(results),
        fixtures_passed=passed,
        fixtures_failed=len(results) - passed,
        per_fixture=results,
    )


def write_resolver_report(
    report: ResolverEvalReport, report_dir: Path = REPORT_DIR
) -> tuple[Path, Path]:
    """Write machine-readable JSON plus a compact human-readable summary."""
    report_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{report.run_id}.resolver"
    json_path = report_dir / f"{stem}.json"
    md_path = report_dir / f"{stem}.md"
    json_path.write_text(
        json.dumps(report.model_dump(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    lines = [
        "# Resolver real-LLM evaluation",
        "",
        f"- run_id: `{report.run_id}`",
        f"- git_sha: `{report.git_sha}`",
        f"- model: `{report.model}`",
        f"- result: {report.fixtures_passed}/{report.fixtures_run} passed",
        "",
        "| fixture | result | latency | details |",
        "|---|---:|---:|---|",
    ]
    for result in report.per_fixture:
        details = result.error or "; ".join(result.failures) or "OK"
        details = details.replace("|", "&#124;")
        lines.append(
            f"| `{result.fixture_id}` | {'PASS' if result.passed else 'FAIL'} "
            f"| {result.latency_s:.3f}s | {details} |"
        )
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return json_path, md_path
