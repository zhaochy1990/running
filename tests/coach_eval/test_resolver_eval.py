"""Offline contract tests for the real-LLM Resolver evaluation harness."""

from __future__ import annotations

import json
from pathlib import Path
import warnings

from coach.contracts import IntentHit, ResolverDraft, ResolverOutput, TargetHint, TargetRef
from coach_eval.resolver_eval import (
    ResolverEvalReport,
    ResolverFixture,
    ResolverFixtureResult,
    build_resolver_eval_registry,
    grade_resolver_output,
    load_resolver_fixtures,
    run_resolver_evaluation,
    run_resolver_fixture,
    write_resolver_report,
)


def _fixture() -> ResolverFixture:
    return ResolverFixture.model_validate(
        {
            "fixture_id": "resolver-test",
            "description": "test fixture",
            "input": {
                "utterance": "把本周三改成轻松跑",
                "target_resolution": {
                    "kind": "week",
                    "folder": "2026-07-13_07-19(EVAL)",
                },
            },
            "expected": {
                "intents": [
                    {
                        "specialist_id": "weekly_plan",
                        "action": "write",
                        "min_confidence": 0.7,
                    }
                ],
                "is_compound": False,
                "active_target": {
                    "kind": "week",
                    "folder": "2026-07-13_07-19(EVAL)",
                },
                "ambiguity_kind": None,
                "resolved_from": "resolved",
                "self_ambiguity": False,
            },
        }
    )


def _weekly_write_draft(confidence: float = 0.9) -> ResolverDraft:
    return ResolverDraft(
        intents=[
            IntentHit(
                specialist_id="weekly_plan",
                action="write",
                confidence=confidence,
            )
        ],
        target_hint=TargetHint(kind="week", ref_phrase="本周三"),
    )


def test_committed_resolver_fixtures_cover_routing_boundaries() -> None:
    fixtures = load_resolver_fixtures()

    assert fixtures
    fixture_file = (
        Path(__file__).resolve().parents[1]
        / "fixtures"
        / "coach_eval"
        / "resolver.yaml"
    )
    assert fixture_file.is_file()
    assert len({fixture.fixture_id for fixture in fixtures}) == len(fixtures)
    week_read = next(
        fixture for fixture in fixtures if fixture.fixture_id == "resolver-week-read"
    )
    assert week_read.input.utterance == "我这周的训练计划是什么？"
    tags = {tag for fixture in fixtures for tag in fixture.tags}
    assert {
        "read_write_boundary",
        "compound_boundary",
        "compound",
        "anaphora",
        "out_of_domain",
        "target_resolution",
    } <= tags

    registry_ids = set(build_resolver_eval_registry().ids())
    expected_ids = {
        intent.specialist_id
        for fixture in fixtures
        for intent in fixture.expected.intents
    }
    assert expected_ids <= registry_ids


def test_load_resolver_fixtures_filters_and_rejects_unknown_id() -> None:
    import pytest

    fixtures = load_resolver_fixtures(["resolver-master-read"])
    assert [fixture.fixture_id for fixture in fixtures] == ["resolver-master-read"]

    with pytest.raises(ValueError, match="unknown resolver fixture"):
        load_resolver_fixtures(["resolver-does-not-exist"])


def test_grade_resolver_output_accepts_exact_contract() -> None:
    fixture = _fixture()
    draft = _weekly_write_draft()
    output = ResolverOutput(
        intents=draft.intents,
        active_target=TargetRef(
            kind="week", folder="2026-07-13_07-19(EVAL)"
        ),
        resolved_from="resolved",
    )

    assert grade_resolver_output(fixture, draft=draft, output=output) == []


