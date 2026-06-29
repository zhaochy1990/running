"""Tests for commentary_ai helpers + DB generated_by round-trip.

Skip the tests that require the `openai`/`azure-identity` SDKs to be installed —
we only cover helpers that import stride_core and stdlib.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import types
from pathlib import Path

import pytest


# Load commentary_ai without triggering stride_server.__init__ (which imports fastapi)
def _load_commentary_ai():
    if "stride_server" in sys.modules and hasattr(sys.modules["stride_server"], "commentary_ai"):
        return sys.modules["stride_server"].commentary_ai
    pkg = types.ModuleType("stride_server")
    pkg.__path__ = [str(Path(__file__).resolve().parent.parent / "src" / "stride_server")]
    sys.modules["stride_server"] = pkg

    # Load commentary_ai directly off disk. `aoai_client` used to be a
    # sibling module that needed preloading; it was deleted in 4ae1cbe
    # (the AOAI consolidation into coach.runtime), so commentary_ai now
    # imports nothing TZ/LLM-shaped from stride_server.
    src = Path(__file__).resolve().parent.parent / "src" / "stride_server" / "commentary_ai.py"
    spec = importlib.util.spec_from_file_location("stride_server.commentary_ai", str(src))
    module = importlib.util.module_from_spec(spec)
    sys.modules["stride_server.commentary_ai"] = module
    spec.loader.exec_module(module)
    setattr(pkg, "commentary_ai", module)
    return module


@pytest.fixture(scope="module")
def commentary_ai():
    return _load_commentary_ai()


def test_downsample_timeseries_short_passes_through(commentary_ai):
    points = [{"heart_rate": h} for h in [100, 110, 120]]
    assert commentary_ai.downsample_timeseries(points, target=10) == [100, 110, 120]


def test_system_prompt_uses_three_tier_plan_decision(commentary_ai):
    """The plan-matching rule must spell out the 3-tier classify-then-comment flow."""
    prompt = commentary_ai.SYSTEM_PROMPT
    # The decision procedure header and all three tiers must be present.
    assert "计划对照决策流程" in prompt
    assert "执行了计划" in prompt
    assert "微调了计划" in prompt  # tier 2: swap days / reorder
    assert "换序" in prompt
    assert "完全偏离计划" in prompt  # tier 3: off-plan
    assert "不再拿计划给本次跑步打分" in prompt  # tier 3 doesn't grade the run vs plan


def test_system_prompt_decouples_classification_from_valuation(commentary_ai):
    """Classification must not become a scolding lever — the core user intent.

    A shortened/restructured session is 'partial execution' (tier 1), not off-plan;
    every tier must open by crediting the real training value; catastrophizing and
    fabricated plan numbers are banned.
    """
    prompt = commentary_ai.SYSTEM_PROMPT
    # Partial execution stays tier 1, not "off-plan".
    assert "部分执行" in prompt
    # Classification decides what to compare against, not whether to credit.
    assert "不改变" in prompt and "是否认可" in prompt
    # Must lead by crediting the actual training value.
    assert "先肯定本次实际训练的价值" in prompt
    # Negation / catastrophizing vocabulary is explicitly banned.
    assert "落空" in prompt and "后果恐吓" in prompt
    # Ambiguous → lean to the lower (less-deviation) tier.
    assert "往低一档靠" in prompt
    # Crediting value and stating the gap/overshoot are PARALLEL, not either/or
    # (guards against over-correcting into pure praise on off-plan hard efforts).
    assert "信用价值与陈述缺口并行" in prompt
    assert "强度溢出" in prompt and "缺失了一节核心课" in prompt
    # Only quote plan numbers that literally appear in the plan block.
    assert "逐字出现" in prompt and "绝不自己推算或编造区间" in prompt
    # Stale activities (>3d) must not get fresh short-term advice.
    assert "未来 48 小时" in prompt


def test_system_prompt_internal_consistency(commentary_ai):
    """Guards against the two contradictions code-review flagged.

    These are negative/structural assertions (not just substring presence): the
    closing-structure rule must be age-conditional so it cannot contradict the
    >3d no-advice ban, tier 3 must reconcile 'don't grade vs plan' with the
    parallel gap-note, and the deleted auto-fail framing must stay deleted.
    """
    prompt = commentary_ai.SYSTEM_PROMPT
    # Structure point 3 must NOT unconditionally mandate next-1-2-day advice
    # (that contradicted the >3d ban). It must gate the ending on activity age.
    assert "结尾收口（按下面" in prompt
    assert "≤3 天" in prompt and ">3 天" in prompt
    # Tier 3 reconciliation: it explicitly allows the parallel neutral gap-note
    # so "don't grade vs plan" and "state missing core session" don't conflict.
    assert "不与" in prompt and "不打分" in prompt
    # The UNCONDITIONAL forward-advice mandate (which contradicted the >3d ban)
    # must be gone — only the age-gated form may remain.
    assert "结尾给出下一步建议（这次训练对未来 1-2 天意味着什么）" not in prompt


def test_downsample_timeseries_reduces_to_target(commentary_ai):
    points = [{"heart_rate": i} for i in range(200)]
    out = commentary_ai.downsample_timeseries(points, target=20)
    assert len(out) == 20
    # Should be evenly spaced — first ~0, last ~190
    assert out[0] == 0
    assert out[-1] == 190


def test_downsample_preserves_none_gaps(commentary_ai):
    points = [{"heart_rate": h} for h in [100, None, 120, None, 140] * 10]
    out = commentary_ai.downsample_timeseries(points, target=5)
    assert len(out) == 5


def test_get_current_phase_same_month_range(commentary_ai, tmp_path, monkeypatch):
    """Verify the regex handles `4/20-26` (single-month range)."""
    user_dir = tmp_path / "zhaotest"
    user_dir.mkdir()
    (user_dir / "TRAINING_PLAN.md").write_text(
        """## 时间线总览

