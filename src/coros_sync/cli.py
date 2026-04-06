"""CLI entry point for coros-sync."""

from __future__ import annotations

import click
from rich.console import Console
from rich.table import Table

from .auth import Credentials
from .client import CorosClient, CorosAuthError
from .db import Database
from .sync import run_sync

console = Console()


@click.group()
def cli() -> None:
    """Sync COROS watch running data to local SQLite for analysis."""


@cli.command()
@click.option("-u", "--user", default=None, help="COROS account email")
@click.option("-p", "--password", "pwd", default=None, help="COROS account password")
def login(user: str | None, pwd: str | None) -> None:
    """Login to COROS Training Hub."""
    email = user or click.prompt("Email")
    password = pwd or click.prompt("Password", hide_input=True)

    with CorosClient() as client:
        try:
            creds = client.login(email, password)
            console.print(f"[green]Logged in as {creds.email} (region: {creds.region})[/green]")
        except CorosAuthError as e:
            console.print(f"[red]Login failed: {e}[/red]")
            raise SystemExit(1)


@cli.command()
@click.option("--full", is_flag=True, help="Re-sync all activities, not just new ones")
@click.option("-j", "--jobs", default=4, show_default=True, help="Number of parallel fetch threads")
def sync(full: bool, jobs: int) -> None:
    """Sync activities and health data from COROS."""
    creds = Credentials.load()
    if not creds.is_logged_in:
        console.print("[red]Not logged in. Run: coros-sync login[/red]")
        raise SystemExit(1)

    with CorosClient(creds) as client, Database() as db:
        activities, health = run_sync(client, db, full=full, jobs=jobs)
        console.print(f"\n[green]Synced {activities} activities, {health} daily health records[/green]")


@cli.command()
def status() -> None:
    """Show sync status and database summary."""
    with Database() as db:
        count = db.get_activity_count()
        distance = db.get_total_distance_km()
        latest = db.get_latest_activity_date()
        last_sync = db.get_meta("last_sync_time")

    creds = Credentials.load()

    table = Table(title="coros-sync status")
    table.add_column("Field", style="cyan")
    table.add_column("Value")
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
def export(from_date: str | None, to_date: str | None, output: str | None) -> None:
    """Export activities to CSV."""
    from .export import export_activities
    with Database() as db:
        export_activities(db, from_date=from_date, to_date=to_date, output_path=output)


@cli.group()
def analyze() -> None:
    """Analyze running data with charts and tables."""


@analyze.command()
def weekly() -> None:
    """Weekly mileage and average pace."""
    from .analyze import weekly_summary
    with Database() as db:
        weekly_summary(db)


@analyze.command()
def monthly() -> None:
    """Monthly summary."""
    from .analyze import monthly_summary
    with Database() as db:
        monthly_summary(db)


@analyze.command()
def zones() -> None:
    """Heart rate zone distribution across all activities."""
    from .analyze import zone_distribution
    with Database() as db:
        zone_distribution(db)


@analyze.command()
def load() -> None:
    """Training load (ATI/CTI) trends."""
    from .analyze import training_load_trend
    with Database() as db:
        training_load_trend(db)


@analyze.command()
def hrv() -> None:
    """HRV trends over time."""
    from .analyze import hrv_trend
    with Database() as db:
        hrv_trend(db)


