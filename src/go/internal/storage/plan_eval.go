package storage

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	mysqldriver "github.com/go-sql-driver/mysql"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Plan-evaluation persistence (devops#1055). Every multi-row write the
// contract requires to be atomic — task creation with its frozen inputs, the
// generate terminal state with its receipt and artifact — is one transaction
// here; business rules (what to freeze, how to judge) live in internal/planeval.

var (
	ErrPlanEvalNotFound             = errors.New("storage: plan-eval row not found")
	ErrPlanEvalResultConflict       = errors.New("storage: plan-eval result conflicts with persisted submission")
	ErrPlanEvalVersionBusy          = errors.New("storage: plan-eval version operation in progress")
	ErrPlanEvalStaleLease           = errors.New("storage: plan-eval lease is stale")
	ErrPlanEvalAgentVersionMismatch = errors.New("storage: plan-eval agent version mismatch")
)

// PlanEvalIdempotencyConflictError is raised when an idempotency key is
// reused with different parameters.
type PlanEvalIdempotencyConflictError struct{ ExistingTaskID string }

func (e *PlanEvalIdempotencyConflictError) Error() string {
	return fmt.Sprintf("storage: idempotency key already used by task %s with different parameters", e.ExistingTaskID)
}

// PlanEvalLaunchConfigConflictError is raised when a task asks for a different
// set of environment variables than the one a running version was started
// with — the shared consumers would otherwise run under someone else's config.
type PlanEvalLaunchConfigConflictError struct {
	ExistingNames  []string
	RequestedNames []string
}

func (e *PlanEvalLaunchConfigConflictError) Error() string {
	return "storage: agent version already has a different launch configuration"
}

// PlanEvalGenerateAck is the persisted acknowledgment body returned to the
// worker (snake_case mirrors the TS worker's receipt contract).
type PlanEvalGenerateAck struct {
	ReceiptID           string `json:"receipt_id"`
	SnapshotExecutionID string `json:"snapshot_execution_id"`
	GenerateStatus      string `json:"generate_status"`
	ArtifactID          string `json:"artifact_id"`
	EvaluateStatus      string `json:"evaluate_status"`
	ReceivedAt          string `json:"received_at"`
}

// AutoMigratePlanEval creates/updates every plan-eval table in the plan-eval
// database. Called by `stride plan-eval` at boot.
func (s *Store) AutoMigratePlanEval(ctx context.Context) error {
	models := []any{
		&PlanEvalScenario{}, &PlanEvalRunnerSnapshot{}, &PlanEvalRule{}, &PlanEvalTask{},
		&PlanEvalLaunchConfig{}, &PlanEvalFrozenRule{}, &PlanEvalExecution{}, &PlanEvalArtifact{},
		&PlanEvalReceipt{}, &PlanEvalCheckResult{},
	}
	if err := s.db.WithContext(ctx).AutoMigrate(models...); err != nil {
		return fmt.Errorf("storage: automigrate plan-eval: %w", err)
	}
	return nil
}

// ---- presets ----

// UpsertPlanEvalScenario / UpsertPlanEvalRunnerSnapshot / UpsertPlanEvalRule
// make the embedded presets idempotent: the same key always ends up holding
// what this binary ships.
func (s *Store) UpsertPlanEvalScenario(ctx context.Context, row *PlanEvalScenario) error {
	now := time.Now().UTC()
	row.CreatedAt, row.UpdatedAt = now, now
	if err := s.db.WithContext(ctx).Clauses(clause.OnConflict{UpdateAll: true}).Create(row).Error; err != nil {
		return fmt.Errorf("storage: upsert plan_eval_scenarios: %w", err)
	}
	return nil
}

func (s *Store) UpsertPlanEvalRunnerSnapshot(ctx context.Context, row *PlanEvalRunnerSnapshot) error {
	now := time.Now().UTC()
	row.CreatedAt, row.UpdatedAt = now, now
	if err := s.db.WithContext(ctx).Clauses(clause.OnConflict{UpdateAll: true}).Create(row).Error; err != nil {
		return fmt.Errorf("storage: upsert plan_eval_runner_snapshots: %w", err)
	}
	return nil
}

func (s *Store) UpsertPlanEvalRule(ctx context.Context, row *PlanEvalRule) error {
	row.CreatedAt = time.Now().UTC()
	if err := s.db.WithContext(ctx).Clauses(clause.OnConflict{UpdateAll: true}).Create(row).Error; err != nil {
		return fmt.Errorf("storage: upsert plan_eval_rules: %w", err)
	}
	return nil
}

func (s *Store) GetPlanEvalScenario(ctx context.Context, id string) (*PlanEvalScenario, error) {
	var row PlanEvalScenario
	if err := s.db.WithContext(ctx).First(&row, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrPlanEvalNotFound
		}
		return nil, fmt.Errorf("storage: get plan_eval_scenarios: %w", err)
	}
	return &row, nil
}

func (s *Store) GetPlanEvalRunnerSnapshot(ctx context.Context, id string) (*PlanEvalRunnerSnapshot, error) {
	var row PlanEvalRunnerSnapshot
	if err := s.db.WithContext(ctx).First(&row, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrPlanEvalNotFound
		}
		return nil, fmt.Errorf("storage: get plan_eval_runner_snapshots: %w", err)
	}
	return &row, nil
}

