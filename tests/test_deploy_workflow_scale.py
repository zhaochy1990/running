from __future__ import annotations

from pathlib import Path


WORKFLOW_DIR = Path(__file__).parents[1] / ".github" / "workflows"
WORKFLOW_PATH = WORKFLOW_DIR / "deploy.yml"
WEB_WORKFLOW_PATH = WORKFLOW_DIR / "deploy-web.yml"
DAILY_SYNC_PATH = WORKFLOW_DIR / "daily-sync.yml"
WEEKLY_CALIBRATION_PATH = WORKFLOW_DIR / "weekly-running-calibration.yml"
WEB_DEPLOY_PATH = WORKFLOW_DIR / "deploy-web.yml"


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
        "STRIDE_ROUTE_PATCH_USERS_ME_PROFILE=go",
        "STRIDE_ROUTE_GET_USERS_ME_INJURIES=go",
        "STRIDE_ROUTE_POST_USERS_ME_INJURIES=go",
        "STRIDE_ROUTE_PUT_USERS_ME_INJURIES_INJURYID=go",
        "STRIDE_ROUTE_DELETE_USERS_ME_INJURIES_INJURYID=go",
        "STRIDE_ROUTE_POST_USERS_ME_WATCH_LOGIN=go",
        "STRIDE_ROUTE_POST_USER_SYNC=go",
        "STRIDE_ROUTE_GET_PIPELINES_RUNID=go",
        "STRIDE_ROUTE_GET_JOBS_JOBID=go",
        "STRIDE_ROUTE_POST_USERS_ME_ONBOARDING_COMPLETE=go",
    }

    assert "ONBOARDING_GO_ROUTE_VARS=(" in deploy_step
    assert '"${#ONBOARDING_GO_ROUTE_VARS[@]}" -ne 12' in deploy_step
    assert 'grep -Ec \'^STRIDE_ROUTE_[A-Z0-9_]+=go$\'' in deploy_step
    assert "GO_API_URL=$GO_API_URL" in deploy_step
    assert 'verify_readiness_contract "${GO_API_URL%/}/api/readyz/onboarding" "web-onboarding-v2"' in deploy_step
    assert 'verify_readiness_contract "${GO_API_URL%/}/api/readyz/plan-setup" "plan-setup-v1"' in deploy_step
    assert 'verify_readiness_contract "${PUBLIC_DIRECT_BASE_URL%/}/api/readyz/onboarding" "web-onboarding-v2"' in deploy_step
    assert 'verify_readiness_contract "${PUBLIC_DIRECT_BASE_URL%/}/api/readyz/plan-setup" "plan-setup-v1"' in deploy_step
    assert "readiness_bodies=()" in deploy_step
    assert 'readiness_bodies+=("$readiness_body")' in deploy_step
    assert "curl --silent --connect-timeout 10 --max-time 30" in deploy_step
    assert "--location" not in deploy_step
    assert 'readiness_status" != "200"' in deploy_step
    assert 'actual != expected' in deploy_step
    assert "refusing Web route cutover" in deploy_step
    assert "--set-env-vars \"${ENV_VARS[@]}\"" in deploy_step
    assert "Deployed $route_name is not configured for the expected Go cutover." in deploy_step
    assert deploy_step.index("verify_readiness_contract") < deploy_step.index("--set-env-vars")
    assert {line.strip() for line in deploy_step.splitlines()} >= expected_routes


def test_async_job_worker_deploys_keep_one_warm_replica() -> None:
    workflow = WORKFLOW_PATH.read_text(encoding="utf-8")
    worker_step = workflow.split("- name: Deploy async-job worker", maxsplit=1)[1].split(
        "- name: Health check", maxsplit=1,
    )[0]
    update_command = worker_step.split("az containerapp update \\", maxsplit=1)[1]

    assert "--min-replicas 1" in update_command
    assert "--max-replicas 1" in update_command


def test_web_deploy_waits_for_revision_without_http_health_probe() -> None:
    workflow = WEB_DEPLOY_PATH.read_text(encoding="utf-8")
    wait_step = workflow.split("- name: Wait for new revision to reach Running", 1)[1].split(
        "- name: Mirror image to Aliyun ACR", 1
    )[0]

    assert "properties.runningState" in wait_step
    assert "/healthz" not in wait_step
    assert "curl " not in wait_step
    assert '"Failed" || "$STATE" == "Degraded"' in wait_step
    assert "az containerapp logs show" in wait_step
    assert "never reached Running after 5 minutes" in wait_step


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


def test_daily_sync_uses_and_waits_for_go_pipeline() -> None:
    workflow = DAILY_SYNC_PATH.read_text(encoding="utf-8")

    assert "STRIDE_GO_API_URL" in workflow
    assert "STRIDE_GO_INTERNAL_TOKEN" in workflow
    assert "${{ secrets.STRIDE_INTERNAL_TOKEN }}" not in workflow
    assert 'INTERNAL_TOKEN: ${{ secrets.STRIDE_GO_INTERNAL_TOKEN }}' in workflow
    assert '"${STRIDE_GO_API_URL%/}/api/$user/sync"' in workflow
    assert "--data '{\"mode\":\"incremental\"}'" in workflow
    assert "Idempotency-Key: daily-sync-$sync_day-$user" in workflow
    assert '"${STRIDE_GO_API_URL%/}/api/pipelines/$run_id"' in workflow
    assert '"$status" = "done"' in workflow
    assert '"$status" = "failed"' in workflow
    assert 'if [ "$terminal" = "done" ]; then' in workflow
    assert 'fail=$((fail+1))' in workflow
    assert 'if [ "$fail" -gt 0 ]; then' in workflow
    assert "exit 1" in workflow
    assert "MAX_RETRIES" in workflow
    assert "retrying" in workflow


def test_weekly_calibration_enqueues_go_jobs_only() -> None:
    workflow = WEEKLY_CALIBRATION_PATH.read_text(encoding="utf-8")

    assert 'GO_API_URL: ${{ vars.STRIDE_GO_API_URL }}' in workflow
    assert 'GO_INTERNAL_TOKEN: ${{ secrets.STRIDE_GO_INTERNAL_TOKEN }}' in workflow
    assert 'ENDPOINT="/jobs"' in workflow
    assert '\\"type\\":\\"calibration\\"' in workflow
    assert '\\"user_id\\":\\"$user\\"' in workflow
    assert "Idempotency-Key: weekly-calibration-${GITHUB_RUN_ID}-${user}" in workflow
    assert '-H "X-Internal-Token: $GO_INTERNAL_TOKEN"' in workflow
    assert '[ "$http" != "200" ] && [ "$http" != "202" ]' in workflow
    assert "STRIDE_INTERNAL_TOKEN" not in workflow
    assert "STRIDE_PROD_URL" not in workflow
    assert "/internal/training-load/backfill" not in workflow
    assert "workflow_dispatch: {}" in workflow
