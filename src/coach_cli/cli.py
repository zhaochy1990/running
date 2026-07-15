"""Interactive coach REPL (S0+S1 spine) — see package docstring.

Requires:
- Credentials for the models selected by ``STRIDE_COACH_CONFIG_PATH`` (or the
  default local config). Azure managed-identity configs need ``az login``;
  API-key configs need their declared ``api_key_env``.
- A synced ``data/{user_id}/coros.db`` — the status_insight specialist's read
  tools open it. Without it, status_insight degrades to a failure reply (the
  REPL stays alive).

Session state persists to a local file checkpointer under
``~/.coach-cli/checkpoints`` so multi-turn context survives within a session
id (and across runs that reuse ``--session``).
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
import uuid
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

try:
    import readline as _readline
except ImportError:  # pragma: no cover - unavailable on some platforms
    _readline = None

import click
from rich.console import Console
from rich.markdown import Markdown
from rich.text import Text

import stride_core.db as _coredb
from stride_core.master_plan_diff import MasterPlanDiff
from stride_core.timefmt import utc_iso_to_shanghai_iso

# Our trace loggers (DEBUG when --debug). Third-party stays at WARNING so the
# httpx / azure / openai request spam doesn't drown the orchestration trace.
_TRACE_LOGGERS = (
    "coach.runtime.latency",
    "coach.graphs.conversation.graph",
    "coach.graphs.conversation.tool_bridge",
    "coach.orchestrator.graph",
    "coach.orchestrator.dispatcher",
    "stride_server.coach_adapters.orchestrator.status_insight",
    "stride_server.coach_adapters.orchestrator.weekly_plan",
    "stride_server.coach_adapters.orchestrator.season_plan",
    "coach_cli",
)
_NOISY_LOGGERS = ("httpx", "httpcore", "openai", "azure", "urllib3", "langchain", "langgraph")

# langchain_openai's with_structured_output re-serialises the response's parsed
# field and pydantic emits a cosmetic "serializer warnings" UserWarning. The
# Resolver draft itself parses fine; silence the noise for a clean REPL.
warnings.filterwarnings(
    "ignore",
    message="Pydantic serializer warnings",
    category=UserWarning,
    module="pydantic.main",
)

_UUID4_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
)
_COACH_CLI_HOME = Path.home() / ".coach-cli"
_CHECKPOINT_DIR = _COACH_CLI_HOME / "checkpoints"

_HELP = """\
命令:
  /new       开一个新会话（清空上下文）
  /session   列出历史会话，选择并恢复其中一个
  /proposals 查看当前待选的赛季调整方案
  /apply N   应用第 N 个赛季调整方案的全部改动
  /dismiss   放弃当前待选方案
  /help      显示这个帮助
  /exit /quit 退出
  ↑          加载上一条发送给教练的输入
直接输入文字 = 跟教练对话。
"""


def _resolve_profile(profile: str, data_dir: Path | None = None) -> str:
    """Resolve a slug to a UUID via data/.slug_aliases.json (mirrors coros_sync)."""
    if _UUID4_RE.match(profile):
        return profile
    root = data_dir or _coredb.USER_DATA_DIR
    aliases_file = root / ".slug_aliases.json"
    if aliases_file.exists():
        try:
            aliases = json.loads(aliases_file.read_text(encoding="utf-8"))
            if profile in aliases:
                return aliases[profile]
        except Exception:  # noqa: BLE001 — fall back to the literal slug
            pass
    return profile


def _new_session_id() -> str:
    return f"cli-{uuid.uuid4().hex[:8]}"


@dataclass(frozen=True)
class _SessionSummary:
    session_id: str
    updated_at: str | None


class _InputHistory:
    """Enable arrow-key history containing only messages sent to Coach."""

    def __init__(self, backend) -> None:
        self._backend = backend
        self._manual_history = False
        self._previous_entries: list[str] = []

    def start(self) -> None:
        required_methods = (
            "add_history",
            "clear_history",
            "get_current_history_length",
            "get_history_item",
            "set_auto_history",
        )
        if self._backend is None or not all(
            hasattr(self._backend, method) for method in required_methods
        ):
            return
        history_length = self._backend.get_current_history_length()
        self._previous_entries = [
            self._backend.get_history_item(index)
            for index in range(1, history_length + 1)
        ]
        self._backend.clear_history()
        self._backend.set_auto_history(False)
        self._manual_history = True

    def remember(self, line: str) -> None:
        if self._manual_history:
            self._backend.add_history(line)

    def close(self) -> None:
        if not self._manual_history:
            return
        self._backend.clear_history()
        for entry in self._previous_entries:
            self._backend.add_history(entry)
        self._backend.set_auto_history(True)
        self._manual_history = False


def _list_sessions(
    *,
    checkpointer,
    user_id: str,
    current_session_id: str,
) -> list[_SessionSummary]:
    """Return this user's coach sessions, most recently used first."""
    thread_prefix = f"{user_id}:coach:"
    rows = checkpointer.store.list_latest_checkpoint_rows(thread_prefix)
    sessions = [
        _SessionSummary(
            session_id=row.thread_id.removeprefix(thread_prefix),
            updated_at=row.created_at,
        )
        for row in rows
    ]
    if all(session.session_id != current_session_id for session in sessions):
        sessions.insert(0, _SessionSummary(current_session_id, None))
    return sessions


