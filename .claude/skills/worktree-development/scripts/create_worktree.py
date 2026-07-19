#!/usr/bin/env python3
"""Portable, agent-neutral entry point for the ``worktree-development`` skill.

Creates a task-dedicated *linked* git worktree + branch from the launching
checkout, then runs the sibling ``initialize_worktree.py`` to snapshot the
athlete SQLite DB into the new worktree. Emits a machine-readable JSON line
(plus human-readable evidence) describing the new path / branch / base ref.

Design constraints (cross-agent portable — works under any coding agent,
plain shells, and CI):

* Only the Python standard library and the ``git`` CLI are used.
* No editor/agent-specific tool or API is invoked; no higher-level command
  runner is required.
* No network / fetch. Base ref is resolved from local refs only.

Usage::

    python ".claude/skills/worktree-development/scripts/create_worktree.py" <3-5-word-kebab-name>
    python ".claude/skills/worktree-development/scripts/create_worktree.py" <name> --base-ref <ref>

Python 3.12+.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

_SCRIPT_DIR = Path(__file__).resolve().parent
_INITIALIZER = _SCRIPT_DIR / "initialize_worktree.py"

# 3–5 kebab segments; each segment is lowercase alnum, non-empty, starts with a
# letter or digit. No leading/trailing/double dashes, no underscores/spaces.
_NAME_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+){2,4}$")

_BRANCH_PREFIX = "worktree-"
_WORKTREES_DIR = ".worktrees"

Initializer = Callable[[Path], None]


class CreateWorktreeError(RuntimeError):
    """Raised when a worktree cannot be created safely."""


def _configure_utf8_stdio() -> None:
    """Best-effort: force stdout/stderr to UTF-8 so CJK paths never crash.

    Under a cp1252 console a JSON line or error containing non-Latin-1 path
    characters would raise UnicodeEncodeError. ``errors='backslashreplace'``
    keeps human-readable error text robust; the JSON payload is still real
    UTF-8 bytes because the stream encoding is UTF-8.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8", errors="backslashreplace")
            except (ValueError, OSError):  # pragma: no cover - defensive
                pass


# --------------------------------------------------------------------------- #
# Git config isolation (block system/global/env-injected config)
# --------------------------------------------------------------------------- #

# Environment variables that can redirect git's repo discovery, object/index
# location, worktree, config source, or make git run an external command. All
# are stripped from the child git environment; only basic runtime vars (PATH,
# HOME, ...) are kept. Note: this defends against inherited/injected values,
# not against another process owned by the SAME OS user racing us at the
# syscall level (git provides no dir-handle / no-follow primitives).
_GIT_INHERITED_STRIP_EXACT = frozenset({
    # config injection
    "GIT_CONFIG", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM",
    "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS",
    # repo discovery / routing
    "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE",
    "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_PREFIX",
    # attribute / lock / execution surface
    "GIT_ATTR_NOSYSTEM", "GIT_OPTIONAL_LOCKS", "GIT_EXTERNAL_DIFF",
    "GIT_DIFF_OPTS", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS",
    "GIT_TERMINAL_PROMPT", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR",
})
_GIT_CONFIG_INJECTION_PREFIXES = ("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_")

_TRUSTED_GLOBAL_CONFIG: str | None = None


def _trusted_empty_global_config() -> str:
    """Path to a process-lived empty git global config file.

    Used as ``GIT_CONFIG_GLOBAL`` so ``~/.gitconfig`` (which may carry
    ``includeIf``/filter injection) is never read. Created once and kept for the
    whole process lifetime (never deleted mid-run).
    """
    global _TRUSTED_GLOBAL_CONFIG
    if _TRUSTED_GLOBAL_CONFIG is None:
        d = tempfile.mkdtemp(prefix=".wt-empty-global.")
        cfg = Path(d) / "gitconfig"
        cfg.write_text("", encoding="utf-8")
        _TRUSTED_GLOBAL_CONFIG = str(cfg)
    return _TRUSTED_GLOBAL_CONFIG


