"""CLI entry point for coros-sync."""

from __future__ import annotations

import json
import re
from pathlib import Path

import click
from rich.console import Console
from rich.table import Table

from .auth import Credentials, USER_DATA_DIR
from .client import CorosClient, CorosAuthError
from stride_core.db import Database
from .sync import run_sync

console = Console()

_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _resolve_profile(profile: str | None, data_dir: Path | None = None) -> str | None:
    """Resolve a profile slug to a UUID if an alias mapping exists.

    - If profile is None, return None (uses legacy default path).
    - If profile already looks like a UUIDv4, return as-is.
    - Else look up data/.slug_aliases.json; return mapped UUID if found.
    - Otherwise fall back to the friendly slug (legacy behaviour).
    """
    if profile is None:
        return None
    if _UUID4_RE.match(profile):
        return profile
    root = data_dir or USER_DATA_DIR
    aliases_file = root / ".slug_aliases.json"
    if aliases_file.exists():
        try:
            aliases = json.loads(aliases_file.read_text(encoding="utf-8"))
            if profile in aliases:
                return aliases[profile]
        except Exception:
            pass
    return profile


@click.group()
@click.option("-P", "--profile", default=None, envvar="COROS_PROFILE",
              help="User identifier — UUID, or a slug resolved via data/.slug_aliases.json. Data lives at data/{user_id}/.")
@click.pass_context
def cli(ctx: click.Context, profile: str | None) -> None:
    """Sync COROS watch running data to local SQLite for analysis."""
    ctx.ensure_object(dict)
    ctx.obj["profile"] = _resolve_profile(profile)


@cli.command()
@click.option("-u", "--user", default=None, help="COROS account email")
@click.option("-p", "--password", "pwd", default=None, help="COROS account password")
@click.pass_context
def login(ctx: click.Context, user: str | None, pwd: str | None) -> None:
    """Login to COROS Training Hub."""
    profile = ctx.obj["profile"]
    email = user or click.prompt("Email")
    password = pwd or click.prompt("Password", hide_input=True)

    with CorosClient(user=profile) as client:
        try:
            creds = client.login(email, password)
            console.print(f"[green]Logged in as {creds.email} (region: {creds.region})[/green]")
        except CorosAuthError as e:
            console.print(f"[red]Login failed: {e}[/red]")
            raise SystemExit(1)


@cli.command()
@click.option("--full", is_flag=True, help="Re-sync all activities, not just new ones")
@click.option("-j", "--jobs", default=4, show_default=True, help="Number of parallel fetch threads")
@click.pass_context
def sync(ctx: click.Context, full: bool, jobs: int) -> None:
    """Sync activities and health data from COROS."""
    profile = ctx.obj["profile"]
    creds = Credentials.load(user=profile)
    if not creds.is_logged_in:
        console.print("[red]Not logged in. Run: coros-sync login[/red]")
        raise SystemExit(1)

    with CorosClient(creds, user=profile) as client, Database(user=profile) as db:
        activities, health = run_sync(client, db, full=full, jobs=jobs)
        console.print(f"\n[green]Synced {activities} activities, {health} daily health records[/green]")


@cli.command()
@click.option("--from", "date_from", required=True, help="Start date (YYYY-MM-DD or YYYYMMDD)")
@click.option("--to", "date_to", required=True, help="End date (YYYY-MM-DD or YYYYMMDD)")
@click.option("-j", "--jobs", default=4, show_default=True, help="Number of parallel fetch threads")
@click.pass_context
def resync(ctx: click.Context, date_from: str, date_to: str, jobs: int) -> None:
    """Re-sync activities within a date range (re-fetches details from COROS)."""
    from .sync import resync_date_range

    profile = ctx.obj["profile"]
    creds = Credentials.load(user=profile)
    if not creds.is_logged_in:
        console.print("[red]Not logged in. Run: coros-sync login[/red]")
        raise SystemExit(1)

    with CorosClient(creds, user=profile) as client, Database(user=profile) as db:
        count = resync_date_range(client, db, date_from, date_to, jobs=jobs)
        console.print(f"\n[green]Re-synced {count} activities ({date_from} to {date_to})[/green]")


