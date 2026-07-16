"""Frozen-fixture harness for S1 master-plan adjustment conversations.

Unlike the existing S1 generation eval, this path exercises the production
``season_plan`` specialist and ``master_chat`` graph. Fixture-owned read results
keep it deterministic and prevent any local DB or production-store access.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from datetime import date
from types import SimpleNamespace
from typing import Any

from coach.contracts import SpecialistTask, TargetRef, Turn
from coach.graphs.conversation.graph import build_conversation_graph
from coach.graphs.conversation.tool_bridge import MASTER_ASSESSMENT_TOOL_NAME
from coach.schemas import ToolResult
from coach_eval.schemas import AxisScore, FixtureRunOutcome, JudgeScore
from stride_core.master_plan import MasterPlan
from stride_server.coach_adapters.orchestrator.season_plan import (
    make_season_plan_runner,
)
from stride_server.coach_adapters.tool_impls.draft_impls import (
    ChangeTargetImpl,
    CompressPhaseImpl,
    ExtendPhaseImpl,
    ProposeReductionAlternativesImpl,
    RegenerateMasterImpl,
    RescheduleTargetRaceImpl,
    SetPhaseFocusImpl,
    SetPhaseWeeklyRangeImpl,
    ShiftMilestoneImpl,
    UpdateTargetRaceTimeImpl,
)


CONVERSATION_CONTRACT_VERSION = "s1-conversation-v1"
_REQUIRED_READS = (
    "get_master_plan_current",
    "get_health_snapshot",
    "get_pmc_series",
    "estimate_master_plan_load",
)
_DRAFT_TOOLS = (
    "extend_phase",
    "compress_phase",
    "set_phase_weekly_range",
    "set_phase_focus",
    "propose_reduction_alternatives",
    "shift_milestone",
    "reschedule_target_race",
    "change_target",
    "update_target_race_time",
    "regenerate_master",
)


class _FrozenStore:
    def __init__(self, plan: MasterPlan) -> None:
        self._plan = plan

    def get_plan(self, user_id: str, plan_id: str) -> MasterPlan | None:
        if user_id == self._plan.user_id and plan_id == self._plan.plan_id:
            return self._plan
        return None

    def get_active_plan(self, user_id: str) -> MasterPlan | None:
        return self._plan if user_id == self._plan.user_id else None


class _FrozenNoArgRead:
    def __init__(self, data: dict[str, Any]) -> None:
        self._data = data

    def __call__(self) -> ToolResult:
        return ToolResult(ok=True, data=self._data)


class _FrozenPmcRead:
    def __init__(self, data: dict[str, Any]) -> None:
        self._data = data

    def __call__(self, *, days: int = 42, granularity: str = "daily") -> ToolResult:
        return ToolResult(ok=True, data=self._data)


class _FrozenMasterLoadRead:
    def __init__(self, data: dict[str, Any]) -> None:
        self._data = data

    def __call__(
        self,
        *,
        plan: dict | None = None,
        target_race: dict | None = None,
        weekly_run_days_max: int | None = None,
        injuries: list[str] | None = None,
        as_of_date: str | None = None,
    ) -> ToolResult:
        return ToolResult(ok=True, data=self._data)


def _build_frozen_toolkit(fixture: dict, plan: MasterPlan) -> Any:
    fixture_input = fixture.get("input") or {}
    read_results = fixture_input.get("read_results") or {}
    as_of_raw = fixture_input.get("as_of_date")
    as_of = date.fromisoformat(str(as_of_raw)) if as_of_raw else None
    load_plan: Callable[[str], MasterPlan | None] = (
        lambda plan_id: plan if plan_id == plan.plan_id else None
    )
    return SimpleNamespace(
        get_master_plan_current=_FrozenNoArgRead({"plan": plan.model_dump(mode="json")}),
        get_health_snapshot=_FrozenNoArgRead(
            dict(read_results.get("get_health_snapshot") or {})
        ),
        get_pmc_series=_FrozenPmcRead(dict(read_results.get("get_pmc_series") or {})),
        estimate_master_plan_load=_FrozenMasterLoadRead(
            dict(read_results.get("estimate_master_plan_load") or {})
        ),
        get_race_predictions=_FrozenNoArgRead(
            dict(read_results.get("get_race_predictions") or {})
        ),
        get_pbs=_FrozenNoArgRead(dict(read_results.get("get_pbs") or {})),
        extend_phase=ExtendPhaseImpl(plan.user_id, plan_loader=load_plan),
        compress_phase=CompressPhaseImpl(plan.user_id, plan_loader=load_plan),
        set_phase_weekly_range=SetPhaseWeeklyRangeImpl(
            plan.user_id, plan_loader=load_plan
        ),
        set_phase_focus=SetPhaseFocusImpl(
            plan.user_id, plan_loader=load_plan
        ),
        propose_reduction_alternatives=ProposeReductionAlternativesImpl(
            plan.user_id, plan_loader=load_plan
        ),
        shift_milestone=ShiftMilestoneImpl(plan.user_id, plan_loader=load_plan),
        reschedule_target_race=RescheduleTargetRaceImpl(
            plan.user_id, plan_loader=load_plan, as_of=as_of
        ),
        change_target=ChangeTargetImpl(plan.user_id, plan_loader=load_plan),
        update_target_race_time=UpdateTargetRaceTimeImpl(
            plan.user_id, plan_loader=load_plan
        ),
        regenerate_master=RegenerateMasterImpl(
            plan.user_id, plan_loader=load_plan
        ),
    )


def _selected_tool_names() -> tuple[str, ...]:
    return (
        *_REQUIRED_READS,
        "get_race_predictions",
        "get_pbs",
        MASTER_ASSESSMENT_TOOL_NAME,
        *_DRAFT_TOOLS,
    )


def _contract_violations(artifact: dict, expected: dict) -> list[str]:
    violations: list[str] = []
    result = artifact.get("result") or {}
    trace = artifact.get("tool_trace") or []
    ok_names = [
        str(item.get("name"))
        for item in trace
        if isinstance(item, dict) and item.get("outcome") == "ok"
    ]
    proposals = result.get("proposals") or []
    blocked = [
        item
        for item in trace
        if isinstance(item, dict) and item.get("outcome") == "blocked"
    ]

    expected_status = expected.get("status")
    if expected_status and result.get("status") != expected_status:
        violations.append(
            f"status expected {expected_status!r}, got {result.get('status')!r}"
        )
    clarification_required = bool(expected.get("clarification_required"))
    has_clarification = bool(result.get("clarification"))
    if clarification_required != has_clarification:
        violations.append(
            f"clarification_required={clarification_required}, got {has_clarification}"
        )
    clarification_contains = expected.get("clarification_contains")
    if clarification_contains and clarification_contains not in str(
        result.get("clarification") or ""
    ):
        violations.append(
            f"clarification missing expected text {clarification_contains!r}"
        )
    expected_proposals = expected.get("proposal_count")
    if isinstance(expected_proposals, int) and len(proposals) != expected_proposals:
        violations.append(
            f"proposal_count expected {expected_proposals}, got {len(proposals)}"
        )
    if expected.get("tool_trace_empty") and trace:
        violations.append(f"expected no tool calls, got {ok_names}")
    if expected.get("forbid_blocked_calls", True) and blocked:
        blocked_summary = ", ".join(
            f"{item.get('name')}:{item.get('reason')}" for item in blocked
        )
        violations.append("blocked tool attempt(s): " + blocked_summary)

    required_reads = expected.get("required_reads") or []
    for name in required_reads:
        if name not in ok_names:
            violations.append(f"required read tool did not succeed: {name}")
    assessment_verdict = expected.get("assessment_verdict")
    assessment = artifact.get("assessment") or {}
    if assessment_verdict and assessment.get("verdict") != assessment_verdict:
        violations.append(
            f"assessment verdict expected {assessment_verdict!r}, "
            f"got {assessment.get('verdict')!r}"
        )
    assessment_request = expected.get("assessment_request")
    if (
        assessment_request
        and assessment.get("adjustment_request") != assessment_request
    ):
        violations.append(
            f"assessment request expected {assessment_request!r}, "
            f"got {assessment.get('adjustment_request')!r}"
        )
    expected_rationale_contains = expected.get("assessment_rationale_contains") or []
    if isinstance(expected_rationale_contains, str):
        expected_rationale_contains = [expected_rationale_contains]
    rationale = str(assessment.get("rationale") or "")
    for token in expected_rationale_contains:
        if str(token) not in rationale:
            violations.append(
                f"assessment rationale missing expected text {token!r}"
            )
    effective_request = expected.get("effective_request")
    if effective_request and artifact.get("effective_request") != effective_request:
        violations.append(
            f"effective request expected {effective_request!r}, "
            f"got {artifact.get('effective_request')!r}"
        )
    if required_reads and assessment_verdict:
        try:
            assessment_idx = ok_names.index(MASTER_ASSESSMENT_TOOL_NAME)
        except ValueError:
            assessment_idx = -1
        if assessment_idx < 0:
            violations.append("assessment tool did not succeed")
        elif all(name in ok_names for name in required_reads):
            late_reads = [
                name for name in required_reads if ok_names.index(name) > assessment_idx
            ]
            if late_reads:
                violations.append(
                    "assessment ran before required reads: " + ", ".join(late_reads)
                )

    required_draft = expected.get("required_draft_tool")
    if required_draft:
        if required_draft not in ok_names:
            violations.append(f"required draft tool did not succeed: {required_draft}")
        elif MASTER_ASSESSMENT_TOOL_NAME in ok_names and (
            ok_names.index(required_draft) < ok_names.index(MASTER_ASSESSMENT_TOOL_NAME)
        ):
            violations.append("draft tool ran before assessment")
    for forbidden in expected.get("forbidden_tools") or []:
        if forbidden in ok_names:
            violations.append(f"forbidden tool succeeded: {forbidden}")

    proposal_expectation = expected.get("proposal") or {}
    if proposal_expectation and proposals:
        proposal = proposals[0]
        ops = proposal.get("ops") or []
        expected_op_count = proposal_expectation.get("op_count")
        if isinstance(expected_op_count, int) and len(ops) != expected_op_count:
            violations.append(
                f"proposal op_count expected {expected_op_count}, got {len(ops)}"
            )
        if not ops:
            violations.append("proposal has no diff ops")
        else:
            op = ops[0]
            for key in ("op", "phase_id", "milestone_id"):
                expected_value = proposal_expectation.get(key)
                if expected_value is not None and op.get(key) != expected_value:
                    violations.append(
                        f"proposal {key} expected {expected_value!r}, got {op.get(key)!r}"
                    )
            expected_new = proposal_expectation.get("new_value") or {}
            actual_new = op.get("new_value") or {}
            for key, expected_value in expected_new.items():
                if actual_new.get(key) != expected_value:
                    violations.append(
                        f"proposal new_value.{key} expected {expected_value!r}, "
                        f"got {actual_new.get(key)!r}"
                    )
            expected_patch = proposal_expectation.get("spec_patch")
            if expected_patch is not None and op.get("spec_patch") != expected_patch:
                violations.append(
                    f"proposal spec_patch expected {expected_patch!r}, "
                    f"got {op.get('spec_patch')!r}"
                )
            expected_old = proposal_expectation.get("old_value") or {}
            actual_old = op.get("old_value") or {}
            for key, expected_value in expected_old.items():
                if actual_old.get(key) != expected_value:
                    violations.append(
                        f"proposal old_value.{key} expected {expected_value!r}, "
                        f"got {actual_old.get(key)!r}"
                    )
            explanation_contains = proposal_expectation.get(
                "ai_explanation_contains"
            ) or []
            if isinstance(explanation_contains, str):
                explanation_contains = [explanation_contains]
            explanation = str(proposal.get("ai_explanation") or "")
            for token in explanation_contains:
                if str(token) not in explanation:
                    violations.append(
                        f"proposal ai_explanation missing expected text {token!r}"
                    )

    return violations


def run_s1_conversation_fixture(
    fixture: dict, *, llm: Any
) -> FixtureRunOutcome:
    fixture_id = str(fixture.get("fixture_id") or "<unknown>")
    fixture_input = fixture.get("input") or {}
    plan = MasterPlan.model_validate(fixture_input.get("active_plan") or {})
    store = _FrozenStore(plan)
    toolkit = _build_frozen_toolkit(fixture, plan)
    captured_state: dict[str, Any] = {}

    def _observe(state: dict[str, Any]) -> None:
        captured_state.update(state)

    def _graph_factory(**kwargs: Any) -> Any:
        return build_conversation_graph(**kwargs, tool_names=_selected_tool_names())

    runner = make_season_plan_runner(
        user_id=plan.user_id,
        llm=llm,
        toolkit=toolkit,
        plan_store=store,
        state_observer=_observe,
        graph_factory=_graph_factory,
        validation_as_of=(
            date.fromisoformat(str(fixture_input["as_of_date"]))
            if fixture_input.get("as_of_date")
            else None
        ),
    )
    started = time.monotonic()
    try:
        conversation_window = [
            Turn.model_validate(item)
            for item in (fixture_input.get("conversation_window") or [])
        ]
        result = runner(
            SpecialistTask(
                objective=str(fixture_input.get("message") or ""),
                active_target=TargetRef(kind="master", plan_id=plan.plan_id),
                conversation_window=conversation_window,
            )
        )
    except Exception as exc:  # noqa: BLE001 - eval boundary
        return FixtureRunOutcome(
            fixture_id=fixture_id,
            scope="s1",
            l1_passed=False,
            timings={"conversation_s": time.monotonic() - started},
            error=f"conversation_failed: {type(exc).__name__}: {exc}",
        )

    artifact = {
        "evaluation_path": "master_chat",
        "effective_request": captured_state.get("master_adjustment_request"),
        "result": result.model_dump(mode="json"),
        "tool_trace": list(captured_state.get("tool_trace") or []),
        "consulted_tools": list(captured_state.get("consulted_tools") or []),
        "assessment": captured_state.get("master_adjustment_assessment"),
    }
    violations = _contract_violations(artifact, fixture.get("expected") or {})
    passed = not violations
    score = JudgeScore(
        fixture_id=fixture_id,
        scope="s1",
        axes=[
            AxisScore(
                axis="conversation_contract",
                score=5 if passed else 1,
                rationale=("all deterministic conversation contracts passed" if passed else "; ".join(violations)),
                matches_expected=passed,
            )
        ],
        overall_verdict="pass" if passed else "fail",
        overall_rationale=("contract passed" if passed else "; ".join(violations)),
        judge_model="deterministic",
        judge_prompt_version=CONVERSATION_CONTRACT_VERSION,
    )
    return FixtureRunOutcome(
        fixture_id=fixture_id,
        scope="s1",
        l1_passed=passed,
        l1_violations=[
            {"rule": "conversation_contract", "severity": "error", "message": item}
            for item in violations
        ],
        generated_artifact=artifact,
        generation_iterations=captured_state.get("iteration"),
        timings={
            "conversation_s": time.monotonic() - started,
            "total_s": time.monotonic() - started,
        },
        judge_score=score,
        debug={"contract_violations": violations},
    )