func (s *Store) GetPlanEvalRule(ctx context.Context, id string, version int) (*PlanEvalRule, error) {
	var row PlanEvalRule
	if err := s.db.WithContext(ctx).First(&row, "id = ? AND version = ?", id, version).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrPlanEvalNotFound
		}
		return nil, fmt.Errorf("storage: get plan_eval_rules: %w", err)
	}
	return &row, nil
}

// ---- task creation ----

// PlanEvalTaskCreate carries everything one task creation writes. The service
// has already resolved and frozen the inputs; EnvCipher is the encrypted
// environment used only when the version has no launch configuration yet.
type PlanEvalTaskCreate struct {
	LegacyParamsFingerprint string
	Task                    *PlanEvalTask
	LaunchConfig            *PlanEvalLaunchConfig
	EnvCipher               []byte
	Executions              []*PlanEvalExecution
	FrozenRules             []*PlanEvalFrozenRule
}

// Only pre-v2 tasks accept the legacy default-replica fingerprint.
func planEvalParamsMatch(persisted string, in *PlanEvalTaskCreate) bool {
	return persisted == in.Task.ParamsFingerprint || (!strings.HasPrefix(persisted, "v2:") && persisted == in.LegacyParamsFingerprint)
}

// CreatePlanEvalTask persists the task, its pending executions, the frozen
// inputs/rules and the effective launch configuration in one transaction.
//
//   - Same submitter + idempotency key + parameters → the original task is
//     returned with replayed=true and nothing is written.
//   - Same key, different parameters → PlanEvalIdempotencyConflictError.
//   - A launch configuration already exists for the version: it is reused when
//     it has the same variables and values (replicas follow the new
//     request); otherwise PlanEvalLaunchConfigConflictError and nothing is
//     written.
func (s *Store) CreatePlanEvalTask(ctx context.Context, in *PlanEvalTaskCreate) (task *PlanEvalTask, replayed bool, err error) {
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var existing PlanEvalTask
		switch err := tx.Where("submitter = ? AND idempotency_key = ?", in.Task.Submitter, in.Task.IdempotencyKey).First(&existing).Error; {
		case err == nil:
			if !planEvalParamsMatch(existing.ParamsFingerprint, in) {
				return &PlanEvalIdempotencyConflictError{ExistingTaskID: existing.ID}
			}
			task, replayed = &existing, true
			return nil
		case !errors.Is(err, gorm.ErrRecordNotFound):
			return fmt.Errorf("storage: find plan_eval_tasks by idempotency key: %w", err)
		}

		now := time.Now().UTC()
		var current PlanEvalLaunchConfig
		switch err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("agent_version = ?", in.Task.AgentVersion).First(&current).Error; {
		case err == nil:
			// An empty variable set means "keep what this version already runs
			// with"; any other set must match the active values as well.
			if in.LaunchConfig.EnvNames != "[]" && current.EnvFingerprint != in.LaunchConfig.EnvFingerprint {
				return &PlanEvalLaunchConfigConflictError{}
			}
			if in.LaunchConfig.Replicas == 0 {
				in.LaunchConfig.Replicas = current.Replicas
			}
			if err := tx.Model(&PlanEvalLaunchConfig{}).Where("id = ?", current.ID).
				Updates(map[string]any{"replicas": in.LaunchConfig.Replicas, "updated_at": now}).Error; err != nil {
				return fmt.Errorf("storage: update plan_eval_launch_configs: %w", err)
			}
			in.Task.LaunchConfigID = current.ID
			in.Task.LaunchEnvNames = current.EnvNames
		case errors.Is(err, gorm.ErrRecordNotFound):
			launch := *in.LaunchConfig
			if launch.Replicas == 0 {
				launch.Replicas = 1
				in.LaunchConfig.Replicas = 1
			}
			launch.EnvCipher = in.EnvCipher
			launch.CreatedAt, launch.UpdatedAt = now, now
			if err := tx.Create(&launch).Error; err != nil {
				if isDuplicateKey(err) {
					// Lost a race with a concurrent first task on this version.
					return &PlanEvalLaunchConfigConflictError{}
				}
				return fmt.Errorf("storage: create plan_eval_launch_configs: %w", err)
			}
			in.Task.LaunchConfigID = launch.ID
			in.Task.LaunchEnvNames = launch.EnvNames
		default:
			return fmt.Errorf("storage: find plan_eval_launch_configs: %w", err)
		}

		in.Task.LaunchReplicas = in.LaunchConfig.Replicas
		in.Task.Status, in.Task.CreatedAt, in.Task.UpdatedAt = PlanEvalTaskRunning, now, now
		if err := tx.Create(in.Task).Error; err != nil {
			return fmt.Errorf("storage: create plan_eval_tasks: %w", err)
		}
		for _, rule := range in.FrozenRules {
			rule.TaskID = in.Task.ID
			if err := tx.Create(rule).Error; err != nil {
				return fmt.Errorf("storage: create plan_eval_frozen_rules: %w", err)
			}
		}
		for _, execution := range in.Executions {
			execution.TaskID = in.Task.ID
			execution.CreatedAt, execution.UpdatedAt = now, now
			if err := tx.Create(execution).Error; err != nil {
				return fmt.Errorf("storage: create plan_eval_executions: %w", err)
			}
		}
		task = in.Task
		return nil
	})
	if err != nil {
		// A concurrent insertion can win either unique key before our insert.
		var persisted PlanEvalTask
		lookup := s.db.WithContext(ctx).Where("submitter = ? AND idempotency_key = ?", in.Task.Submitter, in.Task.IdempotencyKey).First(&persisted)
		if lookup.Error == nil {
			if !planEvalParamsMatch(persisted.ParamsFingerprint, in) {
				return nil, false, &PlanEvalIdempotencyConflictError{ExistingTaskID: persisted.ID}
			}
			return &persisted, true, nil
		}
		return nil, false, err
	}
	return task, replayed, nil
}

