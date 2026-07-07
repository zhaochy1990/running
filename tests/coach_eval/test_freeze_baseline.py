from __future__ import annotations

import json
from pathlib import Path

from scripts import freeze_baseline


def _outcome(fixture_id: str = "s1-fixture") -> dict:
    return {
        "fixture_id": fixture_id,
        "scope": "s1",
        "l1_passed": True,
        "l1_violations": [],
        "generation_iterations": 1,
        "timings": {"generator_total_s": 12.3},
        "judge_score": {
            "fixture_id": fixture_id,
            "scope": "s1",
            "axes": [
                {
                    "axis": "schema_validity",
                    "score": 5,
                    "rationale": "ok",
                    "matches_expected": True,
                }
            ],
            "overall_verdict": "pass",
            "overall_rationale": "ok",
            "judge_model": "fake",
            "judge_prompt_version": "s1-vtest",
        },
    }


def _report(**overrides: object) -> dict:
    per_fixture = overrides.pop(
        "per_fixture", [_outcome("s1-a"), _outcome("s1-b")]
    )
    report = {
        "run_id": "2026-06-30T00:00:00+00:00",
        "git_sha": "abc123",
        "scope": "s1",
        "mode": "frozen_fixture",
        "judge_prompt_version": "s1-vtest",
        "fixtures_total": len(per_fixture),
        "fixtures_passed": len(per_fixture),
        "fixtures_marginal": 0,
        "fixtures_failed": 0,
        "per_axis_avg": {"schema_validity": 5.0},
        "per_fixture": per_fixture,
    }
    report.update(overrides)
    return report


def _write_report(path: Path, report: dict) -> Path:
    path.write_text(json.dumps(report), encoding="utf-8")
    return path


def test_freeze_baseline_uses_explicit_report(monkeypatch, tmp_path, capsys):
    reports_dir = tmp_path / "reports"
    baselines_dir = tmp_path / "baselines"
    reports_dir.mkdir()
    monkeypatch.setattr(freeze_baseline, "_REPORTS_DIR", reports_dir)
    monkeypatch.setattr(freeze_baseline, "_BASELINES_DIR", baselines_dir)
    src = _write_report(reports_dir / "run.json", _report())

    rc = freeze_baseline.main([
        "--scope",
        "s1",
        "--label",
        "vtest",
        "--report",
        str(src),
    ])

    assert rc == 0
    frozen = json.loads((baselines_dir / "s1_vtest.json").read_text())
    assert frozen["run_id"] == "2026-06-30T00:00:00+00:00"
    summary = (baselines_dir / "s1_vtest.md").read_text(encoding="utf-8")
    assert "source report" in summary
    assert str(src.resolve()) in summary
    out = capsys.readouterr().out
    assert "Source report:" in out
    assert "Fixtures:        2 (pass=2 marginal=0 fail=0)" in out


def test_freeze_baseline_rejects_wrong_scope(tmp_path, capsys):
    src = _write_report(tmp_path / "run.json", _report(scope="s2"))

    rc = freeze_baseline.main(["--scope", "s1", "--report", str(src)])

    assert rc == 1
    assert "scope mismatch" in capsys.readouterr().err


def test_freeze_baseline_rejects_live_mode(tmp_path, capsys):
    src = _write_report(tmp_path / "run.json", _report(mode="live_local_db"))

    rc = freeze_baseline.main(["--scope", "s1", "--report", str(src)])

    assert rc == 1
    assert "Only frozen_fixture reports" in capsys.readouterr().err


def test_freeze_baseline_rejects_single_fixture_by_default(tmp_path, capsys):
    src = _write_report(
        tmp_path / "run.json",
        _report(per_fixture=[_outcome("s1-one")]),
    )

    rc = freeze_baseline.main(["--scope", "s1", "--report", str(src)])

    assert rc == 1
    assert "single-fixture" in capsys.readouterr().err


def test_freeze_baseline_can_allow_single_fixture(monkeypatch, tmp_path):
    baselines_dir = tmp_path / "baselines"
    monkeypatch.setattr(freeze_baseline, "_BASELINES_DIR", baselines_dir)
    src = _write_report(
        tmp_path / "run.json",
        _report(per_fixture=[_outcome("s1-one")]),
    )

    rc = freeze_baseline.main([
        "--scope",
        "s1",
        "--label",
        "diagnostic",
        "--report",
        str(src),
        "--allow-single-fixture",
    ])

    assert rc == 0
    assert (baselines_dir / "s1_diagnostic.json").exists()


def test_freeze_baseline_rejects_judge_artifact_report(tmp_path, capsys):
    artifact_outcome = _outcome("s1-artifact")
    artifact_outcome["generation_iterations"] = None
    artifact_outcome["timings"] = {"judge_s": 10.0}
    src = _write_report(
        tmp_path / "run.json",
        _report(per_fixture=[artifact_outcome, _outcome("s1-full")]),
    )

    rc = freeze_baseline.main(["--scope", "s1", "--report", str(src)])

    assert rc == 1
    err = capsys.readouterr().err
    assert "judge-artifact/partial report" in err
    assert "s1-artifact" in err


def test_freeze_baseline_rejects_judge_artifact_with_backfilled_timings(
    tmp_path, capsys
):
    artifact_outcome = _outcome("s1-artifact")
    artifact_outcome["timings"] = {
        "generator_total_s": 12.3,
        "artifact_source_report": ".omc/eval/reports/run-source.json",
    }
    src = _write_report(
        tmp_path / "run.json",
        _report(per_fixture=[artifact_outcome, _outcome("s1-full")]),
    )

    rc = freeze_baseline.main(["--scope", "s1", "--report", str(src)])

    assert rc == 1
    err = capsys.readouterr().err
    assert "fresh full generation" in err
    assert "s1-artifact" in err


def test_freeze_baseline_rejects_nonpass_by_default(tmp_path, capsys):
    src = _write_report(
        tmp_path / "run.json",
        _report(fixtures_passed=1, fixtures_marginal=1),
    )

    rc = freeze_baseline.main(["--scope", "s1", "--report", str(src)])

    assert rc == 1
    assert "non-pass report" in capsys.readouterr().err


def test_freeze_baseline_picks_latest_valid_report(monkeypatch, tmp_path):
    reports_dir = tmp_path / "reports"
    baselines_dir = tmp_path / "baselines"
    reports_dir.mkdir()
    monkeypatch.setattr(freeze_baseline, "_REPORTS_DIR", reports_dir)
    monkeypatch.setattr(freeze_baseline, "_BASELINES_DIR", baselines_dir)
    old = _write_report(reports_dir / "old.json", _report(run_id="old"))
    new = _write_report(reports_dir / "new.json", _report(run_id="new"))
    old.touch()
    new.touch()

    rc = freeze_baseline.main(["--scope", "s1", "--label", "latest"])

    assert rc == 0
    frozen = json.loads((baselines_dir / "s1_latest.json").read_text())
    assert frozen["run_id"] == "new"
