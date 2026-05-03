"""`coros-sync plan ...` — CLI for the multi-variant weekly plan feature.

Subcommands:
    generate-variants  — fan out to N models via `omc ask`, parse + upload
    list-variants      — show variants for a week
    rate               — record per-dimension ratings
    select             — promote a variant to canonical (FALLBACK design)
    delete-variants    — clear all variants for a week

The CLI orchestrates *parallel* `omc ask <model>` subprocesses (one per
configured model), parses each one's STDOUT with a 3-tier strategy
anchored on a `weekly-plan/v1` schema marker, then POSTs each variant
to the prod STRIDE API. See `.omc/plans/multi-variant-weekly-plans.md`
§ "本地 CLI" for the full design + Architect findings.

Auth: Bearer token from `coros_sync.stride_auth` — these endpoints all
sit behind `protected_user`, so anonymous fallback is NOT supported.
"""
from __future__ import annotations

import concurrent.futures
import hashlib
import json
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import click
import httpx
from rich.console import Console
from rich.table import Table

from stride_core.plan_spec import SUPPORTED_SCHEMA_VERSION, WeeklyPlan

from .stride_auth import bearer_header

console = Console()


# ─────────────────────────────────────────────────────────────────────────
# 3-tier STDOUT parser (Architect MAJOR-D fix — see plan §4 risks)
# ─────────────────────────────────────────────────────────────────────────


_SENTINEL_RE = re.compile(
    r"<<<WEEKLY_PLAN_JSON_START>>>\s*\n(.*?)\n\s*<<<WEEKLY_PLAN_JSON_END>>>",
    re.DOTALL,
)
_FENCED_RE = re.compile(
    r"```(?:json|jsonc)?\s*\n(\{.*?\})\s*\n```",
    re.DOTALL | re.IGNORECASE,
)


def _last_balanced_braces(text: str) -> str | None:
    """Greedy from right: walk backward looking for a balanced top-level
    object. Used as the last-resort tier when neither sentinels nor fenced
    code blocks exist (e.g. a model that just printed raw JSON).
    """
    depth = 0
    end = -1
    for i in range(len(text) - 1, -1, -1):
        ch = text[i]
        if ch == "}":
            if depth == 0:
                end = i
            depth += 1
        elif ch == "{":
            depth -= 1
            if depth == 0 and end != -1:
                return text[i:end + 1]
    return None


def extract_weekly_plan_json(stdout: str) -> dict[str, Any] | None:
    """Pull the WeeklyPlan JSON out of an `omc ask` model's STDOUT.

    Three tiers, applied in order. Each tier independently checks the
    schema anchor `data['schema'] == 'weekly-plan/v1'` — if a tier
    extracts something but the anchor fails, we fall through to the
    next tier rather than returning a wrong-shape dict.

    Returns the parsed dict or None if no tier yielded a schema-anchored
    payload.
    """
    candidates: list[str] = []
    matches = _SENTINEL_RE.findall(stdout)
    if matches:
        candidates.append(matches[-1])
    fenced = _FENCED_RE.findall(stdout)
    if fenced:
        candidates.append(fenced[-1])
    bracey = _last_balanced_braces(stdout)
    if bracey is not None:
        candidates.append(bracey)

    for blob in candidates:
        try:
            data = json.loads(blob)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and data.get("schema") == "weekly-plan/v1":
            return data
    return None


# ─────────────────────────────────────────────────────────────────────────
# Prompt assembly
# ─────────────────────────────────────────────────────────────────────────


_SENTINEL_INSTRUCTIONS = """\
## 输出格式 (严格)

先输出完整 markdown 训练计划,然后在末尾输出 sentinel 包裹的 JSON:

<<<WEEKLY_PLAN_JSON_START>>>
{... WeeklyPlan.to_dict() output, schema='weekly-plan/v1' ...}
<<<WEEKLY_PLAN_JSON_END>>>

此 sentinel 之后不要输出任何其他内容。JSON 必须包含 schema='weekly-plan/v1' 字段;不带此字段的 JSON 视为 parse_failed。
"""


