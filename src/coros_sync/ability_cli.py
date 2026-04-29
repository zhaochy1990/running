"""CLI commands for the custom running-ability score.

Exposes:
  coros-sync -P <user> ability current
  coros-sync -P <user> ability backfill --days 90
  coros-sync -P <user> ability for <label_id>
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone

import click
from rich.columns import Columns
from rich.console import Console
from rich.panel import Panel
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TaskProgressColumn,
    TextColumn,
)
from rich.table import Table

from stride_core.ability import (
    L4_WEIGHTS,
    compute_ability_snapshot,
    compute_contribution,
    compute_l1_quality,
    marathon_target_from_profile,
    marathon_target_label,
)
from stride_core.db import Database, USER_DATA_DIR

console = Console()
logger = logging.getLogger(__name__)


def _today_iso() -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=8)).strftime("%Y-%m-%d")


def _fmt_time(total_s: float | int | None) -> str:
    if total_s is None:
        return "—"
    s = int(round(float(total_s)))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}"


def _fmt_gap(gap_s: int | float | None) -> str:
    if gap_s is None:
        return "—"
    s = int(round(float(gap_s)))
    sign = "+" if s >= 0 else "-"
    s = abs(s)
    m, sec = divmod(s, 60)
    return f"{sign}{m}:{sec:02d}"


def _load_profile(profile: str) -> dict | None:
    path = USER_DATA_DIR / profile / "profile.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("cannot read profile for %s: %s", profile, exc)
        return None
    if not isinstance(data, dict):
        logger.warning("profile for %s is not a JSON object", profile)
        return None
    return data


def _score_color(value: float | None) -> str:
    if value is None:
        return "dim"
    if value >= 80:
        return "bold green"
    if value >= 65:
        return "green"
    if value >= 50:
        return "yellow"
    return "red"


# ---------------------------------------------------------------------------
# ability current
# ---------------------------------------------------------------------------

def _render_marathon_panel(snapshot: dict) -> Panel:
    estimates = snapshot.get("marathon_estimates") or {}
    headline = snapshot.get("l4_marathon_estimate_s")
    target_s = snapshot.get("marathon_target_s")
    target_label = (
        snapshot.get("marathon_target_label")
        or (marathon_target_label(target_s) if target_s is not None else None)
    )
    gap = snapshot.get("distance_to_target_s")

    training_s = estimates.get("training_s")
    race_s = estimates.get("race_s") or headline
    best_s = estimates.get("best_case_s")
    if gap is None and race_s is not None and target_s is not None:
        gap = float(race_s) - float(target_s)

    lines = []
    lines.append(f"[bold]典型赛日预测[/bold]   {_fmt_time(race_s)}")
    if target_label is not None:
        lines.append(f"距 {target_label} 目标      [yellow]{_fmt_gap(gap)}[/yellow]")
    lines.append("")
    lines.append(f"[dim]未减量训练外推[/dim]   {_fmt_time(training_s)}")
    lines.append(f"[dim]完美赛日上限[/dim]     {_fmt_time(best_s)}")

    return Panel("\n".join(lines), title="[bold]全马预测[/bold]", border_style="cyan")


def _render_l3_table(snapshot: dict) -> Table:
    dims = snapshot.get("l3_dimensions") or {}
    t = Table(title="L3 六维能力", show_lines=False)
    t.add_column("维度", style="cyan", no_wrap=True)
    t.add_column("分数", justify="right")
    t.add_column("权重", justify="right", style="dim")
    t.add_column("关键证据", style="dim")
    name_zh = {
        "aerobic": "有氧基础",
        "lt": "乳酸阈值",
        "vo2max": "VO2max",
        "endurance": "耐力",
        "economy": "经济性",
        "recovery": "恢复",
    }
    for dim, weight in L4_WEIGHTS.items():
        d = dims.get(dim) or {}
        score = d.get("score")
        evid = d.get("evidence") or []
        score_str = f"{score:.1f}" if isinstance(score, (int, float)) else "—"
        col = _score_color(score if isinstance(score, (int, float)) else None)
        evidence_str = ",".join(str(e) for e in evid[:2]) or "[dim]—[/dim]"
        t.add_row(
            name_zh.get(dim, dim),
            f"[{col}]{score_str}[/{col}]",
            f"{weight*100:.0f}%",
            evidence_str,
        )
    return t


def _render_l4_panel(snapshot: dict) -> Panel:
    l4 = snapshot.get("l4_composite")
    l4_str = f"{l4:.1f}" if isinstance(l4, (int, float)) else "—"
    col = _score_color(l4 if isinstance(l4, (int, float)) else None)
    l2 = (snapshot.get("l2_freshness") or {}).get("total")
    l2_str = f"{l2:.1f}" if isinstance(l2, (int, float)) else "—"
    return Panel(
        f"[{col} bold]{l4_str}[/{col} bold]   "
        f"[dim]/100[/dim]\n\n"
        f"当前状态 L2  [yellow]{l2_str}[/yellow]",
        title="[bold]L4 综合能力[/bold]",
        border_style="green",
    )


def _render_vo2max_panel(snapshot: dict) -> Panel:
    v = (snapshot.get("l3_dimensions") or {}).get("vo2max") or {}
    primary = v.get("vo2max_primary")
    secondary = v.get("vo2max_secondary")
    floor = v.get("vo2max_floor")
    used = v.get("vo2max_used")
    source = v.get("vo2max_source") or "—"

    def fmt(x):
        return f"{x:.1f}" if isinstance(x, (int, float)) else "—"

    lines = [
        f"[bold]采用[/bold]           {fmt(used)}  ml/kg/min   [dim]source={source}[/dim]",
        f"Daniels VDOT     {fmt(primary)}",
        f"HR 回归          {fmt(secondary)}",
        f"Uth–Sørensen     {fmt(floor)}",
    ]
    # Cross-check warning.
    nums = [x for x in (primary, secondary, floor) if isinstance(x, (int, float))]
    if len(nums) >= 2 and (max(nums) - min(nums)) > 5:
        lines.append("")
        lines.append("[yellow]⚠ 三家估算差异 > 5 ml/kg/min，建议检查 HRmax / 实测成绩[/yellow]")
    return Panel("\n".join(lines), title="[bold]VO2max 交叉估算[/bold]", border_style="magenta")


def _ability_current(profile: str) -> None:
    with Database(user=profile) as db:
        snapshot = compute_ability_snapshot(db, date=_today_iso())
    target_s = marathon_target_from_profile(_load_profile(profile))
    race_s = snapshot.get("l4_marathon_estimate_s")
    snapshot = {
        **snapshot,
        "marathon_target_s": target_s,
        "marathon_target_label": marathon_target_label(target_s) if target_s is not None else None,
        "distance_to_target_s": (
            race_s - target_s
            if race_s is not None and target_s is not None
            else None
        ),
    }

    top = Columns(
        [_render_l4_panel(snapshot), _render_marathon_panel(snapshot)],
        equal=True,
        expand=True,
    )
    console.print(top)
    console.print(_render_l3_table(snapshot))
    console.print(_render_vo2max_panel(snapshot))


# ---------------------------------------------------------------------------
# ability backfill
# ---------------------------------------------------------------------------

def _ability_backfill(profile: str, days: int) -> None:
    end = datetime.now(timezone.utc) + timedelta(hours=8)
    start = end - timedelta(days=days)
    dates = [(start + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(days + 1)]

    wrote = 0
    with Database(user=profile) as db, Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TaskProgressColumn(),
    ) as progress:
        task = progress.add_task(f"Backfilling {days} days...", total=len(dates))
        for d_iso in dates:
            try:
                snapshot = compute_ability_snapshot(db, date=d_iso)
            except Exception as e:
                console.print(f"[yellow]skip {d_iso}: {e}[/yellow]")
                progress.advance(task)
                continue

            # Persist each row.
            l2 = snapshot.get("l2_freshness") or {}
            if l2.get("total") is not None:
                db.upsert_ability_snapshot(
                    date=d_iso, level="L2", dimension="total", value=l2.get("total"),
                )
            for dim in L4_WEIGHTS.keys():
                cell = (snapshot.get("l3_dimensions") or {}).get(dim) or {}
                db.upsert_ability_snapshot(
                    date=d_iso, level="L3", dimension=dim,
                    value=cell.get("score"),
                    evidence_activity_ids=cell.get("evidence"),
                )
            db.upsert_ability_snapshot(
                date=d_iso, level="L4", dimension="composite",
                value=snapshot.get("l4_composite"),
                evidence_activity_ids=snapshot.get("evidence_activity_ids"),
            )
            estimates = snapshot.get("marathon_estimates") or {}
            for dim_name, key in (
                ("marathon_training_s", "training_s"),
                ("marathon_race_s",     "race_s"),
                ("marathon_best_case_s", "best_case_s"),
            ):
                val = estimates.get(key)
                if val is not None:
                    db.upsert_ability_snapshot(
                        date=d_iso, level="L4", dimension=dim_name,
                        value=float(val),
                    )
            wrote += 1
            progress.update(task, description=f"Backfilled {d_iso}")
            progress.advance(task)

    console.print(f"[green]Backfilled {wrote}/{len(dates)} days of ability snapshots[/green]")


# ---------------------------------------------------------------------------
# ability for <label_id>
# ---------------------------------------------------------------------------

def _render_l1_breakdown(l1: dict) -> Table:
    t = Table(title="L1 单次训练质量分")
    t.add_column("指标", style="cyan")
    t.add_column("分数", justify="right")
    t.add_column("权重", justify="right", style="dim")
    from stride_core.ability import L1_WEIGHTS

    breakdown = l1.get("breakdown") or {}
    name_zh = {
        "pace_adherence": "配速符合度",
        "hr_zone_adherence": "心率区间符合度",
        "pace_stability": "配速稳定度",
        "hr_decoupling": "心率解耦",
        "cadence_stability": "步频稳定度",
    }
    for key, weight in L1_WEIGHTS.items():
        v = breakdown.get(key)
        v_str = f"{v:.1f}" if isinstance(v, (int, float)) else "—"
        col = _score_color(v if isinstance(v, (int, float)) else None)
        t.add_row(name_zh.get(key, key), f"[{col}]{v_str}[/{col}]", f"{weight*100:.0f}%")
    total = l1.get("total")
    total_str = f"{total:.1f}" if isinstance(total, (int, float)) else "—"
    col = _score_color(total if isinstance(total, (int, float)) else None)
    t.add_row("[bold]合计[/bold]", f"[{col} bold]{total_str}[/{col} bold]", "100%")
    return t


def _render_contribution(contribution: dict) -> Table:
    t = Table(title="本次训练对 L3 的贡献 (delta)")
    t.add_column("维度", style="cyan")
    t.add_column("Δ", justify="right")
    name_zh = {
        "aerobic": "有氧基础",
        "lt": "乳酸阈值",
        "vo2max": "VO2max",
        "endurance": "耐力",
        "economy": "经济性",
        "recovery": "恢复",
    }
    any_move = False
    for dim in L4_WEIGHTS.keys():
        delta = contribution.get(dim, 0.0) if contribution else 0.0
        if abs(delta) < 0.05:
            continue
        any_move = True
        sign = "+" if delta >= 0 else ""
        col = "green" if delta > 0 else "red"
        t.add_row(name_zh.get(dim, dim), f"[{col}]{sign}{delta:.2f}[/{col}]")
    if not any_move:
        t.add_row("[dim](无明显变化，|Δ| < 0.05)[/dim]", "")
    return t


def _ability_for(profile: str, label_id: str) -> None:
    with Database(user=profile) as db:
        # Try the persisted row first; compute fresh if missing.
        row = db.fetch_activity_ability(label_id)
        if row:
            rec = dict(row)
            l1 = {
                "total": rec.get("l1_quality"),
                "breakdown": json.loads(rec.get("l1_breakdown") or "{}"),
            }
            contribution = json.loads(rec.get("contribution") or "{}")
        else:
            # Fresh compute
            from coros_sync.sync import _load_activity_for_l1
            activity = _load_activity_for_l1(db, label_id)
            if activity is None:
                console.print(f"[red]Activity {label_id} not found in local DB[/red]")
                raise SystemExit(1)
            l1_full = compute_l1_quality(activity, plan_target=None)
            l1 = {"total": l1_full.get("total"), "breakdown": l1_full.get("breakdown")}

            # Compute contribution: delta between snapshot-before and snapshot-with activity.
            # Cheap approximation: run full snapshot twice, once with the activity temporarily
            # excluded via a prior-date computation.
            from datetime import datetime as _dt
            try:
                activity_date = db._conn.execute(
                    "SELECT date FROM activities WHERE label_id = ?", (label_id,)
                ).fetchone()
                if activity_date and activity_date[0]:
                    d_raw = str(activity_date[0])[:10]
                    if "T" in d_raw:
                        d_raw = d_raw.split("T")[0]
                    prior_date = (
                        _dt.fromisoformat(d_raw) - timedelta(days=1)
                    ).strftime("%Y-%m-%d")
                    prior_snap = compute_ability_snapshot(db, date=prior_date)
                    posterior_snap = compute_ability_snapshot(db, date=d_raw)
                    prior_l3 = {
                        k: (prior_snap.get("l3_dimensions") or {}).get(k, {}).get("score", 0.0)
                        for k in L4_WEIGHTS.keys()
                    }
                    posterior_l3 = {
                        k: (posterior_snap.get("l3_dimensions") or {}).get(k, {}).get("score", 0.0)
                        for k in L4_WEIGHTS.keys()
                    }
                    contribution = compute_contribution(activity, prior_l3, posterior_l3)
                else:
                    contribution = {}
            except Exception:
                contribution = {}

    console.print(f"[bold]Activity[/bold] {label_id}")
    console.print(_render_l1_breakdown(l1))
    console.print(_render_contribution(contribution))


# ---------------------------------------------------------------------------
# Click group.
# ---------------------------------------------------------------------------

@click.group("ability")
def ability() -> None:
    """Custom running-ability score (L1/L2/L3/L4)."""


@ability.command("current")
@click.pass_context
def ability_current_cmd(ctx: click.Context) -> None:
    """Print current L4 + L3 radar + marathon estimates."""
    profile = ctx.obj["profile"]
    if not profile:
        console.print("[red]Use -P/--profile to select the user[/red]")
        raise SystemExit(1)
    _ability_current(profile)


@ability.command("backfill")
@click.option("--days", default=90, show_default=True, help="How many days to recompute.")
@click.pass_context
def ability_backfill_cmd(ctx: click.Context, days: int) -> None:
    """Recompute and store the ability snapshot for each of the last N days."""
    profile = ctx.obj["profile"]
    if not profile:
        console.print("[red]Use -P/--profile to select the user[/red]")
        raise SystemExit(1)
    _ability_backfill(profile, days)


@ability.command("for")
@click.argument("label_id")
@click.pass_context
def ability_for_cmd(ctx: click.Context, label_id: str) -> None:
    """Print L1 + contribution for a single activity."""
    profile = ctx.obj["profile"]
    if not profile:
        console.print("[red]Use -P/--profile to select the user[/red]")
        raise SystemExit(1)
    _ability_for(profile, label_id)