def _format_session_time(value: str | None) -> str:
    if value is None:
        return "尚无消息"
    local = utc_iso_to_shanghai_iso(value) or value
    return f"{local[:16].replace('T', ' ')} 上海"


def _select_session(
    *,
    checkpointer,
    user_id: str,
    current_session_id: str,
    prompt: Callable[[str], str] = input,
) -> str:
    """Show the session picker and return the selected session id."""
    sessions = _list_sessions(
        checkpointer=checkpointer,
        user_id=user_id,
        current_session_id=current_session_id,
    )
    click.echo("会话列表（最近使用优先）:")
    for index, session in enumerate(sessions, start=1):
        current = "  ← 当前" if session.session_id == current_session_id else ""
        click.echo(
            f"  {index}. {session.session_id}  "
            f"{_format_session_time(session.updated_at)}{current}"
        )

    while True:
        try:
            answer = prompt("选择编号恢复（Enter 取消） › ").strip()
        except (EOFError, KeyboardInterrupt):
            click.echo("\n已取消")
            return current_session_id
        if not answer:
            click.echo("已取消")
            return current_session_id
        if answer.isdigit() and 1 <= int(answer) <= len(sessions):
            selected = sessions[int(answer) - 1].session_id
            if selected == current_session_id:
                click.echo(f"继续当前会话: {selected}")
            else:
                click.echo(f"已恢复会话: {selected}")
            return selected
        click.echo(f"请输入 1-{len(sessions)}，或按 Enter 取消。")


def _model_banner() -> str:
    """Describe the configured orchestrator + specialist without stale literals."""
    from coach.runtime.config import load_config

    cfg = load_config()
    orchestrator = cfg.for_role("orchestrator")
    status = cfg.for_role("status_insight")
    planner = cfg.generator
    return (
        f"编排={orchestrator.model} ({orchestrator.api_kind}) · "
        f"状态={status.model} ({status.api_kind}) · "
        f"计划={planner.model} ({planner.api_kind})"
    )


def _setup_debug_logging() -> None:
    """Route our orchestration trace loggers to stderr at DEBUG, keep 3rd-party quiet."""
    handler = logging.StreamHandler()
    handler.setFormatter(
        logging.Formatter(
            "  %(asctime)s.%(msecs)03d · %(name)s | %(message)s", datefmt="%H:%M:%S"
        )
    )
    root = logging.getLogger()
    root.setLevel(logging.WARNING)  # third-party default
    root.addHandler(handler)
    for name in _NOISY_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)
    for name in _TRACE_LOGGERS:
        logging.getLogger(name).setLevel(logging.DEBUG)


def _build_checkpointer():
    """Local file-backed checkpointer (no Azure Table needed for dev)."""
    from stride_server.coach_adapters.persistence.checkpointer import (
        AzureTableCheckpointSaver,
    )
    from stride_server.coach_adapters.persistence.file_backend import (
        FileCheckpointStore,
    )

    return AzureTableCheckpointSaver(store=FileCheckpointStore(_CHECKPOINT_DIR))


