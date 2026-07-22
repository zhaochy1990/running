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
from typing import Any, Callable

try:
    import readline as _readline
except ImportError:  # pragma: no cover - unavailable on some platforms
    _readline = None

import click

import stride_core.db as _coredb
from coach_cli.proposals import (
    Proposal,
    applicable_proposals as _applicable_proposals,
    print_proposals as _print_proposals,
    print_turn as _print_turn,
)
from stride_core.master_plan_diff import MasterPlanDiff, MasterPlanDiffOpKind
from stride_core.plan_diff import DiffOpKind, PlanDiff
from stride_core.timefmt import utc_iso_to_shanghai_iso
from stride_core.weekly_plan_proposal import WeeklyPlanCreateProposal

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
  /proposals 查看当前待确认的计划提案
  /apply N   应用第 N 个周计划或赛季计划提案（唯一写入入口）
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
    checkpointer: Any,
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
    checkpointer: Any,
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
        is_ascii_index = answer.isascii() and answer.isdigit() and len(answer) <= 9
        if is_ascii_index and 1 <= int(answer) <= len(sessions):
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


def _build_checkpointer() -> Any:
    """Local file-backed checkpointer (no Azure Table needed for dev)."""
    from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
    from stride_server.coach_adapters.persistence.checkpointer import (
        AzureTableCheckpointSaver,
    )
    from stride_server.coach_adapters.persistence.file_backend import (
        FileCheckpointStore,
    )

    # Checkpoints contain Pydantic ``model_dump`` output whose enum members are
    # reconstructed by msgpack.  Keep the allow-list explicit so LangGraph does
    # not print a permissive-deserialisation warning into the interactive REPL.
    serde = JsonPlusSerializer(
        allowed_msgpack_modules=[
            DiffOpKind,
            MasterPlanDiffOpKind,
        ]
    )
    return AzureTableCheckpointSaver(
        store=FileCheckpointStore(_CHECKPOINT_DIR), serde=serde
    )


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


def _weekly_review_anchor(
    proposals: tuple[Proposal, ...],
) -> tuple[Any, dict[str, Any]] | None:
    """Build ``(target, review_context)`` for a pending weekly-create draft.

    Mirrors the web review workspace: while an unapplied weekly-create proposal
    is pending, a follow-up question ("周六力量练什么") must be answered from the
    in-memory draft — the plan was never saved, so ``get_week_plan`` would find
    nothing. Re-attaching the proposal as ``review_context`` (anchored to its
    week ``target``) makes ``status_insight`` answer from the draft JSON instead.

    Returns ``None`` when no weekly-create proposal is pending — an existing-week
    ``PlanDiff`` / master diff has no review-context contract, and turns without
    a draft must not be forced onto one. Also returns ``None`` if the draft fails
    to serialise (e.g. exceeds the review-context size cap) so the REPL degrades
    to an ordinary turn instead of crashing.
    """
    # Lazy import mirrors the file's discipline (coach modules stay off the hot
    # import path); coach.contracts itself is pure pydantic, no heavy deps.
    from coach.contracts import TargetRef, WeeklyCreateReviewContext

    for proposal in proposals:
        if not isinstance(proposal, WeeklyPlanCreateProposal):
            continue
        try:
            review_context = WeeklyCreateReviewContext(
                proposal=proposal
            ).model_dump(mode="json")
        except ValueError:
            return None
        return TargetRef(kind="week", folder=proposal.folder), review_context
    return None


def _run_turn(
    *,
    user_id: str,
    session_id: str,
    message: str,
    checkpointer: Any,
    target: Any | None = None,
    review_context: dict[str, Any] | None = None,
) -> Any:
    # Lazy import: pulls in azure-identity + langchain, slow to import.
    from stride_server.coach_adapters.orchestrator import run_coach_turn

    # The CLI only renders the TurnResponse; the HTTP layer consumes the stable
    # assistant_message identity that also rides on the result. ``target`` /
    # ``review_context`` carry a pending weekly-create draft into follow-up turns
    # so the drafted week can be discussed before it is applied.
    return run_coach_turn(
        user_id=user_id,
        session_id=session_id,
        message=message,
        checkpointer=checkpointer,
        target=target,
        review_context=review_context,
    ).turn_response


