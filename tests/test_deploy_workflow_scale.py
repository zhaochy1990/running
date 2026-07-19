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


def test_async_job_worker_deploys_keep_one_warm_replica() -> None:
    workflow = WORKFLOW_PATH.read_text(encoding="utf-8")
    worker_step = workflow.split("- name: Deploy async-job worker", maxsplit=1)[1].split(
        "- name: Health check", maxsplit=1,
    )[0]
    update_command = worker_step.split("az containerapp update \\", maxsplit=1)[1]

    assert "--min-replicas 1" in update_command
    assert "--max-replicas 1" in update_command


def _training_load_rollout_step() -> str:
    workflow = WORKFLOW_PATH.read_text(encoding="utf-8")
    # The rollout step's name may change once it becomes async; match either the
    # old "Backfill ... when missing" or a new enqueue-oriented name by grabbing
    # the last step that touches the training-load internal surface.
    idx = workflow.rfind("training-load")
    assert idx != -1, "deploy.yml must still roll out the training-load model"
    start = workflow.rfind("- name:", 0, idx)
    return workflow[start:]


def test_training_load_rollout_enqueues_jobs_not_synchronous_backfill() -> None:
    """The deploy rollout must ENQUEUE training_load_backfill jobs and poll the
    job status endpoint — never call the synchronous backfill route (which 504s
    past the ACA 240s request budget on a 365-day scan)."""
    step = _training_load_rollout_step()

    # The synchronous, inline backfill call is the prod regression — it must be gone.
    assert "training-load/backfill?" not in step, (
        "deploy rollout still calls the synchronous training-load/backfill route"
    )

    # It must hit the enqueue endpoint and poll job status to completion.
    assert "training-load/backfill/enqueue" in step
    assert "/internal/jobs/" in step
    assert "urllib.parse.quote" in step
    assert '"status"' in step or "status" in step
    assert "result_json" in step
    assert "daily_rows_written" in step
