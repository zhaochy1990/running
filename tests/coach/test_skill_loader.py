"""Tests for the coach markdown-as-prompt skill loader."""
from __future__ import annotations

import pytest

from coach.skills import load_skill, render_skill
from coach.skills.loader import Skill


def _make_skills_root(tmp_path):
    root = tmp_path / "skills"
    (root / "demo" / "references").mkdir(parents=True)
    (root / "shared").mkdir(parents=True)
    return root


def test_frontmatter_and_body(tmp_path):
    root = _make_skills_root(tmp_path)
    (root / "demo" / "SKILL.md").write_text(
        "---\nname: demo-skill\ndescription: a demo\n---\nHello ${who}.\n",
        encoding="utf-8",
    )
    sk = load_skill("demo", root=root)
    assert sk.name == "demo-skill"
    assert sk.description == "a demo"
    assert sk.render({"who": "world"}) == "Hello world.\n"


def test_local_include(tmp_path):
    root = _make_skills_root(tmp_path)
    (root / "demo" / "references" / "rule.md").write_text("RULE-A\n", encoding="utf-8")
    (root / "demo" / "SKILL.md").write_text(
        "head\n{{include: references/rule.md}}\ntail\n", encoding="utf-8"
    )
    sk = load_skill("demo", root=root)
    assert "RULE-A" in sk.template
    # included body's surrounding newlines stripped → clean single-newline join
    assert sk.template == "head\nRULE-A\ntail\n"


def test_shared_include_resolves_to_shared_dir(tmp_path):
    root = _make_skills_root(tmp_path)
    (root / "shared" / "nutrition.md").write_text("SHARED-NUTRITION\n", encoding="utf-8")
    (root / "demo" / "SKILL.md").write_text("{{include: shared/nutrition.md}}", encoding="utf-8")
    sk = load_skill("demo", root=root)
    assert "SHARED-NUTRITION" in sk.template


def test_included_frontmatter_stripped(tmp_path):
    root = _make_skills_root(tmp_path)
    (root / "shared" / "x.md").write_text(
        "---\nname: x\n---\nBODY-ONLY\n", encoding="utf-8"
    )
    (root / "demo" / "SKILL.md").write_text("{{include: shared/x.md}}", encoding="utf-8")
    sk = load_skill("demo", root=root)
    assert "BODY-ONLY" in sk.template
    assert "name: x" not in sk.template


def test_nested_include(tmp_path):
    root = _make_skills_root(tmp_path)
    (root / "shared" / "inner.md").write_text("INNER\n", encoding="utf-8")
    (root / "demo" / "references" / "outer.md").write_text(
        "OUTER {{include: shared/inner.md}}\n", encoding="utf-8"
    )
    (root / "demo" / "SKILL.md").write_text("{{include: references/outer.md}}", encoding="utf-8")
    sk = load_skill("demo", root=root)
    assert "OUTER INNER" in sk.template


def test_json_braces_preserved(tmp_path):
    root = _make_skills_root(tmp_path)
    (root / "demo" / "SKILL.md").write_text(
        '{"schema":"v1","plan":{"start":"${plan_start}"}}', encoding="utf-8"
    )
    out = render_skill("demo", {"plan_start": "2026-06-22"}, root=root)
    # single braces untouched, only ${} substituted
    assert out == '{"schema":"v1","plan":{"start":"2026-06-22"}}'


def test_missing_placeholder_becomes_blank_via_none(tmp_path):
    root = _make_skills_root(tmp_path)
    (root / "demo" / "SKILL.md").write_text("a${block}b", encoding="utf-8")
    # None context value renders as empty string (optional dynamic blocks)
    assert render_skill("demo", {"block": None}, root=root) == "ab"
    # genuinely-absent key is left as-is (safe_substitute), never raises
    assert render_skill("demo", {}, root=root) == "a${block}b"


def test_missing_skill_raises(tmp_path):
    root = _make_skills_root(tmp_path)
    with pytest.raises(FileNotFoundError):
        load_skill("nope", root=root)


def test_include_escape_blocked(tmp_path):
    root = _make_skills_root(tmp_path)
    secret = tmp_path / "secret.md"
    secret.write_text("SECRET", encoding="utf-8")
    (root / "demo" / "SKILL.md").write_text("{{include: ../../secret.md}}", encoding="utf-8")
    with pytest.raises((ValueError, FileNotFoundError)):
        load_skill("demo", root=root)
