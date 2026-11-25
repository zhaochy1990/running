package storage

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
)

// openPlanEvalStore connects to the real MySQL the other storage tests use and
// migrates only the plan-eval schema (the service's dedicated database).
func openPlanEvalStore(t *testing.T) *Store {
	t.Helper()
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("set STRIDE_WORKER_TEST_MYSQL_DSN to run storage integration tests")
	}
	st, err := Open(dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	if err := st.AutoMigratePlanEval(context.Background()); err != nil {
		t.Fatalf("automigrate plan-eval: %v", err)
	}
	return st
}

func newPlanEvalTaskCreate(version, envNames string, executions int) *PlanEvalTaskCreate {
	in := &PlanEvalTaskCreate{
		Task:         &PlanEvalTask{ID: uuid.NewString(), AgentVersion: version, Submitter: "admin-" + uuid.NewString(), IdempotencyKey: uuid.NewString(), ParamsFingerprint: "f"},
		LaunchConfig: &PlanEvalLaunchConfig{ID: uuid.NewString(), AgentVersion: version, Replicas: 1, EnvNames: envNames},
		EnvCipher:    []byte("cipher"),
	}
	for range executions {
		in.Executions = append(in.Executions, &PlanEvalExecution{
			ID: uuid.NewString(), ScenarioID: "scenario", SnapshotID: "snapshot", GenerateStatus: PlanEvalGenerateQueued,
			EvaluateStatus: PlanEvalEvaluatePending, AsOf: "2026-10-23T23:59:59+08:00", RequestJSON: `{"request_id":"x"}`, SnapshotJSON: `{"schema":"plan-eval-runner-snapshot/v1"}`,
		})
	}
	return in
}

func onlyExecution(t *testing.T, st *Store, taskID string) *PlanEvalExecution {
	t.Helper()
	rows, err := st.ListPlanEvalExecutions(context.Background(), taskID)
	if err != nil || len(rows) != 1 {
		t.Fatalf("executions of %s: %d (%v)", taskID, len(rows), err)
	}
	return &rows[0]
}

func TestPlanEval_CreateTask_IdempotencyAndLaunchConfig(t *testing.T) {
	st := openPlanEvalStore(t)
	ctx := context.Background()
	version := "v" + uuid.NewString()[:8]

	first, replayed, err := st.CreatePlanEvalTask(ctx, newPlanEvalTaskCreate(version, `["A"]`, 1))
	if err != nil || replayed {
		t.Fatalf("first create: %v replayed=%v", err, replayed)
	}
	sameKey := newPlanEvalTaskCreate(version, `["A"]`, 1)
	sameKey.Task.Submitter, sameKey.Task.IdempotencyKey, sameKey.Task.ParamsFingerprint = first.Submitter, first.IdempotencyKey, first.ParamsFingerprint
	again, replayed, err := st.CreatePlanEvalTask(ctx, sameKey)
	if err != nil || !replayed || again.ID != first.ID {
		t.Fatalf("replay: %v replayed=%v id=%s want %s", err, replayed, again.ID, first.ID)
	}
	var executions int64
	st.db.Model(&PlanEvalExecution{}).Where("task_id = ?", first.ID).Count(&executions)
	if executions != 1 {
		t.Fatalf("a replayed submit wrote again: %d executions", executions)
	}
	changed := newPlanEvalTaskCreate(version, `["A"]`, 1)
	changed.Task.Submitter, changed.Task.IdempotencyKey, changed.Task.ParamsFingerprint = first.Submitter, first.IdempotencyKey, "different"
	if _, _, err := st.CreatePlanEvalTask(ctx, changed); err == nil {
		t.Fatal("the same key with different parameters must conflict")
	} else if _, ok := err.(*PlanEvalIdempotencyConflictError); !ok {
		t.Fatalf("unexpected error type %T", err)
	}

	// Same version and variable names: the launch configuration is shared and
	// its replicas follow the latest request.
	shared, _, err := st.CreatePlanEvalTask(ctx, newPlanEvalTaskCreate(version, `["A"]`, 1))
	if err != nil {
		t.Fatalf("shared launch: %v", err)
	}
	if shared.LaunchConfigID != first.LaunchConfigID {
		t.Fatal("the same version created a second launch configuration")
	}
	scaled := newPlanEvalTaskCreate(version, `["A"]`, 1)
	scaled.LaunchConfig.Replicas = 4
	if _, _, err := st.CreatePlanEvalTask(ctx, scaled); err != nil {
		t.Fatal(err)
	}
	if launch, err := st.GetPlanEvalLaunchConfig(ctx, first.LaunchConfigID); err != nil || launch.Replicas != 4 {
		t.Fatalf("launch config = %+v (%v), want replicas 4", launch, err)
	}

	// Same version, different variable names: the whole batch is refused and
	// nothing is left behind.
	if _, _, err := st.CreatePlanEvalTask(ctx, newPlanEvalTaskCreate(version, `["A","B"]`, 1)); err == nil {
		t.Fatal("a conflicting launch configuration was accepted")
	} else if conflict, ok := err.(*PlanEvalLaunchConfigConflictError); !ok || conflict.Error() == "" {
		t.Fatalf("unexpected error %T %v", err, err)
	}
	var leaked int64
	st.db.Model(&PlanEvalTask{}).Where("agent_version = ?", version).Count(&leaked)
	if leaked != 3 {
		t.Fatalf("tasks on the version = %d, want 3 (two created + the scaled one)", leaked)
	}
}