@cli.command()
@click.pass_context
def status(ctx: click.Context) -> None:
    """Show sync status and database summary."""
    profile = ctx.obj["profile"]
    with Database(user=profile) as db:
        count = db.get_activity_count()
        distance = db.get_total_distance_km()
        latest = db.get_latest_activity_date()
        last_sync = db.get_meta("last_sync_time")

    creds = Credentials.load(user=profile)

    table = Table(title=f"coros-sync status{f' [{profile}]' if profile else ''}")
    table.add_column("Field", style="cyan")
    table.add_column("Value")
    table.add_row("Profile", profile or "[dim]default[/dim]")
    table.add_row("Account", creds.email or "[dim]not logged in[/dim]")
    table.add_row("Region", creds.region)
    table.add_row("Activities", str(count))
    table.add_row("Total Distance", f"{distance} km")
    table.add_row("Latest Activity", latest or "—")
    table.add_row("Last Sync", last_sync or "never")
    console.print(table)


@cli.command()
@click.option("--from", "from_date", default=None, help="Start date (YYYYMMDD)")
@click.option("--to", "to_date", default=None, help="End date (YYYYMMDD)")
@click.option("--output", "-o", default=None, help="Output file (default: stdout)")
@click.pass_context
def export(ctx: click.Context, from_date: str | None, to_date: str | None, output: str | None) -> None:
    """Export activities to CSV."""
    from stride_core.export import export_activities
    profile = ctx.obj["profile"]
    with Database(user=profile) as db:
        export_activities(db, from_date=from_date, to_date=to_date, output_path=output)


@cli.group()
def analyze() -> None:
    """Analyze running data with charts and tables."""


@analyze.command()
@click.pass_context
def weekly(ctx: click.Context) -> None:
    """Weekly mileage and average pace."""
    from stride_core.analyze import weekly_summary
    with Database(user=ctx.obj["profile"]) as db:
        weekly_summary(db)


@analyze.command()
@click.pass_context
def monthly(ctx: click.Context) -> None:
    """Monthly summary."""
    from stride_core.analyze import monthly_summary
    with Database(user=ctx.obj["profile"]) as db:
        monthly_summary(db)


@analyze.command()
@click.pass_context
def zones(ctx: click.Context) -> None:
    """Heart rate zone distribution across all activities."""
    from stride_core.analyze import zone_distribution
    with Database(user=ctx.obj["profile"]) as db:
        zone_distribution(db)


@analyze.command()
@click.pass_context
def load(ctx: click.Context) -> None:
    """Training load (ATI/CTI) trends."""
    from stride_core.analyze import training_load_trend
    with Database(user=ctx.obj["profile"]) as db:
        training_load_trend(db)


@analyze.command()
@click.pass_context
def pmc(ctx: click.Context) -> None:
    """Performance Management Chart (CTI/ATI/TSB)."""
    from stride_core.analyze import pmc_chart
    with Database(user=ctx.obj["profile"]) as db:
        pmc_chart(db)


@analyze.command()
@click.pass_context
def hrv(ctx: click.Context) -> None:
    """HRV trends over time."""
    from stride_core.analyze import hrv_trend
    with Database(user=ctx.obj["profile"]) as db:
        hrv_trend(db)


@analyze.command()
@click.pass_context
def predictions(ctx: click.Context) -> None:
    """Race time predictions."""
    from stride_core.analyze import race_predictions
    with Database(user=ctx.obj["profile"]) as db:
        race_predictions(db)


# --- Workout commands ---

from .ability_cli import ability as _ability_group
cli.add_command(_ability_group)


@cli.group()
def workout() -> None:
    """Create and push workouts to COROS watch."""