def _format_turn(turn) -> str:
    """Render a TurnResponse as stable plain text for pipes/files."""
    lines: list[str] = []
    if turn.clarification:
        lines.append(f"❓ {turn.clarification}")
    else:
        lines.append(turn.reply or "(空回复)")
    lines.extend(f"  {line}" for line in _turn_metadata(turn))
    return "\n".join(lines)


def _turn_metadata(turn) -> list[str]:
    """Build the compact non-Markdown lines appended after the reply."""
    lines: list[str] = []
    master_index = 0
    for card in turn.proposals:
        proposal = card.proposal
        n_ops = len(getattr(proposal, "ops", []) or [])
        explanation = getattr(proposal, "ai_explanation", "") or ""
        if card.specialist_id == "season_plan" and isinstance(
            proposal, MasterPlanDiff
        ):
            master_index += 1
            label = f"提案 {master_index}[season_plan]"
        else:
            # Only season-plan proposals are accepted by `/apply N`; keep all
            # other specialist cards visible without assigning an apply index.
            label = f"提案[{card.specialist_id}]"
        lines.append(
            f"📋 {label} · {n_ops} 处改动 — {explanation}"
        )
    if turn.active_target:
        lines.append(f"· 当前对象: {turn.active_target.model_dump(exclude_none=True)}")
    return lines


def _stdout_is_terminal() -> bool:
    """Return whether stdout is an interactive terminal."""
    stream = click.get_text_stream("stdout")
    isatty = getattr(stream, "isatty", None)
    return bool(isatty and isatty())


def _print_turn(
    turn,
    *,
    interactive: bool,
    render_markdown: bool | None = None,
    console: Console | None = None,
) -> None:
    """Print a turn, rendering Markdown only for an interactive terminal.

    Redirected stdout remains the stable raw Markdown/plain-text contract so
    shell pipelines and files do not receive terminal layout or ANSI escapes.
    ``render_markdown`` and ``console`` are injectable for focused tests.
    """
    should_render = _stdout_is_terminal() if render_markdown is None else render_markdown
    if not should_render:
        prefix = "\n教练 › " if interactive else ""
        click.echo(f"{prefix}{_format_turn(turn)}")
        return

    output = console or Console(
        file=click.get_text_stream("stdout"),
        highlight=False,
    )
    if interactive:
        output.print()
        output.print(Text("教练 ›", style="bold cyan"))

    if turn.clarification:
        output.print(Text("❓ 需要补充信息", style="bold yellow"))
        output.print(Markdown(turn.clarification))
    else:
        output.print(Markdown(turn.reply or "(空回复)"))

    for line in _turn_metadata(turn):
        output.print(Text(f"  {line}", style="dim"))


class _Thinking:
    """Live elapsed-time 'thinking' indicator around a turn.

    Non-debug: a background thread live-updates a single line
    (``（思考中… 3.2s）``). Debug: no live spinner (it would clobber the trace
    log lines with carriage returns) — prints a static marker, and on exit the
    total elapsed (complementing the per-stage timings in the trace).
    """

    def __init__(self, *, debug: bool, label: str = "思考中") -> None:
        self._debug = debug
        self._label = label
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._start = 0.0

    def __enter__(self) -> "_Thinking":
        self._start = time.perf_counter()
        if self._debug:
            click.echo(f"  （{self._label}…）")
        else:
            self._thread = threading.Thread(target=self._spin, daemon=True)
            self._thread.start()
        return self

    def _spin(self) -> None:
        while not self._stop.wait(0.1):
            click.echo(f"\r  （{self._label}… {time.perf_counter() - self._start:.1f}s）", nl=False)

    def __exit__(self, *exc: object) -> bool:
        elapsed = time.perf_counter() - self._start
        if self._thread is not None:
            self._stop.set()
            self._thread.join(timeout=0.5)
            # trailing spaces clear any leftover chars from the longest frame
            click.echo(f"\r  （{self._label}… {elapsed:.1f}s 完成）        ")
        else:
            click.echo(f"  （用时 {elapsed:.1f}s）")
        return False


