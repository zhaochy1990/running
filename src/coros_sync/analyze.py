"""Analysis functions using pandas for aggregation and rich for display."""

from __future__ import annotations

from rich.console import Console
from rich.table import Table

from .db import Database
from .models import pace_str

console = Console()


def _require_pandas():
    try:
        import pandas as pd
        return pd
    except ImportError:
        console.print("[red]Analysis requires pandas. Install with: pip install coros-sync[analysis][/red]")
        raise SystemExit(1)


def weekly_summary(db: Database) -> None:
    pd = _require_pandas()
    rows = db.query(
        "SELECT date, distance_m, duration_s, avg_pace_s_km, avg_hr FROM activities ORDER BY date"
    )
    if not rows:
        console.print("[dim]No activities found.[/dim]")
        return

    df = pd.DataFrame([dict(r) for r in rows])
    df["date"] = pd.to_datetime(df["date"], format="%Y%m%d", errors="coerce")
    df = df.dropna(subset=["date"])
    df["week"] = df["date"].dt.isocalendar().week
    df["year"] = df["date"].dt.isocalendar().year
    df["distance_km"] = df["distance_m"] / 1000

    weekly = df.groupby(["year", "week"]).agg(
        runs=("distance_km", "count"),
        distance_km=("distance_km", "sum"),
        duration_s=("duration_s", "sum"),
        avg_pace=("avg_pace_s_km", "mean"),
        avg_hr=("avg_hr", "mean"),
    ).round(1).tail(12)

    table = Table(title="Weekly Summary (last 12 weeks)")
    table.add_column("Year", style="dim")
    table.add_column("Week", style="dim")
    table.add_column("Runs", justify="right")
    table.add_column("Distance (km)", justify="right", style="cyan")
    table.add_column("Duration", justify="right")
    table.add_column("Avg Pace", justify="right", style="green")
    table.add_column("Avg HR", justify="right", style="red")

    for (year, week), row in weekly.iterrows():
        hrs = int(row["duration_s"]) // 3600
        mins = (int(row["duration_s"]) % 3600) // 60
        table.add_row(
            str(year), str(week), str(int(row["runs"])),
            f"{row['distance_km']:.1f}", f"{hrs}h{mins:02d}m",
            pace_str(row["avg_pace"]) or "—",
            f"{row['avg_hr']:.0f}" if row["avg_hr"] > 0 else "—",
        )

    console.print(table)

    try:
        from .charts import plot_weekly_mileage
        plot_weekly_mileage(weekly)
    except ImportError:
        pass


def monthly_summary(db: Database) -> None:
    pd = _require_pandas()
    rows = db.query(
        "SELECT date, distance_m, duration_s, avg_pace_s_km FROM activities ORDER BY date"
    )
    if not rows:
        console.print("[dim]No activities found.[/dim]")
        return

    df = pd.DataFrame([dict(r) for r in rows])
    df["date"] = pd.to_datetime(df["date"], format="%Y%m%d", errors="coerce")
    df = df.dropna(subset=["date"])
    df["month"] = df["date"].dt.to_period("M")
    df["distance_km"] = df["distance_m"] / 1000

    monthly = df.groupby("month").agg(
        runs=("distance_km", "count"),
        distance_km=("distance_km", "sum"),
        duration_s=("duration_s", "sum"),
        avg_pace=("avg_pace_s_km", "mean"),
    ).round(1).tail(12)

    table = Table(title="Monthly Summary (last 12 months)")
    table.add_column("Month")
    table.add_column("Runs", justify="right")
    table.add_column("Distance (km)", justify="right", style="cyan")
    table.add_column("Duration", justify="right")
    table.add_column("Avg Pace", justify="right", style="green")

    for month, row in monthly.iterrows():
        hrs = int(row["duration_s"]) // 3600
        mins = (int(row["duration_s"]) % 3600) // 60
        table.add_row(
            str(month), str(int(row["runs"])),
            f"{row['distance_km']:.1f}", f"{hrs}h{mins:02d}m",
            pace_str(row["avg_pace"]) or "—",
        )

    console.print(table)


def zone_distribution(db: Database) -> None:
    rows = db.query(
        """SELECT zone_index, range_unit,
           sum(duration_s) as total_s, avg(percent) as avg_pct
           FROM zones WHERE zone_type = 'heartRate'
           GROUP BY zone_index ORDER BY zone_index"""
    )
    if not rows:
        console.print("[dim]No HR zone data found.[/dim]")
        return

    table = Table(title="Heart Rate Zone Distribution")
    table.add_column("Zone", justify="center")
    table.add_column("Total Time", justify="right")
    table.add_column("Avg %", justify="right", style="cyan")

    for row in rows:
        total = dict(row)["total_s"]
        hrs = int(total) // 3600
        mins = (int(total) % 3600) // 60
        table.add_row(
            f"Z{dict(row)['zone_index']}",
            f"{hrs}h{mins:02d}m",
            f"{dict(row)['avg_pct']:.1f}%",
        )

    console.print(table)


def training_load_trend(db: Database) -> None:
    pd = _require_pandas()
    rows = db.query(
        "SELECT date, ati, cti, rhr, fatigue FROM daily_health ORDER BY date"
    )
    if not rows:
        console.print("[dim]No health data found. Run: coros-sync sync[/dim]")
        return

    df = pd.DataFrame([dict(r) for r in rows])
    # Show last 30 days
    tail = df.tail(30)

    table = Table(title="Training Load (last 30 days)")
    table.add_column("Date", style="dim")
    table.add_column("ATI", justify="right", style="cyan")
    table.add_column("CTI", justify="right", style="green")
    table.add_column("RHR", justify="right", style="red")
    table.add_column("Fatigue", justify="right")

    for _, row in tail.iterrows():
        table.add_row(
            str(row["date"]),
            f"{row['ati']:.0f}" if row["ati"] else "—",
            f"{row['cti']:.0f}" if row["cti"] else "—",
            f"{row['rhr']:.0f}" if row["rhr"] else "—",
            f"{row['fatigue']:.0f}" if row["fatigue"] else "—",
        )

    console.print(table)

    try:
        from .charts import plot_training_load
        plot_training_load(df)
    except ImportError:
        pass