@workout.command("push")
@click.argument("workout_type", type=click.Choice(["easy", "tempo", "interval", "long"]))
@click.option("--date", required=True, help="Date YYYYMMDD")
@click.option("--distance", "-d", type=float, help="Distance in km")
@click.option("--duration", type=float, help="Duration in minutes (for training segment)")
@click.option("--pace-low", help="Slower pace target (e.g. 5:40)")
@click.option("--pace-high", help="Faster pace target (e.g. 5:20)")
@click.option("--reps", type=int, help="Number of intervals (interval type)")
@click.option("--interval-m", type=int, help="Interval distance in meters (interval type)")
@click.option("--recovery-min", type=float, default=3, help="Recovery jog between intervals (min)")
@click.option("--mp-km", type=float, default=0, help="Marathon pace km at end (long run)")
@click.option("--mp-pace-low", default="4:10", help="Marathon pace low (long run)")
@click.option("--mp-pace-high", default="4:00", help="Marathon pace high (long run)")
@click.option("--name-prefix", "-p", default="", help="Prefix for workout name (e.g. '[STRIDE]')")
@click.pass_context
def push_workout_cmd(
    ctx: click.Context,
    workout_type: str, date: str, distance: float | None, duration: float | None,
    pace_low: str | None, pace_high: str | None,
    reps: int | None, interval_m: int | None, recovery_min: float,
    mp_km: float, mp_pace_low: str, mp_pace_high: str,
    name_prefix: str,
) -> None:
    """Push a running workout to COROS training schedule.

    Examples:

      coros-sync workout push easy --date 20260401 -d 10 --pace-low 5:40 --pace-high 5:20

      coros-sync workout push tempo --date 20260402 -d 8 --pace-low 3:55 --pace-high 3:50

      coros-sync workout push interval --date 20260403 --reps 5 --interval-m 1000 --pace-low 3:40 --pace-high 3:35

      coros-sync workout push long --date 20260405 -d 30 --mp-km 10 --pace-low 5:20 --pace-high 5:00
    """
    from .workout import easy_run, tempo_run, interval_run, long_run, push_workout

    profile = ctx.obj["profile"]
    creds = Credentials.load(user=profile)
    if not creds.is_logged_in:
        console.print("[red]Not logged in. Run: coros-sync login[/red]")
        raise SystemExit(1)

    if workout_type == "easy":
        w = easy_run(date, distance or 10, pace_low or "5:40", pace_high or "5:20")
    elif workout_type == "tempo":
        w = tempo_run(date, distance or 8, pace_low or "3:55", pace_high or "3:50")
    elif workout_type == "interval":
        if not reps or not interval_m:
            console.print("[red]--reps and --interval-m are required for interval workouts[/red]")
            raise SystemExit(1)
        w = interval_run(date, reps, interval_m, pace_low or "3:40", pace_high or "3:35", recovery_min)
    elif workout_type == "long":
        easy_km = (distance or 30) - mp_km
        w = long_run(date, distance or 30, easy_km, mp_km,
                     pace_low or "5:20", pace_high or "5:00", mp_pace_low, mp_pace_high)
    else:
        console.print(f"[red]Unknown workout type: {workout_type}[/red]")
        raise SystemExit(1)

    if name_prefix:
        w.name = f"{name_prefix} {w.name}"

    with CorosClient(creds, user=profile) as client:
        result = push_workout(client, w)
        console.print(f"[green]Pushed '{w.name}' to {date}[/green]")


@workout.command("week")
@click.option("--start", required=True, help="Week start date YYYYMMDD (Monday)")
@click.pass_context
def push_week_cmd(ctx: click.Context, start: str) -> None:
    """Push this week's recovery plan to COROS."""
    from .workout import build_recovery_week, push_workout

    profile = ctx.obj["profile"]
    creds = Credentials.load(user=profile)
    if not creds.is_logged_in:
        console.print("[red]Not logged in. Run: coros-sync login[/red]")
        raise SystemExit(1)

    workouts = build_recovery_week(start)
    with CorosClient(creds, user=profile) as client:
        for w in workouts:
            result = push_workout(client, w)
            console.print(f"[green]Pushed '{w.name}' to {w.date}[/green]")


