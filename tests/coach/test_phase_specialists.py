"""Tests for the phase-specialist registry + prompts (Stage-3a Task 1).

Verifies all 6 PhaseType members are wired, the Chinese names + tool tuples
match the catalog, and each guidance carries the full 7-block coaching
doctrine at depth (not a generic blurb).
"""

from __future__ import annotations

import pytest

from stride_core.master_plan import PhaseType

from coach.graphs.generation.phase_specialists import (
    SPECIALIST_REGISTRY,
    Specialist,
    get_specialist,
)


# ---------------------------------------------------------------------------
# Registry completeness + lookup
# ---------------------------------------------------------------------------


def test_registry_has_all_six_phase_types():
    assert set(SPECIALIST_REGISTRY.keys()) == set(PhaseType)
    assert len(SPECIALIST_REGISTRY) == 6


def test_get_specialist_returns_matching_specialist():
    for pt in PhaseType:
        spec = get_specialist(pt)
        assert isinstance(spec, Specialist)
        assert spec.phase_type is pt
        assert SPECIALIST_REGISTRY[pt] is spec


def test_get_specialist_unknown_raises():
    with pytest.raises((KeyError, ValueError)):
        get_specialist("not_a_phase")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Chinese names
# ---------------------------------------------------------------------------


EXPECTED_NAMES = {
    PhaseType.BASE: "基础期",
    PhaseType.BUILD: "专项期",
    PhaseType.SPEED: "速度周期",
    PhaseType.PEAK: "巅峰期",
    PhaseType.TAPER: "减量期",
    PhaseType.RECOVERY: "恢复期",
}


@pytest.mark.parametrize("pt,name", list(EXPECTED_NAMES.items()))
def test_specialist_name(pt, name):
    assert get_specialist(pt).name == name


# ---------------------------------------------------------------------------
# Tool tuples per catalog
# ---------------------------------------------------------------------------


EXPECTED_TOOLS = {
    PhaseType.BASE: {"strength_library", "recent_training"},
    PhaseType.BUILD: {"recent_training"},
    PhaseType.SPEED: {"strength_library", "recent_training"},
    PhaseType.PEAK: {"recent_training"},
    PhaseType.TAPER: set(),
    PhaseType.RECOVERY: {"strength_library", "recent_training"},
}


@pytest.mark.parametrize("pt,tools", list(EXPECTED_TOOLS.items()))
def test_specialist_tools(pt, tools):
    spec = get_specialist(pt)
    assert isinstance(spec.tools, tuple)
    assert set(spec.tools) == tools


def test_taper_has_no_tools():
    assert get_specialist(PhaseType.TAPER).tools == ()


# ---------------------------------------------------------------------------
# Depth assertion — all 7 blocks present + injected-numbers discipline
# ---------------------------------------------------------------------------


# Anchor tokens proving each of the 7 blocks is present in the guidance.
SEVEN_BLOCK_MARKERS = [
    "生理目标",    # ① 生理目标
    "处方",        # ② 课程调色板 + 处方
    "强度",        # ④ 强度分布
    "进展",        # ⑤ 周内进展
    "锚定",        # ⑥ 配速 + volume 锚定
    "伤病",        # ⑦ 伤病感知
    "反模式",      # ⑦ 反模式
]


@pytest.mark.parametrize("pt", list(PhaseType))
def test_guidance_depth_and_seven_blocks(pt):
    g = get_specialist(pt).guidance
    assert len(g) > 300, f"{pt} guidance too short: {len(g)}"
    for marker in SEVEN_BLOCK_MARKERS:
        assert marker in g, f"{pt} guidance missing block marker {marker!r}"


@pytest.mark.parametrize("pt", list(PhaseType))
def test_guidance_injected_numbers_discipline(pt):
    """Every specialist must instruct using injected paces/volumes, not invent."""
    g = get_specialist(pt).guidance
    assert "pace_targets" in g, f"{pt} guidance does not reference pace_targets"
    assert "volume_targets" in g, f"{pt} guidance does not reference volume_targets"


# ---------------------------------------------------------------------------
# Per-phase signature doctrine — guard against generic-blurb regression
# ---------------------------------------------------------------------------


def test_base_signature():
    g = get_specialist(PhaseType.BASE).guidance
    assert "金字塔" in g
    assert "阈值" in g and "引入" in g


def test_build_signature():
    g = get_specialist(PhaseType.BUILD).guidance
    # Tokens unique to _BUILD_GUIDANCE — absent from _SHARED_DOCTRINE and every
    # other phase's guidance — so this fails if build's doctrine is replaced by
    # a generic blurb. ("MP"/"tempo" live in the shared block, so they're not
    # discriminating.)
    assert "巡航" in g  # 阈值巡航间歇 — build-only cruise-interval doctrine
    assert "1k * (10-12)" in g  # CV reps prescription — build-only


def test_speed_signature():
    g = get_specialist(PhaseType.SPEED).guidance
    assert "VO2max" in g
    assert "两极化" in g


def test_peak_signature():
    g = get_specialist(PhaseType.PEAK).guidance
    assert "MP" in g and "主导" in g
    assert "实战" in g


def test_taper_signature():
    g = get_specialist(PhaseType.TAPER).guidance
    assert "减量" in g
    assert "25%" in g or "唤醒" in g


def test_recovery_signature():
    g = get_specialist(PhaseType.RECOVERY).guidance
    assert "无质量课" in g
    assert "Z1" in g or "z1" in g


# ---------------------------------------------------------------------------
# Frozen / immutability sanity
# ---------------------------------------------------------------------------


def test_specialist_is_frozen():
    spec = get_specialist(PhaseType.BASE)
    with pytest.raises(Exception):
        spec.name = "X"  # type: ignore[misc]