def _sanitized_git_env(base_env: dict[str, str] | None = None) -> dict[str, str]:
    """A git environment with inherited routing/config/exec vars neutralized.

    Strips every variable that could redirect repo discovery, object/index
    location, worktree, or config source, or make git spawn an external command
    (see ``_GIT_INHERITED_STRIP_EXACT``), plus all ``GIT_CONFIG_KEY_*`` /
    ``GIT_CONFIG_VALUE_*`` injection pairs. Then forbids the system config
    (``GIT_CONFIG_NOSYSTEM=1``) and points the global config at a trusted empty
    file. Basic runtime vars (PATH/HOME/...) are preserved. Repository *local*
    config is still read (git needs it); it is vetted by
    :func:`_assert_local_config_safe`.
    """
    env = dict(os.environ if base_env is None else base_env)
    for key in list(env):
        if key in _GIT_INHERITED_STRIP_EXACT or key.startswith(
            _GIT_CONFIG_INJECTION_PREFIXES
        ):
            del env[key]
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["GIT_CONFIG_GLOBAL"] = _trusted_empty_global_config()
    return env


def _assert_local_config_safe(cwd: Path) -> None:
    """Fail closed on repository-local conditional includes / worktree config.

    With system/global/env config isolated, the remaining vector is
    repository-*local* config. ``include.path`` / ``includeIf.*`` would pull in
    an untrusted file (which could arm a filter that fires inside the new linked
    gitdir), and ``extensions.worktreeConfig`` enables per-worktree config we do
    not vet. This project needs none of them, so reject all. The detection uses
    ``--local --get-regexp`` (which does NOT follow includes — unlike
    ``--includes``) and normalizes case.
    """
    result = _raw_git(
        cwd, "config", "--local", "--name-only", "--get-regexp",
        # Git canonicalizes config section names to lowercase before matching,
        # so the pattern is written in canonical lowercase.
        r"^(include|includeif)\.", check=False,
    )
    for raw in result.stdout.splitlines():
        key = raw.strip().lower()
        if key == "include.path" or key.startswith("includeif."):
            raise CreateWorktreeError(
                "Refusing to proceed: repository-local git config defines an "
                f"include/includeIf ({raw.strip()}). Remove it before creating a "
                "worktree (this skill does not use conditional includes)."
            )
    ext = _raw_git(
        cwd, "config", "--local", "--bool", "--get", "extensions.worktreeConfig",
        check=False,
    )
    if ext.returncode == 0:
        value = ext.stdout.strip().lower()
        # `--bool` normalizes to exactly "true"/"false"; anything else means git
        # could not parse the stored value — fail closed rather than guess.
        if value == "true":
            raise CreateWorktreeError(
                "Refusing to proceed: extensions.worktreeConfig is enabled; "
                "per-worktree config is not vetted by this skill."
            )
        if value != "false":
            raise CreateWorktreeError(
                "Refusing to proceed: extensions.worktreeConfig has a "
                f"non-boolean value ({ext.stdout.strip()!r})."
            )
    elif ext.returncode != 1:
        # rc==1 means the key is absent (safe). Any other failure is unexpected.
        raise CreateWorktreeError(
            "Refusing to proceed: could not read extensions.worktreeConfig "
            f"(git exit {ext.returncode})."
        )


def _is_junction(path: Path) -> bool:
    try:
        return path.is_junction()
    except (OSError, AttributeError):  # pragma: no cover - defensive
        return False


def _is_reparse(path: Path) -> bool:
    """True for symlink or Windows junction/reparse point (uses lstat-style)."""
    return path.is_symlink() or _is_junction(path)


# --------------------------------------------------------------------------- #
# git helpers (UTF-8, argv, no shell)
# --------------------------------------------------------------------------- #

def _raw_git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    """Run git with the sanitized environment (system/global/env config off)."""
    result = subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="strict",
        env=_sanitized_git_env(),
        check=False,
    )
    if check and result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip()
        raise CreateWorktreeError(f"`git {' '.join(args)}` failed: {message}")
    return result


def _run_git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return _raw_git(cwd, *args, check=check)


def _git_out(cwd: Path, *args: str) -> str:
    return _run_git(cwd, *args).stdout.strip()


def _validate_ref_token(ref: str) -> None:
    """Reject option-injection / control chars in an explicit base ref."""
    if ref.startswith("-"):
        raise CreateWorktreeError(
            f"Refusing base ref that looks like an option: {ref!r}."
        )
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in ref):
        raise CreateWorktreeError("Refusing base ref containing control characters.")
    if not ref:
        raise CreateWorktreeError("Empty base ref.")


