#!/usr/bin/env python3
"""Worktree initialization gate + athlete DB snapshot for ``worktree-development``.

Invoked by the portable ``create_worktree.py`` entry point (or standalone for
diagnostics) after a fresh linked git worktree has been created, via::

    python ".claude/skills/worktree-development/scripts/initialize_worktree.py"

Behaviour (fail closed at every step):

1. Verify the current working directory is a *linked* git worktree with a
   clean initial working tree; emit evidence.
2. Locate the *primary* checkout of the SAME repository (shared git
   common-dir) and require its ``data/.slug_aliases.json`` to map the fixed
   slug to the pinned UUID (the primary checkout is the source of truth).
3. Snapshot the athlete SQLite DB from the primary checkout into this
   worktree's canonical ``data/<UUID>/coros.db`` using the stdlib ``sqlite3``
   online backup API, so an active WAL is captured as a transactionally
   consistent copy without mutating or checkpointing the source.

No cloud services, no network, no project package import. Only the Python
standard library is required. The snapshot does not change the source
database's logical content (main + WAL) and never checkpoints it; a SQLite
read-only WAL reader may create or update a transient ``-shm`` file for reader
coordination. An existing target is only replaced after the snapshot
validates. Python 3.12+.
"""

from __future__ import annotations

import os
import re
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

# --- Fixed, non-overridable identity (verified constant) -------------------- #
SLUG = "zhaochaoyi"
FIXED_UUID = "f10bc353-01ab-4db1-af9f-d9305ea9a532"

# SQLite header + a conservative minimum size for a real DB (header page).
_SQLITE_MAGIC = b"SQLite format 3\x00"
_MIN_DB_BYTES = 512

_SIDECAR_SUFFIXES = ("-wal", "-shm", "-journal")


class InitializationError(RuntimeError):
    """Raised when initialization cannot proceed safely."""