@cli.group()
def commentary() -> None:
    """Push locally-stored activity commentary to a remote STRIDE server."""


@commentary.command("push")
@click.argument("label_id")
@click.option(
    "--url",
    default=None,
    envvar="STRIDE_PROD_URL",
    help="STRIDE server base URL (e.g. https://stride-app.xxx.azurecontainerapps.io). "
         "Defaults to $STRIDE_PROD_URL.",
)
@click.option(
    "--generated-by",
    default=None,
    help="Model that authored this commentary (e.g. 'claude-opus-4-7'). "
         "Sent to the server so the UI can show 'Generated by <model>'.",
)
@click.pass_context
def push_commentary_cmd(
    ctx: click.Context, label_id: str, url: str | None, generated_by: str | None,
) -> None:
    """Push the local commentary for LABEL_ID to the remote server.

    Attaches the stored auth token if one exists (see `coros-sync auth login`).
    Falls back to an unauthenticated call for servers that do not enforce auth.

    Example:

      coros-sync -P zhaochaoyi commentary push 476939007924666668 \\
        --url https://stride-app.xxx.azurecontainerapps.io \\
        --generated-by claude-opus-4-7
    """
    if not url:
        console.print("[red]Missing --url (or set $STRIDE_PROD_URL)[/red]")
        raise SystemExit(1)

    profile = ctx.obj["profile"]
    if not profile:
        console.print("[red]Use -P/--profile to select the user[/red]")
        raise SystemExit(1)

    import httpx
    from .stride_auth import bearer_header

    with Database(user=profile) as db:
        row = db.get_activity_commentary_row(label_id)
    if not row:
        console.print(f"[yellow]No local commentary found for {label_id}[/yellow]")
        raise SystemExit(1)
    text = dict(row)["commentary"]
    # Prefer explicit flag; otherwise reuse whatever is stamped locally
    effective_generated_by = generated_by or dict(row).get("generated_by")

    endpoint = f"{url.rstrip('/')}/api/{profile}/activities/{label_id}/commentary"
    headers = bearer_header(profile)
    body = {"commentary": text, "generated_by": effective_generated_by}
    resp = httpx.post(endpoint, json=body, headers=headers, timeout=30)
    if resp.status_code == 401:
        console.print(
            "[red]Server rejected the request (401). "
            "Run `coros-sync -P {p} auth login` first.[/red]".format(p=profile)
        )
        raise SystemExit(1)
    if resp.status_code >= 400:
        console.print(f"[red]POST failed: {resp.status_code} {resp.text}[/red]")
        raise SystemExit(1)
    auth_label = "authenticated" if headers else "anonymous"
    console.print(f"[green]Pushed {len(text)} chars to {endpoint} ({auth_label})[/green]")


@cli.group()
def auth() -> None:
    """Manage STRIDE auth-service tokens used by the CLI."""


@auth.command("login")
@click.option("--email", required=True, help="Account email.")
@click.option("--password", default=None, help="Account password (prompted if omitted).")
@click.option(
    "--auth-url",
    envvar="STRIDE_AUTH_URL",
    required=True,
    help="Auth-service base URL (or $STRIDE_AUTH_URL).",
)
@click.option(
    "--client-id",
    envvar="STRIDE_CLIENT_ID",
    required=True,
    help="OAuth client_id registered in the auth-service (or $STRIDE_CLIENT_ID).",
)
@click.pass_context
def auth_login_cmd(
    ctx: click.Context,
    email: str,
    password: str | None,
    auth_url: str,
    client_id: str,
) -> None:
    """Obtain tokens from the auth-service and save them for this profile."""
    profile = ctx.obj["profile"]
    if not profile:
        console.print("[red]Use -P/--profile to select the user[/red]")
        raise SystemExit(1)

    if password is None:
        password = click.prompt("Password", hide_input=True)

    import httpx
    from .stride_auth import login, save_token, auth_path

    try:
        token = login(auth_url, client_id, email, password)
    except httpx.HTTPStatusError as e:
        console.print(f"[red]Login failed: {e.response.status_code} {e.response.text}[/red]")
        raise SystemExit(1)

    save_token(profile, token)
    console.print(f"[green]Logged in as {email}. Token saved to {auth_path(profile)}.[/green]")


