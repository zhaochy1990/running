from __future__ import annotations

from pathlib import Path


WORKFLOW_PATH = Path(__file__).parents[1] / ".github" / "workflows" / "deploy.yml"


def test_stride_app_deploys_keep_one_warm_replica() -> None:
    workflow = WORKFLOW_PATH.read_text(encoding="utf-8")
    deploy_step = workflow.split("- name: Deploy to Container Apps", maxsplit=1)[1].split(
        "- name: Update plan-reminder cron job image",
        maxsplit=1,
    )[0]
    command_blocks = deploy_step.split("az containerapp update \\")[1:]
    commands = [
        "\n".join(
            line
            for line in block.splitlines()
            if not line.strip() or line.rstrip().endswith("\\")
        )
        for block in command_blocks
    ]
    app_commands = [command for command in commands if "${{ env.APP_NAME }}" in command]

    assert len(app_commands) == 2
    for command in app_commands:
        assert "--min-replicas 1" in command
        assert "--max-replicas 1" in command
