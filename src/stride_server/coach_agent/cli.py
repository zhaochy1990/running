"""Standalone local CLI for evaluating the STRIDE coach agent."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

import click
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.syntax import Syntax
from rich.table import Table

from stride_core import db as core_db
from stride_core.db import Database
from stride_server.coach_agent.agent import apply_weekly_plan, run_agent
from stride_server.coach_agent.context import load_coach_context, summarize_context
from stride_server.coach_agent.model import get_generated_by, get_model_config
from stride_server.deps import parse_week_dates

console = Console()

_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _resolve_profile(profile: str | None, data_dir: Path | None = None) -> str | None:
    if profile is None:
        return None
    if _UUID4_RE.match(profile):
        return profile
    root = data_dir or core_db.USER_DATA_DIR
    aliases_file = root / ".slug_aliases.json"
    if aliases_file.exists():
        try:
            aliases = json.loads(aliases_file.read_text(encoding="utf-8"))
            if profile in aliases:
                return aliases[profile]
        except Exception:
            pass
    return profile


def _require_profile(ctx: click.Context) -> str:
    profile = ctx.obj["profile"]
    if not profile:
        raise click.ClickException("Use -P/--profile to select the user")
    return profile


def _discover_config_path(profile: str | None, explicit: str | None) -> Path | None:
    if explicit:
        path = Path(explicit)
        if not path.exists():
            raise click.ClickException(f"Coach config file not found: {path}")
        return path

    candidates: list[Path] = []
    if profile:
        candidates.append(core_db.USER_DATA_DIR / profile / "coach.json")
    candidates.extend([
        core_db.USER_DATA_DIR / "coach.json",
        Path(".stride-coach.json"),
    ])
    return next((p for p in candidates if p.exists()), None)


def _config_section(data: dict) -> dict:
    for key in ("azure_openai", "azureOpenAI", "model", "llm"):
        value = data.get(key)
        if isinstance(value, dict):
            return value
    return data


def _load_config_file(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise click.ClickException(f"Invalid coach config JSON: {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise click.ClickException("Coach config must be a JSON object")
    section = _config_section(data)
    if not isinstance(section, dict):
        raise click.ClickException("Coach config model section must be a JSON object")
    return section


def _set_env_if_value(name: str, value) -> None:
    if value is not None and value != "":
        os.environ[name] = str(value)


def _first_config_value(config: dict, *keys: str):
    for key in keys:
        value = config.get(key)
        if value is not None and value != "":
            return value
    return None


def _source(sync_before: bool):
    if not sync_before:
        return None
    try:
        from coros_sync.adapter import CorosDataSource
    except Exception as exc:
        raise click.ClickException(f"Cannot initialise COROS data source: {exc}") from exc
    return CorosDataSource()


def _validate_week(folder: str) -> str:
    if not parse_week_dates(folder):
        raise click.ClickException(f"Invalid week folder: {folder}")
    return folder


def _write_output(path: str | None, content: str) -> None:
    if not path:
        return
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(content, encoding="utf-8")
    console.print(f"[green]Wrote output to {out}[/green]")


def _render_result(title: str, content: str, *, markdown: bool) -> None:
    console.print(Panel.fit(title, style="cyan"))
    if markdown:
        console.print(Markdown(content))
    else:
        console.print(content)


def _apply_model_config_file(path: Path | None) -> None:
    if path is None:
        return
    config = _load_config_file(path)
    _set_env_if_value("STRIDE_COACH_LLM_PROVIDER", config.get("provider"))
    _set_env_if_value(
        "STRIDE_COACH_AZURE_OPENAI_ENDPOINT",
        _first_config_value(config, "endpoint", "resource_endpoint", "resourceEndpoint"),
    )
    _set_env_if_value(
        "STRIDE_COACH_AZURE_OPENAI_RESPONSES_URL",
        _first_config_value(config, "responses_url", "responsesUrl"),
    )
    _set_env_if_value("STRIDE_COACH_AZURE_OPENAI_DEPLOYMENT", config.get("deployment"))
    _set_env_if_value("STRIDE_COACH_AZURE_OPENAI_API_VERSION", _first_config_value(config, "api_version", "apiVersion"))
    _set_env_if_value("STRIDE_COACH_AZURE_OPENAI_API_KIND", _first_config_value(config, "api_kind", "apiKind"))
    _set_env_if_value("STRIDE_COACH_AUTH_MODE", _first_config_value(config, "auth", "auth_mode", "authMode"))
    _set_env_if_value("STRIDE_COACH_AZURE_OPENAI_API_KEY", _first_config_value(config, "api_key", "apiKey"))
    _set_env_if_value("STRIDE_COACH_AZURE_TENANT_ID", _first_config_value(config, "tenant_id", "tenantId"))
    _set_env_if_value("STRIDE_COACH_MAX_TOKENS", _first_config_value(config, "max_tokens", "maxTokens"))
    _set_env_if_value("STRIDE_COACH_TEMPERATURE", config.get("temperature"))
    _set_env_if_value(
        "STRIDE_COACH_TIMEOUT_SECONDS",
        _first_config_value(config, "timeout_seconds", "timeoutSeconds"),
    )


def _apply_model_overrides(
    *,
    endpoint: str | None,
    deployment: str | None,
    api_version: str | None,
    auth: str | None,
    api_key: str | None,
    tenant_id: str | None,
    max_tokens: int | None,
    temperature: float | None,
) -> None:
    _set_env_if_value("STRIDE_COACH_AZURE_OPENAI_ENDPOINT", endpoint)
    _set_env_if_value("STRIDE_COACH_AZURE_OPENAI_DEPLOYMENT", deployment)
    _set_env_if_value("STRIDE_COACH_AZURE_OPENAI_API_VERSION", api_version)
    _set_env_if_value("STRIDE_COACH_AUTH_MODE", auth)
    _set_env_if_value("STRIDE_COACH_AZURE_OPENAI_API_KEY", api_key)
    _set_env_if_value("STRIDE_COACH_AZURE_TENANT_ID", tenant_id)
    if max_tokens is not None:
        os.environ["STRIDE_COACH_MAX_TOKENS"] = str(max_tokens)
    if temperature is not None:
        os.environ["STRIDE_COACH_TEMPERATURE"] = str(temperature)


@click.group()
@click.option("-P", "--profile", default=None, envvar="COROS_PROFILE",
              help="User UUID or slug resolved via data/.slug_aliases.json.")
@click.option("--config", "config_path", default=None, envvar="STRIDE_COACH_CONFIG",
              help="Coach model config JSON. Defaults to data/{profile}/coach.json, data/coach.json, then .stride-coach.json.")
@click.option("--endpoint", default=None,
              help="Azure OpenAI resource endpoint or full /openai/responses URL.")
@click.option("--deployment", default=None, help="Azure OpenAI deployment name.")
@click.option("--api-version", default=None, help="Azure OpenAI API version.")
@click.option("--auth", type=click.Choice(["auto", "api-key", "credential"]), default=None,
              help="Auth mode override: API key, AAD credential, or auto.")
@click.option("--api-key", default=None, help="Azure OpenAI API key. Prefer env vars for secrets.")
@click.option("--tenant-id", default=None,
              help="AAD tenant for VS Code/Azure CLI credentials if needed.")
@click.option("--max-tokens", type=int, default=None, help="Max output tokens.")
@click.option("--temperature", type=float, default=None, help="Model temperature.")
@click.pass_context
def cli(
    ctx: click.Context,
    profile: str | None,
    config_path: str | None,
    endpoint: str | None,
    deployment: str | None,
    api_version: str | None,
    auth: str | None,
    api_key: str | None,
    tenant_id: str | None,
    max_tokens: int | None,
    temperature: float | None,
) -> None:
    """Evaluate the STRIDE coach agent locally."""
    ctx.ensure_object(dict)
    resolved_profile = _resolve_profile(profile)
    ctx.obj["profile"] = resolved_profile
    discovered_config = _discover_config_path(resolved_profile, config_path)
    ctx.obj["config_path"] = str(discovered_config) if discovered_config else None
    _apply_model_config_file(discovered_config)
    _apply_model_overrides(
        endpoint=endpoint,
        deployment=deployment,
        api_version=api_version,
        auth=auth,
        api_key=api_key,
        tenant_id=tenant_id,
        max_tokens=max_tokens,
        temperature=temperature,
    )


@cli.command("config")
def config_cmd() -> None:
    """Show resolved model config without printing secrets."""
    cfg = get_model_config()
    table = Table(title="stride-coach model config")
    table.add_column("Field", style="cyan")
    table.add_column("Value")
    table.add_row("Provider", cfg.provider)
    table.add_row("Deployment", cfg.deployment)
    table.add_row("Endpoint", cfg.endpoint)
    table.add_row("Responses URL", cfg.responses_url)
    table.add_row("API version", cfg.api_version)
    table.add_row("API kind", cfg.api_kind)
    table.add_row("Auth mode", cfg.auth_mode)
    table.add_row("Temperature", str(cfg.temperature))
    table.add_row("Max tokens", str(cfg.max_tokens or "default"))
    table.add_row("Timeout", f"{cfg.timeout_s}s")
    config_path = click.get_current_context().obj.get("config_path")
    table.add_row("Config file", config_path or "[dim]none[/dim]")
    console.print(table)


@cli.command("context")
@click.option("--folder", default=None, help="Week folder to include.")
@click.option("--sync/--no-sync", "sync_before", default=False, show_default=True)
@click.option("--json", "as_json", is_flag=True, help="Print full context JSON.")
@click.pass_context
def context_cmd(ctx: click.Context, folder: str | None, sync_before: bool, as_json: bool) -> None:
    """Load and display the deterministic agent context."""
    profile = _require_profile(ctx)
    if folder:
        _validate_week(folder)
    context = load_coach_context(
        profile,
        folder=folder,
        source=_source(sync_before),
        sync_before=sync_before,
    )
    data = context if as_json else summarize_context(context)
    console.print(Syntax(json.dumps(data, ensure_ascii=False, indent=2, default=str), "json"))


@cli.command("chat")
@click.argument("message")
@click.option("--folder", default=None, help="Week folder to include.")
@click.option("--sync/--no-sync", "sync_before", default=True, show_default=True)
@click.option("--output", "-o", default=None, help="Write answer markdown to file.")
@click.option("--plain", is_flag=True, help="Do not render Markdown.")
@click.pass_context
def chat_cmd(
    ctx: click.Context,
    message: str,
    folder: str | None,
    sync_before: bool,
    output: str | None,
    plain: bool,
) -> None:
    """Ask a day-to-day training question."""
    profile = _require_profile(ctx)
    if folder:
        _validate_week(folder)
    result = run_agent(
        profile,
        task="chat",
        user_message=message,
        folder=folder,
        source=_source(sync_before),
        sync_before=sync_before,
    )
    _write_output(output, result.content)
    _render_result(f"stride-coach chat [{result.model}]", result.content, markdown=not plain)


@cli.command("weekly-plan")
@click.argument("folder")
@click.option("--intent", default="请基于当前训练阶段和最新数据生成本周训练计划。")
@click.option("--sync/--no-sync", "sync_before", default=True, show_default=True)
@click.option("--output", "-o", default=None, help="Write plan markdown to file.")
@click.option("--plain", is_flag=True, help="Do not render Markdown.")
@click.pass_context
def weekly_plan_cmd(
    ctx: click.Context,
    folder: str,
    intent: str,
    sync_before: bool,
    output: str | None,
    plain: bool,
) -> None:
    """Generate a weekly plan draft; does not save it."""
    profile = _require_profile(ctx)
    folder = _validate_week(folder)
    result = run_agent(
        profile,
        task="weekly_plan",
        user_message=intent,
        folder=folder,
        source=_source(sync_before),
        sync_before=sync_before,
    )
    _write_output(output, result.content)
    _render_result(f"weekly plan draft [{result.model}]", result.content, markdown=not plain)


@cli.command("adjust-plan")
@click.argument("folder")
@click.option("--feedback", required=True, help="User feedback driving the adjustment.")
@click.option("--constraints", default=None, help="Optional extra constraints.")
@click.option("--sync/--no-sync", "sync_before", default=True, show_default=True)
@click.option("--output", "-o", default=None, help="Write draft markdown to file.")
@click.option("--apply", "apply_now", is_flag=True,
              help="Persist the generated draft as the DB plan override immediately.")
@click.option("--plain", is_flag=True, help="Do not render Markdown.")
@click.pass_context
def adjust_plan_cmd(
    ctx: click.Context,
    folder: str,
    feedback: str,
    constraints: str | None,
    sync_before: bool,
    output: str | None,
    apply_now: bool,
    plain: bool,
) -> None:
    """Generate a plan-adjustment draft; save only with --apply."""
    profile = _require_profile(ctx)
    folder = _validate_week(folder)
    parts = [f"用户反馈：{feedback}"]
    if constraints:
        parts.append(f"额外约束：{constraints}")
    result = run_agent(
        profile,
        task="plan_adjustment",
        user_message="\n".join(parts),
        folder=folder,
        source=_source(sync_before),
        sync_before=sync_before,
    )
    _write_output(output, result.content)
    _render_result(f"plan adjustment draft [{result.model}]", result.content, markdown=not plain)
    if apply_now:
        row = apply_weekly_plan(profile, folder, result.content, generated_by=result.model)
        console.print(f"[green]Saved DB plan override for {row['week']} generated_by={row['generated_by']}[/green]")
    else:
        console.print("[yellow]Draft only. Use `stride-coach apply-plan` or rerun with --apply to save.[/yellow]")


@cli.command("apply-plan")
@click.argument("folder")
@click.option("--from-file", "from_file", required=True,
              type=click.Path(exists=True, dir_okay=False),
              help="Markdown file to save as the DB plan override.")
@click.option("--generated-by", default=None, help="Author/model stamp. Defaults to active deployment.")
@click.pass_context
def apply_plan_cmd(ctx: click.Context, folder: str, from_file: str, generated_by: str | None) -> None:
    """Persist a confirmed markdown plan as the DB override."""
    profile = _require_profile(ctx)
    folder = _validate_week(folder)
    content = Path(from_file).read_text(encoding="utf-8")
    row = apply_weekly_plan(profile, folder, content, generated_by=generated_by or get_generated_by())
    console.print(f"[green]Saved DB plan override for {row['week']} generated_by={row['generated_by']}[/green]")