@analyze.command()
def predictions() -> None:
    """Race time predictions."""
    from .analyze import race_predictions
    with Database() as db:
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
@click.option("--warmup-min", type=float, default=5, help="Warmup duration (min)")
@click.option("--warmup-km", type=float, help="Warmup distance in km (overrides warmup-min)")
@click.option("--warmup-pace-low", help="Warmup slower pace (e.g. 5:40)")
@click.option("--warmup-pace-high", help="Warmup faster pace (e.g. 5:30)")
@click.option("--cooldown-km", type=float, help="Cooldown distance in km")
@click.option("--cooldown-pace-low", help="Cooldown slower pace (e.g. 6:00)")
@click.option("--cooldown-pace-high", help="Cooldown faster pace (e.g. 5:40)")
@click.option("--mp-km", type=float, default=0, help="Marathon pace km at end (long run)")
@click.option("--mp-pace-low", default="4:10", help="Marathon pace low (long run)")
@click.option("--mp-pace-high", default="4:00", help="Marathon pace high (long run)")
def push_workout_cmd(
    workout_type: str, date: str, distance: float | None, duration: float | None,
    pace_low: str | None, pace_high: str | None,
    reps: int | None, interval_m: int | None, recovery_min: float, warmup_min: float,
    warmup_km: float | None, warmup_pace_low: str | None, warmup_pace_high: str | None,
    cooldown_km: float | None, cooldown_pace_low: str | None, cooldown_pace_high: str | None,
    mp_km: float, mp_pace_low: str, mp_pace_high: str,
) -> None:
    """Push a running workout to COROS training schedule.

    Examples:

      coros-sync workout push easy --date 20260401 -d 10 --pace-low 5:40 --pace-high 5:20

      coros-sync workout push tempo --date 20260402 -d 8 --pace-low 3:55 --pace-high 3:50

      coros-sync workout push interval --date 20260403 --reps 5 --interval-m 1000 --pace-low 3:40 --pace-high 3:35

      coros-sync workout push long --date 20260405 -d 30 --mp-km 10 --pace-low 5:20 --pace-high 5:00
    """
    from .workout import easy_run, tempo_run, interval_run, long_run, push_workout

    creds = Credentials.load()
    if not creds.is_logged_in:
        console.print("[red]Not logged in. Run: coros-sync login[/red]")
        raise SystemExit(1)

    if workout_type == "easy":
        w = easy_run(date, distance or 10, pace_low or "5:40", pace_high or "5:20")
    elif workout_type == "tempo":
        w = tempo_run(
            date, warmup_min, distance or 8, pace_low or "3:55", pace_high or "3:50",
            warmup_km=warmup_km, warmup_pace_low=warmup_pace_low, warmup_pace_high=warmup_pace_high,
            cooldown_km=cooldown_km, cooldown_pace_low=cooldown_pace_low, cooldown_pace_high=cooldown_pace_high,
        )
    elif workout_type == "interval":
        if not reps or not interval_m:
            console.print("[red]--reps and --interval-m are required for interval workouts[/red]")
            raise SystemExit(1)
        w = interval_run(
            date, warmup_min, reps, interval_m, pace_low or "3:40", pace_high or "3:35", recovery_min,
            warmup_km=warmup_km, warmup_pace_low=warmup_pace_low, warmup_pace_high=warmup_pace_high,
            cooldown_km=cooldown_km, cooldown_pace_low=cooldown_pace_low, cooldown_pace_high=cooldown_pace_high,
        )
    elif workout_type == "long":
        easy_km = (distance or 30) - mp_km
        w = long_run(date, distance or 30, easy_km, mp_km,
                     pace_low or "5:20", pace_high or "5:00", mp_pace_low, mp_pace_high)
    else:
        console.print(f"[red]Unknown workout type: {workout_type}[/red]")
        raise SystemExit(1)

    with CorosClient(creds) as client:
        result = push_workout(client, w)
        console.print(f"[green]Pushed '{w.name}' to {date}[/green]")


@workout.command("week")
@click.option("--start", required=True, help="Week start date YYYYMMDD (Monday)")
def push_week_cmd(start: str) -> None:
    """Push this week's recovery plan to COROS."""
    from .workout import build_recovery_week, push_workout

    creds = Credentials.load()
    if not creds.is_logged_in:
        console.print("[red]Not logged in. Run: coros-sync login[/red]")
        raise SystemExit(1)

    workouts = build_recovery_week(start)
    with CorosClient(creds) as client:
        for w in workouts:
            result = push_workout(client, w)
            console.print(f"[green]Pushed '{w.name}' to {w.date}[/green]")


@workout.command("delete")
@click.argument("date", required=True)
def delete_workout_cmd(date: str) -> None:
    """Delete a scheduled workout by date (YYYYMMDD).

    Example: coros-sync workout delete 20260402
    """
    creds = Credentials.load()
    if not creds.is_logged_in:
        console.print("[red]Not logged in. Run: coros-sync login[/red]")
        raise SystemExit(1)

    with CorosClient(creds) as client:
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
