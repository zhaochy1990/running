package planeval

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/storage"
	"go.uber.org/zap"
)

// Worker handover (claim / renew / submit), evaluation and cleanup — the parts
// of the service that face workers and the cluster rather than the workbench.

// busyRetryMs caps how long a worker is told to wait before re-claiming an
// execution another worker holds.
const busyRetryMs = 5_000

type claimRequest struct {
	SnapshotExecutionID string `json:"snapshot_execution_id"`
	AgentVersion        string `json:"agent_version"`
	WorkerID            string `json:"worker_id"`
	ClaimRequestID      string `json:"claim_request_id"`
}

type executionInput struct {
	ArtifactType string          `json:"artifact_type"`
	Request      json.RawMessage `json:"request"`
	Snapshot     json.RawMessage `json:"snapshot"`
	AsOf         string          `json:"as_of"`
}

type claimLeased struct {
	Status         string         `json:"status"`
	LeaseEpoch     int            `json:"lease_epoch"`
	LeaseExpiresAt string         `json:"lease_expires_at"`
	Input          executionInput `json:"input"`
}

type claimBusy struct {
	Status       string `json:"status"`
	RetryAfterMs int    `json:"retry_after_ms"`
}

type claimTerminal struct {
	Status         string  `json:"status"`
	GenerateStatus string  `json:"generate_status"`
	ArtifactID     *string `json:"artifact_id"`
}

// Claim hands an execution to a worker: the full frozen input under a fresh
// lease, a wait hint while another lease is valid, or the terminal state so a
// redelivered pointer is acknowledged without generating again.
func (s *Service) Claim(ctx context.Context, req claimRequest) (any, *Error) {
	if req.SnapshotExecutionID == "" || req.WorkerID == "" || len(req.WorkerID) > 191 || req.ClaimRequestID == "" || len(req.ClaimRequestID) > 64 || !validAgentVersion(req.AgentVersion) {
		return nil, fail(422, "invalid_request", "snapshot_execution_id、agent_version、worker_id 必填")
	}
	now := time.Now().UTC()
	claim, err := s.store.ClaimPlanEvalExecution(ctx, req.SnapshotExecutionID, req.AgentVersion, req.WorkerID, req.ClaimRequestID, now, s.cfg.LeaseTTL)
	if err != nil {
		switch {
		case errors.Is(err, storage.ErrPlanEvalNotFound):
			return nil, fail(404, "execution_not_found", "执行项不存在")
		case errors.Is(err, storage.ErrPlanEvalAgentVersionMismatch):
			return nil, fail(409, "agent_version_mismatch", "该执行项不属于本 worker 的 Agent 版本")
		}
		return nil, s.internal(err)
	}
	switch claim.Status {
	case "terminal":
		var artifactID *string
		if claim.Execution.ArtifactID != "" {
			artifactID = &claim.Execution.ArtifactID
		}
		return claimTerminal{Status: "terminal", GenerateStatus: claim.Execution.GenerateStatus, ArtifactID: artifactID}, nil
	case "busy":
		wait := busyRetryMs
		if remaining := time.Until(*claim.Execution.LeaseExpiresAt); remaining < time.Duration(wait)*time.Millisecond {
			wait = max(int(remaining/time.Millisecond), 1)
		}
		return claimBusy{Status: "busy", RetryAfterMs: wait}, nil
	}
	scenario, serr := s.executionScenario(ctx, claim.Execution)
	if serr != nil {
		return nil, serr
	}
	s.log.Info("plan-eval execution leased", zap.String("execution", req.SnapshotExecutionID), zap.Int("epoch", claim.LeaseEpoch), zap.String("worker", req.WorkerID))
	return claimLeased{
		Status:         "leased",
		LeaseEpoch:     claim.LeaseEpoch,
		LeaseExpiresAt: claim.LeaseExpiresAt.Format(time.RFC3339Nano),
		Input: executionInput{
			ArtifactType: scenario.ArtifactType,
			Request:      json.RawMessage(claim.Execution.RequestJSON),
			Snapshot:     json.RawMessage(claim.Execution.SnapshotJSON),
			AsOf:         claim.Execution.AsOf,
		},
	}, nil
}