def hrv_trend(db: Database) -> None:
    rows = db.query(
        "SELECT avg_sleep_hrv, hrv_normal_low, hrv_normal_high FROM dashboard WHERE id = 1"
    )
    if not rows:
        console.print("[dim]No HRV data found. Run: coros-sync sync[/dim]")
        return

    row = dict(rows[0])
    table = Table(title="HRV Status")
    table.add_column("Metric", style="cyan")
    table.add_column("Value", justify="right")
    table.add_row("Avg Sleep HRV", f"{row['avg_sleep_hrv']:.0f}" if row["avg_sleep_hrv"] else "—")
    table.add_row("Normal Range Low", f"{row['hrv_normal_low']:.0f}" if row["hrv_normal_low"] else "—")
    table.add_row("Normal Range High", f"{row['hrv_normal_high']:.0f}" if row["hrv_normal_high"] else "—")

    console.print(table)


def pmc_chart(db: Database) -> None:
    """Performance Management Chart: CTI (fitness), ATI (fatigue), TSB (form)."""
    pd = _require_pandas()
    rows = db.query(
        "SELECT date, ati, cti, fatigue, rhr FROM daily_health ORDER BY date"
    )
    if not rows:
        console.print("[dim]No health data found. Run: coros-sync sync[/dim]")
        return

    df = pd.DataFrame([dict(r) for r in rows])
    df["tsb"] = df["cti"].fillna(0) - df["ati"].fillna(0)
    df["ctl_ramp"] = df["cti"].diff(7).round(1)

    # Show last 30 days in table
    tail = df.tail(30)

    table = Table(title="Performance Management Chart (last 30 days)")
    table.add_column("Date", style="dim")
    table.add_column("CTI", justify="right", style="green")
    table.add_column("ATI", justify="right", style="cyan")
    table.add_column("TSB", justify="right")
    table.add_column("Ramp", justify="right")
    table.add_column("Fatigue", justify="right")
    table.add_column("RHR", justify="right")
    table.add_column("Zone", justify="right")

    for _, row in tail.iterrows():
        tsb = row["tsb"]
        if tsb >= 25:
            zone, zone_style = "减量过多", "yellow"
        elif tsb >= 10:
            zone, zone_style = "比赛就绪", "bold green"
        elif tsb >= -10:
            zone, zone_style = "过渡区", "dim"
        elif tsb >= -30:
            zone, zone_style = "正常训练", "cyan"
        else:
            zone, zone_style = "过度负荷", "bold red"

        tsb_color = "green" if tsb >= 0 else ("red" if tsb < -30 else "yellow")
        ramp = row["ctl_ramp"]
        ramp_str = f"{ramp:+.0f}" if pd.notna(ramp) else "—"
        ramp_color = "red" if pd.notna(ramp) and abs(ramp) > 8 else ""

        table.add_row(
            str(row["date"]),
            f"{row['cti']:.0f}" if pd.notna(row["cti"]) else "—",
            f"{row['ati']:.0f}" if pd.notna(row["ati"]) else "—",
            f"[{tsb_color}]{tsb:+.0f}[/{tsb_color}]",
            f"[{ramp_color}]{ramp_str}[/{ramp_color}]" if ramp_color else ramp_str,
            f"{row['fatigue']:.0f}" if pd.notna(row["fatigue"]) else "—",
            f"{row['rhr']:.0f}" if pd.notna(row["rhr"]) else "—",
            f"[{zone_style}]{zone}[/{zone_style}]",
        )

    console.print(table)

    # Current status summary
    latest = df.iloc[-1]
    tsb_val = latest["tsb"]
    console.print(f"\n[bold]当前状态[/bold]  CTI={latest['cti']:.0f}  ATI={latest['ati']:.0f}  "
                  f"TSB=[{'green' if tsb_val >= 0 else 'yellow'}]{tsb_val:+.0f}[/]  "
                  f"疲劳={latest['fatigue']:.0f}")
    if pd.notna(latest["ctl_ramp"]):
        ramp = latest["ctl_ramp"]
        ramp_warn = " [red]⚠ 增量过快[/red]" if abs(ramp) > 8 else ""
        console.print(f"  CTL周增量: {ramp:+.0f}{ramp_warn}")

    try:
        from .charts import plot_pmc
        plot_pmc(df)
    except ImportError:
        pass


def race_predictions(db: Database) -> None:
    rows = db.query("SELECT race_type, duration_s, avg_pace FROM race_predictions ORDER BY duration_s")
    if not rows:
        console.print("[dim]No race predictions found. Run: coros-sync sync[/dim]")
        return

    table = Table(title="Race Predictions")
    table.add_column("Race", style="cyan")
    table.add_column("Predicted Time", justify="right")
    table.add_column("Avg Pace", justify="right", style="green")

    for row in rows:
        d = dict(row)
        duration = d["duration_s"]
        if duration:
            hrs = int(duration) // 3600
            mins = (int(duration) % 3600) // 60
            secs = int(duration) % 60
            time_str = f"{hrs}:{mins:02d}:{secs:02d}" if hrs else f"{mins}:{secs:02d}"
        else:
            time_str = "—"
        table.add_row(d["race_type"], time_str, pace_str(d["avg_pace"]) or "—")

    console.print(table)