// WithPlanEvalVersionLock coordinates runtime operations across API replicas.
// A dedicated connection owns the database-scoped MySQL lock until completion.
func (s *Store) WithPlanEvalVersionLock(ctx context.Context, version string, run func(context.Context) error) error {
	db, err := s.db.DB()
	if err != nil {
		return err
	}

	var key string
	if err := db.QueryRowContext(ctx, "SELECT SHA2(CONCAT(DATABASE(), ':plan-eval:', ?), 256)", version).Scan(&key); err != nil {
		return err
	}
	waitCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var conn *sql.Conn
	for {
		conn, err = db.Conn(waitCtx)
		if err != nil {
			return err
		}
		var acquired sql.NullInt64
		err = conn.QueryRowContext(waitCtx, "SELECT GET_LOCK(?, 0)", key).Scan(&acquired)
		if err != nil || !acquired.Valid {
			// A failed response may hide an acquired lock; discard the session.
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
			_ = conn.Close()
			if err != nil {
				return err
			}
			return ErrPlanEvalVersionBusy
		}
		if acquired.Int64 == 1 {
			break
		}
		_ = conn.Close()
		// Waiting requests must not exhaust the pool needed by the lock holder.
		select {
		case <-waitCtx.Done():
			return ErrPlanEvalVersionBusy
		case <-time.After(50 * time.Millisecond):
		}
	}
	defer conn.Close()
	defer func() {
		releaseCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var released sql.NullInt64
		if err := conn.QueryRowContext(releaseCtx, "SELECT RELEASE_LOCK(?)", key).Scan(&released); err != nil || !released.Valid || released.Int64 != 1 {
			// Never return a session that may still own the lock to the pool.
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		}
	}()
	// Losing the lock session must cancel in-flight cluster operations.
	runtimeCtx, cancelRuntime := context.WithCancel(ctx)
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(200 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-runtimeCtx.Done():
				return
			case <-ticker.C:
				probeCtx, cancelProbe := context.WithTimeout(runtimeCtx, time.Second)
				var held bool
				err := conn.QueryRowContext(probeCtx, "SELECT IS_USED_LOCK(?) = CONNECTION_ID()", key).Scan(&held)
				cancelProbe()
				if err != nil || !held {
					cancelRuntime()
					return
				}
			}
		}
	}()
	err = run(runtimeCtx)
	runtimeErr := runtimeCtx.Err()
	cancelRuntime()
	<-stopped
	if runtimeErr != nil {
		return runtimeErr
	}
	return err
}

func (s *Store) RecordPlanEvalDispatch(ctx context.Context, executionID string) error {
	return s.db.WithContext(ctx).Model(&PlanEvalExecution{}).Where("id = ?", executionID).Update("dispatched_at", time.Now().UTC()).Error
}

func (s *Store) SetPlanEvalReplicas(ctx context.Context, version string, replicas int) error {
	return s.db.WithContext(ctx).Model(&PlanEvalLaunchConfig{}).Where("agent_version = ?", version).Update("replicas", replicas).Error
}

func (s *Store) PlanEvalLaunchConfigForVersion(ctx context.Context, version string) (*PlanEvalLaunchConfig, error) {
	var row PlanEvalLaunchConfig
	if err := s.db.WithContext(ctx).Where("agent_version = ?", version).First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrPlanEvalNotFound
		}
		return nil, err
	}
	return &row, nil
}

// RecordPlanEvalLaunch records the outcome of publishing and starting a task.
func (s *Store) RecordPlanEvalLaunch(ctx context.Context, taskID, message string) error {
	now := time.Now().UTC()
	changes := map[string]any{"launch_error": message, "updated_at": now}
	if message == "" {
		changes["launched_at"] = now
	}
	err := s.db.WithContext(ctx).Model(&PlanEvalTask{}).Where("id = ?", taskID).
		Updates(changes).Error
	if err != nil {
		return fmt.Errorf("storage: set plan_eval_tasks launch error: %w", err)
	}
	return nil
}