def build_prompt(
    *, user: str, week_folder: str,
    user_dir: Path, recent_weeks: int = 4,
) -> str:
    """Assemble the prompt body (excluding the sentinel instructions
    which `omc ask` doesn't need to see if the agent prompt already
    embeds them — but we always append the sentinel block to defend
    against agent-prompt drift).

    Reads pure local files: TRAINING_PLAN.md, recent N weekly plans +
    the most recent feedback. No DB calls — the CLI is offline-friendly.
    """
    parts: list[str] = []
    parts.append(f"# Generate weekly training plan for {week_folder}")
    parts.append(f"User: {user}")
    parts.append("")
    tp = user_dir / "TRAINING_PLAN.md"
    if tp.exists():
        parts.append("## TRAINING_PLAN.md (overall periodization)")
        parts.append(tp.read_text(encoding="utf-8"))
        parts.append("")
    logs = user_dir / "logs"
    if logs.is_dir():
        # Sort folder names lexicographically — names start with the
        # ISO date so this is also chronological.
        folders = sorted(
            (p for p in logs.iterdir() if p.is_dir()),
            key=lambda p: p.name,
            reverse=True,
        )
        # Skip the target folder itself if it exists.
        recent = [p for p in folders if p.name != week_folder][:recent_weeks]
        for folder in reversed(recent):  # oldest-first for reading flow
            plan_md = folder / "plan.md"
            fb_md = folder / "feedback.md"
            if plan_md.exists():
                parts.append(f"## Recent week {folder.name} — plan.md")
                parts.append(plan_md.read_text(encoding="utf-8"))
                parts.append("")
            if fb_md.exists():
                parts.append(f"## Recent week {folder.name} — feedback.md")
                parts.append(fb_md.read_text(encoding="utf-8"))
                parts.append("")
    parts.append(_SENTINEL_INSTRUCTIONS)
    return "\n".join(parts)


# ─────────────────────────────────────────────────────────────────────────
# Subprocess orchestration
# ─────────────────────────────────────────────────────────────────────────


@dataclass
class VariantResult:
    """Outcome of a single `omc ask <model>` subprocess invocation."""

    model_id: str
    content_md: str
    structured: dict[str, Any] | None
    parse_status: str            # 'fresh' | 'parse_failed'
    duration_s: float
    error: str | None = None     # set when subprocess failed (timeout / non-zero exit)


def run_omc_ask(
    model_id: str, prompt: str, *, timeout_s: int = 180,
) -> VariantResult:
    """Run `omc ask <model> --prompt-file <tmp>` and parse the result.

    On any subprocess failure (timeout / non-zero exit), returns a
    parse_failed VariantResult with the captured stderr in `error` and
    whatever stdout we got as content_md (so the user can still browse it).
    """
    started = time.monotonic()
    # Pipe via stdin to avoid temp-file lifecycle issues across platforms.
    cmd = ["omc", "ask", model_id, "--stdin"]
    try:
        proc = subprocess.run(
            cmd,
            input=prompt,
            capture_output=True,
            text=True,
            timeout=timeout_s,
            encoding="utf-8",
        )
    except subprocess.TimeoutExpired as e:
        elapsed = time.monotonic() - started
        return VariantResult(
            model_id=model_id,
            content_md=(e.stdout or "") if isinstance(e.stdout, str) else (
                e.stdout.decode("utf-8", "replace") if e.stdout else ""
            ),
            structured=None,
            parse_status="parse_failed",
            duration_s=elapsed,
            error=f"timeout after {timeout_s}s",
        )
    except FileNotFoundError:
        return VariantResult(
            model_id=model_id, content_md="",
            structured=None, parse_status="parse_failed",
            duration_s=0.0,
            error="omc command not found on PATH (install oh-my-claudecode)",
        )

    elapsed = time.monotonic() - started
    stdout = proc.stdout or ""
    if proc.returncode != 0:
        return VariantResult(
            model_id=model_id, content_md=stdout,
            structured=None, parse_status="parse_failed",
            duration_s=elapsed,
            error=f"exit {proc.returncode}: {(proc.stderr or '').strip()[:500]}",
        )

    structured = extract_weekly_plan_json(stdout)
    if structured is None:
        return VariantResult(
            model_id=model_id, content_md=stdout,
            structured=None, parse_status="parse_failed",
            duration_s=elapsed,
            error="no schema-anchored JSON found in output",
        )

    # Strip the sentinel block from content_md so the markdown stored
    # server-side doesn't include the JSON twice (the structured field
    # already carries it).
    content_md = _SENTINEL_RE.sub("", stdout).rstrip()
    # Also strip a trailing fenced ```json``` block if present
    # (some models produce both styles).
    content_md = _FENCED_RE.sub("", content_md).rstrip()
    return VariantResult(
        model_id=model_id,
        content_md=content_md,
        structured=structured,
        parse_status="fresh",
        duration_s=elapsed,
        error=None,
    )


