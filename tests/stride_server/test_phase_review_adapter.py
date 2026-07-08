"""Tests for coach_adapters.phase_review_adapter (Stage-3b T4).

``review_phase(phase, weeks, *, milestones=None)``:
  * assembles the per-phase reviewer prompt (core ``build_phase_review_prompt``),
  * calls the **reviewer-role** LLM via ``get_reviewer_llm().invoke`` (plain
    single-shot chat — no tools; NOT the generator, so the review stays
    model-independent),
  * parses via core ``parse_phase_review``,
  * degrades safely on any LLM / construction failure (returns ``revise`` with a
    review-unavailable commentary — never crashes the season).

All LLM calls are faked (no network). The fake captures the composed prompt so
we can assert it carries the doctrine + focus + milestone.
"""

from __future__ import annotations

import pytest

import stride_server.coach_adapters.phase_review_adapter as adapter_mod
from stride_server.coach_adapters.phase_review_adapter import _render_milestone_summary, review_phase
from stride_core.master_plan import Milestone, MilestoneType, Phase, PhaseType


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------


def _speed_phase() -> Phase:
    return Phase(
        id="phase-speed-1",
        name="速度周期",
        start_date="2026-06-15",
        end_date="2026-06-28",
        focus="发展 VO2max 与速度储备",
        weekly_distance_km_low=60.0,
        weekly_distance_km_high=80.0,
        key_session_types=["VO2max", "短间歇"],
        milestone_ids=["ms-1"],
        phase_type=PhaseType.SPEED,
    )


def _milestone() -> Milestone:
    return Milestone(
        id="ms-1",
        type=MilestoneType.TEST_RUN,
        date="2026-06-28",
        phase_id="phase-speed-1",
        target="5k sub-19:00",
        metric="race_time_s_5k",
        target_value=1140.0,
        comparator="<=",
    )


def _weeks() -> list[dict]:
    return [
        {
            "schema": "weekly-plan/v1",
            "week_folder": "2026-06-15_06-21(W1)",
            "sessions": [
                {
                    "schema": "plan-session/v1",
                    "date": "2026-06-16",
                    "session_index": 0,
                    "kind": "run",
                    "summary": "VO2max 1k * 6 @ 3:35/km",
                    "total_distance_m": 12000,
                },
            ],
        },
    ]


# ---------------------------------------------------------------------------
# fake LLM
# ---------------------------------------------------------------------------


class _FakeReply:
    """Mimics a langchain ``AIMessage`` — only ``.content`` is read by the
    adapter (via ``extract_text``)."""

    def __init__(self, content: str) -> None:
        self.content = content


class _FakeReviewerLLM:
    """Mimics the reviewer-role ``BaseChatModel`` returned by
    ``get_reviewer_llm()``.

    The adapter now judges the phase with the **reviewer-role** deployment, not
    the generator, so the fake stands in for that LLM. Class attributes drive
    the behaviour so the test sets them before the adapter calls the factory.
    ``get_reviewer_llm`` itself can raise (construct-failure) and ``invoke`` can
    raise (call-failure) — both must safe-degrade to ``revise``.
    """

    reply: str = ""
    raise_on_construct: Exception | None = None
    raise_on_invoke: Exception | None = None
    # captured holds (system_content, human_content) per the prompt-assert tests.
    captured: list = []

    @classmethod
    def get_reviewer_llm(cls):
        if cls.raise_on_construct is not None:
            raise cls.raise_on_construct
        return cls()

    def invoke(self, messages):  # noqa: ANN001
        system_content = messages[0].content
        human_content = messages[1].content if len(messages) > 1 else ""
        type(self).captured.append((system_content, human_content))
        if type(self).raise_on_invoke is not None:
            raise type(self).raise_on_invoke
        return _FakeReply(type(self).reply)


@pytest.fixture(autouse=True)
def _reset_fake():
    _FakeReviewerLLM.reply = ""
    _FakeReviewerLLM.raise_on_construct = None
    _FakeReviewerLLM.raise_on_invoke = None
    _FakeReviewerLLM.captured = []
    yield


@pytest.fixture
def fake_llm(monkeypatch):
    monkeypatch.setattr(
        adapter_mod, "get_reviewer_llm", _FakeReviewerLLM.get_reviewer_llm
    )
    return _FakeReviewerLLM


# ---------------------------------------------------------------------------
# verdict pass-through
# ---------------------------------------------------------------------------


def test_block_review_returns_block(fake_llm):
    fake_llm.reply = """<review>
      <verdict>block</verdict>
      <commentary>speed 阶段无任何真 Z5 课</commentary>
      <issues>[{"review_class": "phase_fit", "severity": "error", "message": "no Z5"}]</issues>
    </review>"""
    review = review_phase(_speed_phase(), _weeks(), milestones=[_milestone()])
    assert review.verdict == "block"
    assert len(review.issues) == 1
    assert review.issues[0].message == "no Z5"


def test_revise_review_returns_revise(fake_llm):
    fake_llm.reply = """<review>
      <verdict>revise</verdict>
      <commentary>VO2max 密度不足</commentary>
    </review>"""
    review = review_phase(_speed_phase(), _weeks(), milestones=[_milestone()])
    assert review.verdict == "revise"


