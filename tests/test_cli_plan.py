"""Tests for `coros-sync plan ...` (multi-variant CLI subcommands).

Focuses on:
- 3-tier STDOUT parser (sentinel / fenced / balanced-braces) with
  schema-anchor enforcement
- Subprocess orchestration: parallel + timeout + non-zero exit
- HTTP layer: auth required, 409 retry-after auto-retry, parse_failed
  upload demotion
- Click command shapes: --dry-run, rate body, delete confirmation

`subprocess.run` and `httpx.*` are mocked throughout — these tests don't
spawn real `omc ask` subprocesses or call real servers.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import click
import pytest
from click.testing import CliRunner

from coros_sync.cli_plan import (
    VariantResult,
    extract_weekly_plan_json,
    run_omc_ask,
    upload_variant,
)


WEEK = "2026-05-04_05-10(P1W2)"
USER = "a1b2c3d4-e5f6-4aaa-89ab-123456789012"


# ── Fixtures: well-formed WeeklyPlan blob ──────────────────────────────


def _valid_plan_dict() -> dict:
    return {
        "schema": "weekly-plan/v1",
        "week_folder": WEEK,
        "sessions": [
            {"schema": "plan-session/v1", "date": "2026-05-04",
             "session_index": 0, "kind": "run", "summary": "easy 10k",
             "spec": None, "notes_md": None,
             "total_distance_m": None, "total_duration_s": None,
             "scheduled_workout_id": None},
        ],
        "nutrition": [],
        "notes_md": None,
    }


# ── 3-tier STDOUT parser ────────────────────────────────────────────────


class TestParser:
    def test_clean_sentinel(self):
        plan = _valid_plan_dict()
        out = (
            "# Plan\n\nSome markdown content.\n\n"
            "<<<WEEKLY_PLAN_JSON_START>>>\n"
            f"{json.dumps(plan)}\n"
            "<<<WEEKLY_PLAN_JSON_END>>>\n"
        )
        result = extract_weekly_plan_json(out)
        assert result is not None
        assert result["schema"] == "weekly-plan/v1"
        assert result["week_folder"] == WEEK

    def test_banner_prefix_doesnt_break_sentinel(self):
        """Some `omc ask` runners print a banner before the model output."""
        plan = _valid_plan_dict()
        out = (
            "[omc] starting claude…\n[omc] connecting…\n\n"
            "# Plan body\n\n"
            "<<<WEEKLY_PLAN_JSON_START>>>\n"
            f"{json.dumps(plan)}\n"
            "<<<WEEKLY_PLAN_JSON_END>>>\n"
        )
        assert extract_weekly_plan_json(out) is not None

    def test_codex_done_trailer(self):
        """Codex sometimes appends 'Done.' after the sentinel block."""
        plan = _valid_plan_dict()
        out = (
            "# Plan\n\n"
            "<<<WEEKLY_PLAN_JSON_START>>>\n"
            f"{json.dumps(plan)}\n"
            "<<<WEEKLY_PLAN_JSON_END>>>\n"
            "Done.\n"
        )
        assert extract_weekly_plan_json(out) is not None

    def test_fenced_fallback_no_sentinel(self):
        """Tier 2: fenced ```json``` block when sentinels are missing."""
        plan = _valid_plan_dict()
        out = (
            "# Plan body\n\n"
            "```json\n"
            f"{json.dumps(plan)}\n"
            "```\n"
        )
        assert extract_weekly_plan_json(out) is not None

    def test_balanced_braces_fallback(self):
        """Tier 3: greedy balanced-braces extraction (raw JSON, no fence)."""
        plan = _valid_plan_dict()
        out = "# Plan\n\nblah\n\n" + json.dumps(plan, indent=2) + "\n"
        assert extract_weekly_plan_json(out) is not None

    def test_no_schema_anchor_returns_none(self):
        """Even if JSON parses, missing schema='weekly-plan/v1' → None."""
        bad = {"week_folder": WEEK, "sessions": []}  # no `schema` field
        out = (
            "<<<WEEKLY_PLAN_JSON_START>>>\n"
            f"{json.dumps(bad)}\n"
            "<<<WEEKLY_PLAN_JSON_END>>>\n"
        )
        assert extract_weekly_plan_json(out) is None

    def test_wrong_schema_value_returns_none(self):
        bad = {"schema": "weekly-plan/v2", "week_folder": WEEK,
               "sessions": [], "nutrition": [], "notes_md": None}
        out = (
            "<<<WEEKLY_PLAN_JSON_START>>>\n"
            f"{json.dumps(bad)}\n"
            "<<<WEEKLY_PLAN_JSON_END>>>\n"
        )
        assert extract_weekly_plan_json(out) is None

    def test_malformed_json_falls_through(self):
        """Tier 1 finds garbage between sentinels → falls through to
        Tier 2/3, which here also fail → None.
        """
        out = "<<<WEEKLY_PLAN_JSON_START>>>\nnot json\n<<<WEEKLY_PLAN_JSON_END>>>\n"
        assert extract_weekly_plan_json(out) is None

    def test_empty_stdout(self):
        assert extract_weekly_plan_json("") is None


# ── Subprocess orchestration ───────────────────────────────────────────


class TestRunOmcAsk:
    def test_happy_path(self, monkeypatch):
        plan = _valid_plan_dict()
        out = (
            "# Plan\n\nbody\n\n"
            "<<<WEEKLY_PLAN_JSON_START>>>\n"
            f"{json.dumps(plan)}\n"
            "<<<WEEKLY_PLAN_JSON_END>>>\n"
        )
        completed = MagicMock(returncode=0, stdout=out, stderr="")
        monkeypatch.setattr(subprocess, "run", MagicMock(return_value=completed))
        result = run_omc_ask("claude", "prompt body", timeout_s=180)
        assert result.parse_status == "fresh"
        assert result.structured is not None
        assert result.structured["schema"] == "weekly-plan/v1"
        # Sentinel block stripped from content_md.
        assert "<<<WEEKLY_PLAN_JSON_START>>>" not in result.content_md
        assert "# Plan" in result.content_md
        assert result.error is None

    def test_timeout_returns_parse_failed(self, monkeypatch):
        def raise_timeout(*args, **kwargs):
            raise subprocess.TimeoutExpired(cmd="omc", timeout=180,
                                             output="partial output")
        monkeypatch.setattr(subprocess, "run", raise_timeout)
        result = run_omc_ask("claude", "prompt", timeout_s=180)
        assert result.parse_status == "parse_failed"
        assert "timeout" in (result.error or "").lower()
        # Whatever stdout we got is preserved as content_md.
        assert "partial output" in result.content_md

    def test_nonzero_exit_returns_parse_failed(self, monkeypatch):
        completed = MagicMock(returncode=1, stdout="some output",
                              stderr="model error: something")
        monkeypatch.setattr(subprocess, "run", MagicMock(return_value=completed))
        result = run_omc_ask("codex", "prompt", timeout_s=180)
        assert result.parse_status == "parse_failed"
        assert "exit 1" in (result.error or "")
        assert "model error" in (result.error or "")

    def test_omc_command_not_found(self, monkeypatch):
        def raise_fnf(*args, **kwargs):
            raise FileNotFoundError("omc")
        monkeypatch.setattr(subprocess, "run", raise_fnf)
        result = run_omc_ask("claude", "prompt", timeout_s=180)
        assert result.parse_status == "parse_failed"
        assert "omc command not found" in (result.error or "")

    def test_no_schema_anchor_demotes_to_parse_failed(self, monkeypatch):
        # Output has JSON but missing `schema` field.
        bad = {"week_folder": WEEK, "sessions": []}
        out = (
            "# Plan\n\n```json\n"
            f"{json.dumps(bad)}\n"
            "```\n"
        )
        completed = MagicMock(returncode=0, stdout=out, stderr="")
        monkeypatch.setattr(subprocess, "run", MagicMock(return_value=completed))
        result = run_omc_ask("gemini", "prompt", timeout_s=180)
        assert result.parse_status == "parse_failed"
        assert "no schema-anchored JSON" in (result.error or "")


# ── upload_variant ─────────────────────────────────────────────────────


class TestUploadVariant:
    def _make_result(self, *, structured=True, model_id="claude") -> VariantResult:
        return VariantResult(
            model_id=model_id,
            content_md="# v1",
            structured=_valid_plan_dict() if structured else None,
            parse_status="fresh" if structured else "parse_failed",
            duration_s=12.34,
            error=None if structured else "no schema",
        )

    def test_no_token_fails_loud(self, monkeypatch):
        # Bearer header empty → ClickException raised (no anonymous fallback).
        monkeypatch.setattr(
            "coros_sync.cli_plan.bearer_header",
            lambda profile: {},
        )
        result = self._make_result()
        with pytest.raises(click.ClickException) as excinfo:
            upload_variant(
                prod_url="https://x.test", profile="zhaochaoyi",
                folder=WEEK, result=result, prompt_hash="abc12345",
            )
        assert "No auth token" in str(excinfo.value.message)

    def test_uploads_with_correct_body(self, monkeypatch):
        captured = {}

        class _Resp:
            def __init__(self):
                self.status_code = 200
                self.text = ""
            def json(self):
                return {"variant_id": 1, "variant_index": 0,
                        "variant_parse_status": "fresh",
                        "sessions_count": 1, "nutrition_days": 0}

        def fake_post(url, headers=None, json=None, **kwargs):
            captured["url"] = url
            captured["headers"] = headers
            captured["json"] = json
            return _Resp()

        monkeypatch.setattr(
            "coros_sync.cli_plan.bearer_header",
            lambda profile: {"Authorization": "Bearer test-token"},
        )
        monkeypatch.setattr("coros_sync.cli_plan.httpx.post", fake_post)

        result = self._make_result()
        resp = upload_variant(
            prod_url="https://x.test", profile=USER, folder=WEEK,
            result=result, prompt_hash="abc12345",
        )
        assert resp["variant_id"] == 1
        # Body shape.
        body = captured["json"]
        assert body["schema_version"] == 1
        assert body["model_id"] == "claude"
        assert body["content_md"] == "# v1"
        assert body["structured"]["schema"] == "weekly-plan/v1"
        assert body["generation_metadata"]["prompt_version"] == "abc12345"
        assert body["generation_metadata"]["parse_status"] == "fresh"
        # Auth header present.
        assert captured["headers"]["Authorization"] == "Bearer test-token"

    def test_parse_failed_uploads_null_structured(self, monkeypatch):
        captured = {}

        class _Resp:
            status_code = 200
            text = ""
            def json(self):
                return {"variant_id": 7, "variant_index": 0,
                        "variant_parse_status": "parse_failed",
                        "sessions_count": 0, "nutrition_days": 0}

        def fake_post(url, headers=None, json=None, **kwargs):
            captured["json"] = json
            return _Resp()

        monkeypatch.setattr(
            "coros_sync.cli_plan.bearer_header",
            lambda profile: {"Authorization": "Bearer t"},
        )
        monkeypatch.setattr("coros_sync.cli_plan.httpx.post", fake_post)

        result = self._make_result(structured=False)
        upload_variant(
            prod_url="https://x.test", profile=USER, folder=WEEK,
            result=result, prompt_hash="abc",
        )
        assert captured["json"]["structured"] is None

    def test_http_error_raises_click_exception(self, monkeypatch):
        class _Resp:
            status_code = 500
            text = "boom"

        monkeypatch.setattr(
            "coros_sync.cli_plan.bearer_header",
            lambda profile: {"Authorization": "Bearer t"},
        )
        monkeypatch.setattr(
            "coros_sync.cli_plan.httpx.post",
            lambda *a, **kw: _Resp(),
        )
        with pytest.raises(click.ClickException):
            upload_variant(
                prod_url="https://x.test", profile=USER, folder=WEEK,
                result=self._make_result(), prompt_hash="abc",
            )


# ── Click command shapes: rate body construction ───────────────────────


class TestRateCommand:
    def test_rate_builds_correct_body(self, monkeypatch):
        from coros_sync.cli_plan import rate
        from coros_sync.cli import cli  # parent group

        captured = {}

        class _Resp:
            status_code = 200
            text = ""
            def json(self):
                return {"variant_id": 7,
                        "ratings": {"overall": 4, "structure": 5},
                        "rating_comment": "decent"}

        def fake_post(url, headers=None, json=None, **kwargs):
            captured["url"] = url
            captured["json"] = json
            return _Resp()

        monkeypatch.setattr(
            "coros_sync.cli_plan.bearer_header",
            lambda profile: {"Authorization": "Bearer t"},
        )
        monkeypatch.setattr("coros_sync.cli_plan.httpx.post", fake_post)

        runner = CliRunner()
        result = runner.invoke(
            cli, [
                "-P", USER, "plan", "rate",
                "--variant-id", "7",
                "--overall", "4",
                "--structure", "5",
                "--comment", "decent",
                "--prod-url", "https://x.test",
            ],
        )
        assert result.exit_code == 0, result.output
        # Body should have ratings dict with only the explicitly-provided
        # dimensions, and the comment.
        assert captured["json"]["ratings"] == {"overall": 4, "structure": 5}
        assert captured["json"]["comment"] == "decent"
        assert "/api/" in captured["url"]
        assert "/plan/variants/7/rate" in captured["url"]

    def test_rate_no_dimensions_errors(self):
        from coros_sync.cli import cli
        runner = CliRunner()
        result = runner.invoke(
            cli, [
                "-P", USER, "plan", "rate",
                "--variant-id", "7",
                "--prod-url", "https://x.test",
            ],
        )
        assert result.exit_code != 0
        assert "at least one" in result.output.lower()


# ── Select command: 409 + Retry-After auto-retry ───────────────────────


class TestSelectRetry:
    def test_concurrent_select_409_retries_once(self, monkeypatch):
        from coros_sync.cli import cli

        first = MagicMock()
        first.status_code = 409
        first.headers = {"Retry-After": "1"}
        first.json = MagicMock(return_value={"detail": {
            "error": "concurrent_select", "retry_after_s": 1,
        }})
        second = MagicMock()
        second.status_code = 200
        second.json = MagicMock(return_value={
            "ok": True, "no_change": False, "week_folder": WEEK,
            "selected_variant_id": 7, "dropped_scheduled_workout_ids": [],
        })

        post_mock = MagicMock(side_effect=[first, second])
        monkeypatch.setattr(
            "coros_sync.cli_plan.bearer_header",
            lambda profile: {"Authorization": "Bearer t"},
        )
        monkeypatch.setattr("coros_sync.cli_plan.httpx.post", post_mock)
        # Also patch sleep so the test doesn't actually wait 1s.
        monkeypatch.setattr("coros_sync.cli_plan.time.sleep", lambda s: None)

        runner = CliRunner()
        result = runner.invoke(
            cli, [
                "-P", USER, "plan", "select",
                "--week", WEEK, "--variant-id", "7",
                "--prod-url", "https://x.test",
            ],
        )
        assert result.exit_code == 0, result.output
        assert "selected variant 7" in result.output
        # Verify exactly two POSTs (initial + retry).
        assert post_mock.call_count == 2

    def test_selection_conflict_no_retry(self, monkeypatch):
        from coros_sync.cli import cli

        resp = MagicMock()
        resp.status_code = 409
        resp.headers = {}
        resp.json = MagicMock(return_value={"detail": {
            "error": "selection_conflict",
            "already_pushed_count": 2,
            "hint": "force=true to override",
        }})
        post_mock = MagicMock(return_value=resp)
        monkeypatch.setattr(
            "coros_sync.cli_plan.bearer_header",
            lambda profile: {"Authorization": "Bearer t"},
        )
        monkeypatch.setattr("coros_sync.cli_plan.httpx.post", post_mock)

        runner = CliRunner()
        result = runner.invoke(
            cli, [
                "-P", USER, "plan", "select",
                "--week", WEEK, "--variant-id", "7",
                "--prod-url", "https://x.test",
            ],
        )
        # Non-zero exit because we raised ClickException on selection_conflict.
        assert result.exit_code != 0
        assert "selection_conflict" in result.output
        # Only one POST — no retry on selection_conflict (it isn't transient).
        assert post_mock.call_count == 1


# ── delete-variants confirmation ───────────────────────────────────────


class TestDeleteCommand:
    def test_delete_with_yes_skips_prompt(self, monkeypatch):
        from coros_sync.cli import cli

        resp = MagicMock()
        resp.status_code = 200
        resp.json = MagicMock(return_value={"deleted_variants": 3})
        delete_mock = MagicMock(return_value=resp)
        monkeypatch.setattr(
            "coros_sync.cli_plan.bearer_header",
            lambda profile: {"Authorization": "Bearer t"},
        )
        monkeypatch.setattr("coros_sync.cli_plan.httpx.delete", delete_mock)

        runner = CliRunner()
        result = runner.invoke(
            cli, [
                "-P", USER, "plan", "delete-variants",
                "--week", WEEK, "--yes",
                "--prod-url", "https://x.test",
            ],
        )
        assert result.exit_code == 0, result.output
        assert "deleted 3 variant" in result.output

    def test_delete_without_yes_aborts_on_no(self, monkeypatch):
        from coros_sync.cli import cli
        delete_mock = MagicMock()
        monkeypatch.setattr(
            "coros_sync.cli_plan.bearer_header",
            lambda profile: {"Authorization": "Bearer t"},
        )
        monkeypatch.setattr("coros_sync.cli_plan.httpx.delete", delete_mock)

        runner = CliRunner()
        result = runner.invoke(
            cli, [
                "-P", USER, "plan", "delete-variants",
                "--week", WEEK,
                "--prod-url", "https://x.test",
            ],
            input="n\n",
        )
        # User answered 'n' → click.confirm aborts → non-zero exit; no
        # HTTP DELETE was issued.
        assert result.exit_code != 0
        assert delete_mock.call_count == 0
