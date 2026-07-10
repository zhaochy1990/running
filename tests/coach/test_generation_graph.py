"""US-008 acceptance: generation graph routes through rule_filter + reviewer
correctly and respects max_iterations."""

from __future__ import annotations

from coach.graphs.generation.graph import build_generation_graph, parse_reviewer_xml
from coach.schemas import ReviewReport


def _clean_plan() -> dict:
    return {
        "schema": "weekly-plan/v1",
        "week_folder": "2026-05-11_05-17",
        "sessions": [
            {
                "date": "2026-05-11",
                "session_index": 0,
                "kind": "run",
                "summary": "easy",
                "spec": None,
                "notes_md": None,
                "total_distance_m": 8000,
                "total_duration_s": 2700,
            },
            {
                "date": "2026-05-12",
                "session_index": 0,
                "kind": "rest",
                "summary": "rest",
                "spec": None,
                "notes_md": None,
                "total_distance_m": None,
                "total_duration_s": None,
            },
        ],
        "nutrition": [],
    }


# ---------------------------------------------------------------------------
# Happy path: clean draft + reviewer verdict 'pass' → finalize
# ---------------------------------------------------------------------------


def test_happy_path_finalize():
    def loader(_state):
        return {}

    def generator(_state):
        return {"current_draft": _clean_plan()}

    def reviewer(state):
        return ReviewReport(
            verdict="pass", reviewer_model="fake", iteration=state["iteration"]
        )

    graph = build_generation_graph(
        load_context=loader,
        generator=generator,
        reviewer=reviewer,
        max_iterations=3,
    )
    out = graph.invoke(
        {"job_id": "j", "user_id": "u", "plan_type": "week", "input_payload": {}}
    )
    assert out["final_verdict"] == "pass"
    assert out["final_artifact"]["week_folder"] == "2026-05-11_05-17"


def test_generator_timing_metadata_is_preserved():
    def loader(_state):
        return {}

    def generator(_state):
        return {
            "current_draft": _clean_plan(),
            "timing_metadata": {
                "generator_system_prompt_chars": 123,
                "generator_user_prompt_chars": 45,
                "generator_raw_response_chars": 678,
            },
        }

    def reviewer(state):
        return ReviewReport(
            verdict="pass", reviewer_model="fake", iteration=state["iteration"]
        )

    graph = build_generation_graph(
        load_context=loader,
        generator=generator,
        reviewer=reviewer,
        max_iterations=3,
    )
    out = graph.invoke(
        {"job_id": "j", "user_id": "u", "plan_type": "week", "input_payload": {}}
    )

    assert out["timings"]["generator_system_prompt_chars"] == 123
    assert out["timings"]["generator_user_prompt_chars"] == 45
    assert out["timings"]["generator_raw_response_chars"] == 678


# ---------------------------------------------------------------------------
# Reviewer verdict 'revise' → loop back to generator; second pass succeeds
# ---------------------------------------------------------------------------


def test_reviewer_revise_loops_until_pass():
    call_count = {"gen": 0, "rev": 0}

    def loader(_state):
        return {}

    def generator(_state):
        call_count["gen"] += 1
        return {"current_draft": _clean_plan()}

    def reviewer(state):
        call_count["rev"] += 1
        # First pass: revise; second pass: pass
        verdict = "revise" if call_count["rev"] == 1 else "pass"
        return ReviewReport(
            verdict=verdict, reviewer_model="fake", iteration=state["iteration"]
        )

    graph = build_generation_graph(
        load_context=loader, generator=generator, reviewer=reviewer, max_iterations=3
    )
    out = graph.invoke(
        {"job_id": "j", "user_id": "u", "plan_type": "week", "input_payload": {}}
    )
    assert out["final_verdict"] == "pass"
    assert call_count["gen"] == 2
    assert call_count["rev"] == 2


def test_generator_retry_clears_stale_master_plan_load_estimate():
    call_count = {"gen": 0, "rev": 0}

    def loader(_state):
        return {}

    def generator(_state):
        call_count["gen"] += 1
        out = {"current_draft": _clean_plan()}
        if call_count["gen"] == 1:
            out["master_plan_load_estimate"] = {
                "alignment": {
                    "status": "overload",
                    "issues": [{"kind": "stale", "message": "old estimate"}],
                }
            }
        return out

    def reviewer(state):
        call_count["rev"] += 1
        verdict = "revise" if call_count["rev"] == 1 else "pass"
        return ReviewReport(
            verdict=verdict, reviewer_model="fake", iteration=state["iteration"]
        )

    graph = build_generation_graph(
        load_context=loader, generator=generator, reviewer=reviewer, max_iterations=3
    )
    out = graph.invoke(
        {"job_id": "j", "user_id": "u", "plan_type": "master", "input_payload": {}}
    )

    assert out["final_verdict"] == "pass"
    assert call_count["gen"] == 2
    assert out["master_plan_load_estimate"] is None