# ─────────────────────────────────────────────────────────────────────────
# Server interaction
# ─────────────────────────────────────────────────────────────────────────


def _require_token(profile: str) -> dict[str, str]:
    """Return the Bearer header. Plan endpoints require auth (no anonymous
    fallback like commentary push has); we fail loudly on missing token.
    """
    headers = bearer_header(profile)
    if not headers:
        raise click.ClickException(
            f"No auth token for profile {profile!r}. "
            "Run: coros-sync auth login --email ... --auth-url ..."
        )
    return headers


def upload_variant(
    *, prod_url: str, profile: str, folder: str, result: VariantResult,
    prompt_hash: str,
) -> dict[str, Any]:
    """POST one variant to /api/{user}/plan/{folder}/variants. Returns
    the parsed response body. Raises click.ClickException on HTTP error.
    """
    structured: dict[str, Any] | None = None
    if result.structured is not None:
        # Re-validate via WeeklyPlan.from_dict so we never upload a
        # malformed dict the server would 400 on. Failures convert to
        # parse_failed (set above already), but defensive double-check.
        try:
            plan = WeeklyPlan.from_dict(result.structured)
            structured = plan.to_dict()
        except (KeyError, ValueError, TypeError) as e:
            console.print(
                f"[yellow]{result.model_id}: structured payload "
                f"failed local validation, demoting to parse_failed: {e}[/yellow]",
            )
            structured = None

    body = {
        "schema_version": SUPPORTED_SCHEMA_VERSION,
        "model_id": result.model_id,
        "content_md": result.content_md,
        "structured": structured,
        "generation_metadata": {
            "prompt_version": prompt_hash,
            "generation_duration_s": round(result.duration_s, 2),
            "parse_status": result.parse_status,
            "error": result.error,
        },
    }
    headers = _require_token(profile)
    url = f"{prod_url.rstrip('/')}/api/{profile}/plan/{folder}/variants"
    resp = httpx.post(url, headers=headers, json=body, timeout=60.0)
    if resp.status_code >= 400:
        raise click.ClickException(
            f"upload {result.model_id} → HTTP {resp.status_code}: {resp.text[:500]}"
        )
    return resp.json()


# ─────────────────────────────────────────────────────────────────────────
# `coros-sync plan` subcommands
# ─────────────────────────────────────────────────────────────────────────
#
# These commands are attached to the existing ``plan`` group in cli.py
# via ``register_subcommands(plan_group)`` at module-load time. We don't
# define a new @click.group() here because cli.py already exposes a
# ``plan`` group containing the ``reparse`` backfill command, and we
# want all subcommands under one ``coros-sync plan ...`` namespace.


def _profile_or_fail(ctx: click.Context) -> str:
    profile = ctx.obj.get("profile") if ctx.obj else None
    if not profile:
        raise click.UsageError("--profile / -P required (or COROS_PROFILE env)")
    return profile


def _prod_url(option_url: str | None) -> str:
    import os
    url = option_url or os.environ.get("STRIDE_PROD_URL")
    if not url:
        raise click.UsageError(
            "--prod-url required (or set STRIDE_PROD_URL env)"
        )
    return url


# ── generate-variants ────────────────────────────────────────────────────


@click.command("generate-variants")
@click.option("--week", "week_folder", required=True,
              help="Week folder name, e.g. 2026-05-04_05-10(P1W2)")
@click.option("--models", default="claude,codex,gemini", show_default=True,
              help="Comma-separated `omc ask` model ids")
