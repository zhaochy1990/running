"""Stage-3a Task 5: per-week specialist graph wrapper.

``build_week_specialist_graph`` is a thin coach-core convenience constructor
over ``build_generation_graph`` + ``run_rule_filter`` (the S2 weekly rules).
The generator + reviewer are injected (Task 6 passes the real
``generate_specialist_week`` and a per-phase reviewer); ``rule_filter_kwargs``
flows straight through to ``run_rule_filter`` — this is where the per-week S2
inputs (``prev_week_km`` / ``injuries`` / ``prev_ctl`` /
``z45_pace_threshold_s_km``) go.
"""

from __future__ import annotations

from coach.graphs.generation.week_graph import build_week_specialist_graph
from coach.schemas import ReviewReport


def _multi_run_week() -> dict:
    """A clean aspirational (spec=None) multi-run week with a rest day.

    Two short runs + a rest day → run_rule_filter passes (long_run_share only
    bites once ≥2 runs and one dominates >35%; here the two runs are 8k/8k so
    longest share is 50% — keep them unequal-but-safe by making one smaller
    and adding a third so no single run exceeds 35%).
    """
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
                "date": "2026-05-13",
                "session_index": 0,
                "kind": "run",
                "summary": "easy",
                "spec": None,
                "notes_md": None,
                "total_distance_m": 8000,
                "total_duration_s": 2700,
            },
            {
                "date": "2026-05-15",
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


def _base_state() -> dict:
    return {
        "job_id": "j",
        "user_id": "u",
        "plan_type": "week",
        "input_payload": {},
    }


# ---------------------------------------------------------------------------
# Happy path: clean aspirational week + reviewer 'pass' → finalize
# ---------------------------------------------------------------------------


def test_happy_path_finalizes():
    def generator(_state):
        return {"current_draft": _multi_run_week()}

    def reviewer(state):
        return ReviewReport(
            verdict="pass", reviewer_model="fake", iteration=state["iteration"]
        )

    graph = build_week_specialist_graph(generator=generator, reviewer=reviewer)
    out = graph.invoke(_base_state())

    assert out["final_verdict"] == "pass"
    assert out["final_artifact"]["week_folder"] == "2026-05-11_05-17"


# ---------------------------------------------------------------------------
# Violation routes back to generator; persistent violation ends at fallback
# ---------------------------------------------------------------------------


def test_violation_routes_back_to_generator():
    call_count = {"gen": 0, "rev": 0}

    def generator(_state):
        call_count["gen"] += 1
        # Always emit a week with no rest day (7 consecutive run days) → the
        # rest_days rule fires an error every round, never reaching reviewer.
        bad = _multi_run_week()
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
            for d in range(11, 18)
        ]
        return {"current_draft": bad}

    def reviewer(state):
        call_count["rev"] += 1
        return ReviewReport(
            verdict="pass", reviewer_model="fake", iteration=state["iteration"]
        )

    graph = build_week_specialist_graph(
        generator=generator, reviewer=reviewer, max_iterations=3
    )
    out = graph.invoke(_base_state())

    # Routed back to generator repeatedly, never reached the reviewer, ended
    # at fallback with verdict 'block'. This proves rule_filter is wired.
    assert out["final_verdict"] == "block"
    assert call_count["gen"] > 1
    assert call_count["rev"] == 0


# ---------------------------------------------------------------------------
# rule_filter_kwargs forwarding: prev_week_km must reach run_rule_filter and
# change behaviour (passes without it, trips weekly_progression with it).
# ---------------------------------------------------------------------------


def test_rule_filter_kwargs_forwarded():
    def generator(_state):
        return {"current_draft": _multi_run_week()}

    def reviewer(state):
        return ReviewReport(
            verdict="pass", reviewer_model="fake", iteration=state["iteration"]
        )

    # Without prev_week_km → weekly_progression is a no-op, week passes.
    graph_ok = build_week_specialist_graph(generator=generator, reviewer=reviewer)
    out_ok = graph_ok.invoke(_base_state())
    assert out_ok["final_verdict"] == "pass"

    # The week totals 24 km. A small prev_week_km=5 makes the ratio 4.8x → far
    # over the 1.10x cap → weekly_progression error → routes back → fallback.
    graph_trip = build_week_specialist_graph(
        generator=generator,
        reviewer=reviewer,
        rule_filter_kwargs={"prev_week_km": 5.0},
        max_iterations=2,
    )
    out_trip = graph_trip.invoke(_base_state())
    assert out_trip["final_verdict"] == "block"


# ---------------------------------------------------------------------------
# Default passthrough loader: building without load_context works AND the
# default loader is a true no-op — it preserves pre-injected state["context"]
# instead of wiping it to {}.
# ---------------------------------------------------------------------------


def test_default_loader_empty_when_no_context_injected():
    seen = {}

    def generator(state):
        seen["context"] = state.get("context")
        return {"current_draft": _multi_run_week()}

    def reviewer(state):
        return ReviewReport(
            verdict="pass", reviewer_model="fake", iteration=state["iteration"]
        )

    # No load_context kwarg + no pre-injected context → generator sees {}.
    graph = build_week_specialist_graph(generator=generator, reviewer=reviewer)
    out = graph.invoke(_base_state())

    assert out["final_verdict"] == "pass"
    assert seen["context"] == {}


def test_default_loader_preserves_injected_context():
    seen = {}

    def generator(state):
        seen["context"] = state.get("context")
        return {"current_draft": _multi_run_week()}

    def reviewer(state):
        return ReviewReport(
            verdict="pass", reviewer_model="fake", iteration=state["iteration"]
        )

    # No load_context kwarg, but the invocation state pre-populates context.
    # The default loader must PRESERVE it (not wipe it to {}) so the generator
    # sees the threaded context — this locks the per-phase loop's reliance on
    # the core default.
    graph = build_week_specialist_graph(generator=generator, reviewer=reviewer)
    state = _base_state()
    state["context"] = {"foo": "bar"}
    out = graph.invoke(state)

    assert out["final_verdict"] == "pass"
    assert seen["context"] == {"foo": "bar"}