def _configure_utf8_stdio() -> None:
    """Best-effort: force stdout/stderr to UTF-8 so CJK paths never crash.

    Under a cp1252 console (Windows default) printing evidence or a JSON line
    that contains non-Latin-1 path characters would raise UnicodeEncodeError.
    ``errors='backslashreplace'`` keeps human-readable error text robust; the
    JSON payload is still real UTF-8 bytes because the stream encoding is UTF-8.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="backslashreplace")
            except (ValueError, OSError):  # pragma: no cover - defensive
                pass


# --------------------------------------------------------------------------- #
# Git gate (UTF-8 decoding — git always emits UTF-8 paths)
# --------------------------------------------------------------------------- #

_FILTER_CFG_RE = re.compile(r"^filter\.(.+)\.(clean|smudge|process|required)$")
_EMPTY_HOOKS_DIR: str | None = None
_TRUSTED_GLOBAL_CONFIG: str | None = None

# Environment variables that can redirect git's repo discovery, object/index
# location, worktree, config source, or make git run an external command.
_GIT_INHERITED_STRIP_EXACT = frozenset({
    "GIT_CONFIG", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS",
    "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_PREFIX",
    "GIT_ATTR_NOSYSTEM", "GIT_OPTIONAL_LOCKS", "GIT_EXTERNAL_DIFF",
    "GIT_DIFF_OPTS", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS",
    "GIT_TERMINAL_PROMPT", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR",
})
_GIT_CONFIG_INJECTION_PREFIXES = ("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_")


def _trusted_empty_global_config() -> str:
    """Process-lived empty git global config (blocks ``~/.gitconfig`` includes)."""
    global _TRUSTED_GLOBAL_CONFIG
    if _TRUSTED_GLOBAL_CONFIG is None:
        d = tempfile.mkdtemp(prefix=".wt-init-empty-global.")
        cfg = Path(d) / "gitconfig"
        cfg.write_text("", encoding="utf-8")
        _TRUSTED_GLOBAL_CONFIG = str(cfg)
    return _TRUSTED_GLOBAL_CONFIG


def _sanitized_git_env(base_env: dict[str, str] | None = None) -> dict[str, str]:
    """git env with inherited routing/config/exec vars neutralized."""
    env = dict(os.environ if base_env is None else base_env)
    for key in list(env):
        if key in _GIT_INHERITED_STRIP_EXACT or key.startswith(
            _GIT_CONFIG_INJECTION_PREFIXES
        ):
            del env[key]
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["GIT_CONFIG_GLOBAL"] = _trusted_empty_global_config()
    return env


def _empty_hooks_dir() -> str:
    """A process-wide trusted empty directory used for ``core.hooksPath``."""
    global _EMPTY_HOOKS_DIR
    if _EMPTY_HOOKS_DIR is None:
        _EMPTY_HOOKS_DIR = tempfile.mkdtemp(prefix=".wt-init-empty-hooks.")
    return _EMPTY_HOOKS_DIR


def _raw_git(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="strict",
        env=_sanitized_git_env(),
        check=False,
    )


def _assert_local_config_safe(cwd: Path) -> None:
    """Fail closed on repository-local conditional includes / worktree config.

    Uses ``--local --get-regexp`` (does NOT follow includes, unlike
    ``--includes``); case-insensitive.
    """
    result = _raw_git(
        cwd, "config", "--local", "--name-only", "--get-regexp",
        # Git canonicalizes config section names to lowercase before matching.
        r"^(include|includeif)\.",
    )
    for raw in result.stdout.splitlines():
        key = raw.strip().lower()
        if key == "include.path" or key.startswith("includeif."):
            raise InitializationError(
                "Refusing to proceed: repository-local git config defines an "
                f"include/includeIf ({raw.strip()})."
            )
    ext = _raw_git(
        cwd, "config", "--local", "--bool", "--get", "extensions.worktreeConfig"
    )
    if ext.returncode == 0:
        value = ext.stdout.strip().lower()
        # `--bool` normalizes to exactly "true"/"false"; anything else means git
        # could not parse the stored value — fail closed rather than guess.
        if value == "true":
            raise InitializationError(
                "Refusing to proceed: extensions.worktreeConfig is enabled."
            )
        if value != "false":
            raise InitializationError(
                "Refusing to proceed: extensions.worktreeConfig has a "
                f"non-boolean value ({ext.stdout.strip()!r})."
            )
    elif ext.returncode != 1:
        raise InitializationError(
            "Refusing to proceed: could not read extensions.worktreeConfig "
            f"(git exit {ext.returncode})."
        )


def _effective_filter_drivers(cwd: Path) -> set[str]:
    # Local-only: system/global/env are isolated by the sanitized env.
    out = _raw_git(
        cwd, "config", "--local", "--name-only", "--get-regexp",
        r"^filter\..*\.(clean|smudge|process|required)$",
    ).stdout
    drivers: set[str] = set()
    for line in out.splitlines():
        match = _FILTER_CFG_RE.match(line.strip())
        if match:
            drivers.add(match.group(1))
    return drivers


def _safe_git_prefix(cwd: Path) -> list[str]:
    """`-c` overrides that disable hooks, fsmonitor and all filter drivers.

    Ensures no configured checkout hook / fsmonitor / clean|smudge|process
    filter can execute as a side effect of the initializer's own git commands.
    """
    prefix = ["-c", f"core.hooksPath={_empty_hooks_dir()}", "-c", "core.fsmonitor=false"]
    for driver in sorted(_effective_filter_drivers(cwd)):
        prefix += [
            "-c", f"filter.{driver}.clean=",
            "-c", f"filter.{driver}.smudge=",
            "-c", f"filter.{driver}.process=",
            "-c", f"filter.{driver}.required=false",
        ]
    return prefix


def _run_git(cwd: Path, *args: str) -> str:
    result = _raw_git(cwd, *_safe_git_prefix(cwd), *args)
    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip()
        raise InitializationError(f"`git {' '.join(args)}` failed: {message}")
    return result.stdout


def _run_git_raw(cwd: Path, *args: str) -> subprocess.CompletedProcess[str]:
    """Hardened git (sanitized env + hooks/filter suppression) without raising."""
    return _raw_git(cwd, *_safe_git_prefix(cwd), *args)


def git_toplevel(cwd: Path) -> Path:
    """Absolute path of the current worktree's top level."""
    return Path(_run_git(cwd, "rev-parse", "--show-toplevel").strip()).resolve()


