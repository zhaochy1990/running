"""S1d — dispatcher: execute CallPlan, attribute + contain failures (§4.6)."""

from __future__ import annotations

from coach.contracts import (
    CallPlan,
    SpecialistCall,
    SpecialistCard,
    SpecialistRegistry,
    SpecialistResult,
    SpecialistTask,
)
from coach.orchestrator.dispatcher import dispatch


def _plan(*specialist_ids: str) -> CallPlan:
    return CallPlan(
        calls=[
            SpecialistCall(specialist_id=sid, task=SpecialistTask(objective=f"do {sid}"))
            for sid in specialist_ids
        ]
    )


def test_single_call_runs_and_attributes_result() -> None:
    reg = SpecialistRegistry()
    reg.register(
        SpecialistCard(id="status_insight", description="x"),
        lambda task: SpecialistResult(status="completed", reply_fragment=task.objective),
    )
    out = dispatch(_plan("status_insight"), registry=reg)
    assert len(out) == 1
    assert out[0].specialist_id == "status_insight"
    assert out[0].result.reply_fragment == "do status_insight"


def test_runner_exception_contained_as_failed() -> None:
    reg = SpecialistRegistry()

    def _boom(task: SpecialistTask) -> SpecialistResult:
        raise RuntimeError("db down")

    reg.register(SpecialistCard(id="status_insight", description="x"), _boom)
    out = dispatch(_plan("status_insight"), registry=reg)
    assert out[0].result.status == "failed"
    assert "db down" in out[0].result.reply_fragment


def test_one_failure_does_not_crash_other_calls() -> None:
    reg = SpecialistRegistry()
    reg.register(
        SpecialistCard(id="ok", description="x"),
        lambda task: SpecialistResult(status="completed", reply_fragment="fine"),
    )

    def _boom(task: SpecialistTask) -> SpecialistResult:
        raise ValueError("nope")

    reg.register(SpecialistCard(id="bad", description="x"), _boom)
    out = dispatch(_plan("ok", "bad"), registry=reg)
    assert [d.specialist_id for d in out] == ["ok", "bad"]
    assert out[0].result.status == "completed"
    assert out[1].result.status == "failed"


def test_empty_plan_returns_empty() -> None:
    reg = SpecialistRegistry()
    assert dispatch(CallPlan(calls=[]), registry=reg) == []