@auth.command("logout")
@click.pass_context
def auth_logout_cmd(ctx: click.Context) -> None:
    """Remove the stored token for this profile."""
    profile = ctx.obj["profile"]
    if not profile:
        console.print("[red]Use -P/--profile to select the user[/red]")
        raise SystemExit(1)

    from .stride_auth import auth_path, clear_token

    if clear_token(profile):
        console.print(f"[green]Removed {auth_path(profile)}.[/green]")
    else:
        console.print("[yellow]No stored token found.[/yellow]")


@auth.command("status")
@click.pass_context
def auth_status_cmd(ctx: click.Context) -> None:
    """Show the stored token's metadata (no secrets printed)."""
    profile = ctx.obj["profile"]
    if not profile:
        console.print("[red]Use -P/--profile to select the user[/red]")
        raise SystemExit(1)

    from datetime import datetime

    from .stride_auth import load_token

    token = load_token(profile)
    if token is None:
        console.print("[yellow]No token stored. Run `auth login` first.[/yellow]")
        return

    exp = token.get("expires_at")
    exp_str = datetime.fromtimestamp(exp).isoformat() if exp else "?"
    table = Table(title=f"auth status [{profile}]")
    table.add_column("Field", style="cyan")
    table.add_column("Value")
    table.add_row("Email", token.get("email") or "?")
    table.add_row("Auth URL", token.get("auth_url") or "?")
    table.add_row("Client ID", token.get("client_id") or "?")
    table.add_row("Access token expires", exp_str)
    console.print(table)


@cli.group()
def inbody() -> None:
    """Manage InBody body-composition scans (local DB + push to prod)."""


def _scan_row_to_display(row) -> dict:
    return dict(row)


def _render_inbody_table(scans: list[dict], title: str) -> Table:
    table = Table(title=title)
    table.add_column("Date", style="cyan")
    table.add_column("Weight kg", justify="right")
    table.add_column("SMM kg", justify="right")
    table.add_column("BF %", justify="right")
    table.add_column("Fat kg", justify="right")
    table.add_column("VF", justify="right")
    table.add_column("Score", justify="right")
    table.add_column("Δ Weight", justify="right", style="dim")
    # scans come newest-first; compute delta vs next-older entry
    reversed_scans = list(reversed(scans))
    deltas: dict[str, float | None] = {}
    for i, s in enumerate(reversed_scans):
        if i == 0:
            deltas[s["scan_date"]] = None
        else:
            deltas[s["scan_date"]] = round(s["weight_kg"] - reversed_scans[i - 1]["weight_kg"], 2)
    for s in scans:
        d = deltas.get(s["scan_date"])
        delta_str = "" if d is None else (f"+{d}" if d > 0 else f"{d}")
        table.add_row(
            s["scan_date"],
            f"{s['weight_kg']:.1f}",
            f"{s['smm_kg']:.1f}",
            f"{s['body_fat_pct']:.1f}",
            f"{s['fat_mass_kg']:.1f}",
            str(s["visceral_fat_level"]),
            str(s["inbody_score"] if s.get("inbody_score") is not None else "—"),
            delta_str,
        )
    return table


@inbody.command("add")
@click.option("--from-json", "json_path", required=True,
              type=click.Path(exists=True, dir_okay=False),
              help="Path to a JSON file matching the InBody scan schema.")
