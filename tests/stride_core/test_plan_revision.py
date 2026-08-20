"""Pure-domain weekly plan fingerprint (base_revision for optimistic apply)."""

from __future__ import annotations

from stride_core.plan_revision import weekly_plan_fingerprint
from stride_core.plan_spec import PlannedSession, SessionKind, WeeklyPlan


def _plan(summary: str = "轻松跑") -> WeeklyPlan:
    return WeeklyPlan(
        week_folder="2026-06-22_06-28(W8)",
        sessions=(
            PlannedSession(
                date="2026-06-24",
                session_index=0,
                kind=SessionKind.RUN,
                summary=summary,
            ),
        ),
        notes_md="本周说明",
    )


def test_fingerprint_is_stable_for_equal_plans() -> None:
    assert weekly_plan_fingerprint(_plan()) == weekly_plan_fingerprint(_plan())


def test_fingerprint_changes_when_plan_changes() -> None:
    assert weekly_plan_fingerprint(_plan("轻松跑")) != weekly_plan_fingerprint(
        _plan("节奏跑")
    )


def test_fingerprint_is_key_order_independent() -> None:
    # Same content reached via a round-trip through the canonical dict must match.
    plan = _plan()
    rebuilt = WeeklyPlan.from_dict(plan.to_dict())
    assert weekly_plan_fingerprint(plan) == weekly_plan_fingerprint(rebuilt)


def test_fingerprint_is_hex_sha256() -> None:
    fp = weekly_plan_fingerprint(_plan())
    assert len(fp) == 64
    assert all(c in "0123456789abcdef" for c in fp)
