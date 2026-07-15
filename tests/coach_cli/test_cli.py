"""Focused tests for the local Coach CLI presentation layer."""

from __future__ import annotations

from io import StringIO
from types import SimpleNamespace

from click.testing import CliRunner
from rich.console import Console

from coach_cli.cli import (
    _CHECKPOINT_DIR,
    _model_banner,
    _print_turn,
    _select_session,
    main,
)
from stride_storage.coach_persistence.store import CheckpointRow


def _row(session_id: str, created_at: str) -> CheckpointRow:
    thread_id = f"user-x:coach:{session_id}"
    return CheckpointRow(
        thread_id=thread_id,
        checkpoint_id="ck0",
        parent_checkpoint_id=None,
        blob_path=f"{thread_id}/ck0.json.gz",
        blob_sha256="sha",
        blob_size_bytes=1,
        state_uncompressed_bytes=1,
        metadata_json="{}",
        created_at=created_at,
    )


class _Store:
    def __init__(self, rows: list[CheckpointRow]) -> None:
        self.rows = rows
        self.seen_prefix: str | None = None

    def list_latest_checkpoint_rows(
        self, thread_id_prefix: str, *, limit: int | None = None
    ) -> list[CheckpointRow]:
        self.seen_prefix = thread_id_prefix
        return self.rows[:limit] if limit is not None else self.rows


class _Checkpointer:
    def __init__(self, rows: list[CheckpointRow]) -> None:
        self.store = _Store(rows)


def test_checkpoints_live_under_coach_cli_home() -> None:
    assert _CHECKPOINT_DIR == _CHECKPOINT_DIR.home() / ".coach-cli" / "checkpoints"
    assert _CHECKPOINT_DIR.is_absolute()


def test_session_picker_lists_current_and_restores_selected(capsys) -> None:
    checkpointer = _Checkpointer(
        [
            _row("cli-current", "2026-07-15T07:00:00Z"),
            _row("cli-old", "2026-07-14T06:30:00Z"),
        ]
    )

    selected = _select_session(
        checkpointer=checkpointer,
        user_id="user-x",
        current_session_id="cli-current",
        prompt=lambda _: "2",
    )

    output = capsys.readouterr().out
    assert selected == "cli-old"
    assert checkpointer.store.seen_prefix == "user-x:coach:"
    assert "cli-current" in output
    assert "← 当前" in output
    assert "cli-old" in output
    assert "已恢复会话: cli-old" in output


def test_session_picker_includes_unsaved_current_and_reprompts(capsys) -> None:
    checkpointer = _Checkpointer([_row("cli-old", "2026-07-14T06:30:00Z")])
    answers = iter(["9", ""])

    selected = _select_session(
        checkpointer=checkpointer,
        user_id="user-x",
        current_session_id="cli-unsaved",
        prompt=lambda _: next(answers),
    )

    output = capsys.readouterr().out
    assert selected == "cli-unsaved"
    assert "cli-unsaved  尚无消息  ← 当前" in output
    assert "请输入 1-2" in output
    assert "已取消" in output


def test_repl_uses_restored_session_for_next_turn(monkeypatch, tmp_path) -> None:
    checkpointer = _Checkpointer(
        [
            _row("cli-current", "2026-07-15T07:00:00Z"),
            _row("cli-old", "2026-07-14T06:30:00Z"),
        ]
    )
    seen_session_ids: list[str] = []

    monkeypatch.setattr("coach_cli.cli._build_checkpointer", lambda: checkpointer)

    def fake_turn(*, user_id, session_id, message, checkpointer):
        seen_session_ids.append(session_id)
        return SimpleNamespace(
            clarification=None,
            reply=f"echo: {message}",
            proposals=[],
            active_target=None,
        )

    monkeypatch.setattr("coach_cli.cli._run_turn", fake_turn)

    result = CliRunner().invoke(
        main,
        [
            "--profile",
            "user-x",
            "--session",
            "cli-current",
            "--data-dir",
            str(tmp_path),
        ],
        input="/session\n2\n继续聊\n/quit\n",
    )

    assert result.exit_code == 0, result.output
    assert "已恢复会话: cli-old" in result.output
    assert seen_session_ids == ["cli-old"]


def _turn(reply: str):
    return SimpleNamespace(
        reply=reply,
        clarification=None,
        proposals=[],
        active_target=None,
    )


def test_model_banner_uses_loaded_model_names_and_api_kinds(monkeypatch) -> None:
    orchestrator = SimpleNamespace(model="gpt-5.6-luna", api_kind="responses")
    status = SimpleNamespace(model="gpt-5.6-luna", api_kind="responses")
    generator = SimpleNamespace(model="gpt-5.6-sol", api_kind="responses")
    config = SimpleNamespace(
        generator=generator,
        for_role=lambda role: {
            "orchestrator": orchestrator,
            "status_insight": status,
        }[role],
    )

    monkeypatch.setattr("coach.runtime.config.load_config", lambda: config)

    assert _model_banner() == (
        "编排=gpt-5.6-luna (responses) · 状态=gpt-5.6-luna (responses) · "
        "计划=gpt-5.6-sol (responses)"
    )


def test_print_turn_renders_markdown_for_terminal() -> None:
    stream = StringIO()
    console = Console(
        file=stream,
        force_terminal=False,
        highlight=False,
        width=80,
    )

    _print_turn(
        _turn("# 训练状态\n\n- **恢复良好**\n- 建议 `轻松跑`"),
        interactive=True,
        render_markdown=True,
        console=console,
    )

    rendered = stream.getvalue()
    assert "教练 ›" in rendered
    assert "训练状态" in rendered
    assert "恢复良好" in rendered
    assert "轻松跑" in rendered
    assert "# 训练状态" not in rendered
    assert "**恢复良好**" not in rendered


def test_print_turn_keeps_raw_markdown_for_redirected_stdout(capsys) -> None:
    reply = "# 训练状态\n\n- **恢复良好**"

    _print_turn(
        _turn(reply),
        interactive=False,
        render_markdown=False,
    )

    assert capsys.readouterr().out == f"{reply}\n"