@click.pass_context
def inbody_add_cmd(ctx: click.Context, json_path: str) -> None:
    """Validate and upsert a scan into the local DB."""
    import json as _json

    from stride_core.models import BodyCompositionScan

    profile = ctx.obj["profile"]
    if not profile:
        console.print("[red]Use -P/--profile to select the user[/red]")
        raise SystemExit(1)

    data = _json.loads(Path(json_path).read_text(encoding="utf-8"))
    try:
        scan = BodyCompositionScan.from_dict(data)
    except (ValueError, TypeError) as e:
        console.print(f"[red]Invalid scan: {e}[/red]")
        raise SystemExit(1)

    with Database(user=profile) as db:
        db.upsert_inbody_scan(scan)
    console.print(
        f"[green]Upserted scan {scan.scan_date} "
        f"(weight={scan.weight_kg} smm={scan.smm_kg} bf={scan.body_fat_pct}%) "
        f"+ {len(scan.segments)} segments into local DB[/green]"
    )


@inbody.command("push")
@click.argument("scan_date")
@click.option("--url", default=None, envvar="STRIDE_PROD_URL",
              help="STRIDE server base URL. Defaults to $STRIDE_PROD_URL.")
@click.pass_context
def inbody_push_cmd(ctx: click.Context, scan_date: str, url: str | None) -> None:
    """Push the local scan for SCAN_DATE (YYYY-MM-DD) to the remote server."""
    if not url:
        console.print("[red]Missing --url (or set $STRIDE_PROD_URL)[/red]")
        raise SystemExit(1)

    profile = ctx.obj["profile"]
    if not profile:
        console.print("[red]Use -P/--profile to select the user[/red]")
        raise SystemExit(1)

    import httpx
    from .stride_auth import bearer_header

    with Database(user=profile) as db:
        row = db.get_inbody_scan(scan_date)
        if not row:
            console.print(f"[yellow]No local scan found for {scan_date}[/yellow]")
            raise SystemExit(1)
        segs = db.get_inbody_segments(scan_date)

    payload = dict(row)
    payload.pop("ingested_at", None)
    payload["segments"] = [
        {k: dict(s)[k] for k in (
            "segment", "lean_mass_kg", "fat_mass_kg",
            "lean_pct_of_standard", "fat_pct_of_standard",
        )}
        for s in segs
    ]

    endpoint = f"{url.rstrip('/')}/api/{profile}/inbody"
    headers = bearer_header(profile)
    resp = httpx.post(endpoint, json=payload, headers=headers, timeout=30)
    if resp.status_code == 401:
        console.print(
            f"[red]Server rejected the request (401). "
            f"Run `coros-sync -P {profile} auth login` first.[/red]"
        )
        raise SystemExit(1)
    if resp.status_code >= 400:
        console.print(f"[red]POST failed: {resp.status_code} {resp.text}[/red]")
        raise SystemExit(1)
    auth_label = "authenticated" if headers else "anonymous"
    console.print(f"[green]Pushed scan {scan_date} to {endpoint} ({auth_label})[/green]")


@inbody.command("list")
@click.option("--days", default=None, type=int, help="Limit to the last N days")
@click.pass_context
def inbody_list_cmd(ctx: click.Context, days: int | None) -> None:
    """Print a table of local scans, newest first."""
    profile = ctx.obj["profile"]
    if not profile:
        console.print("[red]Use -P/--profile to select the user[/red]")
        raise SystemExit(1)

    with Database(user=profile) as db:
        scans = [_scan_row_to_display(r) for r in db.list_inbody_scans(days=days)]

    if not scans:
        console.print("[yellow]No local InBody scans.[/yellow]")
        return
    console.print(_render_inbody_table(scans, f"InBody scans [{profile}] (local)"))


@inbody.command("fetch")
@click.option("--url", default=None, envvar="STRIDE_PROD_URL",
              help="STRIDE server base URL. Defaults to $STRIDE_PROD_URL.")