def _friendly_error(exc: Exception) -> str:
    """Translate common infra failures into an actionable hint."""
    s = str(exc)
    low = s.lower()
    if "tenant" in low and "does not match" in low:
        return (
            "Azure 租户不匹配 —— az login 的租户与资源租户不一致。\n"
            "  修复: az login --tenant 72f988bf-86f1-41af-91ab-2d7cd011db47  （用 @microsoft.com 账号）\n"
            f"  原始: {s}"
        )
    if any(k in low for k in ("defaultazurecredential", "azureclicredential", "az login", "no credential", "token")):
        return f"拿不到 Azure 凭据 —— 先 `az login`（正确租户）。\n  原始: {s}"
    if any(k in low for k in ("getaddrinfo", "connection", "timed out", "timeout", "ssl", "proxy")):
        return f"网络/连接失败 —— 检查网络或代理。\n  原始: {s}"
    if "deployment" in low and ("not found" in low or "does not exist" in low):
        return f"模型部署名不对 —— 检查 config/coach.local.toml 的 deployment。\n  原始: {s}"
    return s


def _run_turn(*, user_id: str, session_id: str, message: str, checkpointer):
    # Lazy import: pulls in azure-identity + langchain, slow to import.
    from stride_server.coach_adapters.orchestrator import run_coach_turn

    return run_coach_turn(
        user_id=user_id,
        session_id=session_id,
        message=message,
        checkpointer=checkpointer,
    )


def _master_proposals(turn) -> list[MasterPlanDiff]:
    """Return only season-plan proposals that the CLI can apply directly."""
    return [
        card.proposal
        for card in turn.proposals
        if card.specialist_id == "season_plan"
        and isinstance(card.proposal, MasterPlanDiff)
    ]


def _apply_master_proposal(*, user_id: str, proposal: MasterPlanDiff) -> dict:
    """Apply every op in a selected stateless season proposal."""
    from stride_server.routes.coach import (
        CoachMasterApplyRequest,
        apply_coach_master_diff,
    )

    return apply_coach_master_diff(
        proposal.plan_id,
        CoachMasterApplyRequest(
            diff=proposal,
            accepted_op_ids=[op.id for op in proposal.ops],
            change_reason="coach CLI selected proposal",
        ),
        payload={"sub": user_id},
    )


