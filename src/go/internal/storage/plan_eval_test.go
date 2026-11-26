package storage

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm/clause"
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
		LaunchConfig: &PlanEvalLaunchConfig{ID: uuid.NewString(), AgentVersion: version, Replicas: 1, EnvNames: envNames, EnvFingerprint: envNames},
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

	// Same version and launch parameters: the configuration is shared.
	shared, _, err := st.CreatePlanEvalTask(ctx, newPlanEvalTaskCreate(version, `["A"]`, 1))
	if err != nil {
		t.Fatalf("shared launch: %v", err)
	}
	if shared.LaunchConfigID != first.LaunchConfigID {
		t.Fatal("the same version created a second launch configuration")
	}
	// Only the independent scale entry changes the shared replica count.
	if _, err := st.SetPlanEvalReplicas(ctx, version, 4); err != nil {
		t.Fatal(err)
	}
	before, err := st.GetPlanEvalLaunchConfig(ctx, first.LaunchConfigID)
	if err != nil {
		t.Fatal(err)
	}
	for _, replicas := range []int{1, 2, 5} {
		conflicting := newPlanEvalTaskCreate(version, `[]`, 2)
		conflicting.LaunchConfig.Replicas = replicas
		conflicting.FrozenRules = []*PlanEvalFrozenRule{{CheckID: "rule", Version: 1}}
		_, _, err := st.CreatePlanEvalTask(ctx, conflicting)
		var conflict *PlanEvalLaunchConfigConflictError
		if !errors.As(err, &conflict) || conflict.ExistingReplicas != 4 || conflict.RequestedReplicas != replicas {
			t.Fatalf("replicas %d: want conflict with effective 4, got %v", replicas, err)
		}
		for _, model := range []any{&PlanEvalTask{}, &PlanEvalExecution{}, &PlanEvalFrozenRule{}} {
			var leaked int64
			column := "task_id"
			if _, ok := model.(*PlanEvalTask); ok {
				column = "id"
			}
			if err := st.db.Model(model).Where(column+" = ?", conflicting.Task.ID).Count(&leaked).Error; err != nil || leaked != 0 {
				t.Fatalf("refused task leaked %T rows: %d (%v)", model, leaked, err)
			}
		}
	}
	after, err := st.GetPlanEvalLaunchConfig(ctx, first.LaunchConfigID)
	if err != nil || after.Replicas != before.Replicas || after.RuntimeRevision != before.RuntimeRevision || !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Fatalf("conflict changed the effective config: %+v (%v)", after, err)
	}
	// Original parameters still replay after an independent scale.
	again, replayed, err = st.CreatePlanEvalTask(ctx, sameKey)
	if err != nil || !replayed || again.ID != first.ID || again.LaunchReplicas != 1 {
		t.Fatalf("replay after scale: %+v replayed=%v (%v)", again, replayed, err)
	}
	inherited := newPlanEvalTaskCreate(version, `[]`, 1)
	inherited.LaunchConfig.Replicas = 0
	blank, _, err := st.CreatePlanEvalTask(ctx, inherited)
	if err != nil || blank.LaunchReplicas != 4 || blank.LaunchConfigID != first.LaunchConfigID || blank.LaunchEnvNames != `["A"]` {
		t.Fatalf("blank config did not inherit: %+v (%v)", blank, err)
	}

	// Explicit environment conflicts still refuse the whole batch.
	conflictingEnv := newPlanEvalTaskCreate(version, `["A","B"]`, 1)
	conflictingEnv.LaunchConfig.Replicas = 4
	if _, _, err := st.CreatePlanEvalTask(ctx, conflictingEnv); err == nil {
		t.Fatal("a conflicting launch configuration was accepted")
	} else if conflict, ok := err.(*PlanEvalLaunchConfigConflictError); !ok || conflict.Error() == "" {
		t.Fatalf("unexpected error %T %v", err, err)
	}
	var tasks int64
	if err := st.db.Model(&PlanEvalTask{}).Where("agent_version = ?", version).Count(&tasks).Error; err != nil || tasks != 3 {
		t.Fatalf("tasks on the version = %d, want 3 (%v)", tasks, err)
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

	if _, err := st.ClaimPlanEvalExecution(ctx, uuid.NewString(), version, "w", "claim-1", now, ttl); err != ErrPlanEvalNotFound {
		t.Fatalf("unknown execution: %v", err)
	}
	if _, err := st.ClaimPlanEvalExecution(ctx, id, "other-version", "w", "claim-1", now, ttl); err != ErrPlanEvalAgentVersionMismatch {
		t.Fatalf("version mismatch: %v", err)
	}
	claim, err := st.ClaimPlanEvalExecution(ctx, id, version, "worker-1", "claim-1", now, ttl)
	if err != nil || claim.Status != "leased" || claim.LeaseEpoch != 1 || claim.Execution.Attempts != 1 || claim.Execution.GenerateStatus != PlanEvalGenerateLeased || claim.Execution.RequestJSON == "" {
		t.Fatalf("first claim: %+v %v", claim, err)
	}
	if busy, _ := st.ClaimPlanEvalExecution(ctx, id, version, "worker-2", "claim-1", now.Add(time.Second), ttl); busy.Status != "busy" {
		t.Fatalf("a valid lease must block a second claim: %+v", busy)
	}
	if _, err := st.RenewPlanEvalLease(ctx, id, PlanEvalWorkerLease{AgentVersion: version, WorkerID: "worker-1", LeaseEpoch: 1}, now.Add(10*time.Second), ttl); err != nil {
		t.Fatalf("holder renew: %v", err)
	}
	if _, err := st.RenewPlanEvalLease(ctx, id, PlanEvalWorkerLease{AgentVersion: version, WorkerID: "worker-1", LeaseEpoch: 0}, now.Add(10*time.Second), ttl); err != ErrPlanEvalStaleLease {
		t.Fatalf("renew from an older epoch: %v", err)
	}

	// The lease expires: another worker takes over at the next epoch.
	if err := st.db.Model(&PlanEvalExecution{}).Where("id = ?", id).Update("lease_expires_at", now.Add(-time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	taken, err := st.ClaimPlanEvalExecution(ctx, id, version, "worker-2", "claim-1", now.Add(2*time.Minute), ttl)
	if err != nil || taken.Status != "leased" || taken.LeaseEpoch != 2 || taken.Execution.Attempts != 2 {
		t.Fatalf("takeover: %+v %v", taken, err)
	}
	late := &PlanEvalGenerateOutcome{ErrorCode: "late", ErrorMessage: "from the old holder"}
	if _, _, err := st.SubmitPlanEvalGenerate(ctx, id, PlanEvalWorkerLease{AgentVersion: version, WorkerID: "worker-1", LeaseEpoch: 1}, "submit-1", "fingerprint-1", now.Add(3*time.Minute), late); err != ErrPlanEvalStaleLease {
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
	ack, replayed, err := st.SubmitPlanEvalGenerate(ctx, id, PlanEvalWorkerLease{AgentVersion: version, WorkerID: "worker-2", LeaseEpoch: 2}, "submit-1", "fingerprint-1", now.Add(150*time.Second), outcome)
	if err != nil || replayed {
		t.Fatalf("submit: %v replayed=%v", err, replayed)
	}
	if ack.GenerateStatus != PlanEvalGenerateDone || ack.ArtifactID != artifact.ID || ack.EvaluateStatus != PlanEvalEvaluatePending || ack.SnapshotExecutionID != id {
		t.Fatalf("ack = %+v", ack)
	}
	// A replay returns the original receipt and writes nothing new.
	if again, replayed, err := st.SubmitPlanEvalGenerate(ctx, id, PlanEvalWorkerLease{AgentVersion: version, WorkerID: "worker-2", LeaseEpoch: 2}, "submit-1", "fingerprint-1", now.Add(170*time.Second), outcome); err != nil || !replayed || again.ReceiptID != ack.ReceiptID {
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
	if claim, _ := st.ClaimPlanEvalExecution(ctx, id, version, "worker-3", "claim-1", now.Add(5*time.Minute), ttl); claim.Status != "terminal" {
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
	if _, _, err := st.SubmitPlanEvalGenerate(ctx, id, PlanEvalWorkerLease{AgentVersion: version, WorkerID: "worker-1", LeaseEpoch: 1}, "submit-1", "fingerprint-1", now, &PlanEvalGenerateOutcome{ErrorCode: "x"}); !errors.Is(err, ErrPlanEvalStaleLease) {
		t.Fatalf("a result without a lease must be refused: %v", err)
	}
	if claim, err := st.ClaimPlanEvalExecution(ctx, id, version, "worker-1", "claim-1", now, time.Minute); err != nil || claim.Status != "leased" {
		t.Fatalf("claim: %+v %v", claim, err)
	}
	if _, _, err := st.SubmitPlanEvalGenerate(ctx, id, PlanEvalWorkerLease{AgentVersion: version, WorkerID: "worker-1", LeaseEpoch: 1}, "submit-1", "fingerprint-1", now, &PlanEvalGenerateOutcome{}); err == nil {
		t.Fatal("an outcome needs an artifact or an error code")
	}
	ack, _, err := st.SubmitPlanEvalGenerate(ctx, id, PlanEvalWorkerLease{AgentVersion: version, WorkerID: "worker-1", LeaseEpoch: 1}, "submit-1", "fingerprint-1", now, &PlanEvalGenerateOutcome{ErrorCode: "model_timeout", ErrorMessage: "生成模型调用超时。"})
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
	if _, err := st.ClaimPlanEvalExecution(ctx, id, version, "worker-1", "claim-1", now, time.Minute); err != nil {
		t.Fatal(err)
	}
	const content = `{"type":"master_plan"}`
	artifact := &PlanEvalArtifact{ID: uuid.NewString(), ArtifactType: "master_plan", Content: content, Sha256: "abc"}
	schema := &PlanEvalCheckResult{ID: uuid.NewString(), CheckID: "schema", Status: PlanEvalCheckPass}
	if _, _, err := st.SubmitPlanEvalGenerate(ctx, id, PlanEvalWorkerLease{AgentVersion: version, WorkerID: "worker-1", LeaseEpoch: 1}, "submit-1", "fingerprint-1", now, &PlanEvalGenerateOutcome{Artifact: artifact, SchemaResult: schema}); err != nil {
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
	if err := st.SavePlanEvalCheckResults(ctx, id, work.LeaseUntil, results, PlanEvalEvaluateDone, now.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	// A takeover after a crash replays the batch: existing verdicts are kept.
	replayed := []PlanEvalCheckResult{
		{ID: uuid.NewString(), ArtifactID: artifact.ID, CheckID: "weekly_run_days", RuleVersion: 1, Status: PlanEvalCheckFail, Reason: "must not overwrite"},
		{ID: uuid.NewString(), ArtifactID: artifact.ID, CheckID: "schema", RuleVersion: 0, Status: PlanEvalCheckFail, Reason: "must not overwrite the schema verdict"},
	}
	if err := st.SavePlanEvalCheckResults(ctx, id, work.LeaseUntil, replayed, PlanEvalEvaluateDone, now.Add(3*time.Second)); err != ErrPlanEvalStaleLease {
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

func TestPlanEval_WorkerIdentityAndLostResponses(t *testing.T) {
	st := openPlanEvalStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	version := "v" + uuid.NewString()[:8]
	task, _, err := st.CreatePlanEvalTask(ctx, newPlanEvalTaskCreate(version, `[]`, 1))
	if err != nil {
		t.Fatal(err)
	}
	id := onlyExecution(t, st, task.ID).ID
	claim, err := st.ClaimPlanEvalExecution(ctx, id, version, "worker-1", "claim-1", now, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := st.ClaimPlanEvalExecution(ctx, id, version, "worker-1", "claim-1", now.Add(time.Second), time.Minute)
	if err != nil || replay.LeaseEpoch != claim.LeaseEpoch || replay.Execution.Attempts != 1 || !replay.LeaseExpiresAt.Equal(*replay.Execution.LeaseExpiresAt) {
		t.Fatalf("lost claim response: %+v %v", replay, err)
	}
	busy, err := st.ClaimPlanEvalExecution(ctx, id, version, "worker-1", "another-delivery", now.Add(time.Second), time.Minute)
	if err != nil || busy.Status != "busy" {
		t.Fatalf("another request must not reuse the lease: %+v %v", busy, err)
	}
	holder := PlanEvalWorkerLease{AgentVersion: version, WorkerID: "worker-1", LeaseEpoch: 1}
	for _, wrong := range []PlanEvalWorkerLease{
		{AgentVersion: version, WorkerID: "worker-2", LeaseEpoch: 1},
		{AgentVersion: "another-version", WorkerID: "worker-1", LeaseEpoch: 1},
	} {
		if _, err := st.RenewPlanEvalLease(ctx, id, wrong, now.Add(time.Second), time.Minute); err != ErrPlanEvalStaleLease {
			t.Fatalf("wrong identity renew: %v", err)
		}
		if _, _, err := st.SubmitPlanEvalGenerate(ctx, id, wrong, "submit-1", "fp", now.Add(time.Second), &PlanEvalGenerateOutcome{ErrorCode: "timeout"}); err == nil {
			t.Fatal("wrong identity submitted")
		}
	}
	if _, err := st.RenewPlanEvalLease(ctx, id, holder, now.Add(2*time.Minute), time.Minute); err != ErrPlanEvalStaleLease {
		t.Fatalf("expired lease resurrected: %v", err)
	}
	out := &PlanEvalGenerateOutcome{ErrorCode: "timeout"}
	ack, _, err := st.SubmitPlanEvalGenerate(ctx, id, holder, "submit-1", "fp", now.Add(2*time.Second), out)
	if err != nil {
		t.Fatal(err)
	}
	again, replayed, err := st.SubmitPlanEvalGenerate(ctx, id, holder, "submit-1", "fp", now.Add(2*time.Minute), out)
	if err != nil || !replayed || *again != *ack {
		t.Fatalf("lost submit response: %+v %v", again, err)
	}
	for _, attempt := range [][2]string{{"submit-1", "different-content"}, {"different-submission", "fp"}} {
		if _, _, err := st.SubmitPlanEvalGenerate(ctx, id, holder, attempt[0], attempt[1], now, out); err != ErrPlanEvalResultConflict {
			t.Fatalf("conflicting replay: %v", err)
		}
	}
}

func TestPlanEval_EvaluationRecoveryFromPartialChecks(t *testing.T) {
	st := openPlanEvalStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	version := "v" + uuid.NewString()[:8]
	in := newPlanEvalTaskCreate(version, `[]`, 1)
	in.FrozenRules = []*PlanEvalFrozenRule{{CheckID: "first", Version: 1, ArtifactType: "master_plan", Source: "function run(){}"}, {CheckID: "second", Version: 1, ArtifactType: "master_plan", Source: "function run(){}"}}
	task, _, err := st.CreatePlanEvalTask(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	id := onlyExecution(t, st, task.ID).ID
	if _, err := st.ClaimPlanEvalExecution(ctx, id, version, "worker-1", "claim-1", now, time.Minute); err != nil {
		t.Fatal(err)
	}
	artifact := &PlanEvalArtifact{ID: uuid.NewString(), ArtifactType: "master_plan", Content: `{"type":"master_plan"}`, Sha256: "fp"}
	if _, _, err := st.SubmitPlanEvalGenerate(ctx, id, PlanEvalWorkerLease{AgentVersion: version, WorkerID: "worker-1", LeaseEpoch: 1}, "submit-1", "fp", now, &PlanEvalGenerateOutcome{Artifact: artifact, SchemaResult: &PlanEvalCheckResult{ID: uuid.NewString(), CheckID: "schema", Status: PlanEvalCheckPass}}); err != nil {
		t.Fatal(err)
	}
	find := func(at time.Time) PlanEvalEvaluationWork {
		work, err := st.ClaimPlanEvalEvaluations(ctx, at, time.Minute, 1000)
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range work {
			if item.ExecutionID == id {
				return item
			}
		}
		t.Fatal("evaluation not claimed")
		return PlanEvalEvaluationWork{}
	}
	first := find(now.Add(time.Second))
	result := []PlanEvalCheckResult{{ArtifactID: artifact.ID, CheckID: "first", RuleVersion: 1, Status: PlanEvalCheckPass}}
	if err := st.SavePlanEvalCheckResults(ctx, id, first.LeaseUntil, result, PlanEvalEvaluateRunning, now.Add(2*time.Second)); err != nil {
		t.Fatal(err)
	}
	// API dies after saving one check; a different replica resumes only the other.
	second := find(now.Add(2 * time.Minute))
	if second.ArtifactContent != artifact.Content || len(second.Rules) != 1 || second.Rules[0].CheckID != "second" {
		t.Fatalf("recovery: %+v", second)
	}
	if err := st.SavePlanEvalCheckResults(ctx, id, first.LeaseUntil, nil, PlanEvalEvaluateDone, now.Add(121*time.Second)); err != ErrPlanEvalStaleLease {
		t.Fatalf("old evaluator was not fenced: %v", err)
	}
	result = []PlanEvalCheckResult{{ArtifactID: artifact.ID, CheckID: "second", RuleVersion: 1, Status: PlanEvalCheckFail}}
	if err := st.SavePlanEvalCheckResults(ctx, id, second.LeaseUntil, result, PlanEvalEvaluateDone, now.Add(121*time.Second)); err != nil {
		t.Fatal(err)
	}
	checks, err := st.ListPlanEvalCheckResults(ctx, []string{artifact.ID})
	if err != nil || len(checks) != 3 {
		t.Fatalf("checks: %v %v", checks, err)
	}
}

func TestPlanEval_VersionLockAcrossConnections(t *testing.T) {
	st := openPlanEvalStore(t)
	other := openPlanEvalStore(t)
	ctx := context.Background()
	version := uuid.NewString()
	entered := make(chan struct{})
	release := make(chan struct{})
	first := make(chan error, 1)
	go func() {
		first <- st.WithPlanEvalVersionLock(ctx, version, func(ctx context.Context) error { close(entered); <-release; return errors.New("injected failure") })
	}()
	<-entered
	// Another version is independent, even while the first runtime command blocks.
	if err := other.WithPlanEvalVersionLock(ctx, version+"-other", func(ctx context.Context) error { return nil }); err != nil {
		t.Fatal(err)
	}
	deadline, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	err := other.WithPlanEvalVersionLock(deadline, version, func(ctx context.Context) error { t.Error("same version entered concurrently"); return nil })
	cancel()
	close(release)
	if err == nil {
		t.Fatal("same version was not coordinated")
	}
	if err := <-first; err == nil {
		t.Fatal("callback failure swallowed")
	}
	if err := other.WithPlanEvalVersionLock(ctx, version, func(ctx context.Context) error { return nil }); err != nil {
		t.Fatalf("lock leaked on failure: %v", err)
	}
}

func TestPlanEval_ConcurrentFinalGeneratesSettleTask(t *testing.T) {
	st := openPlanEvalStore(t)
	ctx := context.Background()
	for range 10 {
		version := "v" + uuid.NewString()[:8]
		in := newPlanEvalTaskCreate(version, `[]`, 2)
		task, _, err := st.CreatePlanEvalTask(ctx, in)
		if err != nil {
			t.Fatal(err)
		}
		now := time.Now().UTC()
		for _, execution := range in.Executions {
			if _, err := st.ClaimPlanEvalExecution(ctx, execution.ID, version, execution.ID, "claim-1", now, time.Minute); err != nil {
				t.Fatal(err)
			}
		}
		start := make(chan struct{})
		errors := make(chan error, 2)
		var group sync.WaitGroup
		for _, execution := range in.Executions {
			group.Add(1)
			go func(execution *PlanEvalExecution) {
				defer group.Done()
				<-start
				_, _, err := st.SubmitPlanEvalGenerate(ctx, execution.ID, PlanEvalWorkerLease{AgentVersion: version, WorkerID: execution.ID, LeaseEpoch: 1}, "submit-1", "fp", time.Now().UTC(), &PlanEvalGenerateOutcome{ErrorCode: "timeout"})
				errors <- err
			}(execution)
		}
		close(start)
		group.Wait()
		close(errors)
		for err := range errors {
			if err != nil {
				t.Fatal(err)
			}
		}
		final, err := st.GetPlanEvalTask(ctx, task.ID)
		if err != nil || final.Status != PlanEvalTaskDone {
			t.Fatalf("settlement: %+v %v", final, err)
		}
	}
}

func TestPlanEval_LockWaitCannotReviveExpiredLease(t *testing.T) {
	st := openPlanEvalStore(t)
	ctx := context.Background()
	for _, action := range []string{"renew", "submit", "evaluate"} {
		t.Run(action, func(t *testing.T) {
			version := "v" + uuid.NewString()[:8]
			task, _, err := st.CreatePlanEvalTask(ctx, newPlanEvalTaskCreate(version, `[]`, 1))
			if err != nil {
				t.Fatal(err)
			}
			id := onlyExecution(t, st, task.ID).ID
			holder := PlanEvalWorkerLease{AgentVersion: version, WorkerID: "w", LeaseEpoch: 1}
			if _, err := st.ClaimPlanEvalExecution(ctx, id, version, "w", "claim-1", time.Now().UTC(), time.Second); err != nil {
				t.Fatal(err)
			}
			var evalUntil time.Time
			if action == "evaluate" {
				artifact := &PlanEvalArtifact{ID: uuid.NewString(), ArtifactType: "master_plan", Content: `{}`, Sha256: "fp"}
				if _, _, err := st.SubmitPlanEvalGenerate(ctx, id, holder, "submit-1", "fp", time.Now().UTC(), &PlanEvalGenerateOutcome{Artifact: artifact, SchemaResult: &PlanEvalCheckResult{ID: uuid.NewString(), CheckID: "schema", Status: PlanEvalCheckPass}}); err != nil {
					t.Fatal(err)
				}
				work, err := st.ClaimPlanEvalEvaluations(ctx, time.Now().UTC(), time.Minute, 1000)
				if err != nil {
					t.Fatal(err)
				}
				for _, row := range work {
					if row.ExecutionID == id {
						evalUntil = row.LeaseUntil
					}
				}
				if evalUntil.IsZero() {
					t.Fatal("evaluation not claimed")
				}
			}
			lock := st.db.Begin()
			defer lock.Rollback()
			var row PlanEvalExecution
			if err := lock.Clauses(clause.Locking{Strength: "UPDATE"}).First(&row, "id = ?", id).Error; err != nil {
				t.Fatal(err)
			}
			// Give the blocked operation a still-valid reference clock, then expire it
			// while it waits for the row lock.
			until := time.Now().UTC().Add(30 * time.Millisecond).Truncate(time.Millisecond)
			column := "lease_expires_at"
			if action == "evaluate" {
				column = "evaluate_lease_until"
				evalUntil = until
			}
			if err := lock.Model(&PlanEvalExecution{}).Where("id = ?", id).Update(column, until).Error; err != nil {
				t.Fatal(err)
			}
			result := make(chan error, 1)
			now := time.Now().UTC()
			go func() {
				switch action {
				case "renew":
					_, err := st.RenewPlanEvalLease(ctx, id, holder, now, time.Minute)
					result <- err
				case "submit":
					_, _, err := st.SubmitPlanEvalGenerate(ctx, id, holder, "submit-1", "fp", now, &PlanEvalGenerateOutcome{ErrorCode: "timeout"})
					result <- err
				case "evaluate":
					result <- st.SavePlanEvalCheckResults(ctx, id, evalUntil, nil, PlanEvalEvaluateDone, now)
				}
			}()
			time.Sleep(60 * time.Millisecond)
			if err := lock.Commit().Error; err != nil {
				t.Fatal(err)
			}
			if err := <-result; err != ErrPlanEvalStaleLease {
				t.Fatalf("expired %s accepted after lock wait: %v", action, err)
			}
		})
	}
}

func TestPlanEval_LegacyFingerprintDoesNotWeakenNewIdempotency(t *testing.T) {
	in := &PlanEvalTaskCreate{
		Task:                         &PlanEvalTask{ParamsFingerprint: "v3:omitted"},
		CompatibleParamsFingerprints: []string{"legacy-default-one", "v2:omitted"},
	}
	for _, compatible := range []string{"legacy-default-one", "v2:omitted", "v3:omitted"} {
		if !in.MatchesParamsFingerprint(compatible) {
			t.Fatalf("compatible request cannot replay: %s", compatible)
		}
	}
	for _, incompatible := range []string{"v2:explicit-one", "v3:explicit-one"} {
		if in.MatchesParamsFingerprint(incompatible) {
			t.Fatalf("explicit replicas confused with omission: %s", incompatible)
		}
	}
}

func TestPlanEval_LostLockSessionCancelsRuntime(t *testing.T) {
	st := openPlanEvalStore(t)
	other := openPlanEvalStore(t)
	ctx := context.Background()
	version := uuid.NewString()
	entered := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		result <- st.WithPlanEvalVersionLock(ctx, version, func(runtimeCtx context.Context) error {
			close(entered)
			select {
			case <-runtimeCtx.Done():
				return runtimeCtx.Err()
			case <-time.After(3 * time.Second):
				return errors.New("lock loss not detected")
			}
		})
	}()
	<-entered
	var connectionID int64
	if err := other.db.Raw("SELECT IS_USED_LOCK(SHA2(CONCAT(DATABASE(), ':plan-eval:', ?), 256))", version).Scan(&connectionID).Error; err != nil {
		t.Fatal(err)
	}
	if err := other.db.Exec("KILL ?", connectionID).Error; err != nil {
		t.Fatal(err)
	}
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("lock-session loss did not cancel runtime: %v", err)
	}
	if err := other.WithPlanEvalVersionLock(ctx, version, func(context.Context) error { return nil }); err != nil {
		t.Fatalf("takeover: %v", err)
	}
}

func TestPlanEval_CleanupIntentFencesNewWorkAndPreservesRevision(t *testing.T) {
	st := openPlanEvalStore(t)
	ctx := context.Background()
	version := "v" + uuid.NewString()[:8]
	task, _, err := st.CreatePlanEvalTask(ctx, newPlanEvalTaskCreate(version, `[]`, 1))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.BeginPlanEvalCleanup(ctx, version); !errors.Is(err, ErrPlanEvalVersionBusy) {
		t.Fatalf("active version accepted cleanup: %v", err)
	}
	if err := st.db.Model(&PlanEvalExecution{}).Where("task_id = ?", task.ID).Update("generate_status", PlanEvalGenerateFailed).Error; err != nil {
		t.Fatal(err)
	}
	intent, err := st.BeginPlanEvalCleanup(ctx, version)
	if err != nil {
		t.Fatal(err)
	}
	retry, err := st.BeginPlanEvalCleanup(ctx, version)
	if err != nil || retry.ID != intent.ID || retry.RuntimeRevision != intent.RuntimeRevision {
		t.Fatalf("cleanup retry created a different intent: %+v, %v", retry, err)
	}
	input := newPlanEvalTaskCreate(version, `[]`, 2)
	input.LaunchConfig.Replicas = 2
	if _, _, err := st.CreatePlanEvalTask(ctx, input); !errors.Is(err, ErrPlanEvalVersionBusy) {
		t.Fatalf("new work entered during cleanup: %v", err)
	}
	if _, err := st.SetPlanEvalReplicas(ctx, version, 3); !errors.Is(err, ErrPlanEvalVersionBusy) {
		t.Fatalf("scale entered during cleanup: %v", err)
	}
	if err := st.FinishPlanEvalCleanup(ctx, intent); err != nil {
		t.Fatal(err)
	}
	if _, err := st.GetPlanEvalLaunchConfig(ctx, intent.ID); !errors.Is(err, ErrPlanEvalNotFound) {
		t.Fatalf("retired configuration remains active: %v", err)
	}
	newTask, _, err := st.CreatePlanEvalTask(ctx, input)
	if err != nil || newTask.LaunchConfigID == intent.ID {
		t.Fatalf("new runtime did not replace config identity: %+v, %v", newTask, err)
	}
	if err := st.FinishPlanEvalCleanup(ctx, intent); err != nil {
		t.Fatal(err)
	}
	updated, err := st.GetPlanEvalLaunchConfig(ctx, newTask.LaunchConfigID)
	if err != nil || updated.RuntimeRevision <= intent.RuntimeRevision || updated.Replicas != 2 {
		t.Fatalf("late cleanup affected the new runtime: %+v, %v", updated, err)
	}
}

func TestPlanEvalScenarioRulesKeepLegacyAndExcludeOtherScenarios(t *testing.T) {
	rules := []PlanEvalFrozenRule{{CheckID: "legacy"}, {ScenarioID: "a", CheckID: "rule", Version: 1}, {ScenarioID: "b", CheckID: "rule", Version: 2}}
	got := scenarioRules(rules, "a")
	if len(got) != 2 || got[1].Version != 1 {
		t.Fatalf("wrong scenario rules: %v", got)
	}
}

func TestPlanEval_PublishRuleIsImmutableAndConcurrent(t *testing.T) {
	st := openPlanEvalStore(t)
	ctx := context.Background()
	id := "publish-" + uuid.NewString()
	first := PlanEvalRule{ID: id, Version: 1, Name: "v1", ArtifactType: "*", Source: "function run(){}"}
	if err := st.PublishPlanEvalRule(ctx, &first); err != nil {
		t.Fatal(err)
	}
	changed := first
	changed.Source = "overwritten"
	if err := st.UpsertPlanEvalRule(ctx, &changed); err != nil {
		t.Fatal(err)
	}
	saved, err := st.GetPlanEvalRule(ctx, id, 1)
	if err != nil || saved.Source != first.Source {
		t.Fatalf("seed overwrote version: %+v %v", saved, err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			next := first
			next.Version = 2
			results <- st.PublishPlanEvalRule(ctx, &next)
		}()
	}
	wg.Wait()
	close(results)
	success, conflict := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, ErrPlanEvalRuleConflict) {
			conflict++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("concurrent publish: success=%d conflict=%d", success, conflict)
	}
	first.Version = 4
	if err := st.PublishPlanEvalRule(ctx, &first); !errors.Is(err, ErrPlanEvalRuleConflict) {
		t.Fatalf("skipped version: %v", err)
	}
}

func TestPlanEvalArtifactMetasOmitContentAndVirtualSize(t *testing.T) {
	st := openPlanEvalStore(t)
	ctx := context.Background()
	task, _, err := st.CreatePlanEvalTask(ctx, newPlanEvalTaskCreate("metadata-"+uuid.NewString()[:8], "[]", 1))
	if err != nil {
		t.Fatal(err)
	}
	execution := onlyExecution(t, st, task.ID)
	artifact := &PlanEvalArtifact{ID: uuid.NewString(), ExecutionID: execution.ID, TaskID: task.ID, ArtifactType: "master_plan", Content: "原始 <content>\n", Sha256: "hash", SchemaValid: false, CreatedAt: time.Now()}
	if err := st.db.Create(artifact).Error; err != nil {
		t.Fatal(err)
	}
	// Migration must never materialize this read-only expression as a column.
	if st.db.Migrator().HasColumn(&PlanEvalArtifact{}, "size_bytes") {
		t.Fatal("virtual size_bytes was migrated")
	}
	metas, err := st.ListPlanEvalArtifactMetas(ctx, task.ID)
	if err != nil || len(metas) != 1 {
		t.Fatalf("metas: %v, %d", err, len(metas))
	}
	if metas[0].Content != "" || metas[0].SizeBytes != len(artifact.Content) || metas[0].Sha256 != artifact.Sha256 {
		t.Fatalf("metadata includes content or wrong UTF-8 size: %+v", metas[0])
	}
	raw, err := st.GetPlanEvalArtifact(ctx, artifact.ID)
	if err != nil || raw.Content != artifact.Content {
		t.Fatalf("normal Get queried virtual column or changed content: %v", err)
	}
}

func TestPlanEvalReportMetadataCountsTextNotArtifactContent(t *testing.T) {
	st := openPlanEvalStore(t)
	ctx := context.Background()
	in := newPlanEvalTaskCreate("budget-"+uuid.NewString()[:8], "[]", 1)
	source := strings.Repeat("x", 1<<15)
	in.FrozenRules = []*PlanEvalFrozenRule{{ScenarioID: "scenario", CheckID: "rule", Version: 1, ArtifactType: "master_plan", Source: source}}
	task, _, err := st.CreatePlanEvalTask(ctx, in)
	if err != nil {
		t.Fatal(err)
	}
	artifact := &PlanEvalArtifact{ID: uuid.NewString(), TaskID: task.ID, ExecutionID: in.Executions[0].ID, Content: "small", ArtifactType: "master_plan", Sha256: "hash", CreatedAt: time.Now()}
	if err := st.db.Create(artifact).Error; err != nil {
		t.Fatal(err)
	}
	detail := `{"detail":"` + strings.Repeat("d", 1<<19) + `"}`
	reason := strings.Repeat("r", 1<<15)
	check := &PlanEvalCheckResult{ID: uuid.NewString(), ArtifactID: artifact.ID, CheckID: "rule", Status: "fail", Reason: reason, DetailJSON: &detail, ErrorJSON: nil}
	if err := st.db.Create(check).Error; err != nil {
		t.Fatal(err)
	}
	before, err := st.PlanEvalReportMetadata(ctx, task.ID)
	if err != nil || before.ID != task.ID || before.Status != PlanEvalTaskRunning || before.SizeBytes < 6*int64(len(source)+len(reason)+len(detail)) {
		t.Fatalf("text budget: %+v %v", before, err)
	}
	if err := st.db.Model(artifact).Update("content", strings.Repeat("c", 4<<20)).Error; err != nil {
		t.Fatal(err)
	}
	after, err := st.PlanEvalReportMetadata(ctx, task.ID)
	if err != nil || before.SizeBytes != after.SizeBytes {
		t.Fatal("report metadata loaded/counts artifact content")
	}
	if _, err := st.PlanEvalReportMetadata(ctx, uuid.NewString()); !errors.Is(err, ErrPlanEvalNotFound) {
		t.Fatalf("missing metadata: %v", err)
	}
}