def primary_root(cwd: Path) -> Path:
    """Locate the primary checkout via the shared git common-dir.

    Only the standard linked-worktree layout is supported, where the common-dir
    is ``<primary>/.git``. Non-standard layouts (e.g. ``--separate-git-dir``)
    fail closed rather than silently creating a worktree in the wrong place.
    """
    raw = _git_out(cwd, "rev-parse", "--git-common-dir")
    common = (Path(cwd) / raw).resolve()
    if common.name != ".git":
        raise CreateWorktreeError(
            "Unsupported git layout: expected the common git dir to be a "
            f"'.git' directory, got {common}. Only standard linked worktrees "
            "are supported."
        )
    return common.parent


# --------------------------------------------------------------------------- #
# Validation / resolution
# --------------------------------------------------------------------------- #

def validate_name(name: str) -> str:
    """Validate a 3–5 word kebab-case task name."""
    if not _NAME_RE.match(name):
        raise CreateWorktreeError(
            f"Invalid task name {name!r}. Use 3–5 lowercase kebab-case words "
            "(e.g. 'fix-training-load-dates'); alnum segments, single dashes, "
            "no leading/trailing/double dashes, no underscores or spaces."
        )
    return name


def resolve_base_ref(cwd: Path, override: str | None) -> str:
    """Resolve the base ref to a fixed commit OID, without any network access.

    Default: the *launching checkout's* current ``HEAD``. An explicit
    ``override`` (validated) takes precedence but is resolved the same way — a
    single ``rev-parse --verify --quiet --end-of-options <ref>^{commit}`` in the
    launch ``cwd`` — so the returned value is always a fixed commit OID (e.g.
    ``--base-ref HEAD`` from a linked worktree pins that worktree's HEAD).
    """
    ref = "HEAD"
    if override is not None:
        _validate_ref_token(override)
        ref = override

    result = _run_git(cwd, "rev-parse", "--verify", "--quiet", "--end-of-options",
                      f"{ref}^{{commit}}", check=False)
    oid = result.stdout.strip()
    if result.returncode != 0 or not oid:
        if override is not None:
            raise CreateWorktreeError(f"Base ref does not exist locally: {override!r}")
        raise CreateWorktreeError("Could not resolve launch checkout HEAD commit.")
    return oid


def _load_initializer() -> Initializer:
    """Load the trusted sibling initializer from this skill's absolute path.

    Deliberately loads from ``_INITIALIZER`` (the skill source next to this
    file), never from the newly created worktree's target branch.
    """
    spec = importlib.util.spec_from_file_location(
        "worktree_initializer", _INITIALIZER
    )
    if spec is None or spec.loader is None:  # pragma: no cover - defensive
        raise CreateWorktreeError(f"Cannot load initializer at {_INITIALIZER}")
    module = importlib.util.module_from_spec(spec)
    # Do not write a bytecode cache into the launching checkout's scripts dir.
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = previous
    return module.run  # type: ignore[no-any-return]


# --------------------------------------------------------------------------- #
# Checkout code-execution surface suppression (hooks + filters + fsmonitor)
# --------------------------------------------------------------------------- #

_FILTER_CFG_RE = re.compile(r"^filter\.(.+)\.(clean|smudge|process|required)$")


def effective_filter_drivers(root: Path) -> set[str]:
    """Names of repository-*local* filter drivers.

    Only local config is read (system/global/env are already isolated by the
    sanitized env), so each configured driver is overridden to passthrough at
    ``git worktree add`` time. A driver only present on the target branch's
    committed config is not applicable — branch content is never config.
    """
    out = _run_git(
        root, "config", "--local", "--name-only", "--get-regexp",
        r"^filter\..*\.(clean|smudge|process|required)$", check=False
    ).stdout
    drivers: set[str] = set()
    for line in out.splitlines():
        match = _FILTER_CFG_RE.match(line.strip())
        if match:
            drivers.add(match.group(1))
    return drivers