@click.command()
@click.option(
    "-P",
    "--profile",
    default="zhaochaoyi",
    envvar="COROS_PROFILE",
    help="用户标识 — UUID 或 data/.slug_aliases.json 里的 slug。",
)
@click.option(
    "--session",
    "session_id",
    default=None,
    help="复用一个 session id（默认每次随机新建）。",
)
@click.option(
    "-m",
    "--message",
    default=None,
    help="非交互模式：发一句、打印回复、退出（适合脚本/管道）。",
)
@click.option(
    "-v",
    "--debug",
    is_flag=True,
    default=False,
    help="打印编排各阶段 trace（意图/计划/分派/各阶段耗时），第三方 HTTP 日志保持静默。",
)
@click.option(
    "--data-dir",
    default=None,
    help="读工具的数据根目录（默认 <项目>/data）。在 git worktree 里测试时指向主仓库的 data，"
    "例如 C:/Users/zhaochaoyi/workspace/running/data，避免 worktree 里 coros.db 是空的。",
)
def main(
    profile: str,
    session_id: str | None,
    message: str | None,
    debug: bool,
    data_dir: str | None,
) -> None:
    """与 STRIDE 教练对话（本地测试 S0+S1 编排脑）。"""
    if debug:
        _setup_debug_logging()

    # Redirect every read tool's DB root (status_insight opens data/{uid}/coros.db).
    # Done before resolving the profile / building the toolkit so it takes effect.
    if data_dir:
        _coredb.USER_DATA_DIR = Path(data_dir).resolve()
    data_root = _coredb.USER_DATA_DIR

    user_id = _resolve_profile(profile, data_dir=data_root)
    session_id = session_id or _new_session_id()
    checkpointer = _build_checkpointer()

    db_path = data_root / user_id / "coros.db"
    if not db_path.exists():
        click.echo(
            f"⚠️  {db_path} 不存在 — status_insight 读工具会返回空。"
            f"先 `python -m coros_sync -P {profile} sync`，或用 --data-dir 指向已同步的 data。",
            err=True,
        )
    elif db_path.stat().st_size < 1_000_000:  # < 1MB ≈ schema-only skeleton
        click.echo(
            f"⚠️  {db_path} 只有 {db_path.stat().st_size // 1024}KB，疑似空库（worktree 没同步过）。"
            f"用 --data-dir 指向主仓库的 data，例如：--data-dir C:/Users/zhaochaoyi/workspace/running/data",
            err=True,
        )

    # Non-interactive one-shot.
    if message is not None:
        t0 = time.perf_counter()
        try:
            turn = _run_turn(
                user_id=user_id, session_id=session_id, message=message, checkpointer=checkpointer
            )
        except Exception as exc:  # noqa: BLE001 — surface a friendly error
            raise SystemExit(f"❌ 教练调用失败: {_friendly_error(exc)}")
        _print_turn(turn, interactive=False)
        # Elapsed to stderr so piped stdout stays clean.
        click.echo(f"（用时 {time.perf_counter() - t0:.1f}s）", err=True)
        return

    # Interactive REPL.
    click.echo("─" * 60)
    click.echo("  STRIDE 教练 CLI · S0+S1 编排脑（本地测试）")
    click.echo(f"  user: {user_id}")
    click.echo(f"  session: {session_id}")
    click.echo(f"  data: {db_path}")
    click.echo(f"  {_model_banner()} · /help 看命令")
    click.echo("─" * 60)

    input_history = _InputHistory(_readline)
    input_history.start()
    pending_proposals: list[MasterPlanDiff] = []
    try:
        while True:
            try:
                line = input("\n你 › ").strip()
            except (EOFError, KeyboardInterrupt):
                click.echo("\n再见 👋")
                return

            if not line:
                continue
            if line in ("/exit", "/quit"):
                click.echo("再见 👋")
                return
            if line == "/help":
                click.echo(_HELP)
                continue
            if line == "/session":
                session_id = _select_session(
                    checkpointer=checkpointer,
                    user_id=user_id,
                    current_session_id=session_id,
                )
                pending_proposals = []
                continue
            if line == "/new":
                session_id = _new_session_id()
                pending_proposals = []
                click.echo(f"已开新会话: {session_id}")
                continue
            if line == "/proposals":
                if not pending_proposals:
                    click.echo("当前没有待选的赛季调整方案。")
                else:
                    for index, proposal in enumerate(pending_proposals, start=1):
                        click.echo(
                            f"{index}. {proposal.ai_explanation}（{len(proposal.ops)} 处改动）"
                        )
                continue
            if line == "/dismiss":
                pending_proposals = []
                click.echo("已放弃当前待选方案。")
                continue
            if line.startswith("/apply"):
                parts = line.split()
                if len(parts) != 2 or not parts[1].isdigit():
                    click.echo("用法: /apply N（例如 /apply 2）")
                    continue
                if not pending_proposals:
                    click.echo("当前没有待选的赛季调整方案。")
                    continue
                selected = int(parts[1])
                if selected < 1 or selected > len(pending_proposals):
                    click.echo(f"方案编号无效，请输入 1-{len(pending_proposals)}。")
                    continue
                try:
                    result = _apply_master_proposal(
                        user_id=user_id, proposal=pending_proposals[selected - 1]
                    )
                except Exception as exc:  # noqa: BLE001 — keep the REPL alive
                    click.echo(f"❌ 应用失败: {_friendly_error(exc)}")
                    continue
                pending_proposals = []
                click.echo(
                    f"✅ 方案 {selected} 已应用，训练计划已更新至 v{result.get('version', '?')}。"
                )
                continue

            input_history.remember(line)
            try:
                with _Thinking(debug=debug):
                    turn = _run_turn(
                        user_id=user_id,
                        session_id=session_id,
                        message=line,
                        checkpointer=checkpointer,
                    )
            except Exception as exc:  # noqa: BLE001 — keep the REPL alive
                click.echo(f"❌ 调用失败: {_friendly_error(exc)}")
                continue

            _print_turn(turn, interactive=True)
            pending_proposals = _master_proposals(turn)
    finally:
        input_history.close()


if __name__ == "__main__":
    main()