def git_common_dir(cwd: Path) -> Path:
    """Absolute path of the shared git common-dir for this repository.

    Git may return a path relative to ``cwd`` (e.g. ``.git`` from the primary
    checkout), so resolve it against ``cwd`` rather than the process cwd.
    """
    raw = _run_git(cwd, "rev-parse", "--git-common-dir").strip()
    return (Path(cwd) / raw).resolve()


def _git_dir(cwd: Path) -> Path:
    raw = _run_git(cwd, "rev-parse", "--git-dir").strip()
    return (Path(cwd) / raw).resolve()


def ensure_inside_worktree(cwd: Path) -> None:
    if _run_git(cwd, "rev-parse", "--is-inside-work-tree").strip() != "true":
        raise InitializationError("Current directory is not inside a git working tree.")


def ensure_linked_worktree(cwd: Path) -> None:
    """Fail unless the cwd's worktree is a *linked* (non-primary) worktree."""
    common_dir = git_common_dir(cwd)
    git_dir = _git_dir(cwd)
    is_linked = git_dir != common_dir and common_dir in git_dir.parents
    if not is_linked:
        raise InitializationError(
            "Current worktree is the primary checkout, not a linked worktree. "
            "Create a dedicated worktree via create_worktree.py first."
        )


def ensure_clean_worktree(cwd: Path) -> None:
    _assert_local_config_safe(cwd)
    porcelain = _run_git(cwd, "status", "--porcelain")
    if porcelain.strip():
        raise InitializationError(
            "Worktree is not clean at initialization; refusing to proceed. "
            "Not cleaning or overwriting anything. Offending entries:\n"
            + porcelain.rstrip()
        )


def emit_evidence(cwd: Path) -> None:
    for command, args in (
        ("git worktree list", ("worktree", "list")),
        ("git status --short --branch", ("status", "--short", "--branch")),
        ("git rev-parse --show-toplevel", ("rev-parse", "--show-toplevel")),
    ):
        print(f"$ {command}")
        print(_run_git(cwd, *args).rstrip())
        print()


# --------------------------------------------------------------------------- #
# Primary checkout location
# --------------------------------------------------------------------------- #

def primary_from_porcelain(porcelain: str, common_dir: Path) -> Path:
    """Return the primary checkout root from ``git worktree list --porcelain``.

    The primary (main) checkout is the entry whose ``<path>/.git`` is the
    repository's git common-dir (a real directory), as opposed to linked
    worktrees whose ``.git`` is a file pointing into ``<common>/worktrees/``.
    Falls back to ``common_dir.parent`` when the common-dir is a ``.git`` dir.
    """
    common_dir = common_dir.resolve()
    candidates: list[Path] = []
    for block in porcelain.split("\n\n"):
        for line in block.splitlines():
            if line.startswith("worktree "):
                candidates.append(Path(line[len("worktree "):]).resolve())
                break
    for candidate in candidates:
        if (candidate / ".git").resolve() == common_dir:
            return candidate
    # Fallback: a standard layout keeps the common-dir at ``<primary>/.git``.
    if common_dir.name == ".git":
        parent = common_dir.parent.resolve()
        if not candidates or parent in candidates:
            return parent
    raise InitializationError(
        "Could not identify the primary checkout from `git worktree list`."
    )


def locate_primary_checkout(cwd: Path) -> Path:
    """Locate the primary checkout that shares this worktree's git common-dir."""
    common_dir = git_common_dir(cwd)
    porcelain = _run_git(cwd, "worktree", "list", "--porcelain")
    primary = primary_from_porcelain(porcelain, common_dir)
    # Defensive: the primary must genuinely share our common-dir.
    if git_common_dir(primary) != common_dir:
        raise InitializationError(
            "Located candidate does not share the current repository's git dir."
        )
    return primary