@click.option("--prod-url", default=None,
              help="STRIDE prod URL (or set STRIDE_PROD_URL env)")
@click.option("--dry-run", is_flag=True,
              help="Parse + validate but don't POST. Prints what would be uploaded.")
@click.option("--timeout", default=180, show_default=True,
              help="Per-worker `omc ask` timeout in seconds")
@click.pass_context
def generate_variants(
    ctx: click.Context, week_folder: str, models: str,
    prod_url: str | None, dry_run: bool, timeout: int,
) -> None:
    """Fan out to N models via `omc ask`, parse output, upload each variant."""
    profile = _profile_or_fail(ctx)
    if not dry_run:
        url = _prod_url(prod_url)
    else:
        url = None  # not used

    from stride_core.db import USER_DATA_DIR
    user_dir = Path(USER_DATA_DIR) / profile
    if not user_dir.is_dir():
        raise click.ClickException(f"user dir not found: {user_dir}")

    prompt = build_prompt(user=profile, week_folder=week_folder, user_dir=user_dir)
    prompt_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()[:8]
    model_ids = [m.strip() for m in models.split(",") if m.strip()]
    if not model_ids:
        raise click.UsageError("--models must list at least one model id")

    console.print(
        f"Generating {len(model_ids)} variants for [cyan]{week_folder}[/cyan] "
        f"(profile={profile}, prompt_version={prompt_hash})…"
    )

    # Spawn parallel workers.
    results: list[VariantResult] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(model_ids)) as pool:
        futs = {
            pool.submit(run_omc_ask, m, prompt, timeout_s=timeout): m
            for m in model_ids
        }
        for fut in concurrent.futures.as_completed(futs):
            results.append(fut.result())

    # Sort by model_ids order for stable display.
    results.sort(key=lambda r: model_ids.index(r.model_id) if r.model_id in model_ids else 999)

    table = Table(title="Variant generation results")
    table.add_column("model")
    table.add_column("status")
    table.add_column("sessions", justify="right")
    table.add_column("duration", justify="right")
    table.add_column("notes", overflow="fold")
    for r in results:
        sess = (
            str(len(r.structured.get("sessions") or []))
            if r.structured else "—"
        )
        notes = r.error or ""
        status_col = (
            "[green]fresh[/green]" if r.parse_status == "fresh"
            else "[yellow]parse_failed[/yellow]"
        )
        table.add_row(r.model_id, status_col, sess,
                      f"{r.duration_s:.1f}s", notes)
    console.print(table)

    if dry_run:
        console.print("[dim](dry run — no upload)[/dim]")
        return

    # Upload sequentially. Server-side append-only supersede handles race-y
    # multi-POSTs but sequential is easier to reason about and the
    # workload is tiny (3 small POSTs).
    upload_summary: list[dict[str, Any]] = []
    for r in results:
        try:
            resp = upload_variant(
                prod_url=url, profile=profile, folder=week_folder,
                result=r, prompt_hash=prompt_hash,
            )
            upload_summary.append({"model_id": r.model_id, **resp})
        except click.ClickException as e:
            console.print(f"[red]{r.model_id} upload failed:[/red] {e}")
            upload_summary.append({"model_id": r.model_id, "error": str(e)})

    console.print("\n[bold]Upload summary:[/bold]")
    for u in upload_summary:
        console.print(f"  - {u}")


# ── list-variants ────────────────────────────────────────────────────────