// ReleasePlanEvalLaunchConfig removes even its encrypted values after cleanup.
// The task rows retain the effective replica count and variable names.
func (s *Store) ReleasePlanEvalLaunchConfig(ctx context.Context, agentVersion, configID string) error {
	if configID == "" {
		return nil
	}
	res := s.db.WithContext(ctx).Where("id = ? AND agent_version = ?", configID, agentVersion).
		Where("NOT EXISTS (SELECT 1 FROM plan_eval_executions e JOIN plan_eval_tasks t ON t.id = e.task_id WHERE t.agent_version = ? AND e.generate_status IN ('queued','leased'))", agentVersion).
		Delete(&PlanEvalLaunchConfig{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		var remaining int64
		if err := s.db.WithContext(ctx).Model(&PlanEvalLaunchConfig{}).Where("id = ?", configID).Count(&remaining).Error; err != nil {
			return err
		}
		if remaining != 0 {
			return ErrPlanEvalVersionBusy
		}
	}
	return nil
}

// ---- reads ----

// ListPlanEvalTasks returns the newest tasks first plus the total count.
func (s *Store) ListPlanEvalTasks(ctx context.Context, limit, offset int) ([]PlanEvalTask, int64, error) {
	var total int64
	if err := s.db.WithContext(ctx).Model(&PlanEvalTask{}).Count(&total).Error; err != nil {
		return nil, 0, fmt.Errorf("storage: count plan_eval_tasks: %w", err)
	}
	var rows []PlanEvalTask
	if err := s.db.WithContext(ctx).Order("created_at DESC, id DESC").Limit(limit).Offset(offset).Find(&rows).Error; err != nil {
		return nil, 0, fmt.Errorf("storage: list plan_eval_tasks: %w", err)
	}
	return rows, total, nil
}

// PlanEvalTaskCounts aggregates one task's executions for the list row.
type PlanEvalTaskCounts struct {
	TaskID         string
	Total          int64
	Finished       int64 // Generate 与 Evaluate 都已终结的执行项
	GenerateFailed int64 // Generate 失败（模型/数据/内核错误）
	RuleFailed     int64 // 产物无效（Schema 不通过）或业务规则不通过的执行项
}

// PlanEvalTaskCounts returns the per-task aggregates in one grouped query.
func (s *Store) PlanEvalTaskCounts(ctx context.Context, taskIDs []string) (map[string]PlanEvalTaskCounts, error) {
	out := make(map[string]PlanEvalTaskCounts, len(taskIDs))
	if len(taskIDs) == 0 {
		return out, nil
	}
	var rows []struct {
		TaskID         string
		Total          int64
		Finished       int64
		GenerateFailed int64
		RuleFailed     int64
	}
	err := s.db.WithContext(ctx).Raw(`
		SELECT e.task_id,
		       COUNT(*) AS total,
		       SUM(e.generate_status IN ('done','failed') AND e.evaluate_status IN ('done','failed','skipped')) AS finished,
		       SUM(e.generate_status = 'failed') AS generate_failed,
		       SUM(e.generate_status = 'done' AND (a.schema_valid = 0 OR EXISTS (
		           SELECT 1 FROM plan_eval_check_results r
		            WHERE r.artifact_id = a.id AND r.status = 'fail'))) AS rule_failed
		  FROM plan_eval_executions e
		  LEFT JOIN plan_eval_artifacts a ON a.execution_id = e.id
		 WHERE e.task_id IN ?
		 GROUP BY e.task_id`, taskIDs).Scan(&rows).Error
	if err != nil {
		return nil, fmt.Errorf("storage: plan-eval task counts: %w", err)
	}
	for _, row := range rows {
		out[row.TaskID] = PlanEvalTaskCounts{TaskID: row.TaskID, Total: row.Total, Finished: row.Finished, GenerateFailed: row.GenerateFailed, RuleFailed: row.RuleFailed}
	}
	return out, nil
}

func (s *Store) GetPlanEvalTask(ctx context.Context, id string) (*PlanEvalTask, error) {
	var row PlanEvalTask
	if err := s.db.WithContext(ctx).First(&row, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrPlanEvalNotFound
		}
		return nil, fmt.Errorf("storage: get plan_eval_tasks: %w", err)
	}
	return &row, nil
}

func (s *Store) ListPlanEvalExecutions(ctx context.Context, taskID string) ([]PlanEvalExecution, error) {
	var rows []PlanEvalExecution
	// The frozen inputs are re-read only when they are needed (claim / evaluate).
	if err := s.db.WithContext(ctx).Omit("request_json", "snapshot_json").
		Where("task_id = ?", taskID).Order("created_at ASC, id ASC").Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("storage: list plan_eval_executions: %w", err)
	}
	return rows, nil
}

// ListPlanEvalArtifactMetas lists a task's artifacts without their content.
func (s *Store) ListPlanEvalArtifactMetas(ctx context.Context, taskID string) ([]PlanEvalArtifact, error) {
	var rows []PlanEvalArtifact
	if err := s.db.WithContext(ctx).Select("plan_eval_artifacts.*, OCTET_LENGTH(content) AS size_bytes").
		Where("task_id = ?", taskID).Order("created_at ASC, id ASC").Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("storage: list plan_eval_artifacts: %w", err)
	}
	return rows, nil
}

func (s *Store) ListPlanEvalCheckResults(ctx context.Context, artifactIDs []string) ([]PlanEvalCheckResult, error) {
	var rows []PlanEvalCheckResult
	if len(artifactIDs) == 0 {
		return rows, nil
	}
	if err := s.db.WithContext(ctx).Where("artifact_id IN ?", artifactIDs).Order("created_at ASC, id ASC").Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("storage: list plan_eval_check_results: %w", err)
	}
	return rows, nil
}

func (s *Store) ListPlanEvalFrozenRules(ctx context.Context, taskID string) ([]PlanEvalFrozenRule, error) {
	var rows []PlanEvalFrozenRule
	if err := s.db.WithContext(ctx).Where("task_id = ?", taskID).Order("id ASC").Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("storage: list plan_eval_frozen_rules: %w", err)
	}
	return rows, nil
}

func (s *Store) GetPlanEvalArtifact(ctx context.Context, id string) (*PlanEvalArtifact, error) {
	var row PlanEvalArtifact
	if err := s.db.WithContext(ctx).First(&row, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrPlanEvalNotFound
		}
		return nil, fmt.Errorf("storage: get plan_eval_artifacts: %w", err)
	}
	return &row, nil
}