def _apply_result_message(
    *,
    proposal: MasterPlanDiff | PlanDiff | WeeklyPlanCreateProposal,
    result: dict,
    selected: int,
) -> str:
    if isinstance(proposal, MasterPlanDiff):
        suffix = f"训练计划已更新至 v{result.get('version', '?')}。"
        affected = result.get("affected_weeks") or []
        if affected:
            suffix += f"\n⚠️  {len(affected)} 个周计划可能仍含旧总纲目标，请按需重新生成。"
    elif result.get("created"):
        suffix = f"周计划 {result.get('folder', '')} 已创建。"
    else:
        suffix = f"周计划 {result.get('folder', '')} 已更新。"
    return f"✅ 方案 {selected} 已应用，{suffix}"


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


def _apply_week_proposal(
    *, user_id: str, proposal: PlanDiff | WeeklyPlanCreateProposal
) -> dict:
    """Create a week or apply every op in an existing-week adjustment."""
    from stride_server.routes.coach import (
        CoachWeekApplyRequest,
        apply_coach_week_diff,
    )

    if isinstance(proposal, WeeklyPlanCreateProposal):
        body = CoachWeekApplyRequest(proposal=proposal)
    else:
        body = CoachWeekApplyRequest(
            diff=proposal,
            accepted_op_ids=[
                op.id for op in proposal.ops if op.accepted is not False
            ],
        )
    return apply_coach_week_diff(
        proposal.folder, body, payload={"sub": user_id}
    )


def _apply_proposal(*, user_id: str, proposal: Proposal) -> dict:
    if isinstance(proposal, MasterPlanDiff):
        return _apply_master_proposal(user_id=user_id, proposal=proposal)
    return _apply_week_proposal(user_id=user_id, proposal=proposal)


@dataclass(frozen=True)
class _ReplState:
    session_id: str
    pending_proposals: tuple[Proposal, ...] = ()


@dataclass(frozen=True)
class _CommandOutcome:
    handled: bool
    state: _ReplState
    should_exit: bool = False


def _apply_pending(
    *, user_id: str, state: _ReplState, selected: int
) -> _CommandOutcome:
    proposals = state.pending_proposals
    if not proposals:
        click.echo("当前没有待确认的计划提案。")
        return _CommandOutcome(True, state)
    if selected < 1 or selected > len(proposals):
        click.echo(f"方案编号无效，请输入 1-{len(proposals)}。")
        return _CommandOutcome(True, state)
    proposal = proposals[selected - 1]
    try:
        result = _apply_proposal(user_id=user_id, proposal=proposal)
    except Exception as exc:  # noqa: BLE001 — keep the REPL alive
        click.echo(f"❌ 应用失败: {_friendly_error(exc)}")
        return _CommandOutcome(True, state)
    click.echo(_apply_result_message(proposal=proposal, result=result, selected=selected))
    return _CommandOutcome(True, _ReplState(state.session_id))


def _handle_slash_command(
    *, line: str, user_id: str, state: _ReplState, checkpointer
) -> _CommandOutcome:
    if line in ("/exit", "/quit"):
        click.echo("再见 👋")
        return _CommandOutcome(True, state, should_exit=True)
    if line == "/help":
        click.echo(_HELP)
        return _CommandOutcome(True, state)
    if line == "/session":
        selected = _select_session(
            checkpointer=checkpointer,
            user_id=user_id,
            current_session_id=state.session_id,
        )
        if selected == state.session_id:
            return _CommandOutcome(True, state)
        return _CommandOutcome(True, _ReplState(selected))
    if line == "/new":
        selected = _new_session_id()
        click.echo(f"已开新会话: {selected}")
        return _CommandOutcome(True, _ReplState(selected))
    if line == "/proposals":
        if state.pending_proposals:
            _print_proposals(state.pending_proposals)
        else:
            click.echo("当前没有待确认的计划提案。")
        return _CommandOutcome(True, state)
    if line == "/dismiss":
        click.echo("已放弃当前待选方案。")
        return _CommandOutcome(True, _ReplState(state.session_id))
    if not (line == "/apply" or line.startswith("/apply ")):
        return _CommandOutcome(False, state)
    parts = line.split()
    if len(parts) != 2 or not parts[1].isascii() or not parts[1].isdigit():
        click.echo("用法: /apply N（例如 /apply 2）")
        return _CommandOutcome(True, state)
    normalized_index = parts[1].lstrip("0") or "0"
    selected = int(normalized_index) if len(normalized_index) <= 9 else 1_000_000_000
    return _apply_pending(user_id=user_id, state=state, selected=selected)