@click.option("--days", default=None, type=int, help="Limit to the last N days")
@click.pass_context
def inbody_fetch_cmd(ctx: click.Context, url: str | None, days: int | None) -> None:
    """GET prod's scans and print the same table (reconcile vs `inbody list`)."""
    if not url:
        console.print("[red]Missing --url (or set $STRIDE_PROD_URL)[/red]")
        raise SystemExit(1)

    profile = ctx.obj["profile"]
    if not profile:
        console.print("[red]Use -P/--profile to select the user[/red]")
        raise SystemExit(1)

    import httpx
    from .stride_auth import bearer_header

    params = {"days": days} if days else {}
    endpoint = f"{url.rstrip('/')}/api/{profile}/inbody"
    resp = httpx.get(endpoint, params=params, headers=bearer_header(profile), timeout=30)
    if resp.status_code >= 400:
        console.print(f"[red]GET failed: {resp.status_code} {resp.text}[/red]")
        raise SystemExit(1)
    scans = resp.json().get("scans", [])
    if not scans:
        console.print("[yellow]No remote InBody scans.[/yellow]")
        return
    console.print(_render_inbody_table(scans, f"InBody scans [{profile}] (prod)"))


@workout.command("delete")
@click.argument("date", required=True)
@click.pass_context
def delete_workout_cmd(ctx: click.Context, date: str) -> None:
    """Delete a scheduled workout by date (YYYYMMDD).

    Example: coros-sync workout delete 20260402
    """
    profile = ctx.obj["profile"]
    creds = Credentials.load(user=profile)
    if not creds.is_logged_in:
        console.print("[red]Not logged in. Run: coros-sync login[/red]")
        raise SystemExit(1)

    with CorosClient(creds, user=profile) as client:
        # Query schedule to find the workout on that date
        data = client.query_schedule(date, date)
        schedule = data.get("data", {})
        plan_id = schedule.get("id", "")
        entities = schedule.get("entities", [])

        matches = [e for e in entities if str(e.get("happenDay")) == date]
        if not matches:
            console.print(f"[yellow]No workout found on {date}[/yellow]")
            return

        for entity in matches:
            client.delete_scheduled_workout(entity, plan_id)
            name = ""
            for bar in entity.get("exerciseBarChart", []):
                if bar.get("exerciseType") == 2:
                    name = bar.get("name", "")
                    break
            console.print(f"[green]Deleted workout on {date} (idInPlan={entity.get('idInPlan')})[/green]")


# ─────────────────────────────────────────────────────────────────────────────
# plan — structured-plan reverse parser (one-shot backfill)
# ─────────────────────────────────────────────────────────────────────────────


@cli.group()
def plan() -> None:
    """Structured weekly-plan utilities (reverse parser, multi-variant)."""


# Multi-variant subcommands (Step 3 of the multi-variant feature) live in
# cli_plan.py; attach them to this same `plan` group so users see one
# unified namespace.
from .cli_plan import register_subcommands as _register_plan_subcommands
_register_plan_subcommands(plan)


@plan.command("reparse")
@click.option("--all", "all_weeks", is_flag=True,
              help="Reparse every week folder under data/{user}/logs/.")
@click.option("--folder", "folder", default=None,
              help="Single week folder (e.g. 2026-04-20_04-26(W0)).")
@click.option("--dry-run", is_flag=True,
              help="List candidate folders only; do not invoke the LLM or write the DB.")