def test_grade_resolver_output_reports_semantic_mismatches() -> None:
    fixture = _fixture()
    draft = ResolverDraft(
        intents=[
            IntentHit(
                specialist_id="status_insight", action="read", confidence=0.6
            )
        ],
        is_compound=True,
        self_ambiguity=True,
    )
    output = ResolverOutput(
        intents=draft.intents,
        is_compound=True,
        active_target=None,
        resolved_from="default",
    )

    failures = grade_resolver_output(fixture, draft=draft, output=output)

    assert any(failure.startswith("intents:") for failure in failures)
    assert any(failure.startswith("is_compound:") for failure in failures)
    assert any(failure.startswith("active_target:") for failure in failures)
    assert any(failure.startswith("resolved_from:") for failure in failures)
    assert any(failure.startswith("self_ambiguity:") for failure in failures)


def test_grade_resolver_output_rejects_duplicate_intents() -> None:
    fixture = _fixture()
    draft = ResolverDraft(
        intents=[
            IntentHit(
                specialist_id="weekly_plan", action="write", confidence=0.9
            ),
            IntentHit(
                specialist_id="weekly_plan", action="write", confidence=0.8
            ),
        ],
        target_hint=TargetHint(kind="week", ref_phrase="本周"),
    )
    output = ResolverOutput(
        intents=draft.intents,
        active_target=TargetRef(
            kind="week", folder="2026-07-13_07-19(EVAL)"
        ),
        resolved_from="resolved",
    )

    failures = grade_resolver_output(fixture, draft=draft, output=output)

    assert any(failure.startswith("intents:") for failure in failures)


def test_run_resolver_fixture_captures_draft_and_production_output() -> None:
    fixture = _fixture()

    result = run_resolver_fixture(
        fixture,
        draft_fn=lambda _system, _user: _weekly_write_draft(),
    )

    assert result.passed is True
    assert result.error is None
    assert result.draft is not None
    assert result.output is not None
    assert result.output["active_target"]["folder"] == "2026-07-13_07-19(EVAL)"


def test_run_resolver_evaluation_stops_after_provider_error() -> None:
    fixtures = [_fixture(), _fixture().model_copy(update={"fixture_id": "resolver-test-2"})]
    calls = 0

    def _broken(_system: str, _user: str) -> ResolverDraft:
        nonlocal calls
        calls += 1
        raise RuntimeError("provider unavailable")

    report = run_resolver_evaluation(fixtures, draft_fn=_broken, model="test-model")

    assert calls == 1
    assert report.fixtures_total == 2
    assert report.fixtures_run == 1
    assert report.fixtures_failed == 1
    assert report.per_fixture[0].error == "RuntimeError: provider unavailable"


def test_write_resolver_report_writes_json_and_markdown(tmp_path: Path) -> None:
    report = ResolverEvalReport(
        run_id="2026-07-15T00-00-00+00-00",
        git_sha="abc1234",
        model="real-model",
        fixtures_total=1,
        fixtures_run=1,
        fixtures_passed=1,
        fixtures_failed=0,
        per_fixture=[
            ResolverFixtureResult(
                fixture_id="resolver-test",
                description="test",
                passed=True,
                latency_s=1.25,
            )
        ],
    )

    json_path, md_path = write_resolver_report(report, report_dir=tmp_path)

    assert json.loads(json_path.read_text(encoding="utf-8"))["model"] == "real-model"
    markdown = md_path.read_text(encoding="utf-8")
    assert "Resolver real-LLM evaluation" in markdown
    assert "1/1 passed" in markdown
    assert "resolver-test" in markdown


def test_cli_installs_only_the_known_structured_output_warning_filter(
    monkeypatch,
) -> None:
    from scripts import eval_resolver

    recorded: list[tuple[tuple, dict]] = []
    monkeypatch.setattr(
        warnings,
        "filterwarnings",
        lambda *args, **kwargs: recorded.append((args, kwargs)),
    )
    monkeypatch.setattr(
        "coach_eval.resolver_eval.load_resolver_fixtures",
        lambda _fixture_ids: [],
    )

    assert eval_resolver.main(["--no-report"]) == eval_resolver.EXIT_FAIL
    assert recorded == [
        (
            ("ignore",),
            {
                "message": "Pydantic serializer warnings:",
                "category": UserWarning,
                "module": "pydantic.main",
            },
        )
    ]