func (s *Store) GetPlanEvalLaunchConfig(ctx context.Context, id string) (*PlanEvalLaunchConfig, error) {
	var row PlanEvalLaunchConfig
	if err := s.db.WithContext(ctx).First(&row, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrPlanEvalNotFound
		}
		return nil, fmt.Errorf("storage: get plan_eval_launch_configs: %w", err)
	}
	return &row, nil
}

func (s *Store) ListPlanEvalLaunchConfigs(ctx context.Context) ([]PlanEvalLaunchConfig, error) {
	var rows []PlanEvalLaunchConfig
	if err := s.db.WithContext(ctx).Omit("env_cipher").Order("agent_version ASC").Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("storage: list plan_eval_launch_configs: %w", err)
	}
	return rows, nil
}

// ---- worker handover: claim / renew / submit ----

// PlanEvalClaim is the outcome of a worker's claim attempt.
type PlanEvalClaim struct {
	// Status is leased, busy or terminal.
	Status         string
	LeaseEpoch     int
	LeaseExpiresAt time.Time
	// Execution is set for leased and carries the frozen inputs.
	Execution *PlanEvalExecution
}

// ClaimPlanEvalExecution hands the execution to the calling worker unless a
// valid lease or a terminal state says otherwise. A lease that has expired may
// be taken over (epoch + 1), which is what makes an older holder's later
// renewals and results fall on stale ground.
func (s *Store) ClaimPlanEvalExecution(ctx context.Context, id, agentVersion, workerID, claimRequestID string, now time.Time, ttl time.Duration) (*PlanEvalClaim, error) {
	started := time.Now()
	claim := &PlanEvalClaim{}
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Lock the execution first; the task is only read.
		var execution PlanEvalExecution
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&execution, "id = ?", id).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlanEvalNotFound
			}
			return fmt.Errorf("storage: lock plan_eval_executions: %w", err)
		}
		var task PlanEvalTask
		if err := tx.Select("id", "agent_version").First(&task, "id = ?", execution.TaskID).Error; err != nil {
			return fmt.Errorf("storage: get plan_eval_tasks for claim: %w", err)
		}
		if task.AgentVersion != agentVersion {
			return ErrPlanEvalAgentVersionMismatch
		}
		now = now.Add(time.Since(started))
		claim.Execution = &execution
		if PlanEvalGenerateTerminal(execution.GenerateStatus) {
			claim.Status = "terminal"
			return nil
		}
		if execution.LeaseExpiresAt != nil && execution.LeaseExpiresAt.After(now) {
			if execution.LeaseWorker == workerID && execution.ClaimRequestID == claimRequestID {
				claim.Status, claim.LeaseEpoch, claim.LeaseExpiresAt = "leased", execution.LeaseEpoch, *execution.LeaseExpiresAt
			} else {
				claim.Status = "busy"
			}
			return nil
		}
		expires := now.Add(ttl).Truncate(time.Millisecond)
		epoch := execution.LeaseEpoch + 1
		res := tx.Model(&PlanEvalExecution{}).Where("id = ?", id).Updates(map[string]any{
			"generate_status": PlanEvalGenerateLeased, "attempts": gorm.Expr("attempts + 1"),
			"lease_epoch": epoch, "lease_expires_at": expires, "lease_worker": workerID, "claim_request_id": claimRequestID, "updated_at": now,
		})
		if res.Error != nil {
			return fmt.Errorf("storage: lease plan_eval_executions: %w", res.Error)
		}
		// Re-read so the caller gets the stored state (attempts was a SQL-side increment).
		if err := tx.First(&execution, "id = ?", id).Error; err != nil {
			return fmt.Errorf("storage: reload leased plan_eval_executions: %w", err)
		}
		claim.Execution = &execution
		claim.Status, claim.LeaseEpoch, claim.LeaseExpiresAt = "leased", epoch, expires
		return nil
	})
	if err != nil {
		return nil, err
	}
	return claim, nil
}

// RenewPlanEvalLease extends the lease held under `epoch`; the server clock is
// the only clock. ErrPlanEvalStaleLease means the lease changed hands.
type PlanEvalWorkerLease struct {
	AgentVersion string `json:"agent_version"`
	WorkerID     string `json:"worker_id"`
	LeaseEpoch   int    `json:"lease_epoch"`
}

func (s *Store) RenewPlanEvalLease(ctx context.Context, id string, lease PlanEvalWorkerLease, now time.Time, ttl time.Duration) (time.Time, error) {

	started := time.Now()
	var expires time.Time
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var execution PlanEvalExecution
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&execution, "id = ?", id).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlanEvalNotFound
			}
			return err
		}
		var task PlanEvalTask
		if err := tx.Select("agent_version").First(&task, "id = ?", execution.TaskID).Error; err != nil {
			return err
		}
		now = now.Add(time.Since(started))
		if task.AgentVersion != lease.AgentVersion || execution.LeaseWorker != lease.WorkerID || execution.LeaseEpoch != lease.LeaseEpoch || execution.GenerateStatus != PlanEvalGenerateLeased || execution.LeaseExpiresAt == nil || !execution.LeaseExpiresAt.After(now) {
			return ErrPlanEvalStaleLease
		}
		expires = now.Add(ttl).Truncate(time.Millisecond)
		return tx.Model(&PlanEvalExecution{}).Where("id = ?", id).Updates(map[string]any{"lease_expires_at": expires, "updated_at": now}).Error
	})
	return expires, err
}