| 阶段 | 日期 | 周数 |
|------|------|------|
| 第0周 | 4/20-26 | 1 |
| Phase 1：基础期 | 4/27 — 6/21 | 8 |
""",
        encoding="utf-8",
    )
    monkeypatch.setattr(commentary_ai, "USER_DATA_DIR", tmp_path)

    phase = commentary_ai.get_current_phase("zhaotest", "2026-04-22T11:31:33+00:00")
    assert phase is not None
    assert phase["phase"] == "第0周"
    assert phase["start"] == "2026-04-20"
    assert phase["end"] == "2026-04-26"


def test_get_current_phase_cross_month_range(commentary_ai, tmp_path, monkeypatch):
    user_dir = tmp_path / "u"
    user_dir.mkdir()
    (user_dir / "TRAINING_PLAN.md").write_text(
        """## 时间线总览

| 阶段 | 日期 |
|------|------|
| Phase 1：基础期 | 4/27 — 6/21 |
""",
        encoding="utf-8",
    )
    monkeypatch.setattr(commentary_ai, "USER_DATA_DIR", tmp_path)
    phase = commentary_ai.get_current_phase("u", "2026-05-15T00:00:00")
    assert phase is not None
    assert phase["phase"].startswith("Phase 1")


def test_get_current_phase_missing_file_returns_none(commentary_ai, tmp_path, monkeypatch):
    monkeypatch.setattr(commentary_ai, "USER_DATA_DIR", tmp_path)
    assert commentary_ai.get_current_phase("nobody", "2026-04-22") is None


def test_get_athlete_profile_reads_json(commentary_ai, tmp_path, monkeypatch):
    user_dir = tmp_path / "x"
    user_dir.mkdir()
    (user_dir / "profile.json").write_text(
        json.dumps({"姓名": "测试", "目标": "2:50"}), encoding="utf-8"
    )
    monkeypatch.setattr(commentary_ai, "USER_DATA_DIR", tmp_path)
    profile = commentary_ai.get_athlete_profile("x")
    assert profile == {"姓名": "测试", "目标": "2:50"}


def test_get_athlete_profile_missing(commentary_ai, tmp_path, monkeypatch):
    monkeypatch.setattr(commentary_ai, "USER_DATA_DIR", tmp_path)
    assert commentary_ai.get_athlete_profile("nobody") is None


class TestGeneratedByDB:
    def test_upsert_with_generated_by(self, db):
        db._conn.execute(
            "INSERT INTO activities (label_id, sport_type, date) VALUES (?, 100, '2026-04-22')",
            ("test-label-1",),
        )
        db._conn.commit()
        db.upsert_activity_commentary(
            "test-label-1", "draft text", generated_by="gpt-4.1",
        )
        row = db.get_activity_commentary_row("test-label-1")
        assert row is not None
        d = dict(row)
        assert d["commentary"] == "draft text"
        assert d["generated_by"] == "gpt-4.1"
        assert d["generated_at"] is not None

    def test_exists_check(self, db):
        db._conn.execute(
            "INSERT INTO activities (label_id, sport_type, date) VALUES (?, 100, '2026-04-22')",
            ("test-label-2",),
        )
        db._conn.commit()
        assert db.activity_commentary_exists("test-label-2") is False
        db.upsert_activity_commentary("test-label-2", "hi")
        assert db.activity_commentary_exists("test-label-2") is True

    def test_upsert_overwrites_generated_by(self, db):
        db._conn.execute(
            "INSERT INTO activities (label_id, sport_type, date) VALUES (?, 100, '2026-04-22')",
            ("test-label-3",),
        )
        db._conn.commit()
        db.upsert_activity_commentary("test-label-3", "v1", generated_by="gpt-4.1")
        db.upsert_activity_commentary("test-label-3", "v2", generated_by="claude-opus-4-7")
        row = db.get_activity_commentary_row("test-label-3")
        assert dict(row)["commentary"] == "v2"
        assert dict(row)["generated_by"] == "claude-opus-4-7"