@click.command("list-variants")
@click.option("--week", "week_folder", required=True)
@click.option("--prod-url", default=None)
@click.option("--include-superseded", is_flag=True)
@click.pass_context
def list_variants(
    ctx: click.Context, week_folder: str,
    prod_url: str | None, include_superseded: bool,
) -> None:
    """List variants for a week (server-side data — joins ratings)."""
    profile = _profile_or_fail(ctx)
    url = _prod_url(prod_url)
    headers = _require_token(profile)
    params = {"include_superseded": str(include_superseded).lower()}
    resp = httpx.get(
        f"{url.rstrip('/')}/api/{profile}/plan/{week_folder}/variants",
        headers=headers, params=params, timeout=30.0,
    )
    if resp.status_code >= 400:
        raise click.ClickException(
            f"list → HTTP {resp.status_code}: {resp.text[:500]}"
        )
    data = resp.json()
    variants = data.get("variants", [])
    if not variants:
        console.print("[dim](no variants)[/dim]")
        return
    table = Table(title=f"Variants for {week_folder}")
    table.add_column("idx", justify="right")
    table.add_column("variant_id", justify="right")
    table.add_column("model")
    table.add_column("status")
    table.add_column("sessions", justify="right")
    table.add_column("overall", justify="right")
    table.add_column("selected")
    table.add_column("selectable")
    for v in variants:
        idx = v.get("variant_index")
        ratings = v.get("ratings") or {}
        overall = ratings.get("overall", "—")
        sessions_n = len(v.get("sessions") or [])
        sel = "✓" if v.get("is_selected") else ""
        selectable = "yes" if v.get("selectable") else f"no ({v.get('unselectable_reason', '')})"
        status = v.get("variant_parse_status", "")
        table.add_row(
            str(idx) if idx is not None else "—",
            str(v["variant_id"]),
            v.get("model_id", ""),
            status, str(sessions_n), str(overall), sel, selectable,
        )
    console.print(table)


# ── rate ─────────────────────────────────────────────────────────────────


@click.command("rate")
@click.option("--variant-id", "variant_id", required=True, type=int)
@click.option("--prod-url", default=None)
@click.option("--overall", type=click.IntRange(1, 5), default=None)
@click.option("--suitability", type=click.IntRange(1, 5), default=None)
@click.option("--structure", type=click.IntRange(1, 5), default=None)
@click.option("--nutrition", type=click.IntRange(1, 5), default=None)
@click.option("--difficulty", type=click.IntRange(1, 5), default=None,
              help="Difficulty match (was 'difficulty-map' in plan)")
@click.option("--comment", default=None)
@click.pass_context
def rate(
    ctx: click.Context, variant_id: int, prod_url: str | None,
    overall: int | None, suitability: int | None, structure: int | None,
    nutrition: int | None, difficulty: int | None, comment: str | None,
) -> None:
    """Upsert per-dimension ratings for a variant."""
    profile = _profile_or_fail(ctx)
    url = _prod_url(prod_url)
    ratings: dict[str, int] = {}
    if overall is not None:      ratings["overall"]      = overall
    if suitability is not None:  ratings["suitability"]  = suitability
    if structure is not None:    ratings["structure"]    = structure
    if nutrition is not None:    ratings["nutrition"]    = nutrition
    if difficulty is not None:   ratings["difficulty"]   = difficulty
    if not ratings:
        raise click.UsageError(
            "Provide at least one of --overall/--suitability/--structure/"
            "--nutrition/--difficulty"
        )
    body: dict[str, Any] = {"ratings": ratings}
    if comment is not None:
        body["comment"] = comment
    headers = _require_token(profile)
    resp = httpx.post(
        f"{url.rstrip('/')}/api/{profile}/plan/variants/{variant_id}/rate",
        headers=headers, json=body, timeout=30.0,
    )
    if resp.status_code >= 400:
        raise click.ClickException(
            f"rate → HTTP {resp.status_code}: {resp.text[:500]}"
        )
    data = resp.json()
    console.print(f"variant {variant_id} ratings: {data.get('ratings', {})}")
    if data.get("rating_comment"):
        console.print(f"  comment: {data['rating_comment']}")


# ── select ───────────────────────────────────────────────────────────────


@click.command("select")
@click.option("--week", "week_folder", required=True)
@click.option("--variant-id", "variant_id", required=True, type=int)
@click.option("--prod-url", default=None)
@click.option("--force", is_flag=True,
              help="Override selection_conflict (will mark prior pushed sessions abandoned)")