// PlanEvalGenerateOutcome is what a worker reports: an artifact (with the
// SchemaCheck verdict the service computed from it) or a structured error.
type PlanEvalGenerateOutcome struct {
	Artifact *PlanEvalArtifact
	// SchemaResult is the SchemaCheck row written next to a kept artifact.
	SchemaResult *PlanEvalCheckResult
	ErrorCode    string
	ErrorMessage string
}

// SubmitPlanEvalGenerate writes the generate terminal state, the receipt, the
// artifact (if any) with its schema verdict and the Evaluate state the
// execution moves to — all in one transaction — and returns the persisted
// acknowledgment. A replay against an already-terminal execution returns the
// original acknowledgment; a result from a lease that is not current is refused
// with ErrPlanEvalStaleLease.
func (s *Store) SubmitPlanEvalGenerate(ctx context.Context, id string, lease PlanEvalWorkerLease, submitID, fingerprint string, now time.Time, out *PlanEvalGenerateOutcome) (ack *PlanEvalGenerateAck, replayed bool, err error) {
	started := time.Now()
	err = s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var execution PlanEvalExecution
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&execution, "id = ?", id).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrPlanEvalNotFound
			}
			return fmt.Errorf("storage: lock plan_eval_executions: %w", err)
		}
		var task PlanEvalTask
		if err := tx.Select("agent_version").First(&task, "id = ?", execution.TaskID).Error; err != nil {
			return err
		}
		if task.AgentVersion != lease.AgentVersion {
			return ErrPlanEvalAgentVersionMismatch
		}
		if PlanEvalGenerateTerminal(execution.GenerateStatus) {
			var receipt PlanEvalReceipt
			if err := tx.First(&receipt, "execution_id = ?", id).Error; err != nil {
				return fmt.Errorf("storage: get plan_eval_receipts: %w", err)
			}
			if receipt.LeaseEpoch != lease.LeaseEpoch || receipt.WorkerID != lease.WorkerID {
				return ErrPlanEvalStaleLease
			}
			if receipt.SubmitID != submitID || receipt.Fingerprint != fingerprint {
				return ErrPlanEvalResultConflict
			}
			var stored PlanEvalGenerateAck
			if err := json.Unmarshal([]byte(receipt.ResponseJSON), &stored); err != nil {
				return fmt.Errorf("storage: decode plan_eval_receipts: %w", err)
			}
			ack, replayed = &stored, true
			return nil
		}
		now = now.Add(time.Since(started))
		if execution.LeaseWorker != lease.WorkerID || execution.LeaseEpoch != lease.LeaseEpoch || execution.LeaseExpiresAt == nil || !execution.LeaseExpiresAt.After(now) {
			return ErrPlanEvalStaleLease
		}

		generateStatus := PlanEvalGenerateFailed
		evaluateStatus := PlanEvalEvaluateSkipped
		artifactID := ""
		if artifact := out.Artifact; artifact != nil {
			row := *artifact
			row.ExecutionID, row.TaskID, row.CreatedAt = execution.ID, execution.TaskID, now
			row.SchemaValid = out.SchemaResult != nil && out.SchemaResult.Status == PlanEvalCheckPass
			if !row.SchemaValid {
				row.SchemaErrors = out.SchemaResult.DetailJSON
			}
			if err := tx.Create(&row).Error; err != nil {
				return fmt.Errorf("storage: create plan_eval_artifacts: %w", err)
			}
			artifactID = row.ID
			result := *out.SchemaResult
			result.ArtifactID, result.CreatedAt = row.ID, now
			if err := tx.Create(&result).Error; err != nil {
				return fmt.Errorf("storage: create plan_eval_check_results (schema): %w", err)
			}
			generateStatus = PlanEvalGenerateDone
			if row.SchemaValid {
				evaluateStatus = PlanEvalEvaluatePending
			}
		} else if out.ErrorCode == "" {
			return errors.New("storage: plan-eval outcome needs an artifact or an error code")
		}

		if err := tx.Model(&PlanEvalExecution{}).Where("id = ?", id).Updates(map[string]any{
			"generate_status":        generateStatus,
			"generate_error_code":    out.ErrorCode,
			"generate_error_message": out.ErrorMessage,
			"evaluate_status":        evaluateStatus,
			"artifact_id":            sqlNullString(artifactID),
			"lease_expires_at":       nil,
			"lease_worker":           "",
			"completed_at":           now,
			"updated_at":             now,
		}).Error; err != nil {
			return fmt.Errorf("storage: finish plan_eval_executions: %w", err)
		}
		ack = &PlanEvalGenerateAck{
			ReceiptID: uuid.NewString(), SnapshotExecutionID: id, GenerateStatus: generateStatus,
			ArtifactID: artifactID, EvaluateStatus: evaluateStatus, ReceivedAt: now.UTC().Format(time.RFC3339Nano),
		}
		body, err := json.Marshal(ack)
		if err != nil {
			return err
		}
		if err := tx.Create(&PlanEvalReceipt{ID: ack.ReceiptID, ExecutionID: id, ResponseJSON: string(body), SubmitID: submitID, Fingerprint: fingerprint, WorkerID: lease.WorkerID, LeaseEpoch: lease.LeaseEpoch, CreatedAt: now}).Error; err != nil {
			return fmt.Errorf("storage: create plan_eval_receipts: %w", err)
		}
		return planEvalRefreshTaskStatus(tx, execution.TaskID, now)
	}, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, false, err
	}
	return ack, replayed, nil
}