type renewRequest struct {
	storage.PlanEvalWorkerLease
}

// Renew extends the calling worker's lease using the server clock.
func (s *Service) Renew(ctx context.Context, executionID string, req renewRequest) (any, *Error) {
	if err := validateWorkerLease(req.PlanEvalWorkerLease); err != nil {
		return nil, err
	}
	expires, err := s.store.RenewPlanEvalLease(ctx, executionID, req.PlanEvalWorkerLease, time.Now().UTC(), s.cfg.LeaseTTL)
	if err != nil {
		return nil, s.handoverError(err)
	}
	return map[string]any{"lease_expires_at": expires.Format(time.RFC3339Nano)}, nil
}

func (s *Service) handoverError(err error) *Error {
	switch {
	case errors.Is(err, storage.ErrPlanEvalNotFound):
		return fail(404, "execution_not_found", "执行项不存在")
	case errors.Is(err, storage.ErrPlanEvalResultConflict):
		return fail(409, "result_conflict", "提交内容或提交 ID 与已保存结果不同")
	case errors.Is(err, storage.ErrPlanEvalAgentVersionMismatch):
		return fail(409, "agent_version_mismatch", "该执行项不属于本 worker 的 Agent 版本")
	case errors.Is(err, storage.ErrPlanEvalStaleLease):
		return fail(409, "stale_lease", "租约已失效：执行项已被其他 worker 接管")
	}
	return s.internal(err)
}

type reportedError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type reportedResult struct {
	Kind         string         `json:"kind"`
	ArtifactType string         `json:"artifact_type"`
	Content      string         `json:"content"`
	Error        *reportedError `json:"error"`
}

type submitRequest struct {
	storage.PlanEvalWorkerLease
	SubmitID string         `json:"submit_id"`
	Result   reportedResult `json:"result"`
}

// Submit records a generate terminal state and returns the persisted
// acknowledgment. An artifact is kept verbatim with its SchemaCheck verdict;
// that verdict decides whether Evaluate proceeds or is skipped. The response
// is only sent once the whole terminal state is durable — the worker
// acknowledges its message on receipt.
func (s *Service) Submit(ctx context.Context, executionID string, req submitRequest) (any, *Error) {
	if err := validateWorkerLease(req.PlanEvalWorkerLease); err != nil {
		return nil, err
	}
	if req.SubmitID == "" || len(req.SubmitID) > 64 {
		return nil, fail(422, "invalid_request", "submit_id 必填且不超过 64 字符")
	}
	fingerprint := sha256.Sum256(mustJSON(req.Result))
	outcome := &storage.PlanEvalGenerateOutcome{}
	switch req.Result.Kind {
	case "artifact":
		if req.Result.Content == "" {
			return nil, fail(422, "invalid_request", "artifact 结果必须带 content")
		}
		outcome.Artifact = &storage.PlanEvalArtifact{ID: uuid.NewString(), ArtifactType: req.Result.ArtifactType}
	case "failed":
		if req.Result.Error == nil || req.Result.Error.Code == "" {
			return nil, fail(422, "invalid_request", "failed 结果必须带 error.code")
		}
		outcome.ErrorCode, outcome.ErrorMessage = req.Result.Error.Code, req.Result.Error.Message
	default:
		return nil, fail(422, "invalid_request", "result.kind 应为 artifact 或 failed")
	}

	if outcome.Artifact != nil {
		// The schema verdict needs the frozen inputs; load the execution row
		// they live on.
		scenario, input, serr := s.executionInput(ctx, executionID)
		if serr != nil {
			return nil, serr
		}
		if req.Result.ArtifactType != scenario.ArtifactType {
			return nil, fail(422, "invalid_request", fmt.Sprintf("artifact_type 应为 %s", scenario.ArtifactType))
		}
		input.Artifact = json.RawMessage(req.Result.Content)
		verdict := (SchemaCheck{ArtifactType: scenario.ArtifactType}).Run(ctx, *input)
		outcome.SchemaResult = checkResultRow(verdict, "")
		sum := sha256.Sum256([]byte(req.Result.Content))
		outcome.Artifact.Content = req.Result.Content
		outcome.Artifact.Sha256 = hex.EncodeToString(sum[:])
	}

	ack, replayed, err := s.store.SubmitPlanEvalGenerate(ctx, executionID, req.PlanEvalWorkerLease, req.SubmitID, hex.EncodeToString(fingerprint[:]), time.Now().UTC(), outcome)
	if err != nil {
		if errors.Is(err, storage.ErrPlanEvalStaleLease) {
			return nil, fail(409, "stale_lease", "租约已失效：结果未被接受")
		}
		return nil, s.handoverError(err)
	}
	s.log.Info("plan-eval generate settled", zap.String("execution", executionID), zap.String("generate", ack.GenerateStatus), zap.String("evaluate", ack.EvaluateStatus), zap.Bool("replayed", replayed))
	if ack.EvaluateStatus == storage.PlanEvalEvaluatePending {
		// Judge the artifact now; the periodic sweep covers a crash in between.
		go s.EvaluatePending(context.Background())
	}
	return ack, nil
}