func TestPlanEval_ClaimRenewSubmit_TakeoverAndReplay(t *testing.T) {
	st := openPlanEvalStore(t)
	ctx := context.Background()
	version := "v" + uuid.NewString()[:8]
	created, _, err := st.CreatePlanEvalTask(ctx, newPlanEvalTaskCreate(version, `[]`, 1))
	if err != nil {
		t.Fatal(err)
	}
	id := onlyExecution(t, st, created.ID).ID
	now := time.Now().UTC()
	ttl := time.Minute

	if _, err := st.ClaimPlanEvalExecution(ctx, uuid.NewString(), version, "w", now, ttl); err != ErrPlanEvalNotFound {
		t.Fatalf("unknown execution: %v", err)
	}
	if _, err := st.ClaimPlanEvalExecution(ctx, id, "other-version", "w", now, ttl); err != ErrPlanEvalAgentVersionMismatch {
		t.Fatalf("version mismatch: %v", err)
	}
	claim, err := st.ClaimPlanEvalExecution(ctx, id, version, "worker-1", now, ttl)
	if err != nil || claim.Status != "leased" || claim.LeaseEpoch != 1 || claim.Execution.Attempts != 1 || claim.Execution.GenerateStatus != PlanEvalGenerateLeased || claim.Execution.RequestJSON == "" {
		t.Fatalf("first claim: %+v %v", claim, err)
	}
	if busy, _ := st.ClaimPlanEvalExecution(ctx, id, version, "worker-2", now.Add(time.Second), ttl); busy.Status != "busy" {
		t.Fatalf("a valid lease must block a second claim: %+v", busy)
	}
	if _, err := st.RenewPlanEvalLease(ctx, id, 1, now.Add(10*time.Second), ttl); err != nil {
		t.Fatalf("holder renew: %v", err)
	}
	if _, err := st.RenewPlanEvalLease(ctx, id, 0, now.Add(10*time.Second), ttl); err != ErrPlanEvalStaleLease {
		t.Fatalf("renew from an older epoch: %v", err)
	}

	// The lease expires: another worker takes over at the next epoch.
	if err := st.db.Model(&PlanEvalExecution{}).Where("id = ?", id).Update("lease_expires_at", now.Add(-time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	taken, err := st.ClaimPlanEvalExecution(ctx, id, version, "worker-2", now.Add(2*time.Minute), ttl)
	if err != nil || taken.Status != "leased" || taken.LeaseEpoch != 2 || taken.Execution.Attempts != 2 {
		t.Fatalf("takeover: %+v %v", taken, err)
	}
	late := &PlanEvalGenerateOutcome{ErrorCode: "late", ErrorMessage: "from the old holder"}
	if _, _, err := st.SubmitPlanEvalGenerate(ctx, id, 1, now.Add(3*time.Minute), late); err != ErrPlanEvalStaleLease {
		t.Fatalf("the old holder's result must be refused: %v", err)
	}
	if current, _ := st.PlanEvalExecutionInput(ctx, id); current.GenerateStatus != PlanEvalGenerateLeased || current.LeaseEpoch != 2 {
		t.Fatalf("a refused result changed the execution: %+v", current)
	}

	// The new holder delivers an artifact: terminal state, artifact, schema
	// verdict, evaluate state and receipt land in one transaction.
	const content = `{"type":"master_plan","plan":{},"weekly_docs":[]}`
	detail := `{"errors":[]}`
	artifact := &PlanEvalArtifact{ID: uuid.NewString(), ArtifactType: "master_plan", Content: content, Sha256: "abc"}
	outcome := &PlanEvalGenerateOutcome{
		Artifact:     artifact,
		SchemaResult: &PlanEvalCheckResult{ID: uuid.NewString(), CheckID: "schema", Status: PlanEvalCheckPass, DetailJSON: &detail},
	}
	// Taken over at +2min under a 1min lease: this lands inside the new lease.
	ack, replayed, err := st.SubmitPlanEvalGenerate(ctx, id, 2, now.Add(150*time.Second), outcome)
	if err != nil || replayed {
		t.Fatalf("submit: %v replayed=%v", err, replayed)
	}
	if ack.GenerateStatus != PlanEvalGenerateDone || ack.ArtifactID != artifact.ID || ack.EvaluateStatus != PlanEvalEvaluatePending || ack.SnapshotExecutionID != id {
		t.Fatalf("ack = %+v", ack)
	}
	// A replay returns the original receipt and writes nothing new.
	if again, replayed, err := st.SubmitPlanEvalGenerate(ctx, id, 2, now.Add(170*time.Second), &PlanEvalGenerateOutcome{ErrorCode: "ignored"}); err != nil || !replayed || again.ReceiptID != ack.ReceiptID {
		t.Fatalf("replay: %+v replayed=%v %v", again, replayed, err)
	}
	var artifacts, receipts int64
	st.db.Model(&PlanEvalArtifact{}).Where("execution_id = ?", id).Count(&artifacts)
	st.db.Model(&PlanEvalReceipt{}).Where("execution_id = ?", id).Count(&receipts)
	if artifacts != 1 || receipts != 1 {
		t.Fatalf("artifacts=%d receipts=%d, want one each", artifacts, receipts)
	}
	if stored, _ := st.GetPlanEvalArtifact(ctx, artifact.ID); stored.Content != content || !stored.SchemaValid {
		t.Fatalf("artifact not kept verbatim: %+v", stored)
	}
	final, err := st.PlanEvalExecutionInput(ctx, id)
	if err != nil || final.GenerateStatus != PlanEvalGenerateDone || final.EvaluateStatus != PlanEvalEvaluatePending || final.ArtifactID != artifact.ID {
		t.Fatalf("final execution: %+v %v", final, err)
	}
	if claim, _ := st.ClaimPlanEvalExecution(ctx, id, version, "worker-3", now.Add(5*time.Minute), ttl); claim.Status != "terminal" {
		t.Fatalf("a settled execution: %+v", claim)
	}
	if n, _ := st.CountPlanEvalActiveGenerates(ctx, version); n != 0 {
		t.Fatalf("active generates = %d", n)
	}
}

func TestPlanEval_FailedGenerateSkipsEvaluateAndFinishesTheTask(t *testing.T) {
	st := openPlanEvalStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	version := "v" + uuid.NewString()[:8]
	created, _, err := st.CreatePlanEvalTask(ctx, newPlanEvalTaskCreate(version, `[]`, 1))
	if err != nil {
		t.Fatal(err)
	}
	id := onlyExecution(t, st, created.ID).ID
	if _, _, err := st.SubmitPlanEvalGenerate(ctx, id, 1, now, &PlanEvalGenerateOutcome{ErrorCode: "x"}); !errors.Is(err, ErrPlanEvalStaleLease) {
		t.Fatalf("a result without a lease must be refused: %v", err)
	}
	if claim, err := st.ClaimPlanEvalExecution(ctx, id, version, "worker-1", now, time.Minute); err != nil || claim.Status != "leased" {
		t.Fatalf("claim: %+v %v", claim, err)
	}
	if _, _, err := st.SubmitPlanEvalGenerate(ctx, id, 1, now, &PlanEvalGenerateOutcome{}); err == nil {
		t.Fatal("an outcome needs an artifact or an error code")
	}
	ack, _, err := st.SubmitPlanEvalGenerate(ctx, id, 1, now, &PlanEvalGenerateOutcome{ErrorCode: "model_timeout", ErrorMessage: "生成模型调用超时。"})
	if err != nil || ack.GenerateStatus != PlanEvalGenerateFailed || ack.ArtifactID != "" || ack.EvaluateStatus != PlanEvalEvaluateSkipped {
		t.Fatalf("failed generate: %+v %v", ack, err)
	}
	final, _ := st.PlanEvalExecutionInput(ctx, id)
	if final.GenerateErrorCode != "model_timeout" || final.GenerateErrorMessage != "生成模型调用超时。" || final.ArtifactID != "" {
		t.Fatalf("error not stored: %+v", final)
	}
	task, _ := st.GetPlanEvalTask(ctx, created.ID)
	if task.Status != PlanEvalTaskDone || task.CompletedAt == nil {
		t.Fatalf("task = %+v, want done", task)
	}
	counts, _ := st.PlanEvalTaskCounts(ctx, []string{created.ID})
	if c := counts[created.ID]; c.Total != 1 || c.Finished != 1 || c.GenerateFailed != 1 || c.RuleFailed != 0 {
		t.Fatalf("counts = %+v", c)
	}
}

func TestPlanEval_Evaluation_ClaimOnceAndRecordOnce(t *testing.T) {
	st := openPlanEvalStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	version := "v" + uuid.NewString()[:8]
	created, _, err := st.CreatePlanEvalTask(ctx, newPlanEvalTaskCreate(version, `[]`, 1))
	if err != nil {
		t.Fatal(err)
	}
	if err := st.db.Create(&PlanEvalFrozenRule{TaskID: created.ID, CheckID: "weekly_run_days", Version: 1, ArtifactType: "master_plan", Source: "function run(){}"}).Error; err != nil {
		t.Fatal(err)
	}
	id := onlyExecution(t, st, created.ID).ID
	if _, err := st.ClaimPlanEvalExecution(ctx, id, version, "worker-1", now, time.Minute); err != nil {
		t.Fatal(err)
	}
	const content = `{"type":"master_plan"}`
	artifact := &PlanEvalArtifact{ID: uuid.NewString(), ArtifactType: "master_plan", Content: content, Sha256: "abc"}
	schema := &PlanEvalCheckResult{ID: uuid.NewString(), CheckID: "schema", Status: PlanEvalCheckPass}
	if _, _, err := st.SubmitPlanEvalGenerate(ctx, id, 1, now, &PlanEvalGenerateOutcome{Artifact: artifact, SchemaResult: schema}); err != nil {
		t.Fatal(err)
	}

	claimed := func() *PlanEvalEvaluationWork {
		work, err := st.ClaimPlanEvalEvaluations(ctx, now.Add(time.Second), time.Minute, 200)
		if err != nil {
			t.Fatalf("claim evaluations: %v", err)
		}
		for i := range work {
			if work[i].ExecutionID == id {
				return &work[i]
			}
		}
		return nil
	}
	work := claimed()
	if work == nil {
		t.Fatal("a pending evaluation was not claimed")
	}
	if work.ArtifactID != artifact.ID || work.ArtifactContent != content || work.AsOf != "2026-10-23T23:59:59+08:00" || work.RequestJSON == "" || work.SnapshotJSON == "" || len(work.Rules) != 1 || work.Rules[0].Source != "function run(){}" {
		t.Fatalf("evaluation input = %+v", work)
	}
	if claimed() != nil {
		t.Fatal("an evaluation under a valid lease was claimed twice")
	}

	results := []PlanEvalCheckResult{
		{ID: uuid.NewString(), ArtifactID: artifact.ID, CheckID: "weekly_run_days", RuleVersion: 1, Status: PlanEvalCheckPass, Reason: "ok"},
	}
	if err := st.SavePlanEvalCheckResults(ctx, id, results, PlanEvalEvaluateDone, now); err != nil {
		t.Fatal(err)
	}
	// A takeover after a crash replays the batch: existing verdicts are kept.
	replayed := []PlanEvalCheckResult{
		{ID: uuid.NewString(), ArtifactID: artifact.ID, CheckID: "weekly_run_days", RuleVersion: 1, Status: PlanEvalCheckFail, Reason: "must not overwrite"},
		{ID: uuid.NewString(), ArtifactID: artifact.ID, CheckID: "schema", RuleVersion: 0, Status: PlanEvalCheckFail, Reason: "must not overwrite the schema verdict"},
	}
	if err := st.SavePlanEvalCheckResults(ctx, id, replayed, PlanEvalEvaluateDone, now); err != nil {
		t.Fatal(err)
	}
	stored, _ := st.ListPlanEvalCheckResults(ctx, []string{artifact.ID})
	if len(stored) != 2 {
		t.Fatalf("check results = %d, want exactly one per (artifact, check)", len(stored))
	}
	for _, result := range stored {
		if result.Status != PlanEvalCheckPass {
			t.Fatalf("a finished check was overwritten: %+v", result)
		}
	}
	final, _ := st.PlanEvalExecutionInput(ctx, id)
	task, _ := st.GetPlanEvalTask(ctx, created.ID)
	if final.EvaluateStatus != PlanEvalEvaluateDone || task.Status != PlanEvalTaskDone {
		t.Fatalf("evaluate=%s task=%s, want done/done", final.EvaluateStatus, task.Status)
	}
	counts, _ := st.PlanEvalTaskCounts(ctx, []string{created.ID})
	if c := counts[created.ID]; c.Finished != 1 || c.GenerateFailed != 0 || c.RuleFailed != 0 {
		t.Fatalf("counts = %+v", c)
	}

	// An evaluation whose lease expired (the holder crashed) becomes
	// claimable again.
	if err := st.db.Model(&PlanEvalExecution{}).Where("id = ?", id).Updates(map[string]any{"evaluate_status": PlanEvalEvaluateRunning, "evaluate_lease_until": now.Add(-time.Second)}).Error; err != nil {
		t.Fatal(err)
	}
	if claimed() == nil {
		t.Fatal("an expired evaluation lease must be reclaimable")
	}
}