def checkout_hardening_flags(root: Path, hooks_dir: str) -> list[str]:
    """`-c` overrides that neutralize hooks, fsmonitor and every filter driver.

    Empty ``clean``/``smudge``/``process`` values are git's passthrough (no
    external process is spawned); ``required=false`` prevents a hard failure.
    ``core.hooksPath`` points at a trusted empty dir so no repo hook runs.
    """
    flags = [
        "-c", f"core.hooksPath={hooks_dir}",
        "-c", "core.fsmonitor=false",
    ]
    for driver in sorted(effective_filter_drivers(root)):
        flags += [
            "-c", f"filter.{driver}.clean=",
            "-c", f"filter.{driver}.smudge=",
            "-c", f"filter.{driver}.process=",
            "-c", f"filter.{driver}.required=false",
        ]
    return flags


# --------------------------------------------------------------------------- #
# Path protection
# --------------------------------------------------------------------------- #

class DirectoryIdentity:
    """A stable identity for a real directory to detect TOCTOU swaps.

    Captures the resolved path plus ``st_dev``/``st_ino`` from an
    ``lstat``-style stat (``follow_symlinks=False``). On platforms where
    ``st_ino`` is unavailable (0), identity comparison falls back to the
    resolved path + a fresh non-reparse/is-dir re-check by the caller.
    """

    __slots__ = ("resolved", "st_dev", "st_ino")

    def __init__(self, resolved: Path, st_dev: int, st_ino: int) -> None:
        self.resolved = resolved
        self.st_dev = st_dev
        self.st_ino = st_ino

    @classmethod
    def capture(cls, path: Path) -> "DirectoryIdentity":
        info = os.stat(str(path), follow_symlinks=False)
        return cls(path.resolve(), info.st_dev, info.st_ino)

    def matches(self, other: "DirectoryIdentity") -> bool:
        if self.resolved != other.resolved:
            return False
        if self.st_ino and other.st_ino:  # inode meaningful on this platform
            return self.st_dev == other.st_dev and self.st_ino == other.st_ino
        return True  # path-only fallback (caller also re-checks reparse/is_dir)


def _assert_same_real_directory(
    parent: Path, identity: DirectoryIdentity, root: Path
) -> None:
    """Re-verify ``parent`` is still the exact real ``<root>/.worktrees`` dir."""
    if not os.path.lexists(str(parent)):
        raise CreateWorktreeError(f"Worktrees dir vanished: {parent}")
    if _is_reparse(parent):
        raise CreateWorktreeError(
            f"Worktrees dir became a symlink/junction: {parent}"
        )
    if not parent.is_dir():
        raise CreateWorktreeError(f"Worktrees dir is no longer a directory: {parent}")
    resolved = parent.resolve()
    root_resolved = root.resolve()
    if resolved != root_resolved / _WORKTREES_DIR:
        raise CreateWorktreeError(
            f"Worktrees dir {resolved} no longer resolves under {root_resolved}."
        )
    current = DirectoryIdentity.capture(parent)
    if not identity.matches(current):
        raise CreateWorktreeError(
            f"Worktrees dir identity changed (possible swap): {parent}"
        )


def _resolve_worktrees_parent(root: Path) -> tuple[Path, DirectoryIdentity]:
    """Return a safe, real ``<root>/.worktrees`` dir plus its captured identity."""
    parent = root / _WORKTREES_DIR
    if os.path.lexists(str(parent)):
        if _is_reparse(parent):
            raise CreateWorktreeError(
                f"Refusing to use a symlink/junction as the worktrees dir: {parent}"
            )
        if not parent.is_dir():
            raise CreateWorktreeError(f"{parent} exists but is not a directory.")
    else:
        parent.mkdir(parents=True, exist_ok=True)
        if _is_reparse(parent):  # re-verify after creation (defensive)
            raise CreateWorktreeError(f"Worktrees dir became a reparse point: {parent}")

    resolved = parent.resolve()
    root_resolved = root.resolve()
    if resolved != root_resolved / _WORKTREES_DIR and root_resolved not in resolved.parents:
        raise CreateWorktreeError(
            f"Worktrees dir {resolved} escapes the primary root {root_resolved}."
        )
    return parent, DirectoryIdentity.capture(parent)


# --------------------------------------------------------------------------- #
# Core
# --------------------------------------------------------------------------- #

def _branch_exists(root: Path, branch: str) -> bool:
    return _run_git(
        root, "show-ref", "--verify", "--quiet", f"refs/heads/{branch}", check=False
    ).returncode == 0