// executionInput loads an execution's frozen inputs as a CheckInput.
func (s *Service) executionInput(ctx context.Context, executionID string) (*scenarioDocument, *CheckInput, *Error) {
	execution, err := s.store.PlanEvalExecutionInput(ctx, executionID)
	if err != nil {
		return nil, nil, s.handoverError(err)
	}
	scenario, serr := s.executionScenario(ctx, execution)
	if serr != nil {
		return nil, nil, serr
	}
	return scenario, &CheckInput{
		Artifact: nil, Snapshot: json.RawMessage(execution.SnapshotJSON),
		Scenario: ScenarioInput{ScenarioID: scenario.ID, Request: json.RawMessage(execution.RequestJSON)},
		AsOf:     execution.AsOf,
	}, nil
}

// checkResultRow adapts a check verdict to its stored shape.
func checkResultRow(result CheckResult, artifactID string) *storage.PlanEvalCheckResult {
	row := &storage.PlanEvalCheckResult{ID: uuid.NewString(), ArtifactID: artifactID, CheckID: result.CheckID, RuleVersion: result.Version, Status: result.Status, Reason: result.Reason}
	if len(result.Detail) > 0 {
		detail := string(result.Detail)
		row.DetailJSON = &detail
	}
	if result.Error != nil {
		encoded := string(mustJSON(result.Error))
		row.ErrorJSON = &encoded
	}
	return row
}

// EvaluatePending judges every artifact that is waiting (or whose previous
// evaluation lease expired). Safe to call concurrently and from several
// replicas: each evaluation is won with a compare-and-set and each check is
// recorded once per artifact.
func (s *Service) EvaluatePending(ctx context.Context) {
	s.evaluateMu.Lock()
	defer s.evaluateMu.Unlock()

	for range 16 {
		work, err := s.store.ClaimPlanEvalEvaluations(ctx, time.Now().UTC(), s.cfg.LeaseTTL, 1)
		if err != nil {
			s.log.Error("plan-eval: claim evaluations", zap.Error(err))
			return
		}
		if len(work) == 0 {
			return
		}
		s.evaluate(ctx, work[0])
	}
}

func (s *Service) evaluate(ctx context.Context, work storage.PlanEvalEvaluationWork) {
	ctx, cancel := context.WithDeadline(ctx, work.LeaseUntil)
	defer cancel()
	input := CheckInput{
		Artifact: json.RawMessage(work.ArtifactContent), Snapshot: json.RawMessage(work.SnapshotJSON),
		Scenario: ScenarioInput{ScenarioID: work.ScenarioID, Request: json.RawMessage(work.RequestJSON)},
		AsOf:     work.AsOf,
	}

	for _, rule := range work.Rules {
		if !ruleAppliesTo(rule.ArtifactType, work.ArtifactType) {
			continue
		}
		check := s.staticRule(rule.CheckID, rule.Version, rule.Source)
		// One failing check never stops the rest.
		verdict := check.Run(ctx, input)
		if ctx.Err() != nil {
			// Capacity/caller/lease expiry is retryable, not a permanent rule verdict.
			return
		}
		result := *checkResultRow(verdict, work.ArtifactID)
		if err := s.store.SavePlanEvalCheckResults(ctx, work.ExecutionID, work.LeaseUntil, []storage.PlanEvalCheckResult{result}, storage.PlanEvalEvaluateRunning, time.Now().UTC()); err != nil {
			s.log.Error("plan-eval: save check result", zap.String("execution", work.ExecutionID), zap.Error(err))
			return
		}
	}
	status := storage.PlanEvalEvaluateDone
	if err := s.store.SavePlanEvalCheckResults(ctx, work.ExecutionID, work.LeaseUntil, nil, status, time.Now().UTC()); err != nil {
		s.log.Error("plan-eval: save check results", zap.String("execution", work.ExecutionID), zap.Error(err))
		return
	}
	s.log.Info("plan-eval evaluation finished", zap.String("execution", work.ExecutionID), zap.Int("checks", len(work.Rules)))
}

