#!/usr/bin/env python3
"""Run frozen Resolver fixtures against the configured real orchestrator LLM.

This is an offline, manually-triggered evaluation. It is intentionally not a
pytest test: the command needs live model credentials, has provider latency and
cost, and writes a report under `.omc/eval/reports/`.
"""

from __future__ import annotations

import argparse
import sys
import warnings
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SRC = REPO_ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))


EXIT_OK = 0
EXIT_FAIL = 1
EXIT_LLM_UNAVAILABLE = 64


def _print_report(report) -> None:
    print(
        f"Resolver eval: {report.fixtures_passed}/{report.fixtures_run} passed "
        f"(model={report.model})"
    )
    for result in report.per_fixture:
        status = "PASS" if result.passed else "FAIL"
        print(f"  {status:4} {result.fixture_id} ({result.latency_s:.3f}s)")
        for failure in result.failures:
            print(f"       {failure}")
        if result.error:
            print(f"       {result.error}")
    if report.fixtures_run < report.fixtures_total:
        print(
            f"  stopped after provider/runtime error; "
            f"{report.fixtures_total - report.fixtures_run} fixture(s) not run"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Evaluate the production Resolver with the configured real LLM."
    )
    parser.add_argument(
        "--fixture",
        action="append",
        dest="fixture_ids",
        default=None,
        help="Run only this fixture id; repeat to select multiple fixtures.",
    )
    parser.add_argument(
        "--no-report",
        action="store_true",
        help="Do not write JSON/Markdown under .omc/eval/reports/.",
    )
    args = parser.parse_args(argv)

    # langchain-openai's Responses structured-output adapter currently asks
    # Pydantic to serialize a correctly parsed model through a broader response
    # union, which emits a very large non-actionable warning per invocation.
    # Keep this eval's routing output readable without muting other warnings.
    warnings.filterwarnings(
        "ignore",
        message="Pydantic serializer warnings:",
        category=UserWarning,
        module="pydantic.main",
    )

    from coach.orchestrator.resolver import make_llm_draft_fn
    from coach.runtime.config import load_config
    from coach_eval.resolver_eval import (
        load_resolver_fixtures,
        run_resolver_evaluation,
        write_resolver_report,
    )
    from stride_server.coach_runtime import get_orchestrator_llm

    try:
        fixtures = load_resolver_fixtures(args.fixture_ids)
        if not fixtures:
            print("No Resolver fixtures found.", file=sys.stderr)
            return EXIT_FAIL
        config = load_config()
        model = config.for_role("orchestrator").model
        draft_fn = make_llm_draft_fn(get_orchestrator_llm())
    except Exception as exc:  # noqa: BLE001 - config/auth/provider boundary
        print(f"Resolver LLM unavailable: {type(exc).__name__}: {exc}", file=sys.stderr)
        return EXIT_LLM_UNAVAILABLE

    report = run_resolver_evaluation(fixtures, draft_fn=draft_fn, model=model)
    _print_report(report)
    if not args.no_report:
        json_path, md_path = write_resolver_report(report)
        print(f"JSON report: {json_path}")
        print(f"Markdown report: {md_path}")

    if any(result.error is not None for result in report.per_fixture):
        return EXIT_LLM_UNAVAILABLE
    if report.fixtures_failed:
        return EXIT_FAIL
    return EXIT_OK


if __name__ == "__main__":
    raise SystemExit(main())