def test_pass_review_returns_pass(fake_llm):
    fake_llm.reply = """<review>
      <verdict>pass</verdict>
      <commentary>符合速度周期特征</commentary>
    </review>"""
    review = review_phase(_speed_phase(), _weeks(), milestones=[_milestone()])
    assert review.verdict == "pass"


# ---------------------------------------------------------------------------
# prompt carries doctrine + focus + milestone
# ---------------------------------------------------------------------------


def test_prompt_carries_doctrine_and_milestone(fake_llm):
    fake_llm.reply = "<review><verdict>pass</verdict></review>"
    review_phase(_speed_phase(), _weeks(), milestones=[_milestone()])
    system_prompt, _messages = fake_llm.captured[0]
    # specialist doctrine signature: assert tokens unique to the SPEED guidance
    # *body*. "速度周期" is only the specialist name (also in BASE guidance), and
    # "两极化"/"金字塔" are in the reviewer prompt TEMPLATE for every phase
    # (phase_reviewer.py:147), so neither proves routing. "polarized" and
    # "跑步经济性" live only in the speed guidance (phase_specialists.py:167, :155)
    # and not in the template, so they discriminate. (跑步经济性 is also absent
    # from the phase focus string, so it can only come from the doctrine.)
    assert "polarized" in system_prompt
    assert "跑步经济性" in system_prompt
    assert "VO2max" in system_prompt
    # negative guard: "金字塔型" is base-only (phase_specialists.py:101); its
    # absence confirms the BASE specialist was NOT injected by mistake.
    assert "金字塔型" not in system_prompt
    # phase focus
    assert "发展 VO2max 与速度储备" in system_prompt
    # milestone — the quantifiable metric/target/comparator rendered into prose
    assert "race_time_s_5k" in system_prompt
    assert "1140" in system_prompt
    # the generated week summary
    assert "2026-06-15_06-21(W1)" in system_prompt


def test_milestone_summary_includes_date_type_and_metric():
    summary = _render_milestone_summary([_milestone()])

    assert summary is not None
    assert "2026-06-28" in summary
    assert "test_run" in summary
    assert "race_time_s_5k <= 1140" in summary
    assert "5k sub-19:00" in summary


def test_milestones_filtered_to_this_phase(fake_llm):
    """Only milestones owned by this phase (phase_id / milestone_ids) appear."""
    fake_llm.reply = "<review><verdict>pass</verdict></review>"
    other = Milestone(
        id="ms-other",
        type=MilestoneType.RACE,
        date="2026-11-01",
        phase_id="some-other-phase",
        target="全马 sub-3:00",
    )
    review_phase(
        _speed_phase(), _weeks(), milestones=[_milestone(), other]
    )
    system_prompt, _ = fake_llm.captured[0]
    assert "5k sub-19:00" in system_prompt or "race_time_s_5k" in system_prompt
    # the unrelated milestone must not leak in
    assert "全马 sub-3:00" not in system_prompt


# ---------------------------------------------------------------------------
# safe degrade on LLM failure
# ---------------------------------------------------------------------------


def test_chat_exception_degrades_to_revise(fake_llm):
    fake_llm.raise_on_invoke = RuntimeError("boom")
    review = review_phase(_speed_phase(), _weeks(), milestones=[_milestone()])
    # documented safe-degrade verdict: revise (review unavailable → regenerate)
    assert review.verdict == "revise"
    assert "review" in review.commentary_md.lower() or "评审" in review.commentary_md
    # no crash, no issues fabricated
    assert review.issues == []


def test_construct_exception_degrades_to_revise(fake_llm):
    fake_llm.raise_on_construct = RuntimeError("llm unavailable")
    review = review_phase(_speed_phase(), _weeks(), milestones=[_milestone()])
    assert review.verdict == "revise"
    # the reviewer LLM was never reached for an invoke
    assert _FakeReviewerLLM.captured == []


def test_no_milestones_still_reviews(fake_llm):
    fake_llm.reply = "<review><verdict>pass</verdict><commentary>ok</commentary></review>"
    review = review_phase(_speed_phase(), _weeks(), milestones=None)
    assert review.verdict == "pass"


# ---------------------------------------------------------------------------
# reviewer-role independence (not the generator)
# ---------------------------------------------------------------------------


def test_uses_reviewer_role_not_generator(monkeypatch):
    """The per-phase reviewer must judge weeks with the reviewer-role LLM, not
    the generator that produced them — review independence. We patch BOTH role
    accessors: the reviewer fake serves the reply; the generator accessor blows
    up if touched, proving the generator path is never taken."""

    def _boom_generator():
        raise AssertionError("review_phase must NOT call the generator LLM")

    monkeypatch.setattr(
        adapter_mod, "get_reviewer_llm", _FakeReviewerLLM.get_reviewer_llm
    )
    # get_generator_llm isn't imported by the adapter, but guard against a
    # regression that reintroduces LLMClient (which is hardwired to it).
    if hasattr(adapter_mod, "get_generator_llm"):
        monkeypatch.setattr(adapter_mod, "get_generator_llm", _boom_generator)

    _FakeReviewerLLM.reply = "<review><verdict>pass</verdict><commentary>ok</commentary></review>"
    review = review_phase(_speed_phase(), _weeks(), milestones=[_milestone()])
    assert review.verdict == "pass"
    # the reviewer LLM was the one invoked
    assert len(_FakeReviewerLLM.captured) == 1