@click.pass_context
def select(
    ctx: click.Context, week_folder: str, variant_id: int,
    prod_url: str | None, force: bool,
) -> None:
    """Promote a variant to canonical (FALLBACK design)."""
    profile = _profile_or_fail(ctx)
    url = _prod_url(prod_url)
    headers = _require_token(profile)
    body = {"variant_id": variant_id, "force": force}
    full_url = f"{url.rstrip('/')}/api/{profile}/plan/{week_folder}/select"

    resp = httpx.post(full_url, headers=headers, json=body, timeout=60.0)

    # Auto-retry once on 409 concurrent_select with Retry-After.
    if resp.status_code == 409:
        try:
            err_body = resp.json().get("detail", {})
        except json.JSONDecodeError:
            err_body = {}
        if err_body.get("error") == "concurrent_select":
            wait = int(resp.headers.get("Retry-After", "1"))
            console.print(
                f"[yellow]concurrent_select 409 — retrying in {wait}s…[/yellow]"
            )
            time.sleep(wait)
            resp = httpx.post(full_url, headers=headers, json=body, timeout=60.0)

    if resp.status_code == 409:
        # Either selection_conflict (still applicable) or concurrent_select
        # that retried and lost again.
        try:
            detail = resp.json().get("detail", {})
        except json.JSONDecodeError:
            detail = {}
        err = detail.get("error", "conflict")
        if err == "selection_conflict":
            n = detail.get("already_pushed_count", 0)
            hint = detail.get("hint", "")
            console.print(
                f"[red]409 selection_conflict[/red]: {n} session(s) already pushed."
            )
            if hint:
                console.print(f"  hint: {hint}")
            if not force:
                console.print(
                    "  Re-run with [cyan]--force[/cyan] to mark prior pushes "
                    "abandoned (you'll need to delete them on COROS manually)."
                )
            raise click.ClickException("selection conflict")
        raise click.ClickException(f"409 {err}: {detail}")
    if resp.status_code == 426:
        try:
            detail = resp.json().get("detail", {})
        except json.JSONDecodeError:
            detail = {}
        console.print(f"[red]426 schema_outdated[/red]: {detail}")
        raise click.ClickException("variant schema outdated — regenerate variants")
    if resp.status_code >= 400:
        raise click.ClickException(
            f"select → HTTP {resp.status_code}: {resp.text[:500]}"
        )
    data = resp.json()
    if data.get("no_change"):
        console.print(
            f"[dim]no_change: variant {variant_id} was already selected[/dim]"
        )
    else:
        dropped = data.get("dropped_scheduled_workout_ids", [])
        console.print(
            f"[green]selected variant {variant_id} for {week_folder}[/green]"
        )
        if dropped:
            console.print(
                f"  abandoned {len(dropped)} prior scheduled_workout(s): {dropped}"
            )
            console.print(
                "  → please open COROS App and delete the old [STRIDE] entries."
            )


# ── delete-variants ──────────────────────────────────────────────────────


@click.command("delete-variants")
@click.option("--week", "week_folder", required=True)
@click.option("--prod-url", default=None)
@click.option("--yes", is_flag=True, help="Skip confirmation prompt")
@click.pass_context
def delete_variants(
    ctx: click.Context, week_folder: str, prod_url: str | None, yes: bool,
) -> None:
    """Clear all variants (and their ratings) for a week."""
    profile = _profile_or_fail(ctx)
    url = _prod_url(prod_url)
    if not yes:
        click.confirm(
            f"Delete all variants + ratings for {profile}/{week_folder}?",
            abort=True,
        )
    headers = _require_token(profile)
    resp = httpx.delete(
        f"{url.rstrip('/')}/api/{profile}/plan/{week_folder}/variants",
        headers=headers, timeout=30.0,
    )
    if resp.status_code >= 400:
        raise click.ClickException(
            f"delete → HTTP {resp.status_code}: {resp.text[:500]}"
        )
    data = resp.json()
    n = data.get("deleted_variants", 0)
    console.print(f"[green]deleted {n} variant(s) for {week_folder}[/green]")


def register_subcommands(plan_group: click.Group) -> None:
    """Attach the multi-variant subcommands to an existing ``plan`` Click
    group (defined in cli.py alongside the legacy ``reparse`` command).
    """
    plan_group.add_command(generate_variants)
    plan_group.add_command(list_variants)
    plan_group.add_command(rate)
    plan_group.add_command(select)
    plan_group.add_command(delete_variants)