# --------------------------------------------------------------------------- #
# Identity / path resolution
# --------------------------------------------------------------------------- #

def resolve_fixed_uuid(primary_root: Path) -> str:
    """Require ``data/.slug_aliases.json`` (primary) to map SLUG -> FIXED_UUID."""
    import json

    aliases_path = primary_root / "data" / ".slug_aliases.json"
    if not aliases_path.is_file():
        raise InitializationError(f"Slug alias file not found: {aliases_path}")
    try:
        aliases = json.loads(aliases_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise InitializationError(f"Could not parse {aliases_path}: {error}") from error
    if aliases.get(SLUG) != FIXED_UUID:
        raise InitializationError(
            f"Slug '{SLUG}' does not map to the pinned UUID in {aliases_path}. "
            "Refusing to proceed."
        )
    return FIXED_UUID


def _is_junction(path: Path) -> bool:
    try:
        return path.is_junction()
    except (OSError, AttributeError):  # pragma: no cover - defensive
        return False


def _reject_reparse(path: Path, label: str) -> None:
    if path.is_symlink() or _is_junction(path):
        raise InitializationError(f"Refusing to follow a symlink/junction {label}: {path}")


def resolve_source_db_path(primary_root: Path, uuid: str) -> Path:
    """Resolve + protect the source DB at ``<primary>/data/<UUID>/coros.db``.

    Every ancestor (``data``, the UUID dir) and the DB itself is rejected if it
    is a symlink/junction, and the fully-resolved DB must stay contained within
    the resolved primary root (a ``data`` symlink pointing outside the repo is
    refused).
    """
    primary_root = primary_root.resolve()
    data_dir = primary_root / "data"
    _reject_reparse(data_dir, "source data dir")
    if not data_dir.is_dir():
        raise InitializationError(f"Source data directory missing: {data_dir}")

    parent = data_dir / uuid
    _reject_reparse(parent, "source dir")
    if not parent.is_dir():
        raise InitializationError(f"Source data directory missing: {parent}")

    db = parent / "coros.db"
    _reject_reparse(db, "source DB")
    if not db.is_file():
        raise InitializationError(f"Source athlete DB not found: {db}")
    if db.stat().st_size == 0:
        raise InitializationError(f"Source athlete DB is empty (0 bytes): {db}")

    resolved_db = db.resolve()
    if primary_root not in resolved_db.parents:
        raise InitializationError(
            f"Source DB {resolved_db} escapes the primary checkout {primary_root}."
        )
    return db


def resolve_target_db_path(repo_root: Path, uuid: str) -> Path:
    """Resolve + protect the canonical target under the current worktree."""
    repo_root = repo_root.resolve()
    data_dir = repo_root / "data"
    _reject_reparse(data_dir, "target data dir")
    parent = data_dir / uuid
    _reject_reparse(parent, "target dir")
    if not parent.is_dir():
        raise InitializationError(
            f"Canonical data directory does not exist as a real directory: {parent}"
        )
    resolved_parent = parent.resolve()
    if repo_root != resolved_parent and repo_root not in resolved_parent.parents:
        raise InitializationError(
            f"Target directory {resolved_parent} escapes the repository {repo_root}."
        )
    target = parent / "coros.db"
    _reject_reparse(target, "target DB")
    if target.exists() and not target.is_file():
        raise InitializationError(f"Target exists but is not a regular file: {target}")
    return target


def assert_target_private(worktree_cwd: Path, target: Path) -> None:
    """Fail closed unless the canonical target is untracked AND git-ignored.

    The athlete DB is PII and must never become a tracked modification. Using
    the sanitized/hardened git (no hooks/filters/includes; local config safety
    was already asserted), from the *target worktree*:

    * ``git ls-files --error-unmatch -- <rel>`` rc0 => tracked  => reject.
    * ``git check-ignore -q -- <rel>``          rc0 => ignored  => allow;
      anything else (missing ``*.db`` ignore rule) => reject.

    Runs before the snapshot writes anything.
    """
    top = git_toplevel(worktree_cwd)
    try:
        rel = target.resolve().relative_to(top).as_posix()
    except ValueError as error:
        raise InitializationError(
            f"Target {target} is not inside the worktree {top}."
        ) from error

    tracked = _run_git_raw(
        worktree_cwd, "ls-files", "--error-unmatch", "--", rel
    )
    if tracked.returncode == 0:
        raise InitializationError(
            f"Refusing to overwrite a git-tracked target ({rel}); the athlete "
            "DB must stay untracked to avoid committing PII. Untrack it "
            "(git rm --cached) and ensure it is git-ignored."
        )

    ignored = _run_git_raw(worktree_cwd, "check-ignore", "-q", "--", rel)
    if ignored.returncode != 0:
        raise InitializationError(
            f"Refusing to write an un-ignored target ({rel}); add a '*.db' (or "
            "equivalent) ignore rule so the athlete DB is never committed."
        )


# --------------------------------------------------------------------------- #
# Sidecar fail-closed (lexists-based: also catches dangling symlinks)
# --------------------------------------------------------------------------- #

def target_sidecar_paths(target: Path) -> list[Path]:
    return [target.parent / (target.name + suffix) for suffix in _SIDECAR_SUFFIXES]


def _lexists(path: Path) -> bool:
    # os.path.lexists returns True for dangling symlinks too (unlike exists()).
    return os.path.lexists(str(path))


def ensure_no_target_sidecars(target: Path) -> None:
    present = [p.name for p in target_sidecar_paths(target) if _lexists(p)]
    if present:
        raise InitializationError(
            "Refusing to touch the DB: WAL/SHM/journal sidecar(s) present "
            f"({', '.join(present)}). Not deleting or replacing anything."
        )


# --------------------------------------------------------------------------- #
# SQLite validation
# --------------------------------------------------------------------------- #

def _validate_sqlite(path: Path) -> None:
    size = path.stat().st_size
    if size < _MIN_DB_BYTES:
        raise InitializationError(
            f"Snapshot is too small to be a valid SQLite DB ({size} bytes)."
        )
    with path.open("rb") as handle:
        header = handle.read(len(_SQLITE_MAGIC))
    if header != _SQLITE_MAGIC:
        raise InitializationError("Snapshot is not a SQLite database (bad magic).")

    # ``Path.as_uri()`` percent-encodes '#', '%', spaces, drive letters and CJK
    # correctly (a raw ``file:{posix}`` would let '#' start a fragment).
    uri = path.resolve().as_uri() + "?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True)
        try:
            rows = list(conn.execute("PRAGMA integrity_check"))
        finally:
            conn.close()
    except sqlite3.Error as error:
        raise InitializationError(
            f"SQLite validation failed ({type(error).__name__})."
        ) from error
    if rows != [("ok",)]:
        raise InitializationError("SQLite integrity_check did not return a clean 'ok'.")


# --------------------------------------------------------------------------- #
# Snapshot via sqlite3 online backup
# --------------------------------------------------------------------------- #

def _backup_to(source: Path, dest_file: Path) -> None:
    """WAL-consistent snapshot of ``source`` into ``dest_file`` (a fresh DB).

    Opens the source read-only (``mode=ro`` — NOT immutable, so the WAL is
    read). The snapshot does not change the source database's logical content,
    does not checkpoint it, and does not delete its main/WAL files. (A SQLite
    read-only WAL reader may create or update a transient ``-shm`` for reader
    coordination; that is expected and harmless.)

    The destination is forced into ``journal_mode=DELETE`` *after* the backup
    and the result is verified, so the produced file carries no persistent
    ``-wal``/``-shm`` and a first plain read-only open won't spawn one.
    """
    src_uri = source.resolve().as_uri() + "?mode=ro"
    src = sqlite3.connect(src_uri, uri=True)
    try:
        dst = sqlite3.connect(dest_file)
        try:
            src.backup(dst)
            mode = dst.execute("PRAGMA journal_mode=DELETE").fetchone()
            dst.commit()
            if not mode or str(mode[0]).lower() != "delete":
                raise InitializationError(
                    f"Snapshot destination is not in DELETE journal mode: {mode}."
                )
        finally:
            dst.close()
    finally:
        src.close()


def snapshot_db(*, source: Path, target: Path) -> None:
    """Snapshot ``source`` -> ``target`` atomically, validated, fail-closed.

    Fail closed on existing WAL/SHM/journal (or dangling links) at the target,
    checked before and again just before the atomic replace. Uses an exclusive
    temp subdirectory in the target's parent so no stray file can race the
    swap; the source's logical content (main + WAL) is not modified (a
    transient ``-shm`` may be created/updated by the read-only WAL reader).
    """
    ensure_no_target_sidecars(target)

    tmp_dir = tempfile.mkdtemp(dir=str(target.parent), prefix=".coros.snapshot.")
    tmp_dir_path = Path(tmp_dir)
    tmp_db = tmp_dir_path / "coros.db"
    try:
        _reject_reparse(tmp_dir_path, "snapshot temp dir")
        _backup_to(source, tmp_db)

        # Destination must not carry sidecars after backup+close.
        for suffix in _SIDECAR_SUFFIXES:
            if _lexists(tmp_db.parent / (tmp_db.name + suffix)):
                raise InitializationError(
                    "Snapshot unexpectedly produced a WAL/SHM/journal sidecar."
                )

        _validate_sqlite(tmp_db)

        # Restrict the snapshot (athlete PII) to owner-only before publishing.
        # No-op-safe on Windows (mode bits are largely ignored there).
        try:
            os.chmod(tmp_db, 0o600)
        except OSError:  # pragma: no cover - non-POSIX / unusual FS
            pass

        # Durably flush the snapshot file to disk before the atomic swap.
        # Open read-write (no truncate) so fsync is valid on Windows too.
        with tmp_db.open("rb+") as handle:
            handle.flush()
            os.fsync(handle.fileno())

        ensure_no_target_sidecars(target)
        os.replace(tmp_db, target)
    except InitializationError:
        raise
    except Exception as error:  # noqa: BLE001 - sanitize sqlite/os errors
        raise InitializationError(
            f"Failed to snapshot athlete DB ({type(error).__name__})."
        ) from error
    finally:
        _rmtree_quiet(tmp_dir_path)


def _rmtree_quiet(path: Path) -> None:
    import shutil

    try:
        shutil.rmtree(path, ignore_errors=True)
    except OSError:  # pragma: no cover - defensive
        pass


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #

def run(cwd: Path) -> None:
    ensure_inside_worktree(cwd)
    ensure_linked_worktree(cwd)
    # Assert repository-local git config is safe (no include/includeIf/worktree
    # config) BEFORE any status/evidence git command, so an armed clean/smudge
    # filter pulled in via include.path can never execute. This uses a raw,
    # config-only git call under the sanitized env (no include expansion).
    _assert_local_config_safe(cwd)
    # Now emit diagnostic evidence before the clean gate so it is always
    # available (e.g. to debug a rejected dirty tree), then enforce the gate.
    emit_evidence(cwd)
    ensure_clean_worktree(cwd)

    repo_root = git_toplevel(cwd)
    primary_root = locate_primary_checkout(cwd)

    uuid = resolve_fixed_uuid(primary_root)
    source = resolve_source_db_path(primary_root, uuid)
    target = resolve_target_db_path(repo_root, uuid)

    # The target DB is PII: refuse unless it is untracked AND git-ignored, so a
    # snapshot can never become a tracked modification. Runs before any write.
    assert_target_private(cwd, target)

    snapshot_db(source=source, target=target)
    print(f"athlete DB snapshotted from primary checkout to {target}")


def main() -> int:
    _configure_utf8_stdio()
    try:
        run(Path.cwd())
    except InitializationError as error:
        print(f"worktree initialization failed: {error}", file=sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001 - map any error safely, no leak
        print(
            "worktree initialization failed: unexpected error during "
            f"initialization ({type(error).__name__}).",
            file=sys.stderr,
        )
        return 1
    print("worktree initialization gate passed: clean linked worktree, DB snapshotted.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
