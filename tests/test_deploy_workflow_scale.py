from __future__ import annotations

from pathlib import Path


WORKFLOW_DIR = Path(__file__).parents[1] / ".github" / "workflows"
WORKFLOW_PATH = WORKFLOW_DIR / "deploy.yml"
WEB_WORKFLOW_PATH = WORKFLOW_DIR / "deploy-web.yml"
DAILY_SYNC_PATH = WORKFLOW_DIR / "daily-sync.yml"
WEEKLY_CALIBRATION_PATH = WORKFLOW_DIR / "weekly-running-calibration.yml"


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


def test_stride_web_deploys_atomic_go_onboarding_routes() -> None:
    """The production web revision cannot mix Python and Go onboarding state."""
    workflow = WEB_WORKFLOW_PATH.read_text(encoding="utf-8")
    deploy_step = workflow.split("- name: Deploy to Container Apps (stride-web)", maxsplit=1)[1].split(
        "- name: Health check",
        maxsplit=1,
    )[0]
    expected_routes = {
        "STRIDE_ROUTE_GET_USERS_ME_PROFILE=go",
        "STRIDE_ROUTE_POST_USERS_ME_PROFILE=go",
        "STRIDE_ROUTE_POST_USERS_ME_WATCH_LOGIN=go",
        "STRIDE_ROUTE_POST_USER_SYNC=go",
        "STRIDE_ROUTE_GET_PIPELINES_RUNID=go",
        "STRIDE_ROUTE_POST_USERS_ME_ONBOARDING_COMPLETE=go",
    }

    assert "ONBOARDING_GO_ROUTE_VARS=(" in deploy_step
    assert '"${#ONBOARDING_GO_ROUTE_VARS[@]}" -ne 6' in deploy_step
    assert 'grep -Ec \'^STRIDE_ROUTE_[A-Z0-9_]+=go$\'' in deploy_step
    assert "GO_API_URL=$GO_API_URL" in deploy_step
    assert 'verify_onboarding_readiness "${GO_API_URL%/}/readyz/onboarding"' in deploy_step
    assert 'verify_onboarding_readiness "${PUBLIC_DIRECT_BASE_URL%/}/readyz/onboarding"' in deploy_step
    assert "readiness_bodies=()" in deploy_step
    assert 'readiness_bodies+=("$readiness_body")' in deploy_step
    assert "curl --silent --connect-timeout 10 --max-time 30" in deploy_step
    assert "--location" not in deploy_step
    assert 'readiness_status" != "200"' in deploy_step
    assert 'payload.get("contract_version") != "web-onboarding-v1"' in deploy_step
    assert 'actual != expected' in deploy_step
    assert "refusing Web route cutover" in deploy_step
    assert "--set-env-vars \"${ENV_VARS[@]}\"" in deploy_step
    assert "Deployed $route_name is not configured for the Go onboarding lifecycle." in deploy_step
    assert deploy_step.index("verify_onboarding_readiness") < deploy_step.index("--set-env-vars")
    assert {line.strip() for line in deploy_step.splitlines()} >= expected_routes


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
    # Grab the final workflow step that touches the training-load internal
    # surface; rollout stays after the new revision health check.
    idx = workflow.rfind("training-load")
    assert idx != -1, "deploy.yml must still roll out the training-load model"
    start = workflow.rfind("- name:", 0, idx)
    return workflow[start:]


def test_training_load_rollout_uses_api_owned_resumable_shards() -> None:
    """Deploy must advance API-owned shards; the worker must not write SQLite."""
    step = _training_load_rollout_step()

    assert "training-load/backfill/step" in step
    assert "training-load/backfill/enqueue" not in step
    assert "/internal/jobs/" not in step
    assert "status == 503" in step
    assert "MAX_RETRIES" in step
    assert (
        "RETRYABLE_NETWORK_ERRORS = (urllib.error.URLError, TimeoutError)" in step
    )
    assert step.count("except RETRYABLE_NETWORK_ERRORS as exc:") == 2
    assert "next_shard_start" in step
    assert "daily_rows_written" in step


def test_daily_sync_retries_api_writer_contention() -> None:
    workflow = DAILY_SYNC_PATH.read_text(encoding="utf-8")

    assert '"503"' in workflow
    assert "MAX_RETRIES" in workflow
    assert "retrying" in workflow


def test_weekly_manual_backfill_uses_api_owned_shards() -> None:
    workflow = WEEKLY_CALIBRATION_PATH.read_text(encoding="utf-8")

    assert "/internal/training-load/backfill/step" in workflow
    assert "load_lookback_days=365" not in workflow
    assert '"only_if_missing": False' in workflow
    assert '"restart_token": restart_token' in workflow
    assert "GITHUB_RUN_ID" in workflow
    assert (
        "RETRYABLE_NETWORK_ERRORS = (urllib.error.URLError, TimeoutError)"
        in workflow
    )
    assert "except RETRYABLE_NETWORK_ERRORS as exc:" in workflow
    assert "next_shard_start" in workflow