// ---- evaluation ----

// PlanEvalEvaluationWork is everything the checks need for one artifact: the
// artifact itself, the frozen inputs and the frozen rule implementations.
type PlanEvalEvaluationWork struct {
	ExecutionID     string
	LeaseUntil      time.Time
	ScenarioID      string
	ArtifactID      string
	ArtifactType    string
	ArtifactContent string
	AsOf            string
	RequestJSON     string
	SnapshotJSON    string
	Rules           []PlanEvalFrozenRule
}

// PlanEvalExecutionInput returns an execution with its frozen inputs.
func (s *Store) PlanEvalExecutionInput(ctx context.Context, id string) (*PlanEvalExecution, error) {
	var row PlanEvalExecution
	if err := s.db.WithContext(ctx).First(&row, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrPlanEvalNotFound
		}
		return nil, fmt.Errorf("storage: get plan_eval_executions input: %w", err)
	}
	return &row, nil
}

// ClaimPlanEvalEvaluations marks up to limit evaluations as running under a
// lease and returns their inputs. Pending evaluations and ones whose lease
// expired (the previous holder crashed) are both eligible; each is won with a
// compare-and-set so several API replicas never judge the same artifact twice.
func (s *Store) ClaimPlanEvalEvaluations(ctx context.Context, now time.Time, leaseFor time.Duration, limit int) ([]PlanEvalEvaluationWork, error) {
	if limit <= 0 {
		return nil, nil
	}
	var ids []string
	if err := s.db.WithContext(ctx).Model(&PlanEvalExecution{}).
		Where("generate_status = ? AND (evaluate_status = ? OR (evaluate_status = ? AND evaluate_lease_until <= ?))", PlanEvalGenerateDone, PlanEvalEvaluatePending, PlanEvalEvaluateRunning, now).
		Order("created_at ASC, id ASC").Limit(limit).Pluck("id", &ids).Error; err != nil {
		return nil, fmt.Errorf("storage: list eligible evaluations: %w", err)
	}
	work := make([]PlanEvalEvaluationWork, 0, len(ids))
	for _, id := range ids {
		leaseUntil := now.Add(leaseFor).Truncate(time.Millisecond)
		res := s.db.WithContext(ctx).Model(&PlanEvalExecution{}).
			Where("id = ? AND generate_status = ? AND (evaluate_status = ? OR (evaluate_status = ? AND evaluate_lease_until <= ?))", id, PlanEvalGenerateDone, PlanEvalEvaluatePending, PlanEvalEvaluateRunning, now).
			Updates(map[string]any{"evaluate_status": PlanEvalEvaluateRunning, "evaluate_lease_until": leaseUntil, "updated_at": now})
		if res.Error != nil {
			return nil, fmt.Errorf("storage: claim plan_eval_executions evaluation: %w", res.Error)
		}
		if res.RowsAffected == 0 {
			continue // lost the race: another replica has it
		}
		one, err := s.loadPlanEvalEvaluationWork(ctx, id)
		if err != nil {
			return nil, err
		}
		one.LeaseUntil = leaseUntil
		work = append(work, *one)
	}
	return work, nil
}

func (s *Store) loadPlanEvalEvaluationWork(ctx context.Context, executionID string) (*PlanEvalEvaluationWork, error) {
	var execution PlanEvalExecution
	if err := s.db.WithContext(ctx).First(&execution, "id = ?", executionID).Error; err != nil {
		return nil, fmt.Errorf("storage: get plan_eval_executions for evaluation: %w", err)
	}
	var artifact PlanEvalArtifact
	if err := s.db.WithContext(ctx).First(&artifact, "execution_id = ?", executionID).Error; err != nil {
		return nil, fmt.Errorf("storage: get plan_eval_artifacts for evaluation: %w", err)
	}
	rules, err := s.ListPlanEvalFrozenRules(ctx, execution.TaskID)
	if err != nil {
		return nil, err
	}
	var done []string
	if err := s.db.WithContext(ctx).Model(&PlanEvalCheckResult{}).Where("artifact_id = ?", artifact.ID).Pluck("check_id", &done).Error; err != nil {
		return nil, err
	}
	pending := rules[:0]
	for _, rule := range rules {
		found := false
		for _, checkID := range done {
			if rule.CheckID == checkID {
				found = true
				break
			}
		}
		if !found {
			pending = append(pending, rule)
		}
	}
	return &PlanEvalEvaluationWork{
		ExecutionID: executionID, ScenarioID: execution.ScenarioID, ArtifactID: artifact.ID, ArtifactType: artifact.ArtifactType,
		ArtifactContent: artifact.Content, AsOf: execution.AsOf, RequestJSON: execution.RequestJSON,
		SnapshotJSON: execution.SnapshotJSON, Rules: pending,
	}, nil
}