def _warn_about_database(*, db_path: Path, profile: str) -> None:
    if not db_path.exists():
        click.echo(
            f"⚠️  {db_path} 不存在 — status_insight 读工具会返回空。"
            f"先 `python -m coros_sync -P {profile} sync`，或用 --data-dir 指向已同步的 data。",
            err=True,
        )
    elif db_path.stat().st_size < 1_000_000:
        click.echo(
            f"⚠️  {db_path} 只有 {db_path.stat().st_size // 1024}KB，疑似空库（worktree 没同步过）。"
            "用 --data-dir 指向主仓库的 data，例如："
            "--data-dir C:/Users/zhaochaoyi/workspace/running/data",
            err=True,
        )


def _run_one_shot(
    *, user_id: str, session_id: str, message: str, checkpointer: Any
) -> None:
    started_at = time.perf_counter()
    try:
        turn = _run_turn(
            user_id=user_id,
            session_id=session_id,
            message=message,
            checkpointer=checkpointer,
        )
    except Exception as exc:  # noqa: BLE001 — surface a friendly error
        raise SystemExit(f"❌ 教练调用失败: {_friendly_error(exc)}")
    _print_turn(turn, interactive=False)
    click.echo(f"（用时 {time.perf_counter() - started_at:.1f}s）", err=True)


def _print_repl_banner(*, user_id: str, session_id: str, db_path: Path) -> None:
    click.echo("─" * 60)
    click.echo("  STRIDE 教练 CLI · S0+S1 编排脑（本地测试）")
    click.echo(f"  user: {user_id}")
    click.echo(f"  session: {session_id}")
    click.echo(f"  data: {db_path}")
    click.echo(f"  {_model_banner()} · /help 看命令")
    click.echo("─" * 60)


def _run_repl_turn(
    *, line: str, user_id: str, state: _ReplState, checkpointer: Any, debug: bool
) -> _ReplState:
    # A pending weekly-create draft rides the next turn as review_context so a
    # follow-up about the drafted week is answered from it (the plan is not saved
    # yet). Absent such a draft, the turn carries no anchor (unrelated questions
    # must not be forced onto a stale draft).
    anchor = _weekly_review_anchor(state.pending_proposals)
    anchor_kwargs: dict[str, Any] = {}
    if anchor is not None:
        target, review_context = anchor
        anchor_kwargs = {"target": target, "review_context": review_context}
    try:
        with _Thinking(debug=debug):
            turn = _run_turn(
                user_id=user_id,
                session_id=state.session_id,
                message=line,
                checkpointer=checkpointer,
                **anchor_kwargs,
            )
    except Exception as exc:  # noqa: BLE001 — keep the REPL alive
        click.echo(f"❌ 调用失败: {_friendly_error(exc)}")
        return state

    _print_turn(turn, interactive=True)
    new_proposals = _applicable_proposals(turn)
    if new_proposals:
        return _ReplState(state.session_id, new_proposals)
    return state


def _run_repl(
    *, user_id: str, session_id: str, db_path: Path, checkpointer: Any, debug: bool
) -> None:
    _print_repl_banner(user_id=user_id, session_id=session_id, db_path=db_path)
    input_history = _InputHistory(_readline)
    input_history.start()
    state = _ReplState(session_id)
    try:
        while True:
            try:
                line = input("\n你 › ").strip()
            except (EOFError, KeyboardInterrupt):
                click.echo("\n再见 👋")
                return
            if not line:
                continue

            outcome = _handle_slash_command(
                line=line,
                user_id=user_id,
                state=state,
                checkpointer=checkpointer,
            )
            if outcome.handled:
                state = outcome.state
                if outcome.should_exit:
                    return
                continue

            input_history.remember(line)
            state = _run_repl_turn(
                line=line,
                user_id=user_id,
                state=state,
                checkpointer=checkpointer,
                debug=debug,
            )
    finally:
        input_history.close()


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
    if data_dir:
        _coredb.USER_DATA_DIR = Path(data_dir).resolve()
    data_root = _coredb.USER_DATA_DIR
    user_id = _resolve_profile(profile, data_dir=data_root)
    resolved_session_id = session_id or _new_session_id()
    checkpointer = _build_checkpointer()
    db_path = data_root / user_id / "coros.db"
    _warn_about_database(db_path=db_path, profile=profile)
    if message is not None:
        _run_one_shot(
            user_id=user_id,
            session_id=resolved_session_id,
            message=message,
            checkpointer=checkpointer,
        )
        return
    _run_repl(
        user_id=user_id,
        session_id=resolved_session_id,
        db_path=db_path,
        checkpointer=checkpointer,
        debug=debug,
    )


if __name__ == "__main__":
    main()
