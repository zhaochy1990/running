"""CLI entry point for garmin-sync.

Mirrors the `coros-sync` CLI shape (-P profile, login/sync subcommands) so
Garmin-provider users have the same local authoring loop as COROS users.
Profile slug → UUID resolution is shared with coros-sync.
"""

from __future__ import annotations

import logging

import click
from rich.console import Console

from coros_sync.cli import _resolve_profile
from stride_storage.sqlite.database import Database
from stride_core.post_sync import run_post_sync_for_labels
from stride_core.registry import write_user_provider

from .auth import GarminCredentials
from .client import GarminAuthError, GarminClient
from .sync import run_sync

console = Console()
logger = logging.getLogger(__name__)


@click.group()
@click.option(
    "-P", "--profile", default=None, envvar="GARMIN_PROFILE",
    help="User identifier — UUID, or a slug resolved via data/.slug_aliases.json.",
)
@click.pass_context
def cli(ctx: click.Context, profile: str | None) -> None:
    """Sync Garmin Connect running data to local SQLite for analysis."""
    ctx.ensure_object(dict)
    ctx.obj["profile"] = _resolve_profile(profile)


@cli.command()
@click.option("-u", "--user", "email", default=None, help="Garmin Connect account email")
@click.option("-p", "--password", "pwd", default=None, help="Garmin Connect account password")
@click.option(
    "--region", type=click.Choice(["cn", "global"]), default="cn", show_default=True,
    help="Garmin region — 'cn' for garmin.cn, 'global' for garmin.com",
)
@click.pass_context
def login(ctx: click.Context, email: str | None, pwd: str | None, region: str) -> None:
    """Login to Garmin Connect and persist tokens for this profile."""
    profile = ctx.obj["profile"]
    if profile is None:
        console.print("[red]Pass -P/--profile so credentials are saved under data/{user}/.[/red]")
        raise SystemExit(1)

    email = email or click.prompt("Email")
    password = pwd or click.prompt("Password", hide_input=True)

    try:
        client = GarminClient.login(email, password, region=region)
    except GarminAuthError as exc:
        console.print(f"[red]Login failed: {exc}[/red]")
        raise SystemExit(1)

    creds = GarminCredentials.from_garth_client(email, region, client.garth)
    creds.save(profile)
    write_user_provider(profile, "garmin")
    console.print(f"[green]Logged in as {creds.email} (region: {creds.region})[/green]")


@cli.command()
@click.option("--full", is_flag=True, help="Re-sync deeper history (last ~180 days)")
@click.option(
    "--since",
    "since_date",
    default=None,
    help="Pull activities back to this date (YYYY-MM-DD); overrides --full's default window.",
)
@click.pass_context
def sync(ctx: click.Context, full: bool, since_date: str | None) -> None:
    """Sync activities and health data from Garmin Connect."""
    profile = ctx.obj["profile"]
    if profile is None:
        console.print("[red]Pass -P/--profile to select the user.[/red]")
        raise SystemExit(1)

    creds = GarminCredentials.load(profile)
    if not creds.is_logged_in:
        console.print("[red]Not logged in. Run: garmin-sync -P <profile> login[/red]")
        raise SystemExit(1)

    try:
        client = GarminClient.from_stored(creds)
    except GarminAuthError as exc:
        console.print(f"[red]{exc}[/red]")
        raise SystemExit(1)

    with Database(user=profile) as db:
        activities, health, activity_label_ids = run_sync(client, db, full=full, since_date=since_date)
    console.print(
        f"\n[green]Synced {activities} activities, {health} daily health records[/green]"
    )
    try:
        run_post_sync_for_labels(
            user=profile,
            provider="garmin",
            operation="sync",
            activity_label_ids=activity_label_ids,
        )
    except Exception:
        logger.exception("post-sync events failed for Garmin CLI sync profile=%s", profile)


@cli.command()
@click.pass_context
def status(ctx: click.Context) -> None:
    """Show stored Garmin credentials + DB summary for this profile."""
    profile = ctx.obj["profile"]
    if profile is None:
        console.print("[red]Pass -P/--profile to select the user.[/red]")
        raise SystemExit(1)

    creds = GarminCredentials.load(profile)
    with Database(user=profile) as db:
        count = db.get_activity_count()
        latest = db.get_latest_activity_date()

    console.print(f"Profile:  {profile}")
    console.print(f"Account:  {creds.email or '[dim]not logged in[/dim]'}")
    console.print(f"Region:   {creds.region}")
    console.print(f"Activities: {count}")
    console.print(f"Latest:   {latest or '—'}")


if __name__ == "__main__":
    cli()