def _registered_worktree_paths(root: Path) -> list[Path]:
    """Absolute paths of all registered worktrees, parsed exactly.

    Prefers NUL-delimited porcelain (``--porcelain -z``) when the local git
    supports it; otherwise falls back to line-based porcelain, taking only the
    strict ``worktree `` records. Never substring-matches the raw output.
    """
    z = _run_git(root, "worktree", "list", "--porcelain", "-z", check=False)
    paths: list[Path] = []
    if z.returncode == 0 and "\x00" in z.stdout:
        # Records are separated by NUL; each attribute line is also NUL-ended.
        for field in z.stdout.split("\x00"):
            if field.startswith("worktree "):
                paths.append(Path(field[len("worktree "):]))
        return paths
    listed = _run_git(root, "worktree", "list", "--porcelain", check=False).stdout
    for line in listed.splitlines():
        if line.startswith("worktree "):
            paths.append(Path(line[len("worktree "):]))
    return paths


def _canonical(path: Path) -> str:
    return os.path.normcase(str(path.resolve()))


def _worktree_registered(root: Path, path: Path) -> bool:
    """True iff ``path`` is registered as a worktree (exact path, no prefix)."""
    target = _canonical(path)
    return any(_canonical(p) == target for p in _registered_worktree_paths(root))