// RunEvaluator judges artifacts until the context ends: right away, after
// every submit (Submit calls EvaluatePending itself) and on a timer for
// anything left behind by a crash.
func (s *Service) RunEvaluator(ctx context.Context) {
	interval := s.cfg.EvaluateSweepEvery
	if interval <= 0 {
		interval = 30 * time.Second
	}
	s.EvaluatePending(ctx)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.EvaluatePending(ctx)
		}
	}
}

// Cleanup removes the version's worker Deployment once it is provably idle:
// every Generate of the version is terminal and the queue holds neither ready
// nor unacknowledged messages. The queue itself and every artifact stay.
func (s *Service) Cleanup(ctx context.Context, agentVersion string) *Error {
	return s.withVersion(ctx, agentVersion, func(ctx context.Context) *Error { return s.cleanup(ctx, agentVersion) })
}

func (s *Service) cleanup(ctx context.Context, agentVersion string) *Error {
	if !s.knownVersion(agentVersion) || !validAgentVersion(agentVersion) {
		return fail(422, "invalid_request", "未登记的 Agent 版本："+agentVersion)
	}
	active, err := s.store.CountPlanEvalActiveGenerates(ctx, agentVersion)
	if err != nil {
		return s.internal(err)
	}
	if active > 0 {
		return fail(409, "cleanup_blocked", fmt.Sprintf("该版本还有 %d 个执行项在等待或生成中", active))
	}
	if serr := s.requireIdleQueue(ctx, agentVersion); serr != nil {
		return serr
	}
	config, err := s.store.BeginPlanEvalCleanup(ctx, agentVersion)
	if err != nil {
		return s.mapStorageError(err)
	}
	expected, err := s.deployer.Status(ctx, agentVersion)
	if err != nil {
		return s.internal(err)
	}
	if expected.DeploymentRevision > config.RuntimeRevision || expected.SecretRevision > config.RuntimeRevision {
		return s.mapStorageError(storage.ErrPlanEvalVersionBusy)
	}
	if serr := s.requireIdleQueue(ctx, agentVersion); serr != nil {
		return serr
	}
	if err := s.deployer.Delete(ctx, agentVersion, expected); err != nil {
		s.log.Error("plan-eval: delete worker deployment", zap.String("agent_version", agentVersion), zap.Error(err))
		return fail(502, "cleanup_failed", "删除 Deployment 失败")
	}
	if err := s.store.FinishPlanEvalCleanup(ctx, config); err != nil {
		return s.mapStorageError(err)
	}
	s.log.Info("plan-eval worker deployment removed", zap.String("agent_version", agentVersion))
	return nil
}

func (s *Service) requireIdleQueue(ctx context.Context, agentVersion string) *Error {
	depth, err := s.broker.QueueDepth(ctx, QueueName(agentVersion))
	if err != nil {
		return s.internal(err)
	}
	if depth.Ready+depth.Unacked > 0 {
		return fail(409, "cleanup_blocked", fmt.Sprintf("该版本的队列还有 %d 条待消费、%d 条未确认消息", depth.Ready, depth.Unacked))
	}
	return nil
}

func validateWorkerLease(lease storage.PlanEvalWorkerLease) *Error {
	if lease.WorkerID == "" || len(lease.WorkerID) > 191 || !validAgentVersion(lease.AgentVersion) || lease.LeaseEpoch <= 0 {
		return fail(422, "invalid_request", "agent_version、worker_id 和正整数 lease_epoch 必填")
	}
	return nil
}
