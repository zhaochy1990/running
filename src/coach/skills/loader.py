"""Generic skill loader for the coach agent — markdown-as-prompt framework.

A *skill* is a directory holding a ``SKILL.md`` entry point (frontmatter +
body) that can ``{{include: references/<file>.md}}`` other markdown fragments.
The body uses ``${placeholder}`` syntax (``string.Template``) for runtime
values — single ``{`` / ``}`` are left untouched so embedded JSON schema is
safe (no f-string brace-escaping).

This is the reusable substrate the coach's S1 / S2 / S3 prompts are migrating
onto: prompt *content* lives in markdown (single source of truth, editable
without touching Python), and code only supplies the runtime context.

Pure / import-linter clean: stdlib only (pathlib + string.Template + re). No
DB / LLM / yaml. Frontmatter is parsed with a tiny key/value reader (the only
keys these skills need are ``name`` / ``description``), so no YAML dependency.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from string import Template

# Skills bundled with the coach package live next to this module.
_SKILLS_ROOT = Path(__file__).resolve().parent

# {{include: references/foo.md}} — load-time expansion. Double-brace so it never
# collides with literal JSON `{...}` or `${placeholder}` runtime values.
_INCLUDE_RE = re.compile(r"\{\{\s*include:\s*(?P<path>[^}]+?)\s*\}\}")


@dataclass(frozen=True)
class Skill:
    """A loaded skill: its metadata + the fully-assembled (un-rendered) template."""

    name: str
    description: str
    template: str            # SKILL.md body with all {{include}}s expanded
    frontmatter: dict[str, str] = field(default_factory=dict)

    def render(self, context: dict[str, object]) -> str:
        """Fill ``${placeholder}`` values from ``context`` (missing → left as-is)."""
        return Template(self.template).safe_substitute(
            {k: ("" if v is None else str(v)) for k, v in context.items()}
        )


def _split_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Split a leading ``---\\n...\\n---`` frontmatter block from the body.

    Minimal ``key: value`` parsing (one per line) — sufficient for the
    ``name`` / ``description`` these skills carry; avoids a YAML dependency that
    coach core may not import. No frontmatter → ``({}, text)``.
    """
    if not text.startswith("---"):
        return {}, text
    parts = text.split("\n---", 1)
    if len(parts) != 2:
        return {}, text
    fm_block = parts[0][len("---"):].strip()
    body = parts[1].lstrip("\n")
    fm: dict[str, str] = {}
    for line in fm_block.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, _, value = line.partition(":")
        fm[key.strip()] = value.strip()
    return fm, body


def _resolve_include(rel: str, current_dir: Path, skills_root: Path) -> Path:
    """Resolve an include path with two-tier lookup, so skills can pull in both
    skill-local fragments AND shared (cross-skill) modules:

    1. relative to ``current_dir`` (the including file's dir) — skill-local, e.g.
       ``references/phase_sequence.md``;
    2. relative to ``skills_root`` — shared library, e.g. ``shared/nutrition.md``
       (used by S1 master-plan AND S2 weekly-plan).

    The resolved target must stay within ``skills_root`` (no ``../`` escape).
    """
    skills_root = skills_root.resolve()
    for cand in (current_dir / rel, skills_root / rel):
        target = cand.resolve()
        if target.is_file():
            if skills_root not in target.parents:
                raise ValueError(f"skill include escapes skills root: {rel!r}")
            return target
    raise FileNotFoundError(
        f"skill include not found: {rel!r} (looked in {current_dir} and {skills_root})"
    )


def _expand_includes(body: str, current_dir: Path, skills_root: Path) -> str:
    """Replace every ``{{include: path}}`` with the referenced file's body.

    Supports nesting (an included file may itself ``{{include}}`` others) and
    shared-module resolution via :func:`_resolve_include`.
    """

    def repl(match: "re.Match[str]") -> str:
        target = _resolve_include(match.group("path").strip(), current_dir, skills_root)
        # strip an included file's own frontmatter (references may carry their
        # own name/description for documentation; only the body composes in).
        _, text = _split_frontmatter(target.read_text(encoding="utf-8"))
        # Strip the body's surrounding blank lines so inter-section spacing is
        # controlled by the newlines AROUND the {{include}} directive in the
        # entry file (predictable layout, no accidental double blank lines).
        text = text.strip("\n")
        return _expand_includes(text, target.parent, skills_root)

    return _INCLUDE_RE.sub(repl, body)


def load_skill(skill_id: str, *, root: Path | None = None) -> Skill:
    """Load ``<root>/<skill_id>/SKILL.md`` with its ``{{include}}``s expanded.

    Args:
        skill_id: the skill directory name (e.g. ``"master_plan_planner"``).
        root: skills root; defaults to the package-bundled ``coach/skills/``.

    Raises:
        FileNotFoundError: the skill dir / SKILL.md doesn't exist.
        ValueError: an include points outside the skill directory.
    """
    base = (root or _SKILLS_ROOT) / skill_id
    skill_md = base / "SKILL.md"
    if not skill_md.is_file():
        raise FileNotFoundError(f"skill {skill_id!r}: no SKILL.md at {skill_md}")
    fm, body = _split_frontmatter(skill_md.read_text(encoding="utf-8"))
    template = _expand_includes(body, base, (root or _SKILLS_ROOT))
    return Skill(
        name=fm.get("name", skill_id),
        description=fm.get("description", ""),
        template=template,
        frontmatter=fm,
    )


def render_skill(skill_id: str, context: dict[str, object], *, root: Path | None = None) -> str:
    """Convenience: ``load_skill(skill_id).render(context)``."""
    return load_skill(skill_id, root=root).render(context)


def render_fragment(relpath: str, context: dict[str, object], *, root: Path | None = None) -> str:
    """Render a single markdown fragment (NOT a whole skill dir): strip its
    frontmatter, expand ``{{include}}``s, substitute ``${...}`` from context.

    For prompt blocks that are assembled *conditionally* — the data-presence
    condition (e.g. "only when continuity exists") stays in the calling Python
    (it's data logic, not prompt wording), while the block's English prose lives
    in markdown. ``relpath`` is resolved under the skills root (no ``../`` escape);
    returns the rendered body with surrounding blank lines stripped.
    """
    skills_root = (root or _SKILLS_ROOT).resolve()
    target = (skills_root / relpath).resolve()
    if skills_root not in target.parents:
        raise ValueError(f"fragment escapes skills root: {relpath!r}")
    _, body = _split_frontmatter(target.read_text(encoding="utf-8"))
    body = _expand_includes(body.strip("\n"), target.parent, skills_root)
    return Template(body).safe_substitute(
        {k: ("" if v is None else str(v)) for k, v in context.items()}
    )
