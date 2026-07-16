"""Focused tests for the local Coach CLI presentation layer."""

from __future__ import annotations

from io import StringIO
from types import SimpleNamespace

from click.testing import CliRunner
from rich.console import Console

from coach.contracts import ProposalCard
from coach_cli.cli import (
    _CHECKPOINT_DIR,
    _InputHistory,
    _model_banner,
    _print_turn,
    _select_session,
    main,
)
from stride_core.master_plan_diff import MasterPlanDiff
from stride_core.plan_diff import PlanDiff
from stride_core.plan_spec import WeeklyPlan
from stride_core.weekly_plan_proposal import WeeklyPlanCreateProposal
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


class _ReadlineBackend:
    def __init__(self, history: list[str] | None = None) -> None:
        self.history = list(history or [])
        self.added: list[str] = []
        self.auto_history = True

    def get_current_history_length(self) -> int:
        return len(self.history)

    def get_history_item(self, index: int) -> str:
        return self.history[index - 1]

    def clear_history(self) -> None:
        self.history.clear()

    def set_auto_history(self, enabled: bool) -> None:
        self.auto_history = enabled

    def add_history(self, line: str) -> None:
        self.history.append(line)
        self.added.append(line)


def test_checkpoints_live_under_coach_cli_home() -> None:
    assert _CHECKPOINT_DIR == _CHECKPOINT_DIR.home() / ".coach-cli" / "checkpoints"
    assert _CHECKPOINT_DIR.is_absolute()


def test_input_history_recalls_coach_messages_and_restores_process_history() -> None:
    backend = _ReadlineBackend(["existing-shell-input"])
    history = _InputHistory(backend)

    history.start()
    history.remember("我今天应该怎么训练？")

    assert backend.auto_history is False
    assert backend.history == ["我今天应该怎么训练？"]

    history.close()

    assert backend.auto_history is True
    assert backend.history == ["existing-shell-input"]


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
    readline_backend = _ReadlineBackend()

    monkeypatch.setattr("coach_cli.cli._build_checkpointer", lambda: checkpointer)
    monkeypatch.setattr("coach_cli.cli._readline", readline_backend)

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
    assert readline_backend.added == ["继续聊"]


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


def test_print_turn_lists_each_master_plan_choice(capsys) -> None:
    choices = [
        MasterPlanDiff(
            diff_id="a",
            plan_id="plan-1",
            ops=[],
            ai_explanation="方案 A（温和减量）",
            created_at="t",
        ),
        MasterPlanDiff(
            diff_id="b",
            plan_id="plan-1",
            ops=[],
            ai_explanation="方案 B（明显减量）",
            created_at="t",
        ),
    ]
    turn = SimpleNamespace(
        reply="请选择一个调整方向",
        clarification=None,
        proposals=[
            ProposalCard(specialist_id="season_plan", proposal=choice)
            for choice in choices
        ],
        active_target=None,
    )

    _print_turn(turn, interactive=False, render_markdown=False)

    output = capsys.readouterr().out
    assert "方案 A（温和减量）" in output
    assert "方案 B（明显减量）" in output
    assert "📋 提案 1[season_plan]" in output
    assert "📋 提案 2[season_plan]" in output


def test_print_turn_numbers_all_cli_applicable_proposals(capsys) -> None:
    weekly = PlanDiff(
        diff_id="week",
        folder="2026-W29",
        ops=[],
        ai_explanation="调整周三训练",
        created_at="t",
    )
    master = MasterPlanDiff(
        diff_id="master",
        plan_id="plan-1",
        ops=[],
        ai_explanation="降低强化期跑量",
        created_at="t",
    )
    turn = SimpleNamespace(
        reply="这里有两个不同范围的提案",
        clarification=None,
        proposals=[
            ProposalCard(specialist_id="weekly_plan", proposal=weekly),
            ProposalCard(specialist_id="season_plan", proposal=master),
        ],
        active_target=None,
    )

    _print_turn(turn, interactive=False, render_markdown=False)

    output = capsys.readouterr().out
    assert "📋 提案 1[weekly_plan]" in output
    assert "📋 提案 2[season_plan]" in output


def test_repl_applies_selected_master_plan_proposal(monkeypatch, tmp_path) -> None:
    choices = [
        MasterPlanDiff(
            diff_id=diff_id,
            plan_id="plan-1",
            ops=[],
            ai_explanation=label,
            created_at="t",
        )
        for diff_id, label in (("a", "温和减量"), ("b", "明显减量"))
    ]
    turn = SimpleNamespace(
        reply="请选择一个调整方向",
        clarification=None,
        proposals=[
            ProposalCard(specialist_id="season_plan", proposal=choice)
            for choice in choices
        ],
        active_target=None,
    )
    applied: list[str] = []

    monkeypatch.setattr("coach_cli.cli._build_checkpointer", lambda: _Checkpointer([]))
    monkeypatch.setattr("coach_cli.cli._readline", _ReadlineBackend())
    monkeypatch.setattr("coach_cli.cli._run_turn", lambda **_: turn)
    monkeypatch.setattr(
        "coach_cli.cli._apply_master_proposal",
        lambda *, user_id, proposal: applied.append(proposal.diff_id) or {"version": 2},
    )

    result = CliRunner().invoke(
        main,
        ["--profile", "user-x", "--data-dir", str(tmp_path)],
        input="给我两个方案\n/apply 2\n/quit\n",
    )

    assert result.exit_code == 0, result.output
    assert applied == ["b"]
    assert "方案 2 已应用" in result.output
    assert "v2" in result.output


def test_repl_applies_week_create_then_adjust_proposals(monkeypatch, tmp_path) -> None:
    folder = "2026-07-13_07-19"
    create = WeeklyPlanCreateProposal(
        proposal_id="create-1",
        folder=folder,
        plan=WeeklyPlan(week_folder=folder).to_dict(),
        total_distance_km=40,
        ai_explanation="创建本周计划",
        created_at="t",
    )
    adjust = PlanDiff(
        diff_id="adjust-1",
        folder=folder,
        ops=[],
        ai_explanation="调整周三",
        created_at="t",
    )
    turns = iter(
        [
            SimpleNamespace(
                reply="创建提案",
                clarification=None,
                proposals=[ProposalCard(specialist_id="weekly_plan", proposal=create)],
                active_target=None,
            ),
            SimpleNamespace(
                reply="调整提案",
                clarification=None,
                proposals=[ProposalCard(specialist_id="weekly_plan", proposal=adjust)],
                active_target=None,
            ),
        ]
    )
    applied: list[str] = []

    monkeypatch.setattr("coach_cli.cli._build_checkpointer", lambda: _Checkpointer([]))
    monkeypatch.setattr("coach_cli.cli._readline", _ReadlineBackend())
    monkeypatch.setattr("coach_cli.cli._run_turn", lambda **_: next(turns))
    monkeypatch.setattr(
        "coach_cli.cli._apply_proposal",
        lambda *, user_id, proposal: (
            applied.append(
                proposal.proposal_id
                if isinstance(proposal, WeeklyPlanCreateProposal)
                else proposal.diff_id
            )
            or {"folder": folder, "created": isinstance(proposal, WeeklyPlanCreateProposal)}
        ),
    )

    result = CliRunner().invoke(
        main,
        ["--profile", "user-x", "--data-dir", str(tmp_path)],
        input="创建本周计划\n/apply 1\n调整周三\n/apply 1\n/quit\n",
    )

    assert result.exit_code == 0, result.output
    assert applied == ["create-1", "adjust-1"]
    assert "已创建" in result.output
    assert "已更新" in result.output