def create_worktree(
    *,
    name: str,
    cwd: Path,
    base_ref: str | None,
    initializer: Initializer | None = None,
) -> dict[str, str]:
    """Create the worktree + branch and run the initializer. Fail closed.

    On initializer failure (load or run) the worktree and branch are
    intentionally KEPT (no force removal) so no work/data is lost; a
    ``CreateWorktreeError`` with recovery guidance is raised. If the
    ``git worktree add`` itself fails, this attempt's branch is rolled back on a
    best-effort basis; should the rollback delete fail (e.g. a stale ref lock),
    the raised error explicitly reports the orphan branch and the manual
    cleanup command.
    """
    validate_name(name)
    root = primary_root(cwd)
    _assert_local_config_safe(root)
    resolved_base = resolve_base_ref(cwd, base_ref)

    branch = f"{_BRANCH_PREFIX}{name}"
    parent, parent_identity = _resolve_worktrees_parent(root)
    expected_parent_resolved = parent_identity.resolved
    new_path = parent / name

    if os.path.lexists(str(new_path)):
        raise CreateWorktreeError(
            f"Refusing to reuse an existing path: {new_path}. "
            "Pick a different task name."
        )
    if _branch_exists(root, branch):
        raise CreateWorktreeError(
            f"Refusing to reuse an existing branch: {branch}. "
            "Pick a different task name."
        )

    # Re-verify the parent directory identity immediately before creating the
    # branch (guards against a swap between resolution and use).
    _assert_same_real_directory(parent, parent_identity, root)

    # A single trusted empty hooks dir + hardening flag set spans every git
    # ref/checkout mutation below (branch create, worktree add, rollback delete)
    # so configured hooks — including reference-transaction — and filter drivers
    # never execute. Local config was already asserted safe, and the effective
    # filter set is computed exactly once here.
    with tempfile.TemporaryDirectory(prefix=".wt-empty-hooks.") as empty_hooks:
        flags = checkout_hardening_flags(root, empty_hooks)

        def _rollback_branch() -> bool:
            """Best-effort delete of this attempt's branch.

            Returns True if, afterwards, no orphan branch remains (either the
            branch was deleted, never existed, or is legitimately backing a
            worktree so we must not touch it). Returns False if the branch still
            exists after a delete attempt (delete failed — e.g. a stale ref
            ``.lock``), signalling the caller to report an orphan.
            """
            if not _branch_exists(root, branch):
                return True
            if _worktree_registered(root, new_path):
                # Branch legitimately backs the worktree; not an orphan to remove.
                return True
            deleted = _run_git(root, *flags, "branch", "-D", "--", branch, check=False)
            still_present = _branch_exists(root, branch)
            return deleted.returncode == 0 and not still_present

        def _orphan_suffix() -> str:
            return (
                f"\nOrphan branch remains: {branch}. Rollback could not remove "
                "it (a stale ref lock or concurrent access). Remove it manually "
                f"with:\n  git -C \"{root}\" branch -D {branch}"
            )

        # Create the branch first, then add the worktree. Splitting the two lets
        # us roll back an orphan branch if `worktree add` fails, while keeping a
        # fully created worktree+branch intact when only initialization fails.
        _run_git(root, *flags, "branch", "--", branch, resolved_base)

        # Re-verify the parent identity right before the checkout writes into it.
        try:
            _assert_same_real_directory(parent, parent_identity, root)
        except CreateWorktreeError as error:
            if _rollback_branch():
                raise
            raise CreateWorktreeError(str(error) + _orphan_suffix()) from error

        add = _run_git(
            root, *flags, "worktree", "add", "--", str(new_path), branch, check=False
        )
        if add.returncode != 0:
            message = add.stderr.strip() or add.stdout.strip()
            base_msg = f"`git worktree add` failed: {message}"
            if _rollback_branch():
                raise CreateWorktreeError(base_msg)
            raise CreateWorktreeError(base_msg + _orphan_suffix())

        # Post-add: verify the parent identity is unchanged, that the new
        # worktree resolves under the expected real parent, and that git
        # registered exactly that path. Only then is it safe to run the
        # initializer / return success.
        resolved_new = new_path.resolve()
        try:
            _assert_same_real_directory(parent, parent_identity, root)
            if resolved_new.parent != expected_parent_resolved:
                raise CreateWorktreeError(
                    "New worktree does not resolve under the expected parent "
                    f"({resolved_new.parent} != {expected_parent_resolved})."
                )
            if not _worktree_registered(root, new_path):
                raise CreateWorktreeError(
                    "git did not register the new worktree at the expected path."
                )
        except CreateWorktreeError as error:
            # Best-effort swap detection: git provides no dir-handle / no-follow
            # primitive, so a process owned by the SAME OS user can still win a
            # syscall-window race (explicitly out of scope: detection only). We
            # detect an unexpected directory replacement and stop; we do NOT
            # claim to prevent an outside write, and we never follow an attacker
            # symlink to delete anything. Only a provably-unused branch is rolled
            # back. If a worktree is registered at an unexpected location, keep it
            # and the branch and report a critical state for manual review.
            if not _worktree_registered(root, new_path):
                if _rollback_branch():
                    raise
                raise CreateWorktreeError(str(error) + _orphan_suffix()) from error
            raise CreateWorktreeError(
                f"CRITICAL: worktree add for branch {branch} completed but the "
                "target directory identity is inconsistent (possible symlink "
                "swap). NOT auto-removing anything to avoid acting on an "
                f"attacker-controlled path. Inspect manually. Underlying: {error}"
            ) from error

    try:
        run_init = initializer if initializer is not None else _load_initializer()
        run_init(resolved_new)
    except BaseException as error:  # noqa: BLE001 - keep worktree, surface safely
        raise CreateWorktreeError(
            f"Worktree created at {resolved_new} (branch {branch}) but "
            f"initialization failed ({type(error).__name__}). The worktree and "
            "branch were preserved to avoid data loss. Inspect it, then if you "
            "want to discard it run:\n"
            f"  git -C \"{root}\" worktree remove \"{resolved_new}\"\n"
            f"  git -C \"{root}\" branch -D {branch}"
        ) from error

    return {
        "worktree_path": str(resolved_new),
        "branch": branch,
        "base_ref": resolved_base,
    }


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def main(
    argv: list[str] | None = None,
    *,
    cwd: Path | None = None,
    initializer: Initializer | None = None,
) -> int:
    parser = argparse.ArgumentParser(
        description="Create a task-dedicated linked git worktree (portable)."
    )
    parser.add_argument("name", help="3–5 word kebab-case task name")
    parser.add_argument(
        "--base-ref",
        default=None,
        help="Optional explicit base ref; normal flow auto-resolves from local refs.",
    )
    args = parser.parse_args(argv)

    _configure_utf8_stdio()
    try:
        result = create_worktree(
            name=args.name,
            cwd=cwd or Path.cwd(),
            base_ref=args.base_ref,
            initializer=initializer,
        )
    except CreateWorktreeError as error:
        print(f"create_worktree failed: {error}", file=sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001 - type-only sanitized fallback
        print(
            "create_worktree failed: unexpected error "
            f"({type(error).__name__}).",
            file=sys.stderr,
        )
        return 1

    print(f"created worktree: {result['worktree_path']}")
    print(f"branch: {result['branch']} (base {result['base_ref']})")
    # Stable single-line JSON as the LAST stdout line.
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