@click.pass_context
def plan_reparse_cmd(
    ctx: click.Context, all_weeks: bool, folder: str | None, dry_run: bool,
) -> None:
    """Re-parse historical plan.md files into the structured layer.

    Backfilled rows land with ``structured_status='backfilled'`` (NOT ``fresh``)
    so the push guard in ``POST /plan/sessions/.../push`` keeps them disabled
    until a human reviews them. The 24+ weeks of historical markdown are
    free-form Chinese text; the LLM has been observed to hallucinate
    interval structures (e.g. interpreting "6×1km @ 4:00" as 6 separate
    1-km blocks instead of a RepeatGroup).

    Failure tolerance: if the LLM returns no JSON or invalid JSON for a
    given week, the row is marked ``parse_failed`` and the markdown remains
    visible — the calendar tab is unavailable for that week, but nothing
    else regresses.

    Example:

      coros-sync -P zhaochaoyi plan reparse --all
      coros-sync -P zhaochaoyi plan reparse --folder 2026-04-20_04-26\\(W0\\)
    """
    profile = ctx.obj["profile"]
    if not profile:
        console.print("[red]Use -P/--profile to select the user[/red]")
        raise SystemExit(1)
    if all_weeks == bool(folder):
        console.print("[red]Pass exactly one of --all or --folder[/red]")
        raise SystemExit(1)

    user_logs = USER_DATA_DIR / profile / "logs"
    if not user_logs.exists():
        console.print(f"[red]No logs directory for user {profile} at {user_logs}[/red]")
        raise SystemExit(1)

    if all_weeks:
        candidates = sorted(p.name for p in user_logs.iterdir() if p.is_dir())
    else:
        candidates = [folder]

    # Filter to those that actually have a plan.md
    rows: list[tuple[str, Path]] = []
    for f in candidates:
        path = user_logs / f / "plan.md"
        if path.exists():
            rows.append((f, path))
        else:
            console.print(f"[yellow]skip {f!r}: no plan.md[/yellow]")

    if dry_run:
        table = Table(title=f"Plan reparse candidates for {profile}")
        table.add_column("folder")
        table.add_column("plan.md path")
        for f, path in rows:
            table.add_row(f, str(path))
        console.print(table)
        console.print(f"[cyan]Dry-run: {len(rows)} candidates[/cyan]")
        return

    # Local imports — keep the heavy LLM stack lazy so unrelated CLI commands
    # (login/sync/etc.) start fast.
    from stride_server.coach_agent.agent import apply_weekly_plan, run_agent

    table = Table(title=f"Plan reparse for {profile}")
    table.add_column("folder")
    table.add_column("status")
    table.add_column("sessions")
    table.add_column("nutrition")
    table.add_column("note", overflow="fold")

    succeeded = 0
    failed: list[tuple[str, str]] = []
    for f, path in rows:
        md = path.read_text(encoding="utf-8")
        # Seed/refresh the markdown row before the structured upsert so
        # apply_weekly_plan's get_weekly_plan_row check has something to read.
        with Database(user=profile) as db:
            db.upsert_weekly_plan(f, md, generated_by="claude-opus-4-7-backfill")
        try:
            result = run_agent(
                profile, task="parse_plan", user_message="backfill",
                folder=f, md_text=md, sync_before=False,
            )
        except Exception as exc:
            console.print(f"[red]LLM call failed for {f}: {exc}[/red]")
            failed.append((f, f"llm error: {exc}"))
            apply_weekly_plan(
                profile, f, md,
                generated_by="claude-opus-4-7-backfill",
                structured=None, structured_source="backfilled",
            )
            table.add_row(f, "[red]error[/red]", "—", "—", str(exc)[:80])
            continue

        apply_weekly_plan(
            profile, f, md,
            generated_by="claude-opus-4-7-backfill",
            structured=result.structured,
            structured_source="backfilled",
        )
        if result.structured is None:
            failed.append((f, result.parse_error or "unknown parse error"))
            table.add_row(
                f, "[red]parse_failed[/red]", "—", "—",
                (result.parse_error or "")[:80],
            )
        else:
            n_sessions = len(result.structured.sessions)
            n_nutrition = len(result.structured.nutrition)
            succeeded += 1
            table.add_row(
                f, "[green]backfilled[/green]", str(n_sessions), str(n_nutrition), "",
            )

    console.print(table)
    console.print(
        f"[cyan]{succeeded}/{len(rows)} weeks backfilled "
        f"({len(failed)} failed)[/cyan]"
    )
    if failed:
        console.print("[yellow]Failed weeks:[/yellow]")
        for f, reason in failed:
            console.print(f"  - {f}: {reason[:100]}")
