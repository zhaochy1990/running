"""CLI entry point for coros-sync."""

from __future__ import annotations

import click
from rich.console import Console
from rich.table import Table

from .auth import Credentials
from .client import CorosClient, CorosAuthError
from stride_core.db import Database
from .sync import run_sync

console = Console()


@click.group()
@click.option("-P", "--profile", default=None, envvar="COROS_PROFILE",
              help="User profile name (corresponds to data/{profile}/ directory)")
@click.pass_context
def cli(ctx: click.Context, profile: str | None) -> None:
    """Sync COROS watch running data to local SQLite for analysis."""
    ctx.ensure_object(dict)
    ctx.obj["profile"] = profile


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
@click.pass_context
def push_commentary_cmd(ctx: click.Context, label_id: str, url: str | None) -> None:
    """Push the local commentary for LABEL_ID to the remote server.

    Attaches the stored auth token if one exists (see `coros-sync auth login`).
    Falls back to an unauthenticated call for servers that do not enforce auth.

    Example:

      coros-sync -P zhaochaoyi commentary push 476939007924666668 \\
        --url https://stride-app.xxx.azurecontainerapps.io
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
        text = db.get_activity_commentary(label_id)
    if not text:
        console.print(f"[yellow]No local commentary found for {label_id}[/yellow]")
        raise SystemExit(1)

    endpoint = f"{url.rstrip('/')}/api/{profile}/activities/{label_id}/commentary"
    headers = bearer_header(profile)
    resp = httpx.post(endpoint, json={"commentary": text}, headers=headers, timeout=30)
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
