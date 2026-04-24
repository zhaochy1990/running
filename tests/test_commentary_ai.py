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

    # Preload aoai_client
    for mod_name in ("aoai_client", "commentary_ai"):
        src = Path(__file__).resolve().parent.parent / "src" / "stride_server" / f"{mod_name}.py"
        spec = importlib.util.spec_from_file_location(f"stride_server.{mod_name}", str(src))
        module = importlib.util.module_from_spec(spec)
        sys.modules[f"stride_server.{mod_name}"] = module
        spec.loader.exec_module(module)
    return sys.modules["stride_server.commentary_ai"]


@pytest.fixture(scope="module")
def commentary_ai():
    return _load_commentary_ai()


def test_downsample_timeseries_short_passes_through(commentary_ai):
    points = [{"heart_rate": h} for h in [100, 110, 120]]
    assert commentary_ai.downsample_timeseries(points, target=10) == [100, 110, 120]


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
