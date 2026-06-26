"""S0 — SpecialistRegistry behaviour (§4.6, §6)."""

from __future__ import annotations

import pytest

from coach.contracts import (
    SpecialistCard,
    SpecialistRegistry,
    SpecialistResult,
    SpecialistTask,
)


def _card(specialist_id: str, *, writes: bool = False) -> SpecialistCard:
    return SpecialistCard(
        id=specialist_id,
        description=f"route here for {specialist_id}",
        tags=[specialist_id],
        examples=[f"example for {specialist_id}"],
        writes=writes,
    )


def _runner(task: SpecialistTask) -> SpecialistResult:
    return SpecialistResult(status="completed", reply_fragment=task.objective)


def test_register_card_only_then_ids_and_cards() -> None:
    reg = SpecialistRegistry()
    reg.register(_card("status_insight"))
    assert "status_insight" in reg
    assert reg.ids() == ["status_insight"]
    assert reg.cards()[0].description == "route here for status_insight"
    assert len(reg) == 1


def test_register_with_runner_and_invoke() -> None:
    reg = SpecialistRegistry()
    reg.register(_card("status_insight"), _runner)
    runner = reg.get_runner("status_insight")
    result = runner(SpecialistTask(objective="diagnose"))
    assert result.reply_fragment == "diagnose"


def test_get_card_unknown_raises() -> None:
    reg = SpecialistRegistry()
    with pytest.raises(KeyError):
        reg.get_card("missing")


def test_get_runner_without_runner_raises() -> None:
    reg = SpecialistRegistry()
    reg.register(_card("status_insight"))  # card-only, no runner
    with pytest.raises(KeyError):
        reg.get_runner("status_insight")


def test_register_replaces_existing() -> None:
    reg = SpecialistRegistry()
    reg.register(_card("status_insight", writes=False))
    reg.register(_card("status_insight", writes=True))
    assert len(reg) == 1
    assert reg.get_card("status_insight").writes is True


def test_ids_preserve_registration_order() -> None:
    reg = SpecialistRegistry()
    for sid in ("status_insight", "weekly_plan", "season_plan"):
        reg.register(_card(sid))
    assert reg.ids() == ["status_insight", "weekly_plan", "season_plan"]