# ---------------------------------------------------------------------------
# Max iterations reached → fallback (verdict stays 'block')
# ---------------------------------------------------------------------------


def test_max_iterations_then_fallback():
    def loader(_state):
        return {}

    def generator(_state):
        return {"current_draft": _clean_plan()}

    def reviewer(state):
        return ReviewReport(
            verdict="revise", reviewer_model="fake", iteration=state["iteration"]
        )

    graph = build_generation_graph(
        load_context=loader, generator=generator, reviewer=reviewer, max_iterations=2
    )
    out = graph.invoke(
        {"job_id": "j", "user_id": "u", "plan_type": "week", "input_payload": {}}
    )
    assert out["final_verdict"] == "block"


# ---------------------------------------------------------------------------
# Rule-filter HARD violation → loop back to generator without reviewer
# ---------------------------------------------------------------------------


def test_rule_filter_violation_triggers_regenerate():
    call_count = {"gen": 0, "rev": 0}

    def loader(_state):
        return {}

    def generator(state):
        call_count["gen"] += 1
        # First attempt: missing rest day (all 7 days are runs);
        # second attempt: clean plan.
        if call_count["gen"] == 1:
            bad = _clean_plan()
            bad["sessions"] = [
                {
                    "date": f"2026-05-{d:02d}",
                    "session_index": 0,
                    "kind": "run",
                    "summary": "x",
                    "spec": None,
                    "notes_md": None,
                    "total_distance_m": 5000,
                    "total_duration_s": 1800,
                }
                for d in range(11, 18)  # 7 consecutive run days
            ]
            return {"current_draft": bad}
        return {"current_draft": _clean_plan()}

    def reviewer(state):
        call_count["rev"] += 1
        return ReviewReport(
            verdict="pass", reviewer_model="fake", iteration=state["iteration"]
        )

    graph = build_generation_graph(
        load_context=loader, generator=generator, reviewer=reviewer, max_iterations=3
    )
    out = graph.invoke(
        {"job_id": "j", "user_id": "u", "plan_type": "week", "input_payload": {}}
    )
    assert out["final_verdict"] == "pass"
    assert call_count["gen"] == 2
    # Reviewer skipped on the first round because rule_filter killed it
    assert call_count["rev"] == 1
    history = out["timings"]["rule_filter_history"]
    assert [h["iteration"] for h in history] == [1, 2]
    assert history[0]["violations"]
    assert history[0]["violations"][0]["severity"] == "error"
    assert history[1]["violations"] == []


# ---------------------------------------------------------------------------
# Verdict auto_fix → patches applied → finalize
# ---------------------------------------------------------------------------


def test_auto_fix_applies_patches_then_finalizes():
    def loader(_state):
        return {}

    def generator(_state):
        return {"current_draft": _clean_plan()}

    def reviewer(state):
        return ReviewReport(
            verdict="auto_fix",
            reviewer_model="fake",
            iteration=state["iteration"],
            suggested_patches=[{"path": "/sessions/0/summary", "value": "patched"}],
        )

    def apply_patches(draft, patches):
        # Apply a trivial patch
        if patches and isinstance(draft.get("sessions"), list):
            draft["sessions"][0]["summary"] = patches[0]["value"]
        return draft

    graph = build_generation_graph(
        load_context=loader,
        generator=generator,
        reviewer=reviewer,
        apply_patches=apply_patches,
    )
    out = graph.invoke(
        {"job_id": "j", "user_id": "u", "plan_type": "week", "input_payload": {}}
    )
    assert out["final_artifact"]["sessions"][0]["summary"] == "patched"


# ---------------------------------------------------------------------------
# parse_reviewer_xml
# ---------------------------------------------------------------------------


def test_parse_reviewer_xml_happy():
    raw = """<review>
      <verdict>auto_fix</verdict>
      <reviewer_model>claude-sonnet-4-5</reviewer_model>
      <iteration>1</iteration>
      <commentary>降低周三长跑距离</commentary>
      <issues>[{"review_class": "long_run_share", "severity": "error", "message": "too long"}]</issues>
      <suggested_patches>[{"path": "/sessions/0", "value": {}}]</suggested_patches>
    </review>"""
    report = parse_reviewer_xml(raw)
    assert report.verdict == "auto_fix"
    assert report.iteration == 1
    assert len(report.suggested_patches) == 1


def test_parse_reviewer_xml_garbage_returns_block():
    report = parse_reviewer_xml("not xml at all")
    assert report.verdict == "block"
