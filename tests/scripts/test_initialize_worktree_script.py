"""Contract tests for the worktree-development initialization script.

The script is distributed alongside the ``worktree-development`` skill and is
invoked by the portable ``create_worktree.py`` entry point (or standalone for
diagnostics) after a fresh linked worktree has been created, via the repository-
relative ``.claude/skills/worktree-development/scripts/initialize_worktree.py``.

Responsibilities (in order):

1. Gate: current cwd must be a *linked* git worktree with a clean tree.
2. Locate the *primary* checkout of the SAME repository (shared git
   common-dir) and require its ``data/.slug_aliases.json`` to map the fixed
   slug to the pinned UUID.
3. Snapshot the athlete SQLite DB from the primary checkout into this
   worktree's canonical ``data/<UUID>/coros.db`` using ``sqlite3`` online
   backup (WAL-consistent), atomically and validated.

No Azure, no network, no project package import. Any failure exits non-zero
(fail closed) without mutating the source or clobbering an existing target.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sqlite3
import sys
import types
from pathlib import Path
from typing import Any

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
SKILL_DIR = REPO_ROOT / ".claude" / "skills" / "worktree-development"
SCRIPT = SKILL_DIR / "scripts" / "initialize_worktree.py"
SKILL_MD = SKILL_DIR / "SKILL.md"

FIXED_UUID = "f10bc353-01ab-4db1-af9f-d9305ea9a532"
SLUG = "zhaochaoyi"


def _load_module() -> types.ModuleType:
    spec = importlib.util.spec_from_file_location("initialize_worktree_mod", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args],
        cwd=cwd,
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=True,
    )


def _init_primary(root: Path, name: str = "primary") -> Path:
    primary = root / name
    primary.mkdir(parents=True)
    _git(primary, "init", "-b", "main")
    _git(primary, "config", "user.email", "test@example.com")
    _git(primary, "config", "user.name", "Test")
    (primary / "README.md").write_text("hello\n", encoding="utf-8")
    _git(primary, "add", "README.md")
    _git(primary, "commit", "-m", "init")
    return primary


def _add_linked(primary: Path, path: Path, branch: str = "feature") -> Path:
    _git(primary, "worktree", "add", "-b", branch, str(path))
    return path


def _seed_aliases(repo: Path, mapping: dict[str, str] | None = None) -> None:
    data = repo / "data"
    data.mkdir(exist_ok=True, parents=True)
    (data / ".slug_aliases.json").write_text(
        json.dumps(mapping if mapping is not None else {SLUG: FIXED_UUID}),
        encoding="utf-8",
    )


def _make_db(path: Path, *, rows: int = 1, wal: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        if wal:
            conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("CREATE TABLE t (x INTEGER)")
        for i in range(rows):
            conn.execute("INSERT INTO t VALUES (?)", (i,))
        conn.commit()
    finally:
        conn.close()


def _seed_source_db(primary: Path, *, rows: int = 3, wal: bool = False) -> Path:
    db = primary / "data" / FIXED_UUID / "coros.db"
    _make_db(db, rows=rows, wal=wal)
    return db


def _row_count(path: Path) -> int:
    conn = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    try:
        return conn.execute("SELECT count(*) FROM t").fetchone()[0]
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# Git gate + UTF-8 output
# --------------------------------------------------------------------------- #

def test_linked_worktree_accepted_and_primary_rejected(tmp_path: Path) -> None:
    mod = _load_module()
    primary = _init_primary(tmp_path)
    linked = _add_linked(primary, tmp_path / "linked")
    mod.ensure_linked_worktree(linked)
    with pytest.raises(mod.InitializationError):
        mod.ensure_linked_worktree(primary)


def test_git_toplevel_handles_non_ascii_path(tmp_path: Path) -> None:
    """Git emits UTF-8; the runner must decode UTF-8 (not cp1252 on Windows)."""
    mod = _load_module()
    base = tmp_path / "赛季 目录"
    primary = _init_primary(base)
    linked = _add_linked(primary, base / "工作树 linked")
    top = mod.git_toplevel(linked)
    assert top == linked.resolve()


# --------------------------------------------------------------------------- #
# Primary checkout location (pure helper)
# --------------------------------------------------------------------------- #

def test_locate_primary_checkout_from_linked(tmp_path: Path) -> None:
    mod = _load_module()
    primary = _init_primary(tmp_path)
    linked = _add_linked(primary, tmp_path / "linked")
    found = mod.locate_primary_checkout(linked)
    assert found.resolve() == primary.resolve()


def test_locate_primary_from_nested_subdir(tmp_path: Path) -> None:
    mod = _load_module()
    primary = _init_primary(tmp_path)
    linked = _add_linked(primary, tmp_path / "linked")
    nested = linked / "src" / "deep"
    nested.mkdir(parents=True)
    found = mod.locate_primary_checkout(nested)
    assert found.resolve() == primary.resolve()


def test_primary_helper_not_fooled_by_other_linked_worktree(tmp_path: Path) -> None:
    """Two linked worktrees exist; the primary must be the real main checkout."""
    mod = _load_module()
    primary = _init_primary(tmp_path)
    other = _add_linked(primary, tmp_path / "other", branch="other")
    linked = _add_linked(primary, tmp_path / "linked")
    found = mod.locate_primary_checkout(linked)
    assert found.resolve() == primary.resolve()
    assert found.resolve() != other.resolve()


def test_primary_parser_picks_main_not_arbitrary(tmp_path: Path) -> None:
    mod = _load_module()
    common = tmp_path / "main" / ".git"
    porcelain = (
        f"worktree {(tmp_path / 'main').as_posix()}\n"
        "HEAD abc\nbranch refs/heads/main\n\n"
        f"worktree {(tmp_path / 'wt2').as_posix()}\n"
        "HEAD def\nbranch refs/heads/wt2\n"
    )
    picked = mod.primary_from_porcelain(porcelain, common)
    assert picked == (tmp_path / "main").resolve()


def test_non_ascii_primary_path_parsed(tmp_path: Path) -> None:
    mod = _load_module()
    main = tmp_path / "主仓库"
    common = main / ".git"
    porcelain = (
        f"worktree {main.as_posix()}\n"
        "HEAD abc\nbranch refs/heads/main\n"
    )
    assert mod.primary_from_porcelain(porcelain, common) == main.resolve()


# --------------------------------------------------------------------------- #
# Alias / UUID authorization from the primary source-of-truth
# --------------------------------------------------------------------------- #

def test_alias_from_primary_required(tmp_path: Path) -> None:
    mod = _load_module()
    primary = _init_primary(tmp_path)
    _seed_aliases(primary, {SLUG: "00000000-0000-0000-0000-000000000000"})
    with pytest.raises(mod.InitializationError):
        mod.resolve_fixed_uuid(primary)


def test_alias_match_ok(tmp_path: Path) -> None:
    mod = _load_module()
    primary = _init_primary(tmp_path)
    _seed_aliases(primary)
    assert mod.resolve_fixed_uuid(primary) == FIXED_UUID


# --------------------------------------------------------------------------- #
# Source DB resolution / protection
# --------------------------------------------------------------------------- #

def test_source_db_missing_rejected(tmp_path: Path) -> None:
    mod = _load_module()
    primary = _init_primary(tmp_path)
    (primary / "data" / FIXED_UUID).mkdir(parents=True)
    with pytest.raises(mod.InitializationError):
        mod.resolve_source_db_path(primary, FIXED_UUID)


def test_source_db_zero_bytes_rejected(tmp_path: Path) -> None:
    mod = _load_module()
    primary = _init_primary(tmp_path)
    src = primary / "data" / FIXED_UUID / "coros.db"
    src.parent.mkdir(parents=True)
    src.write_bytes(b"")
    with pytest.raises(mod.InitializationError):
        mod.resolve_source_db_path(primary, FIXED_UUID)


def test_source_symlink_rejected(tmp_path: Path) -> None:
    mod = _load_module()
    primary = _init_primary(tmp_path)
    real = tmp_path / "elsewhere.db"
    _make_db(real)
    src = primary / "data" / FIXED_UUID / "coros.db"
    src.parent.mkdir(parents=True)
    try:
        src.symlink_to(real)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation not permitted")
    with pytest.raises(mod.InitializationError):
        mod.resolve_source_db_path(primary, FIXED_UUID)


def test_source_ok_regular(tmp_path: Path) -> None:
    mod = _load_module()
    primary = _init_primary(tmp_path)
    src = _seed_source_db(primary)
    got = mod.resolve_source_db_path(primary, FIXED_UUID)
    assert got.resolve() == src.resolve()


# --------------------------------------------------------------------------- #
# Target path protection
# --------------------------------------------------------------------------- #

def test_target_symlink_rejected(tmp_path: Path) -> None:
    mod = _load_module()
    repo = tmp_path / "repo"
    (repo / "data").mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    link = repo / "data" / FIXED_UUID
    try:
        link.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation not permitted")
    with pytest.raises(mod.InitializationError):
        mod.resolve_target_db_path(repo, FIXED_UUID)


def test_target_ok(tmp_path: Path) -> None:
    mod = _load_module()
    repo = tmp_path / "repo"
    (repo / "data" / FIXED_UUID).mkdir(parents=True)
    target = mod.resolve_target_db_path(repo, FIXED_UUID)
    assert target.name == "coros.db"
    assert target.parent.name == FIXED_UUID


# --------------------------------------------------------------------------- #
# Sidecar / dangling-link fail-closed
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("suffix", ["-wal", "-shm", "-journal"])
def test_existing_target_sidecar_rejected(tmp_path: Path, suffix: str) -> None:
    mod = _load_module()
    repo = tmp_path / "repo"
    (repo / "data" / FIXED_UUID).mkdir(parents=True)
    target = repo / "data" / FIXED_UUID / "coros.db"
    (target.parent / (target.name + suffix)).write_bytes(b"x")
    with pytest.raises(mod.InitializationError):
        mod.ensure_no_target_sidecars(target)


@pytest.mark.parametrize("suffix", ["-wal", "-shm", "-journal"])
def test_dangling_symlink_sidecar_rejected(tmp_path: Path, suffix: str) -> None:
    mod = _load_module()
    repo = tmp_path / "repo"
    (repo / "data" / FIXED_UUID).mkdir(parents=True)
    target = repo / "data" / FIXED_UUID / "coros.db"
    sidecar = target.parent / (target.name + suffix)
    try:
        sidecar.symlink_to(tmp_path / "nonexistent-target")
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation not permitted")
    # exists() is False for a dangling link, but it must still fail closed.
    assert not sidecar.exists()
    with pytest.raises(mod.InitializationError):
        mod.ensure_no_target_sidecars(target)


# --------------------------------------------------------------------------- #
# Backup snapshot (the real copy path)
# --------------------------------------------------------------------------- #

def test_backup_snapshot_valid_atomic_replace(tmp_path: Path) -> None:
    mod = _load_module()
    primary = _init_primary(tmp_path)
    src = _seed_source_db(primary, rows=5)
    repo = tmp_path / "repo"
    (repo / "data" / FIXED_UUID).mkdir(parents=True)
    target = repo / "data" / FIXED_UUID / "coros.db"

    mod.snapshot_db(source=src, target=target)

    assert target.is_file()
    assert _row_count(target) == 5
    leftovers = [p.name for p in target.parent.iterdir() if p.name != "coros.db"]
    assert leftovers == []


def test_backup_includes_wal_only_rows(tmp_path: Path) -> None:
    """Rows sitting in an un-checkpointed WAL must be captured by the snapshot.

    A separate writer connection stays open with ``wal_autocheckpoint=0`` so the
    new rows live only in ``coros.db-wal`` — a naive main-file copy would miss
    them. The snapshot (sqlite backup) must include them.
    """
    mod = _load_module()
    primary = _init_primary(tmp_path)
    src = primary / "data" / FIXED_UUID / "coros.db"
    _make_db(src, rows=2, wal=True)

    writer = sqlite3.connect(src)
    try:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("PRAGMA wal_autocheckpoint=0")  # never auto-checkpoint
        writer.execute("INSERT INTO t VALUES (100)")
        writer.execute("INSERT INTO t VALUES (101)")
        writer.commit()

        wal = src.parent / "coros.db-wal"
        assert wal.exists() and wal.stat().st_size > 0, "expected an un-checkpointed WAL"

        # A main-file-only copy must be missing the two WAL-only rows.
        main_only = tmp_path / "main_only.db"
        main_only.write_bytes(src.read_bytes())
        assert _row_count(main_only) == 2

        repo = tmp_path / "repo"
        (repo / "data" / FIXED_UUID).mkdir(parents=True)
        target = repo / "data" / FIXED_UUID / "coros.db"
        mod.snapshot_db(source=src, target=target)
        assert _row_count(target) == 4
    finally:
        writer.close()


def _file_hash(path: Path) -> str:
    import hashlib

    return hashlib.sha256(path.read_bytes()).hexdigest()


def test_source_main_and_wal_unchanged_shm_allowed(tmp_path: Path) -> None:
    """Snapshot must not change source main/wal bytes; a transient -shm is ok."""
    mod = _load_module()
    primary = _init_primary(tmp_path)
    src = primary / "data" / FIXED_UUID / "coros.db"
    _make_db(src, rows=3, wal=True)

    writer = sqlite3.connect(src)
    try:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute("PRAGMA wal_autocheckpoint=0")
        writer.execute("INSERT INTO t VALUES (7)")
        writer.commit()

        wal = src.parent / "coros.db-wal"
        main_hash = _file_hash(src)
        wal_hash = _file_hash(wal)
        rows_before = _row_count(src)

        repo = tmp_path / "repo"
        (repo / "data" / FIXED_UUID).mkdir(parents=True)
        target = repo / "data" / FIXED_UUID / "coros.db"
        mod.snapshot_db(source=src, target=target)

        assert _file_hash(src) == main_hash, "source main DB must not change"
        assert _file_hash(wal) == wal_hash, "source WAL must not change"
        assert _row_count(src) == rows_before
    finally:
        writer.close()


def test_snapshot_target_is_delete_journal_mode(tmp_path: Path) -> None:
    """The produced target must be in DELETE journal mode (no persistent WAL)."""
    mod = _load_module()
    primary = _init_primary(tmp_path)
    src = _seed_source_db(primary, rows=3, wal=True)
    repo = tmp_path / "repo"
    (repo / "data" / FIXED_UUID).mkdir(parents=True)
    target = repo / "data" / FIXED_UUID / "coros.db"
    mod.snapshot_db(source=src, target=target)

    # A first plain read-only open must not create -wal/-shm sidecars.
    conn = sqlite3.connect(f"file:{target.as_posix()}?mode=ro", uri=True)
    try:
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
    finally:
        conn.close()
    assert mode.lower() == "delete"
    for suffix in ("-wal", "-shm", "-journal"):
        assert not (target.parent / (target.name + suffix)).exists()





def test_snapshot_leaves_no_dest_sidecars(tmp_path: Path) -> None:
    mod = _load_module()
    primary = _init_primary(tmp_path)
    src = _seed_source_db(primary, rows=3, wal=True)
    repo = tmp_path / "repo"
    (repo / "data" / FIXED_UUID).mkdir(parents=True)
    target = repo / "data" / FIXED_UUID / "coros.db"
    mod.snapshot_db(source=src, target=target)
    for suffix in ("-wal", "-shm", "-journal"):
        assert not (target.parent / (target.name + suffix)).exists()


def test_snapshot_failure_preserves_existing_target(tmp_path: Path) -> None:
    mod = _load_module()
    primary = _init_primary(tmp_path)
    src = _seed_source_db(primary, rows=3)
    repo = tmp_path / "repo"
    (repo / "data" / FIXED_UUID).mkdir(parents=True)
    target = repo / "data" / FIXED_UUID / "coros.db"
    _make_db(target, rows=99)
    old = target.read_bytes()

    # Corrupt validation by monkeypatching integrity check to fail.
    def boom(_p: Path) -> None:
        raise mod.InitializationError("forced")

    orig = mod._validate_sqlite
    mod._validate_sqlite = boom  # type: ignore[assignment]
    try:
        with pytest.raises(mod.InitializationError):
            mod.snapshot_db(source=src, target=target)
    finally:
        mod._validate_sqlite = orig  # type: ignore[assignment]

    assert target.read_bytes() == old
    leftovers = [p.name for p in target.parent.iterdir() if p.name != "coros.db"]
    assert leftovers == []


# --------------------------------------------------------------------------- #
# F. Snapshot target permissions (POSIX 0600)
# --------------------------------------------------------------------------- #

def test_snapshot_target_is_mode_0600_posix(tmp_path: Path) -> None:
    if os.name != "posix":
        pytest.skip("POSIX mode bits only")
    mod = _load_module()
    primary = _init_primary(tmp_path)
    src = _seed_source_db(primary, rows=3)
    repo = tmp_path / "repo"
    (repo / "data" / FIXED_UUID).mkdir(parents=True)
    target = repo / "data" / FIXED_UUID / "coros.db"
    mod.snapshot_db(source=src, target=target)
    import stat as _stat

    mode = _stat.S_IMODE(target.stat().st_mode)
    assert mode == 0o600, oct(mode)


# --------------------------------------------------------------------------- #
# C. Source/target ancestor reparse protection (symlink to outside repo)
# --------------------------------------------------------------------------- #

def test_source_data_symlink_to_outside_rejected(tmp_path: Path) -> None:
    mod = _load_module()
    primary = _init_primary(tmp_path)
    outside = tmp_path / "outside_data"
    (outside / FIXED_UUID).mkdir(parents=True)
    _make_db(outside / FIXED_UUID / "coros.db", rows=3)
    (outside / ".slug_aliases.json").write_text(
        json.dumps({SLUG: FIXED_UUID}), encoding="utf-8"
    )
    data_link = primary / "data"
    try:
        data_link.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation not permitted")
    with pytest.raises(mod.InitializationError):
        mod.resolve_source_db_path(primary, FIXED_UUID)


def test_target_data_ancestor_symlink_rejected(tmp_path: Path) -> None:
    mod = _load_module()
    repo = tmp_path / "repo"
    repo.mkdir()
    outside = tmp_path / "outside"
    (outside / FIXED_UUID).mkdir(parents=True)
    data_link = repo / "data"
    try:
        data_link.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation not permitted")
    with pytest.raises(mod.InitializationError):
        mod.resolve_target_db_path(repo, FIXED_UUID)


# --------------------------------------------------------------------------- #
# A. UTF-8 stdio under cp1252 (real subprocess, CJK path)
# --------------------------------------------------------------------------- #

def test_initializer_git_calls_suppress_filters(tmp_path: Path) -> None:
    """A malicious clean/smudge filter must not run during initializer git ops."""
    mod = _load_module()
    primary = _init_primary(tmp_path)
    linked = _add_linked(primary, tmp_path / "linked")

    marker = tmp_path / "init-filter-ran.marker"
    _git(linked, "config", "filter.evil.smudge", f'sh -c \'touch "{marker}"\'')
    _git(linked, "config", "filter.evil.clean", f'sh -c \'touch "{marker}"\'')
    (linked / ".gitattributes").write_text("payload.bin filter=evil\n", encoding="utf-8")
    (linked / "payload.bin").write_text("x\n", encoding="utf-8")

    # ensure_clean_worktree runs `git status` — with hardening it must neither
    # crash on the required filter nor execute the payload.
    try:
        mod.ensure_clean_worktree(linked)
    except mod.InitializationError:
        pass  # dirty tree is fine; we only care the filter did not execute
    assert not marker.exists(), "initializer git ops must suppress filter drivers"


def test_initializer_run_git_carries_hardening_flags() -> None:
    mod = _load_module()
    # The safe git prefix must disable hooks + fsmonitor.
    prefix = mod._safe_git_prefix(Path("."))
    joined = " ".join(prefix)
    assert "core.hooksPath=" in joined
    assert "core.fsmonitor=false" in joined


def test_initializer_sanitized_env_isolates_config() -> None:
    mod = _load_module()
    dirty = {
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "filter.evil.smudge",
        "GIT_CONFIG_VALUE_0": "sh -c 'x'",
        "GIT_CONFIG_PARAMETERS": "'a=b'",
        "PATH": os.environ.get("PATH", ""),
    }
    env = mod._sanitized_git_env(base_env=dirty)
    assert "GIT_CONFIG_COUNT" not in env
    assert "GIT_CONFIG_KEY_0" not in env
    assert "GIT_CONFIG_PARAMETERS" not in env
    assert env["GIT_CONFIG_NOSYSTEM"] == "1"
    assert Path(env["GIT_CONFIG_GLOBAL"]).exists()


@pytest.mark.parametrize(
    "var",
    ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
     "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE", "GIT_EXTERNAL_DIFF",
     "GIT_SSH_COMMAND", "GIT_ASKPASS", "GIT_EDITOR"],
)
def test_initializer_sanitized_env_strips_routing(var: str) -> None:
    mod = _load_module()
    env = mod._sanitized_git_env(base_env={var: "x", "PATH": os.environ.get("PATH", "")})
    assert var not in env


def test_initializer_git_toplevel_not_rerouted_by_git_dir(tmp_path: Path) -> None:
    """git_toplevel must reflect the real linked worktree, not an env GIT_DIR."""
    mod = _load_module()
    primary = _init_primary(tmp_path / "A")
    linked = _add_linked(primary, tmp_path / "A" / ".worktrees" / "wt")
    other = _init_primary(tmp_path / "B", name="B")
    saved = os.environ.get("GIT_DIR")
    os.environ["GIT_DIR"] = str(other / ".git")
    try:
        top = mod.git_toplevel(linked)
    finally:
        if saved is None:
            os.environ.pop("GIT_DIR", None)
        else:
            os.environ["GIT_DIR"] = saved
    assert top == linked.resolve()


def test_initializer_rejects_local_includeif(tmp_path: Path) -> None:
    mod = _load_module()
    primary = _init_primary(tmp_path)
    linked = _add_linked(primary, tmp_path / "linked")
    inc = linked / "evil.inc"
    inc.write_text("[user]\n\temail=x@y\n", encoding="utf-8")
    _git(linked, "config", "includeIf.gitdir:**/worktrees/**.path", str(inc))
    with pytest.raises(mod.InitializationError):
        mod.ensure_clean_worktree(linked)


@pytest.mark.parametrize(
    "config_key",
    [
        "INCLUDE.path",
        "Include.Path",
        "IncludeIf.gitdir:**/worktrees/**.path",
        "INCLUDEIF.onbranch:main.path",
    ],
)
def test_initializer_mixed_case_include_fails_closed(
    tmp_path: Path, config_key: str
) -> None:
    mod = _load_module()
    primary = _init_primary(tmp_path)
    linked = _add_linked(primary, tmp_path / "linked")
    inc = linked / "evil.inc"
    inc.write_text("[user]\n\temail=x@y\n", encoding="utf-8")
    _git(linked, "config", config_key, str(inc))
    with pytest.raises(mod.InitializationError):
        mod._assert_local_config_safe(linked)


def test_initializer_mixed_case_include_canonical_raw_output(tmp_path: Path) -> None:
    mod = _load_module()
    primary = _init_primary(tmp_path)
    linked = _add_linked(primary, tmp_path / "linked")
    inc = linked / "evil.inc"
    inc.write_text("[user]\n\temail=x@y\n", encoding="utf-8")
    _git(linked, "config", "IncludeIf.gitdir:**/worktrees/**.path", str(inc))
    out = mod._raw_git(
        linked, "config", "--local", "--name-only", "--get-regexp",
        r"^(include|includeif)\.",
    ).stdout.lower()
    assert "includeif." in out


@pytest.mark.parametrize("truthy", ["true", "yes", "on", "1"])
def test_initializer_worktree_config_truthy_rejected(tmp_path: Path, truthy: str) -> None:
    mod = _load_module()
    primary = _init_primary(tmp_path)
    linked = _add_linked(primary, tmp_path / "linked")
    _git(linked, "config", "extensions.worktreeConfig", truthy)
    with pytest.raises(mod.InitializationError):
        mod._assert_local_config_safe(linked)


@pytest.mark.parametrize("falsy", ["false", "no", "off", "0"])
def test_initializer_worktree_config_falsy_accepted(tmp_path: Path, falsy: str) -> None:
    mod = _load_module()
    primary = _init_primary(tmp_path)
    linked = _add_linked(primary, tmp_path / "linked")
    _git(linked, "config", "extensions.worktreeConfig", falsy)
    mod._assert_local_config_safe(linked)  # no raise


def test_initializer_worktree_config_malformed_fails_closed(tmp_path: Path) -> None:
    mod = _load_module()
    primary = _init_primary(tmp_path)
    linked = _add_linked(primary, tmp_path / "linked")
    _git(linked, "config", "extensions.worktreeConfig", "not-a-bool")
    with pytest.raises(mod.InitializationError):
        mod._assert_local_config_safe(linked)


def test_run_asserts_config_safe_before_any_evidence(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """A local include.path arming a required clean filter must be rejected
    before `run` emits any status/evidence (so the filter never executes)."""
    mod = _load_module()
    primary = _init_primary(tmp_path)
    linked = _add_linked(primary, tmp_path / "linked")

    marker = tmp_path / "include-filter.marker"
    evil = linked / "armed.inc"
    evil.write_text(
        "[filter \"evil\"]\n"
        f"\tclean = sh -c 'touch \"{marker}\"; cat'\n"
        "\trequired = true\n",
        encoding="utf-8",
    )
    (linked / ".gitattributes").write_text("* filter=evil\n", encoding="utf-8")
    _git(linked, "config", "include.path", str(evil))

    with pytest.raises(mod.InitializationError):
        mod.run(linked)

    out = capsys.readouterr().out
    # Fail-closed before any evidence and without executing the filter.
    assert "git worktree list" not in out
    assert "git status" not in out
    assert not marker.exists(), "clean filter must not execute (rejected pre-evidence)"


def test_evidence_emitted_before_clean_gate_when_config_safe(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """With safe config but a dirty tree, evidence is still emitted before the
    clean gate rejects (diagnostics remain available)."""
    mod = _load_module()
    primary = _init_primary(tmp_path)
    linked = _add_linked(primary, tmp_path / "linked")
    (linked / "dirty.txt").write_text("x\n", encoding="utf-8")

    with pytest.raises(mod.InitializationError):
        mod.run(linked)
    out = capsys.readouterr().out
    assert "git worktree list" in out


def test_initializer_evidence_utf8_under_cp1252(tmp_path: Path) -> None:
    base = tmp_path / "赛季 目录"
    primary = _init_primary(base)
    linked = _add_linked(primary, base / "工作树 linked")

    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "cp1252"
    proc = subprocess.run(
        [sys.executable, str(SCRIPT)],
        cwd=linked,
        capture_output=True,
        env=env,
        check=False,
    )
    out = proc.stdout.decode("utf-8")
    err = proc.stderr.decode("utf-8")
    # Evidence emission must not crash with a UnicodeEncodeError on the CJK path.
    assert "UnicodeEncodeError" not in err
    # It fails the gate later (no seeded alias/DB) but the CJK worktree path
    # must appear in the emitted evidence without a codec crash.
    assert "工作树 linked" in out



    mod = _load_module()
    bad = tmp_path / "bad.db"
    bad.write_bytes(b"SQLite format 3\x00" + b"\x00" * 4096)
    with pytest.raises(mod.InitializationError):
        mod._validate_sqlite(bad)


def test_validate_sqlite_handles_uri_special_chars(tmp_path: Path) -> None:
    mod = _load_module()
    subdir = tmp_path / "a#b c%20d"
    subdir.mkdir()
    db = subdir / "coros.db"
    _make_db(db)
    before = sorted(p.name for p in subdir.iterdir())
    mod._validate_sqlite(db)
    after = sorted(p.name for p in subdir.iterdir())
    assert after == before == ["coros.db"]


# --------------------------------------------------------------------------- #
# Exception sanitization in main()
# --------------------------------------------------------------------------- #

def test_main_unexpected_error_does_not_leak_message(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    mod = _load_module()
    secret = "https://acct.example/x?sig=SUPERSECRETTOKEN"

    def boom(_cwd: Path) -> None:
        raise RuntimeError(secret)

    monkeypatch.setattr(mod, "run", boom)
    rc = mod.main()
    out = capsys.readouterr()
    assert rc == 1
    assert secret not in (out.out + out.err)
    assert "RuntimeError" in out.err


# --------------------------------------------------------------------------- #
# No target-branch package import
# --------------------------------------------------------------------------- #

def test_script_does_not_import_target_worktree_src(tmp_path: Path) -> None:
    """A malicious src/ in the target worktree must never be imported/run."""
    mod = _load_module()
    text = SCRIPT.read_text(encoding="utf-8")
    # No sys.path injection of a worktree src, no stride_storage import.
    assert "_prepend_worktree_src" not in text
    assert "stride_storage" not in text
    assert "sys.path.insert" not in text


def test_no_azure_references(tmp_path: Path) -> None:
    text = SCRIPT.read_text(encoding="utf-8")
    lowered = text.lower()
    for banned in ("azure", "file.core.windows.net", "defaultazurecredential", "token_intent"):
        assert banned not in lowered, banned


# --------------------------------------------------------------------------- #
# Item 1: target must be untracked + git-ignored before snapshot
# --------------------------------------------------------------------------- #

def _linked_worktree_with_ignore(tmp_path: Path, *, ignore_db: bool = True) -> tuple[Path, Path]:
    """Primary + linked worktree; base commit has data/<UUID>/ dir and, when
    ``ignore_db``, a .gitignore that ignores *.db. Returns (primary, linked)."""
    primary = _init_primary(tmp_path)
    if ignore_db:
        (primary / ".gitignore").write_text("*.db\n", encoding="utf-8")
        _git(primary, "add", ".gitignore")
    keep = primary / "data" / FIXED_UUID
    keep.mkdir(parents=True)
    (keep / ".gitkeep").write_text("", encoding="utf-8")
    _git(primary, "add", f"data/{FIXED_UUID}/.gitkeep")
    _git(primary, "commit", "-m", "base with data dir")
    linked = _add_linked(primary, tmp_path / "linked")
    return primary, linked


def test_target_privacy_rejects_tracked_db(tmp_path: Path) -> None:
    mod = _load_module()
    _primary, linked = _linked_worktree_with_ignore(tmp_path)
    target = linked / "data" / FIXED_UUID / "coros.db"
    _make_db(target, rows=1)
    # Force-track the DB despite the ignore rule (this is the PII leak we reject).
    _git(linked, "add", "-f", f"data/{FIXED_UUID}/coros.db")
    _git(linked, "commit", "-m", "force-track db")

    with pytest.raises(mod.InitializationError):
        mod.assert_target_private(linked, target)


def test_target_privacy_rejects_untracked_but_not_ignored(tmp_path: Path) -> None:
    mod = _load_module()
    # No *.db ignore rule -> an untracked DB is NOT ignored -> reject.
    _primary, linked = _linked_worktree_with_ignore(tmp_path, ignore_db=False)
    target = linked / "data" / FIXED_UUID / "coros.db"
    _make_db(target, rows=1)
    with pytest.raises(mod.InitializationError):
        mod.assert_target_private(linked, target)


def test_target_privacy_allows_untracked_ignored(tmp_path: Path) -> None:
    mod = _load_module()
    _primary, linked = _linked_worktree_with_ignore(tmp_path)
    target = linked / "data" / FIXED_UUID / "coros.db"
    # Absent target is fine (ignored path, untracked).
    mod.assert_target_private(linked, target)  # no raise
    # Present-but-ignored untracked target is also fine.
    _make_db(target, rows=1)
    mod.assert_target_private(linked, target)  # no raise


def test_run_refuses_to_overwrite_tracked_target(tmp_path: Path) -> None:
    """End-to-end: a force-tracked target DB is not overwritten by the primary
    snapshot; run fails closed and the tracked bytes are preserved."""
    mod = _load_module()
    primary, linked = _linked_worktree_with_ignore(tmp_path)
    # Primary source DB (the snapshot source).
    _make_db(primary / "data" / FIXED_UUID / "coros.db", rows=9)
    _seed_aliases(primary)

    target = linked / "data" / FIXED_UUID / "coros.db"
    _make_db(target, rows=1)
    _git(linked, "add", "-f", f"data/{FIXED_UUID}/coros.db")
    _git(linked, "commit", "-m", "force-track db")
    original = target.read_bytes()

    with pytest.raises(mod.InitializationError):
        mod.run(linked)
    assert target.read_bytes() == original  # not overwritten by primary snapshot


# --------------------------------------------------------------------------- #
# Skill contract
# --------------------------------------------------------------------------- #

def test_skill_md_uses_repository_relative_scripts() -> None:
    text = SKILL_MD.read_text(encoding="utf-8")
    assert "CLAUDE_SKILL_DIR" not in text
    assert 'python ".claude/skills/worktree-development/scripts/initialize_worktree.py"' in text
    assert 'python ".claude/skills/worktree-development/scripts/create_worktree.py"' in text


def test_skill_is_self_contained_and_has_no_enterworktree() -> None:
    text = SKILL_MD.read_text(encoding="utf-8")
    assert "不调用、加载或委托任何其他 skill" in text
    assert "EnterWorktree" not in text
    assert "create_worktree.py" in text


def test_skill_md_documents_target_untracked_ignored() -> None:
    text = SKILL_MD.read_text(encoding="utf-8")
    assert "untracked" in text or "未跟踪" in text
    assert "ignore" in text.lower() or "忽略" in text


def test_skill_md_describes_sqlite_backup_from_primary() -> None:
    text = SKILL_MD.read_text(encoding="utf-8")
    lowered = text.lower()
    assert "backup" in lowered
    assert "primary" in lowered or "主" in text
    # No Azure/prod/DAC/RBAC wording remains.
    for banned in ("azure", "rbac", "defaultazurecredential", "file.core.windows.net"):
        assert banned not in lowered, banned
