from __future__ import annotations

import json
from pathlib import Path

from scripts.refresh_eval_report_l1 import refresh_l1_report


def test_refresh_l1_report_rewrites_rule_filter_history(monkeypatch, tmp_path):
    fixture = {"fixture_id": "s1-refresh", "input": {"user_profile": {}}}
    monkeypatch.setattr("scripts.refresh_eval_report_l1.load_fixtures", lambda scope: [fixture])
    monkeypatch.setattr(
        "scripts.refresh_eval_report_l1._s1_rule_filter_kwargs", lambda fixture: {"x": 1}
    )

    captured = {}

    class FakeViolation:
        rule = "new_rule"
        severity = "warning"
        message = "new"
        details = {"x": 1}

    class FakeReport:
        violations = [FakeViolation()]

        def errors(self):
            return []

    def fake_rule_filter(plan, **kwargs):
        captured["plan"] = plan
        captured["kwargs"] = kwargs
        return FakeReport()

    monkeypatch.setattr(
        "scripts.refresh_eval_report_l1.run_master_rule_filter", fake_rule_filter
    )

    report = {
        "run_id": "old-run",
        "git_sha": "abc123",
        "scope": "s1",
        "mode": "frozen_fixture",
        "judge_prompt_version": "s1-vtest",
        "fixtures_total": 1,
        "fixtures_passed": 1,
        "fixtures_marginal": 0,
        "fixtures_failed": 0,
        "per_axis_avg": {},
        "per_fixture": [
            {
                "fixture_id": "s1-refresh",
                "scope": "s1",
                "l1_passed": True,
                "l1_violations": [{"rule": "old", "severity": "warning"}],
                "generated_artifact": {"plan_id": "p1"},
                "generation_iterations": 2,
                "timings": {
                    "generator_total_s": 10.0,
                    "rule_filter_history": [
                        {"iteration": 2, "violations": [{"rule": "old"}]}
                    ],
                },
                "judge_score": {
                    "fixture_id": "s1-refresh",
                    "scope": "s1",
                    "axes": [],
                    "overall_verdict": "pass",
                    "overall_rationale": "ok",
                    "judge_model": "fake",
                    "judge_prompt_version": "s1-vtest",
                },
            }
        ],
    }
    path = tmp_path / "report.json"
    path.write_text(json.dumps(report), encoding="utf-8")

    refreshed = refresh_l1_report(path)

    outcome = refreshed.per_fixture[0]
    assert refreshed.run_id != "old-run"
    assert refreshed.fixtures_passed == 1
    assert refreshed.fixtures_failed == 0
    assert captured == {"plan": {"plan_id": "p1"}, "kwargs": {"x": 1}}
    assert outcome.l1_passed is True
    assert outcome.l1_violations == [
        {
            "rule": "new_rule",
            "severity": "warning",
            "message": "new",
            "details": {"x": 1},
        }
    ]
    assert outcome.timings["generator_total_s"] == 10.0
    assert outcome.timings["rule_filter_history"] == [
        {
            "iteration": 2,
            "violations": [
                {
                    "rule": "new_rule",
                    "severity": "warning",
                    "message": "new",
                    "details": {"x": 1},
                }
            ],
        }
    ]
