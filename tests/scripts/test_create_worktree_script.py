"""Contract tests for the portable ``create_worktree.py`` skill entry point.

This script is the single, agent-neutral entry point for the
``worktree-development`` skill: it creates a task-dedicated linked git worktree
+ branch from the launching checkout, then runs the sibling
``initialize_worktree.py`` to snapshot the athlete DB. It must not call any
skill, slash command, or Claude/OpenCode-specific tool — only stdlib + git CLI.

Tests use throwaway temp repos and an injected initializer seam so no real PII
is copied.
"""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import subprocess
import sys
import types
from pathlib import Path
from typing import Any

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
SKILL_DIR = REPO_ROOT / ".claude" / "skills" / "worktree-development"
CREATE_SCRIPT = SKILL_DIR / "scripts" / "create_worktree.py"
INIT_SCRIPT = SKILL_DIR / "scripts" / "initialize_worktree.py"
SKILL_MD = SKILL_DIR / "SKILL.md"
ROOT_CLAUDE_MD = REPO_ROOT / "CLAUDE.md"
ROOT_AGENTS_MD = REPO_ROOT / "AGENTS.md"


def _load(script: Path, name: str) -> types.ModuleType:
    spec = importlib.util.spec_from_file_location(name, script)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_create() -> types.ModuleType:
    return _load(CREATE_SCRIPT, "create_worktree_mod")


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
    ).stdout


def _init_origin_style_repo(root: Path, primary_name: str = "primary") -> Path:
    """Create a repo with a proper ``origin/HEAD`` pointing at ``main``."""
    origin = root / "origin.git"
    subprocess.run(["git", "init", "--bare", "-b", "main", str(origin)], check=True,
                   capture_output=True, text=True)
    primary = root / primary_name
    subprocess.run(["git", "clone", str(origin), str(primary)], check=True,
                   capture_output=True, text=True)
    _git(primary, "config", "user.email", "t@t")
    _git(primary, "config", "user.name", "t")
    (primary / "README.md").write_text("hello\n", encoding="utf-8")
    _git(primary, "add", "README.md")
    _git(primary, "commit", "-m", "init")
    _git(primary, "push", "-u", "origin", "main")
    # Ensure origin/HEAD symbolic ref is set.
    _git(primary, "remote", "set-head", "origin", "-a")
    return primary


# --------------------------------------------------------------------------- #
# Name validation
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize(
    "name",
    ["fix-training-load-dates", "add-coach-eval", "a1-b2-c3", "one-two-three-four-five"],
)
def test_valid_kebab_names_accepted(name: str) -> None:
    mod = _load_create()
    assert mod.validate_name(name) == name


@pytest.mark.parametrize(
    "name",
    [
        "two-seg",            # too few segments (2)
        "way-too-many-segments-here-now",  # 6 segments
        "Has-Upper-Case",
        "trailing-",
        "-leading",
        "double--dash",
        "under_score-name",
        "space name here",
        "slash/name-here",
        "",
    ],
)
def test_invalid_names_rejected(name: str) -> None:
    mod = _load_create()
    with pytest.raises(mod.CreateWorktreeError):
        mod.validate_name(name)


# --------------------------------------------------------------------------- #
# Base-ref resolution priority (no network)
# --------------------------------------------------------------------------- #