// SavePlanEvalCheckResults records each verdict once per (artifact_id,
// check_id) — a verdict that already exists is kept, so a takeover after a
// crash never overwrites a finished check — then closes the evaluation with
// `evaluateStatus`.
func (s *Store) SavePlanEvalCheckResults(ctx context.Context, executionID string, leaseUntil time.Time, results []PlanEvalCheckResult, evaluateStatus string, now time.Time) error {
	started := time.Now()
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var execution PlanEvalExecution
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&execution, "id = ?", executionID).Error; err != nil {
			return fmt.Errorf("storage: lock plan_eval_executions for evaluation: %w", err)
		}
		now = now.Add(time.Since(started))
		if execution.EvaluateStatus != PlanEvalEvaluateRunning || execution.EvaluateLeaseUntil == nil || !execution.EvaluateLeaseUntil.Equal(leaseUntil) || !execution.EvaluateLeaseUntil.After(now) {
			return ErrPlanEvalStaleLease
		}
		for i := range results {
			if results[i].ArtifactID != execution.ArtifactID {
				return errors.New("storage: evaluation artifact mismatch")
			}
			results[i].ID = uuid.NewString()
			results[i].CreatedAt = now
			if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&results[i]).Error; err != nil {
				return fmt.Errorf("storage: create plan_eval_check_results: %w", err)
			}
		}
		changes := map[string]any{"evaluate_status": evaluateStatus, "updated_at": now}
		if evaluateStatus != PlanEvalEvaluateRunning {
			changes["evaluate_lease_until"] = nil
		}
		if err := tx.Model(&PlanEvalExecution{}).Where("id = ?", executionID).Updates(changes).Error; err != nil {
			return fmt.Errorf("storage: finish plan_eval_executions evaluation: %w", err)
		}
		if evaluateStatus == PlanEvalEvaluateRunning {
			return nil
		}
		return planEvalRefreshTaskStatus(tx, execution.TaskID, now)
	}, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
}

// planEvalRefreshTaskStatus moves the task to done once every execution has
// reached terminal Generate and Evaluate states.
func planEvalRefreshTaskStatus(tx *gorm.DB, taskID string, now time.Time) error {
	var task PlanEvalTask
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Select("id").First(&task, "id = ?", taskID).Error; err != nil {
		return fmt.Errorf("storage: lock plan_eval_tasks for settlement: %w", err)
	}
	var open int64
	if err := tx.Model(&PlanEvalExecution{}).Where("task_id = ? AND NOT (generate_status IN ('done','failed') AND evaluate_status IN ('done','failed','skipped'))", taskID).Count(&open).Error; err != nil {
		return fmt.Errorf("storage: count open plan_eval_executions: %w", err)
	}
	if open > 0 {
		return nil
	}
	if err := tx.Model(&PlanEvalTask{}).Where("id = ?", taskID).Updates(map[string]any{"status": PlanEvalTaskDone, "completed_at": now, "updated_at": now}).Error; err != nil {
		return fmt.Errorf("storage: finish plan_eval_tasks: %w", err)
	}
	return nil
}

// CountPlanEvalActiveGenerates reports how many executions of an agent
// version are still waiting for, or under, a generate lease. Cleanup refuses
// while this is non-zero.
func (s *Store) CountPlanEvalActiveGenerates(ctx context.Context, agentVersion string) (int64, error) {
	var n int64
	err := s.db.WithContext(ctx).Model(&PlanEvalExecution{}).
		Where("generate_status IN ('queued','leased') AND task_id IN (SELECT id FROM plan_eval_tasks WHERE agent_version = ?)", agentVersion).
		Count(&n).Error
	if err != nil {
		return 0, fmt.Errorf("storage: count active plan-eval generates: %w", err)
	}
	return n, nil
}

// sqlNullString adapts "" to NULL for nullable pointer columns in Updates maps.
func sqlNullString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// PlanEvalSnapshotUsernames returns the anonymized runner reference of each
// snapshot without loading the (multi-megabyte) document.
func (s *Store) PlanEvalSnapshotUsernames(ctx context.Context, ids []string) (map[string]string, error) {
	out := make(map[string]string, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	var rows []struct {
		ID       string
		Username string
	}
	if err := s.db.WithContext(ctx).Model(&PlanEvalRunnerSnapshot{}).Select("id", "username").Where("id IN ?", ids).Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("storage: plan-eval snapshot usernames: %w", err)
	}
	for _, row := range rows {
		out[row.ID] = row.Username
	}
	return out, nil
}

// EnsurePlanEvalDatabase creates the plan-eval database if it does not exist
// yet. It is boot-time provisioning for the service's own database (the
// storage layer owns its DDL), run once before Open; nothing here reads or
// writes application rows.
func EnsurePlanEvalDatabase(dsn string) error {
	parsed, err := mysqldriver.ParseDSN(dsn)
	if err != nil {
		return fmt.Errorf("storage: parse plan-eval DSN: %w", err)
	}
	name := parsed.DBName
	if name == "" || !planEvalIdentifier(name) {
		return fmt.Errorf("storage: plan-eval DSN must name a plain database, got %q", name)
	}
	parsed.DBName = ""
	db, err := sql.Open("mysql", parsed.FormatDSN())
	if err != nil {
		return err
	}
	defer db.Close()
	if _, err := db.Exec("CREATE DATABASE IF NOT EXISTS `" + name + "` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"); err != nil {
		return fmt.Errorf("storage: create plan-eval database: %w", err)
	}
	return nil
}

// planEvalIdentifier admits only plain identifiers (the name is interpolated
// into DDL).
func planEvalIdentifier(name string) bool {
	if name == "" || len(name) > 64 {
		return false
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_':
		default:
			return false
		}
	}
	return true
}
