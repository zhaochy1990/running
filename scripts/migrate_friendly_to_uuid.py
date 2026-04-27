"""Migrate data/{slug}/ directories to data/{uuid}/ using JWT sub UUIDs.

Usage:
    export STRIDE_ADMIN_TOKEN=<admin-jwt>
    python scripts/migrate_friendly_to_uuid.py \
        --auth-url https://auth-backend.xxx.azurecontainerapps.io \
        --data-dir data \
        [--dry-run] \
        [--mapping mapping.json]

The script is SAFE BY DEFAULT: it only prints a plan unless --dry-run is
omitted and you explicitly confirm. Run with --dry-run first.

The admin token is read (in this order) from:
  1. ``--admin-token-env <ENV_NAME>`` (default ``STRIDE_ADMIN_TOKEN``)
  2. interactive ``getpass`` prompt

``--auth-url`` must be HTTPS unless ``--allow-insecure`` is passed.

IMPORTANT: Do NOT run this against real data without a backup.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def is_uuid4(s: str) -> bool:
    return bool(_UUID4_RE.match(s))


def resolve_uuid_via_api(auth_url: str, admin_token: str, email: str) -> str | None:
    """Call GET /admin/users?email=<email> and return the user's UUID (sub)."""
    try:
        import requests
    except ImportError:
        import urllib.request, urllib.parse  # noqa: E401

        url = f"{auth_url.rstrip('/')}/admin/users?{urllib.parse.urlencode({'email': email})}"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {admin_token}"})
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
    else:
        url = f"{auth_url.rstrip('/')}/admin/users"
        resp = requests.get(
            url,
            params={"email": email},
            headers={"Authorization": f"Bearer {admin_token}"},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()

    # Auth service returns a list or a single-user envelope; handle both shapes.
    if isinstance(data, list):
        users = data
    elif isinstance(data, dict) and "users" in data:
        users = data["users"]
    elif isinstance(data, dict) and "id" in data:
        users = [data]
    else:
        users = []

    for user in users:
        if user.get("email", "").lower() == email.lower():
            return user.get("id") or user.get("sub")
    return None


def load_slug_aliases(data_dir: Path) -> dict[str, str]:
    aliases_file = data_dir / ".slug_aliases.json"
    if aliases_file.exists():
        return json.loads(aliases_file.read_text(encoding="utf-8"))
    return {}


def save_slug_aliases(data_dir: Path, aliases: dict[str, str]) -> None:
    aliases_file = data_dir / ".slug_aliases.json"
    aliases_file.write_text(json.dumps(aliases, indent=2), encoding="utf-8")


def ensure_profile_json(slug_dir: Path, slug: str) -> dict:
    profile_file = slug_dir / "profile.json"
    if profile_file.exists():
        profile = json.loads(profile_file.read_text(encoding="utf-8"))
    else:
        profile = {}
    if not profile.get("display_name"):
        profile["display_name"] = slug
    return profile


def write_profile_json(target_dir: Path, profile: dict) -> None:
    profile_file = target_dir / "profile.json"
    profile_file.write_text(json.dumps(profile, indent=2), encoding="utf-8")


def migrate(
    auth_url: str | None,
    admin_token: str | None,
    data_dir: Path,
    dry_run: bool,
    explicit_mapping: dict[str, str],
) -> int:
    """Perform the migration. Returns number of dirs migrated (or planned)."""
    if not data_dir.exists():
        print(f"ERROR: data dir does not exist: {data_dir}", file=sys.stderr)
        return 0

    subdirs = [d for d in data_dir.iterdir() if d.is_dir() and not d.name.startswith(".")]
    friendly_dirs = [d for d in subdirs if not is_uuid4(d.name)]

    if not friendly_dirs:
        print("Nothing to migrate — all dirs already use UUID names.")
        return 0

    aliases = load_slug_aliases(data_dir)
    plan: list[tuple[Path, str, dict]] = []  # (src_dir, target_uuid, profile)

    print(f"{'DRY-RUN — ' if dry_run else ''}Planning migration for {len(friendly_dirs)} dir(s):\n")

    for slug_dir in friendly_dirs:
        slug = slug_dir.name

        # 1. Try explicit mapping first.
        uuid = explicit_mapping.get(slug)

        # 2. Try the alias file (idempotent re-runs).
        if not uuid:
            uuid = aliases.get(slug)

        # 3. Look up via COROS config email → auth API.
        if not uuid:
            config_file = slug_dir / "config.json"
            if config_file.exists():
                config = json.loads(config_file.read_text(encoding="utf-8"))
                email = config.get("email", "")
            else:
                email = ""

            if email and auth_url and admin_token:
                try:
                    uuid = resolve_uuid_via_api(auth_url, admin_token, email)
                except Exception as exc:
                    print(f"  WARN: API lookup for {slug!r} ({email}) failed: {exc}")

            if not uuid:
                print(
                    f"  SKIP {slug!r}: could not resolve UUID "
                    f"(no explicit mapping, no alias, API lookup failed or skipped)"
                )
                continue

        target_dir = data_dir / uuid
        if target_dir.exists():
            print(f"  SKIP {slug!r} → {uuid}: target {target_dir} already exists")
            continue

        profile = ensure_profile_json(slug_dir, slug)
        plan.append((slug_dir, uuid, profile))
        print(f"  PLAN  {slug!r} → {uuid}  (display_name={profile['display_name']!r})")

    if not plan:
        print("\nNothing to do.")
        return 0

    if dry_run:
        print(f"\n[dry-run] Would migrate {len(plan)} dir(s). Re-run without --dry-run to apply.")
        return len(plan)

    # Apply
    migrated = 0
    for src_dir, uuid, profile in plan:
        slug = src_dir.name
        target_dir = data_dir / uuid

        # Write profile.json with display_name to the source dir before rename
        # (rename is atomic on the same filesystem).
        write_profile_json(src_dir, profile)

        os.rename(src_dir, target_dir)
        aliases[slug] = uuid
        save_slug_aliases(data_dir, aliases)

        print(f"  DONE  {slug!r} → {uuid}")
        migrated += 1

    print(f"\nMigrated {migrated}/{len(plan)} dir(s).")
    return migrated


def _resolve_admin_token(env_name: str) -> str | None:
    """Pull the admin token from the named env var, or prompt via getpass."""
    token = os.environ.get(env_name)
    if token:
        return token
    try:
        return getpass.getpass(f"Admin token (env {env_name} not set): ") or None
    except (EOFError, KeyboardInterrupt):
        return None


def _validate_auth_url(auth_url: str | None, allow_insecure: bool) -> None:
    """Ensure --auth-url is HTTPS unless --allow-insecure is explicit."""
    if not auth_url:
        return
    scheme = urlparse(auth_url).scheme.lower()
    if scheme == "https":
        return
    if scheme == "http" and allow_insecure:
        print("WARN: --auth-url is HTTP. Insecure mode enabled (--allow-insecure).", file=sys.stderr)
        return
    raise SystemExit(
        f"ERROR: --auth-url must be HTTPS (got scheme {scheme!r}). "
        "Pass --allow-insecure to override (HTTP only)."
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Migrate data/{slug}/ dirs to data/{uuid}/ using JWT sub UUIDs."
    )
    parser.add_argument("--auth-url", default=None, help="Auth-service base URL (HTTPS required)")
    parser.add_argument(
        "--admin-token-env",
        default="STRIDE_ADMIN_TOKEN",
        help="Environment variable holding the admin JWT (default: STRIDE_ADMIN_TOKEN). "
             "If unset, the script prompts via getpass.",
    )
    parser.add_argument(
        "--allow-insecure",
        action="store_true",
        help="Allow HTTP (non-TLS) --auth-url. Required for HTTP, otherwise the script aborts.",
    )
    parser.add_argument(
        "--data-dir",
        default="data",
        help="Path to the data/ directory (default: data/)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Only print the plan; make no filesystem changes",
    )
    parser.add_argument(
        "--mapping",
        default=None,
        help="Optional JSON file mapping slug→uuid (bypasses API lookup)",
    )
    args = parser.parse_args()

    _validate_auth_url(args.auth_url, args.allow_insecure)

    admin_token: str | None = None
    if args.auth_url:
        admin_token = _resolve_admin_token(args.admin_token_env)
        if not admin_token:
            print(
                f"WARN: no admin token supplied (env {args.admin_token_env} unset and prompt empty); "
                "API lookups will be skipped.",
                file=sys.stderr,
            )

    explicit_mapping: dict[str, str] = {}
    if args.mapping:
        explicit_mapping = json.loads(Path(args.mapping).read_text(encoding="utf-8"))

    data_dir = Path(args.data_dir).resolve()
    migrate(
        auth_url=args.auth_url,
        admin_token=admin_token,
        data_dir=data_dir,
        dry_run=args.dry_run,
        explicit_mapping=explicit_mapping,
    )


if __name__ == "__main__":
    main()