def test_base_ref_defaults_to_launch_head_oid(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    head = _git(primary, "rev-parse", "HEAD").strip()
    base = mod.resolve_base_ref(primary, override=None)
    # Default is the launching checkout's HEAD commit OID (not origin/HEAD).
    assert base == head


def test_base_ref_override_used(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    # An explicit override is resolved to a fixed commit OID (like the default),
    # not returned as the symbolic name.
    main_oid = _git(primary, "rev-parse", "main").strip()
    base = mod.resolve_base_ref(primary, override="main")
    assert base == main_oid


def test_base_ref_override_head_resolves_launch_cwd_oid(tmp_path: Path) -> None:
    """`--base-ref HEAD` from a linked worktree resolves that worktree's HEAD."""
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    linked = primary / ".worktrees" / "seed-override-head"
    (primary / ".worktrees").mkdir(exist_ok=True)
    _git(primary, "worktree", "add", "-b", "worktree-seed-override-head", str(linked))
    (linked / "only.txt").write_text("x\n", encoding="utf-8")
    _git(linked, "add", "only.txt")
    _git(linked, "commit", "-m", "linked commit")
    linked_head = _git(linked, "rev-parse", "HEAD").strip()
    primary_head = _git(primary, "rev-parse", "HEAD").strip()
    assert linked_head != primary_head

    base = mod.resolve_base_ref(linked, override="HEAD")
    assert base == linked_head


def test_create_with_override_head_from_linked_uses_linked_oid(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    linked = primary / ".worktrees" / "seed-linked-for-create"
    (primary / ".worktrees").mkdir(exist_ok=True)
    _git(primary, "worktree", "add", "-b", "worktree-seed-linked-for-create", str(linked))
    (linked / "mark.txt").write_text("y\n", encoding="utf-8")
    _git(linked, "add", "mark.txt")
    _git(linked, "commit", "-m", "linked mark")
    linked_head = _git(linked, "rev-parse", "HEAD").strip()

    result = mod.create_worktree(
        name="carry-linked-head",
        cwd=linked,
        base_ref="HEAD",
        initializer=lambda p: None,
    )
    assert result["base_ref"] == linked_head
    new_path = Path(result["worktree_path"])
    assert (new_path / "mark.txt").exists()


def test_base_ref_override_unknown_rejected(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    with pytest.raises(mod.CreateWorktreeError):
        mod.resolve_base_ref(primary, override="does-not-exist-ref")


def test_base_ref_resolves_head_in_plain_repo(tmp_path: Path) -> None:
    mod = _load_create()
    # Plain repo, no origin remote at all.
    primary = tmp_path / "plain"
    primary.mkdir()
    _git(primary, "init", "-b", "main")
    _git(primary, "config", "user.email", "t@t")
    _git(primary, "config", "user.name", "t")
    (primary / "f").write_text("x", encoding="utf-8")
    _git(primary, "add", "f")
    _git(primary, "commit", "-m", "i")
    head = _git(primary, "rev-parse", "HEAD").strip()
    base = mod.resolve_base_ref(primary, override=None)
    assert base == head


# --------------------------------------------------------------------------- #
# End-to-end create (with injected initializer seam)
# --------------------------------------------------------------------------- #

def test_create_worktree_makes_branch_path_and_registers(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    calls: list[Path] = []

    result = mod.create_worktree(
        name="fix-training-load-dates",
        cwd=primary,
        base_ref=None,
        initializer=lambda p: calls.append(Path(p)),
    )

    new_path = Path(result["worktree_path"])
    assert result["branch"] == "worktree-fix-training-load-dates"
    assert new_path.is_dir()
    # Lives under the primary's ignored .worktrees/, agent-neutral.
    assert new_path.parent.name == ".worktrees"
    assert new_path.parent.parent.resolve() == primary.resolve()
    assert new_path.name == "fix-training-load-dates"

    # Registered as a real linked worktree.
    listed = _git(primary, "worktree", "list", "--porcelain")
    assert new_path.as_posix() in listed.replace("\\", "/")

    # Branch exists and points where expected.
    branches = _git(primary, "branch", "--list", "worktree-fix-training-load-dates")
    assert "worktree-fix-training-load-dates" in branches

    # Initializer invoked exactly once against the new worktree path.
    assert calls == [new_path.resolve()]


def test_initializer_seam_receives_new_worktree_not_target_branch(tmp_path: Path) -> None:
    """The initializer must be the trusted sibling script, run against new path."""
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    seen: dict[str, Any] = {}

    def fake_init(path: Any) -> None:
        seen["path"] = Path(path)
        seen["is_dir"] = Path(path).is_dir()

    mod.create_worktree(
        name="add-coach-eval",
        cwd=primary,
        base_ref=None,
        initializer=fake_init,
    )
    assert seen["is_dir"] is True
    assert seen["path"].name == "add-coach-eval"


def test_collision_path_rejected(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    # Pre-create the target dir to force a collision.
    (primary / ".worktrees" / "fix-the-thing").mkdir(parents=True)
    with pytest.raises(mod.CreateWorktreeError):
        mod.create_worktree(
            name="fix-the-thing",
            cwd=primary,
            base_ref=None,
            initializer=lambda p: None,
        )


def test_collision_branch_rejected(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    _git(primary, "branch", "worktree-fix-the-branch")
    with pytest.raises(mod.CreateWorktreeError):
        mod.create_worktree(
            name="fix-the-branch",
            cwd=primary,
            base_ref=None,
            initializer=lambda p: None,
        )


def test_init_failure_preserves_worktree(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)

    def failing_init(_p: Any) -> None:
        raise RuntimeError("init boom")

    with pytest.raises(mod.CreateWorktreeError):
        mod.create_worktree(
            name="keep-me-around",
            cwd=primary,
            base_ref=None,
            initializer=failing_init,
        )
    # Worktree + branch preserved (no force removal) for manual recovery.
    new_path = primary / ".worktrees" / "keep-me-around"
    assert new_path.is_dir()
    listed = _git(primary, "worktree", "list", "--porcelain")
    assert new_path.as_posix() in listed.replace("\\", "/")


def test_non_ascii_and_space_path_json_safe(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    mod = _load_create()
    base = tmp_path / "赛季 目录"
    primary = _init_origin_style_repo(base)
    rc = mod.main(
        ["add-season-continuity"],
        cwd=primary,
        initializer=lambda p: None,
    )
    assert rc == 0
    out = capsys.readouterr().out
    last_line = out.strip().splitlines()[-1]
    payload = json.loads(last_line)
    assert payload["branch"] == "worktree-add-season-continuity"
    assert Path(payload["worktree_path"]).is_dir()
    assert "赛季 目录" in payload["worktree_path"]


# --------------------------------------------------------------------------- #
# Portability / no agent-specific API
# --------------------------------------------------------------------------- #

def test_create_script_has_no_agent_specific_api() -> None:
    text = CREATE_SCRIPT.read_text(encoding="utf-8").lower()
    for banned in ("enterworktree", "exitworktree", "slash command", "claude_tool"):
        assert banned not in text, banned


def test_create_script_stdlib_and_git_only() -> None:
    text = CREATE_SCRIPT.read_text(encoding="utf-8")
    # No third-party imports beyond stdlib; must not import project packages.
    assert "stride_storage" not in text
    assert "import requests" not in text


# --------------------------------------------------------------------------- #
# Docs contract
# --------------------------------------------------------------------------- #

def test_skill_md_uses_portable_repository_relative_creator() -> None:
    text = SKILL_MD.read_text(encoding="utf-8")
    assert "EnterWorktree" not in text
    assert "CLAUDE_SKILL_DIR" not in text
    assert 'python ".claude/skills/worktree-development/scripts/create_worktree.py"' in text


def test_root_claude_md_points_to_portable_creator() -> None:
    text = ROOT_CLAUDE_MD.read_text(encoding="utf-8")
    assert "EnterWorktree" not in text
    assert "create_worktree.py" in text


def test_agents_md_has_worktree_hard_rule() -> None:
    text = ROOT_AGENTS_MD.read_text(encoding="utf-8")
    assert "create_worktree.py" in text
    assert "EnterWorktree" not in text


# --------------------------------------------------------------------------- #
# A. Windows stdout/stderr UTF-8 (real subprocess, cp1252, CJK path)
# --------------------------------------------------------------------------- #

def test_cp1252_env_utf8_json_output(tmp_path: Path) -> None:
    base = tmp_path / "赛季 目录"
    primary = _init_origin_style_repo(base)
    # Seed the primary's ignored source DB + tracked alias so a real (non-seam)
    # initializer run would have inputs; here we still let the script's own
    # bundled initializer run end-to-end against synthetic data.
    _seed_primary_athlete(primary)

    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "cp1252"
    proc = subprocess.run(
        [sys.executable, str(CREATE_SCRIPT), "add-cjk-output-check"],
        cwd=primary,
        capture_output=True,
        env=env,
        check=False,
    )
    out = proc.stdout.decode("utf-8")
    err = proc.stderr.decode("utf-8")
    assert proc.returncode == 0, err
    payload = json.loads(out.strip().splitlines()[-1])
    assert payload["branch"] == "worktree-add-cjk-output-check"
    assert "赛季 目录" in payload["worktree_path"]
    assert Path(payload["worktree_path"]).is_dir()


def _seed_primary_athlete(primary: Path) -> None:
    """Track a slug alias mapping + place the ignored source DB in the primary.

    Also commits a ``.gitkeep`` so the canonical ``data/<UUID>/`` directory
    exists in the created worktree (the initializer requires a real target dir).
    """
    import sqlite3

    init = _load(INIT_SCRIPT, "init_mod_for_seed")
    data = primary / "data"
    data.mkdir(exist_ok=True)
    (data / ".slug_aliases.json").write_text(
        json.dumps({init.SLUG: init.FIXED_UUID}), encoding="utf-8"
    )
    uuid_dir = data / init.FIXED_UUID
    uuid_dir.mkdir(parents=True, exist_ok=True)
    (uuid_dir / ".gitkeep").write_text("", encoding="utf-8")
    # Ignore the athlete DB so the initializer's target-privacy gate (untracked
    # AND ignored) is satisfied in the created worktree.
    (primary / ".gitignore").write_text("*.db\n", encoding="utf-8")
    _git(primary, "add", ".gitignore", "data/.slug_aliases.json",
         f"data/{init.FIXED_UUID}/.gitkeep")
    _git(primary, "commit", "-m", "seed alias + data dir + db ignore")
    # Publish so the default base (launch HEAD commit OID) is a shared commit.
    _git(primary, "push", "origin", "main")
    db = uuid_dir / "coros.db"
    conn = sqlite3.connect(db)
    try:
        conn.execute("CREATE TABLE t (x INTEGER)")
        conn.execute("INSERT INTO t VALUES (1)")
        conn.commit()
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# B. Creator path protection
# --------------------------------------------------------------------------- #

def test_worktrees_parent_symlink_rejected(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    link = primary / ".worktrees"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation not permitted")
    with pytest.raises(mod.CreateWorktreeError):
        mod.create_worktree(
            name="fix-parent-symlink",
            cwd=primary,
            base_ref=None,
            initializer=lambda p: None,
        )


def test_target_dangling_symlink_collision_rejected(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    (primary / ".worktrees").mkdir()
    dangling = primary / ".worktrees" / "fix-dangling-target"
    try:
        dangling.symlink_to(tmp_path / "nope")
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation not permitted")
    assert not dangling.exists()  # dangling
    assert os.path.lexists(str(dangling))
    with pytest.raises(mod.CreateWorktreeError):
        mod.create_worktree(
            name="fix-dangling-target",
            cwd=primary,
            base_ref=None,
            initializer=lambda p: None,
        )


def test_git_add_failure_leaves_no_orphan_branch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)

    real_run_git = mod._run_git

    def flaky_run_git(cwd: Any, *args: str, check: bool = True) -> Any:
        if "worktree" in args and "add" in args:
            # Simulate a mid-add failure (inject a bogus flag).
            return real_run_git(cwd, "worktree", "add", "--bogus-flag", check=False)
        return real_run_git(cwd, *args, check=check)

    monkeypatch.setattr(mod, "_run_git", flaky_run_git)

    with pytest.raises(mod.CreateWorktreeError):
        mod.create_worktree(
            name="fix-add-failure",
            cwd=primary,
            base_ref=None,
            initializer=lambda p: None,
        )
    # The branch created for this attempt must have been cleaned up (no orphan).
    branches = _git(primary, "branch", "--list", "worktree-fix-add-failure")
    assert branches.strip() == ""


def test_add_failure_rollback_failure_reports_orphan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If `git worktree add` fails AND the branch delete cannot complete (a
    stale ref .lock), the branch remains and the error explicitly reports the
    orphan branch plus a manual cleanup command."""
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    branch = "worktree-fix-rollback-fail"

    real_run_git = mod._run_git

    def flaky_run_git(cwd: Any, *args: str, check: bool = True) -> Any:
        if "worktree" in args and "add" in args:
            # Just before the failing add, lock the branch ref so the
            # subsequent rollback `branch -D` cannot delete it.
            lock = Path(cwd) / ".git" / "refs" / "heads" / f"{branch}.lock"
            lock.parent.mkdir(parents=True, exist_ok=True)
            lock.write_text("", encoding="utf-8")
            return real_run_git(cwd, "worktree", "add", "--bogus-flag", check=False)
        return real_run_git(cwd, *args, check=check)

    monkeypatch.setattr(mod, "_run_git", flaky_run_git)

    with pytest.raises(mod.CreateWorktreeError) as excinfo:
        mod.create_worktree(
            name="fix-rollback-fail",
            cwd=primary,
            base_ref=None,
            initializer=lambda p: None,
        )
    msg = str(excinfo.value)
    assert "orphan branch remains" in msg.lower() or "orphan" in msg.lower()
    assert branch in msg
    assert f'branch -D {branch}' in msg or f'branch -D -- {branch}' in msg
    # The branch is still present (rollback could not remove it).
    branches = _git(primary, "branch", "--list", branch)
    assert branch in branches



def test_init_failure_still_preserves_worktree_and_branch(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)

    def failing_init(_p: Any) -> None:
        raise RuntimeError("boom")

    with pytest.raises(mod.CreateWorktreeError):
        mod.create_worktree(
            name="keep-after-init-fail",
            cwd=primary,
            base_ref=None,
            initializer=failing_init,
        )
    assert (primary / ".worktrees" / "keep-after-init-fail").is_dir()
    branches = _git(primary, "branch", "--list", "worktree-keep-after-init-fail")
    assert "worktree-keep-after-init-fail" in branches


# --------------------------------------------------------------------------- #
# H. CLI / ref-option safety
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("bad", ["--help", "-x", "--upload-pack=evil", "\x01ctrl"])
def test_base_ref_option_injection_rejected(tmp_path: Path, bad: str) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    with pytest.raises(mod.CreateWorktreeError):
        mod.resolve_base_ref(primary, override=bad)


# --------------------------------------------------------------------------- #
# G. Checkout code-execution surface: hooks + filters suppressed
# --------------------------------------------------------------------------- #

def test_post_checkout_hook_not_executed(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    hooks = Path(_git(primary, "rev-parse", "--git-path", "hooks").strip())
    if not hooks.is_absolute():
        hooks = (primary / hooks).resolve()
    hooks.mkdir(parents=True, exist_ok=True)
    marker = tmp_path / "hook-ran.marker"
    hook = hooks / "post-checkout"
    hook.write_text(f'#!/bin/sh\ntouch "{marker}"\n', encoding="utf-8")
    os.chmod(hook, 0o755)

    mod.create_worktree(
        name="fix-hook-suppression",
        cwd=primary,
        base_ref=None,
        initializer=lambda p: None,
    )
    assert not marker.exists(), "post-checkout hook must not run during worktree add"


def _install_hook(primary: Path, name: str, marker: Path) -> None:
    hooks = Path(_git(primary, "rev-parse", "--git-path", "hooks").strip())
    if not hooks.is_absolute():
        hooks = (primary / hooks).resolve()
    hooks.mkdir(parents=True, exist_ok=True)
    hook = hooks / name
    hook.write_text(f'#!/bin/sh\ntouch "{marker}"\nexit 0\n', encoding="utf-8")
    os.chmod(hook, 0o755)


def test_reference_transaction_hook_not_executed_on_success(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    marker = tmp_path / "reftx-ran.marker"
    _install_hook(primary, "reference-transaction", marker)

    mod.create_worktree(
        name="fix-reftx-suppression",
        cwd=primary,
        base_ref=None,
        initializer=lambda p: None,
    )
    assert not marker.exists(), (
        "reference-transaction hook must not run during branch create/worktree add"
    )


def test_reference_transaction_hook_not_executed_on_rollback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A simulated `worktree add` failure triggers branch rollback; the
    reference-transaction hook must fire during neither branch create nor the
    rollback delete."""
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    marker = tmp_path / "reftx-rollback.marker"
    _install_hook(primary, "reference-transaction", marker)

    real_run_git = mod._run_git

    def flaky_run_git(cwd: Any, *args: str, check: bool = True) -> Any:
        if "worktree" in args and "add" in args:
            return real_run_git(cwd, "worktree", "add", "--bogus-flag", check=False)
        return real_run_git(cwd, *args, check=check)

    monkeypatch.setattr(mod, "_run_git", flaky_run_git)

    with pytest.raises(mod.CreateWorktreeError):
        mod.create_worktree(
            name="fix-reftx-rollback",
            cwd=primary,
            base_ref=None,
            initializer=lambda p: None,
        )
    # Branch rolled back (no orphan) and hook never executed.
    branches = _git(primary, "branch", "--list", "worktree-fix-reftx-rollback")
    assert branches.strip() == ""
    assert not marker.exists(), (
        "reference-transaction hook must not run during branch create or rollback"
    )



def test_smudge_filter_not_executed(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    marker = tmp_path / "smudge-ran.marker"
    _configure_smudge_marker(primary, marker)

    result = mod.create_worktree(
        name="fix-smudge-suppression",
        cwd=primary,
        base_ref=None,
        initializer=lambda p: None,
    )
    assert Path(result["worktree_path"]).is_dir()
    assert not marker.exists(), "smudge filter must not run during worktree add"


def _configure_smudge_marker(primary: Path, marker: Path) -> None:
    # A smudge filter bound to a fresh tracked file (avoids re-normalizing
    # README on `git add`). clean is passthrough; smudge would run on checkout.
    _git(primary, "config", "filter.evil.smudge", f'sh -c \'touch "{marker}"\'')
    (primary / ".gitattributes").write_text("payload.bin filter=evil\n", encoding="utf-8")
    (primary / "payload.bin").write_text("data\n", encoding="utf-8")
    _git(primary, "add", ".gitattributes", "payload.bin")
    _git(primary, "commit", "-m", "add evil filter attr")


def test_effective_filter_drivers_helper(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    _git(primary, "config", "filter.evil.smudge", "cat")
    _git(primary, "config", "filter.evil.required", "true")
    drivers = mod.effective_filter_drivers(primary)
    assert "evil" in drivers


def test_worktree_add_config_flags_disable_hooks_and_filters(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    _git(primary, "config", "filter.evil.smudge", "cat")
    flags = mod.checkout_hardening_flags(primary, hooks_dir="/tmp/empty")
    joined = " ".join(flags)
    assert "core.hooksPath=/tmp/empty" in joined
    assert "core.fsmonitor=false" in joined
    assert "filter.evil.smudge=" in joined
    assert "filter.evil.process=" in joined
    assert "filter.evil.required=false" in joined


# --------------------------------------------------------------------------- #
# MEDIUM: initializer load+run unified error handling
# --------------------------------------------------------------------------- #

def test_initializer_load_failure_preserves_and_sanitizes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    secret = "https://acct.example/x?sig=SUPERSECRETTOKEN"

    def boom_loader() -> Any:
        raise RuntimeError(secret)

    monkeypatch.setattr(mod, "_load_initializer", boom_loader)

    with pytest.raises(mod.CreateWorktreeError) as excinfo:
        mod.create_worktree(
            name="load-fail-check",
            cwd=primary,
            base_ref=None,
            initializer=None,  # force the real loader path
        )
    msg = str(excinfo.value)
    assert secret not in msg
    assert "preserved" in msg.lower() or "worktree remove" in msg
    assert (primary / ".worktrees" / "load-fail-check").is_dir()
    branches = _git(primary, "branch", "--list", "worktree-load-fail-check")
    assert "worktree-load-fail-check" in branches


def test_main_unexpected_error_sanitized(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    secret = "token=LEAKME https://h/x?sig=ABC"

    def boom(**_: Any) -> Any:
        raise RuntimeError(secret)

    monkeypatch.setattr(mod, "create_worktree", boom)
    rc = mod.main(["fix-main-sanitize"], cwd=primary, initializer=lambda p: None)
    out = capsys.readouterr()
    assert rc == 1
    combined = out.out + out.err
    assert secret not in combined
    assert "RuntimeError" in combined


# --------------------------------------------------------------------------- #
# Batch N: bytecode cache, HEAD base semantics, layout fail-closed
# --------------------------------------------------------------------------- #

def test_load_initializer_writes_no_pycache(tmp_path: Path) -> None:
    import shutil

    mod = _load_create()
    scripts_dir = INIT_SCRIPT.parent
    cache = scripts_dir / "__pycache__"
    if cache.exists():
        shutil.rmtree(cache)
    # Loading the trusted initializer must not create a bytecode cache in the
    # launching checkout's scripts dir.
    fn = mod._load_initializer()
    assert callable(fn)
    assert not cache.exists(), "must not write __pycache__ into the launching checkout"


def test_base_defaults_to_launch_head_oid(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    # Local main is ahead of origin/main with an un-pushed commit.
    (primary / "local.txt").write_text("ahead\n", encoding="utf-8")
    _git(primary, "add", "local.txt")
    _git(primary, "commit", "-m", "local ahead")
    head = _git(primary, "rev-parse", "HEAD").strip()

    base = mod.resolve_base_ref(primary, override=None)
    assert base == head  # a fixed OID, not origin/HEAD

    result = mod.create_worktree(
        name="carry-local-commit",
        cwd=primary,
        base_ref=None,
        initializer=lambda p: None,
    )
    assert result["base_ref"] == head
    new_path = Path(result["worktree_path"])
    # The new worktree must contain the un-pushed local commit's file.
    assert (new_path / "local.txt").exists()


def test_base_from_linked_uses_linked_head(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    linked = primary / ".worktrees" / "seed-linked-base"
    (primary / ".worktrees").mkdir(exist_ok=True)
    _git(primary, "worktree", "add", "-b", "worktree-seed-linked-base", str(linked))
    (linked / "only-here.txt").write_text("x\n", encoding="utf-8")
    _git(linked, "add", "only-here.txt")
    _git(linked, "commit", "-m", "linked commit")
    linked_head = _git(linked, "rev-parse", "HEAD").strip()

    base = mod.resolve_base_ref(linked, override=None)
    assert base == linked_head


def test_nonstandard_layout_fails_closed(tmp_path: Path) -> None:
    mod = _load_create()
    work = tmp_path / "work"
    gitdir = tmp_path / "external.git"
    work.mkdir()
    subprocess.run(
        ["git", "init", "--separate-git-dir", str(gitdir), str(work)],
        check=True, capture_output=True, text=True,
    )
    _git(work, "config", "user.email", "t@t")
    _git(work, "config", "user.name", "t")
    (work / "f").write_text("x", encoding="utf-8")
    _git(work, "add", "f")
    _git(work, "commit", "-m", "i")
    # Standard-linked-only: a separate-git-dir layout must fail closed, not
    # silently create a worktree in the wrong place.
    with pytest.raises(mod.CreateWorktreeError):
        mod.create_worktree(
            name="unsupported-layout-case",
            cwd=work,
            base_ref=None,
            initializer=lambda p: None,
        )


# --------------------------------------------------------------------------- #
# Batch P: git config injection isolation + local include/includeIf fail-closed
# --------------------------------------------------------------------------- #

def test_sanitized_git_env_strips_config_injection() -> None:
    mod = _load_create()
    dirty = {
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "filter.evil.smudge",
        "GIT_CONFIG_VALUE_0": "sh -c 'touch x'",
        "GIT_CONFIG_PARAMETERS": "'filter.evil.smudge=sh'",
        "PATH": os.environ.get("PATH", ""),
    }
    env = mod._sanitized_git_env(base_env=dirty)
    for key in list(env):
        assert not key.startswith("GIT_CONFIG_KEY_")
        assert not key.startswith("GIT_CONFIG_VALUE_")
    assert "GIT_CONFIG_COUNT" not in env
    assert "GIT_CONFIG_PARAMETERS" not in env
    assert env["GIT_CONFIG_NOSYSTEM"] == "1"
    assert Path(env["GIT_CONFIG_GLOBAL"]).exists()


def test_parent_env_config_injection_ignored(tmp_path: Path) -> None:
    """A malicious GIT_CONFIG_* in the parent env must not reach worktree add."""
    primary = _init_origin_style_repo(tmp_path)
    _seed_primary_athlete(primary)
    marker = tmp_path / "env-injection.marker"

    env = dict(os.environ)
    env["GIT_CONFIG_COUNT"] = "2"
    env["GIT_CONFIG_KEY_0"] = "filter.evil.smudge"
    env["GIT_CONFIG_VALUE_0"] = f'sh -c \'touch "{marker}"\''
    env["GIT_CONFIG_KEY_1"] = "filter.evil.required"
    env["GIT_CONFIG_VALUE_1"] = "true"

    proc = subprocess.run(
        [sys.executable, str(CREATE_SCRIPT), "ignore-env-injection"],
        cwd=primary,
        capture_output=True,
        env=env,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr.decode("utf-8", "replace")
    assert not marker.exists(), "parent env GIT_CONFIG_* injection must be ignored"


def test_local_includeif_worktree_gitdir_fails_closed(tmp_path: Path) -> None:
    """includeIf.gitdir:**/worktrees/** that arms an evil filter must fail closed."""
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    marker = tmp_path / "includeif.marker"

    evil_inc = primary / "evil.inc"
    evil_inc.write_text(
        "[filter \"evil\"]\n"
        f"\tsmudge = sh -c 'touch \"{marker}\"'\n"
        "\trequired = true\n",
        encoding="utf-8",
    )
    # A conditional include that only activates inside the new worktree gitdir.
    _git(primary, "config", "includeIf.gitdir:**/worktrees/**.path", str(evil_inc))

    with pytest.raises(mod.CreateWorktreeError):
        mod.create_worktree(
            name="reject-includeif-case",
            cwd=primary,
            base_ref=None,
            initializer=lambda p: None,
        )
    assert not marker.exists()
    assert not (primary / ".worktrees" / "reject-includeif-case").exists()
    branches = _git(primary, "branch", "--list", "worktree-reject-includeif-case")
    assert branches.strip() == ""


def test_local_include_path_fails_closed(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    inc = primary / "some.inc"
    inc.write_text("[user]\n\temail = x@y\n", encoding="utf-8")
    _git(primary, "config", "include.path", str(inc))
    with pytest.raises(mod.CreateWorktreeError):
        mod.create_worktree(
            name="reject-include-path",
            cwd=primary,
            base_ref=None,
            initializer=lambda p: None,
        )


@pytest.mark.parametrize(
    "config_key",
    [
        "INCLUDE.path",
        "Include.Path",
        "IncludeIf.gitdir:**/worktrees/**.path",
        "INCLUDEIF.onbranch:main.path",
    ],
)
def test_mixed_case_include_config_fails_closed(tmp_path: Path, config_key: str) -> None:
    """Git canonicalizes section names to lowercase; the detector must match
    them regardless of the case used to write the config key."""
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    inc = primary / "some.inc"
    inc.write_text("[user]\n\temail = x@y\n", encoding="utf-8")
    _git(primary, "config", config_key, str(inc))
    with pytest.raises(mod.CreateWorktreeError):
        mod._assert_local_config_safe(primary)


def test_mixed_case_include_canonical_raw_output(tmp_path: Path) -> None:
    """Prove git's canonical (lowercased) output is what the detector sees."""
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    inc = primary / "some.inc"
    inc.write_text("[user]\n\temail = x@y\n", encoding="utf-8")
    _git(primary, "config", "IncludeIf.gitdir:**/worktrees/**.path", str(inc))
    out = mod._raw_git(
        primary, "config", "--local", "--name-only", "--get-regexp",
        r"^(include|includeif)\.", check=False,
    ).stdout.lower()
    assert "includeif." in out


def test_extensions_worktree_config_fails_closed(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    _git(primary, "config", "extensions.worktreeConfig", "true")
    with pytest.raises(mod.CreateWorktreeError):
        mod.create_worktree(
            name="reject-worktree-config",
            cwd=primary,
            base_ref=None,
            initializer=lambda p: None,
        )


@pytest.mark.parametrize("truthy", ["true", "yes", "on", "1"])
def test_worktree_config_truthy_rejected(tmp_path: Path, truthy: str) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    _git(primary, "config", "extensions.worktreeConfig", truthy)
    with pytest.raises(mod.CreateWorktreeError):
        mod._assert_local_config_safe(primary)


@pytest.mark.parametrize("falsy", ["false", "no", "off", "0"])
def test_worktree_config_falsy_accepted(tmp_path: Path, falsy: str) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    _git(primary, "config", "extensions.worktreeConfig", falsy)
    mod._assert_local_config_safe(primary)  # no raise


def test_worktree_config_absent_ok(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    mod._assert_local_config_safe(primary)  # no raise


def test_worktree_config_malformed_bool_fails_closed(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    _git(primary, "config", "extensions.worktreeConfig", "definitely-not-a-bool")
    with pytest.raises(mod.CreateWorktreeError):
        mod._assert_local_config_safe(primary)


def test_local_filter_still_neutralized_with_isolation(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    marker = tmp_path / "local-filter.marker"
    _configure_smudge_marker(primary, marker)
    result = mod.create_worktree(
        name="neutralize-local-filter",
        cwd=primary,
        base_ref=None,
        initializer=lambda p: None,
    )
    assert Path(result["worktree_path"]).is_dir()
    assert not marker.exists()


# --------------------------------------------------------------------------- #
# Batch O: worktrees-parent directory identity (TOCTOU)
# --------------------------------------------------------------------------- #

def test_parent_swapped_to_symlink_before_add_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If the .worktrees parent is swapped for an outside symlink after the
    identity is captured, creation must fail closed and roll back the branch."""
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    outside = tmp_path / "attacker"
    outside.mkdir()

    real_run_git = mod._run_git
    swapped = {"done": False}

    def swap_after_branch(cwd: Any, *args: str, **kw: Any) -> Any:
        result = real_run_git(cwd, *args, **kw)
        # After the branch is created, swap the empty parent for a symlink.
        # (branch create now carries hardening `-c` flags, so match "branch"
        # anywhere in argv rather than as the first token.)
        if not swapped["done"] and "branch" in args and "--" in args:
            parent = primary / ".worktrees"
            saved = tmp_path / ".worktrees.saved"
            os.rename(parent, saved)
            try:
                parent.symlink_to(outside, target_is_directory=True)
            except (OSError, NotImplementedError):
                pytest.skip("symlink creation not permitted")
            swapped["done"] = True
        return result

    monkeypatch.setattr(mod, "_run_git", swap_after_branch)

    with pytest.raises(mod.CreateWorktreeError):
        mod.create_worktree(
            name="detect-parent-swap",
            cwd=primary,
            base_ref=None,
            initializer=lambda p: None,
        )
    # No worktree created inside the attacker dir.
    assert list(outside.iterdir()) == []
    # Branch rolled back.
    branches = _git(primary, "branch", "--list", "worktree-detect-parent-swap")
    assert branches.strip() == ""


def test_initializer_not_called_when_parent_identity_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    called = {"init": False}

    def track_init(_p: Any) -> None:
        called["init"] = True

    # Force a post-add identity mismatch by patching the identity assertion to
    # raise on the final (post-add) check only.
    real_assert = mod._assert_same_real_directory
    calls = {"n": 0}

    def flaky_assert(parent: Any, identity: Any, root: Any) -> None:
        calls["n"] += 1
        if calls["n"] >= 3:  # pre-branch=1, pre-add=2, post-add=3
            raise mod.CreateWorktreeError("identity changed post-add")
        return real_assert(parent, identity, root)

    monkeypatch.setattr(mod, "_assert_same_real_directory", flaky_assert)

    with pytest.raises(mod.CreateWorktreeError):
        mod.create_worktree(
            name="post-add-identity-guard",
            cwd=primary,
            base_ref=None,
            initializer=track_init,
        )
    assert called["init"] is False


def test_directory_identity_matches_same_dir(tmp_path: Path) -> None:
    mod = _load_create()
    root = tmp_path / "root"
    parent = root / ".worktrees"
    parent.mkdir(parents=True)
    ident = mod.DirectoryIdentity.capture(parent)
    mod._assert_same_real_directory(parent, ident, root)  # no raise


# --------------------------------------------------------------------------- #
# Batch R: _worktree_registered exact-path (no substring/prefix collision)
# --------------------------------------------------------------------------- #

def test_worktree_registered_no_prefix_collision(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    # Register a worktree whose path is a strict superstring of the query path.
    extra = primary / ".worktrees" / "fix-the-task-extra"
    (primary / ".worktrees").mkdir(exist_ok=True)
    _git(primary, "worktree", "add", "-b", "wt-extra", str(extra))

    query = primary / ".worktrees" / "fix-the-task"
    assert mod._worktree_registered(primary, extra) is True
    assert mod._worktree_registered(primary, query) is False


def test_worktree_registered_exact_match_true(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    wt = primary / ".worktrees" / "exact-match-here"
    (primary / ".worktrees").mkdir(exist_ok=True)
    _git(primary, "worktree", "add", "-b", "wt-exact", str(wt))
    assert mod._worktree_registered(primary, wt) is True


def test_worktree_registered_cjk_and_space_path(tmp_path: Path) -> None:
    mod = _load_create()
    base = tmp_path / "赛季 目录"
    primary = _init_origin_style_repo(base)
    wt = primary / ".worktrees" / "工作 树-path"
    (primary / ".worktrees").mkdir(exist_ok=True)
    _git(primary, "worktree", "add", "-b", "wt-cjk", str(wt))
    assert mod._worktree_registered(primary, wt) is True
    other = primary / ".worktrees" / "工作 树-path-extra"
    assert mod._worktree_registered(primary, other) is False


def test_prefix_named_task_add_failure_rolls_back_branch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With a prefix-superstring worktree already present, a simulated add
    failure for the shorter task must still roll back this run's branch."""
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    (primary / ".worktrees").mkdir(exist_ok=True)
    extra = primary / ".worktrees" / "fix-the-task-extra"
    _git(primary, "worktree", "add", "-b", "wt-extra", str(extra))

    real_run_git = mod._run_git

    def flaky_run_git(cwd: Any, *args: str, check: bool = True) -> Any:
        if "worktree" in args and "add" in args:
            return real_run_git(cwd, "worktree", "add", "--bogus-flag", check=False)
        return real_run_git(cwd, *args, check=check)

    monkeypatch.setattr(mod, "_run_git", flaky_run_git)

    with pytest.raises(mod.CreateWorktreeError):
        mod.create_worktree(
            name="fix-the-task",
            cwd=primary,
            base_ref=None,
            initializer=lambda p: None,
        )
    branches = _git(primary, "branch", "--list", "worktree-fix-the-task")
    assert branches.strip() == ""


# --------------------------------------------------------------------------- #
# Batch Q: strip inherited git routing/execution env vars
# --------------------------------------------------------------------------- #

_ROUTING_ENV_VARS = [
    "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_PREFIX",
    "GIT_CONFIG", "GIT_CONFIG_SYSTEM", "GIT_ATTR_NOSYSTEM", "GIT_OPTIONAL_LOCKS",
    "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS", "GIT_SSH", "GIT_SSH_COMMAND",
    "GIT_ASKPASS", "GIT_TERMINAL_PROMPT", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR",
]


@pytest.mark.parametrize("var", _ROUTING_ENV_VARS)
def test_sanitized_env_strips_routing_var(var: str) -> None:
    mod = _load_create()
    dirty = {var: "attacker-value", "PATH": os.environ.get("PATH", "")}
    env = mod._sanitized_git_env(base_env=dirty)
    assert var not in env, var


def test_sanitized_env_keeps_path_and_home() -> None:
    mod = _load_create()
    dirty = {"PATH": "/x/bin", "HOME": "/home/u", "GIT_DIR": "/evil/.git"}
    env = mod._sanitized_git_env(base_env=dirty)
    assert env["PATH"] == "/x/bin"
    assert env.get("HOME") == "/home/u"
    assert "GIT_DIR" not in env


@pytest.mark.parametrize("var", ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR",
                                 "GIT_INDEX_FILE"])
def test_git_routing_env_does_not_reroute_creation(tmp_path: Path, var: str) -> None:
    """A hostile GIT_* routing var in the parent env must not redirect creation."""
    a = _init_origin_style_repo(tmp_path / "A_root", primary_name="A")
    b = _init_origin_style_repo(tmp_path / "B_root", primary_name="B")
    _seed_primary_athlete(a)

    env = dict(os.environ)
    if var == "GIT_INDEX_FILE":
        env[var] = str(b / ".git" / "hostile-index")
    elif var == "GIT_COMMON_DIR":
        env[var] = str(b / ".git")
    elif var == "GIT_WORK_TREE":
        env[var] = str(b)
    else:  # GIT_DIR
        env[var] = str(b / ".git")

    proc = subprocess.run(
        [sys.executable, str(CREATE_SCRIPT), "route-guard-check"],
        cwd=a,
        capture_output=True,
        env=env,
        check=False,
    )
    out = proc.stdout.decode("utf-8", "replace")
    assert proc.returncode == 0, proc.stderr.decode("utf-8", "replace")
    payload = json.loads(out.strip().splitlines()[-1])
    new_path = Path(payload["worktree_path"]).resolve()
    # Created under A, not B.
    assert a.resolve() in new_path.parents
    assert b.resolve() not in new_path.parents
    # B has no branch/worktree from this run.
    b_branches = _git(b, "branch", "--list", "worktree-route-guard-check")
    assert b_branches.strip() == ""
    b_wt = _git(b, "worktree", "list", "--porcelain")
    assert "route-guard-check" not in b_wt


def test_env_external_diff_and_ssh_stripped() -> None:
    mod = _load_create()
    dirty = {
        "GIT_EXTERNAL_DIFF": "sh -c 'touch /tmp/x'",
        "GIT_SSH_COMMAND": "sh -c 'touch /tmp/y'",
        "GIT_ASKPASS": "sh",
        "PATH": os.environ.get("PATH", ""),
    }
    env = mod._sanitized_git_env(base_env=dirty)
    for k in ("GIT_EXTERNAL_DIFF", "GIT_SSH_COMMAND", "GIT_ASKPASS"):
        assert k not in env


def test_includeif_onbranch_local_fails_closed(tmp_path: Path) -> None:
    mod = _load_create()
    primary = _init_origin_style_repo(tmp_path)
    inc = primary / "branch.inc"
    inc.write_text("[user]\n\temail=x@y\n", encoding="utf-8")
    _git(primary, "config", "includeIf.onbranch:main.path", str(inc))
    with pytest.raises(mod.CreateWorktreeError):
        mod.create_worktree(
            name="reject-onbranch-include",
            cwd=primary,
            base_ref=None,
            initializer=lambda p: None,
        )
