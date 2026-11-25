package storage

import "time"

// Plan-evaluation tables (devops#1055). They live in a dedicated database —
// `storage.Open` pointed at the plan-eval DSN — and never join production user
// tables: the whole point of the service is to run without them.

// Generate statuses of one snapshot execution.
const (
	PlanEvalGenerateQueued = "queued" // 待投递/已投递，尚无有效租约
	PlanEvalGenerateLeased = "leased" // 某 worker 持有有效租约，正在生成
	PlanEvalGenerateDone   = "done"   // 产出一份 Artifact
	PlanEvalGenerateFailed = "failed" // 结构化 Generate 错误，无 Artifact
)

// Evaluate statuses of one snapshot execution.
const (
	PlanEvalEvaluatePending = "pending" // Artifact 有效，等待规则
	PlanEvalEvaluateRunning = "running"
	PlanEvalEvaluateDone    = "done"    // 规则全部跑完（通过与否见逐条结果）
	PlanEvalEvaluateFailed  = "failed"  // 评分阶段自身故障
	PlanEvalEvaluateSkipped = "skipped" // 生成失败或 Schema 无效，跳过业务规则
)

// Task statuses.
const (
	PlanEvalTaskRunning = "running"
	PlanEvalTaskDone    = "done"
)

// PlanEvalGenerateTerminal reports whether Generate has reached a final state.
func PlanEvalGenerateTerminal(status string) bool {
	return status == PlanEvalGenerateDone || status == PlanEvalGenerateFailed
}

// PlanEvalEvaluateTerminal reports whether Evaluate has reached a final state.
func PlanEvalEvaluateTerminal(status string) bool {
	switch status {
	case PlanEvalEvaluateDone, PlanEvalEvaluateFailed, PlanEvalEvaluateSkipped:
		return true
	}
	return false
}

// PlanEvalScenario is one benchmark definition: the artifact it expects, the
// generation request it freezes and the runner snapshots it runs against.
type PlanEvalScenario struct {
	ID           string `gorm:"column:id;type:char(36);primaryKey"`
	Name         string `gorm:"column:name;size:128;not null"`
	ArtifactType string `gorm:"column:artifact_type;size:32;not null"`
	// RequestJSON is the generation-request template (MasterPlanGraphRequest).
	// It is copied verbatim into every execution; only requested_as_of is stamped.
	RequestJSON string `gorm:"column:request_json;type:longtext;not null"`
	// SnapshotIDs / RuleRefs are JSON arrays: ["<uuid>"] and
	// [{"id":"…","version":1}].
	SnapshotIDs string `gorm:"column:snapshot_ids;type:json;not null"`
	RuleRefs    string `gorm:"column:rule_refs;type:json;not null"`
	// AsOf is the frozen execution instant (ISO 8601 with offset) shared by
	// Generate and Evaluate.
	AsOf      string    `gorm:"column:as_of;size:40;not null"`
	CreatedAt time.Time `gorm:"column:created_at"`
	UpdatedAt time.Time `gorm:"column:updated_at"`
}

func (PlanEvalScenario) TableName() string { return "plan_eval_scenarios" }

// PlanEvalRunnerSnapshot is one anonymized runner's frozen records
// (plan-eval-runner-snapshot/v1). The summary columns duplicate the envelope so
// lists never parse the 1.7MB body.
type PlanEvalRunnerSnapshot struct {
	ID             string `gorm:"column:id;type:char(36);primaryKey"`
	Username       string `gorm:"column:username;size:64;not null"`
	GenerationKind string `gorm:"column:generation_kind;size:32;not null"`
	Event          string `gorm:"column:event;size:8;not null"`
	TargetTime     string `gorm:"column:target_time;size:16;not null;default:''"`
	// AsOfDay is the Shanghai data cutoff day (YYYY-MM-DD).
	AsOfDay         string `gorm:"column:as_of_day;size:10;not null"`
	ConstraintsJSON string `gorm:"column:constraints_json;type:json;not null"`
	// SnapshotJSON is the complete snapshot document, byte-exact.
	SnapshotJSON string    `gorm:"column:snapshot_json;type:longtext;not null"`
	CreatedAt    time.Time `gorm:"column:created_at"`
	UpdatedAt    time.Time `gorm:"column:updated_at"`
}

func (PlanEvalRunnerSnapshot) TableName() string { return "plan_eval_runner_snapshots" }

// PlanEvalRule is one published version of a JavaScript check. Versions are
// immutable rows keyed by (id, version); tasks copy the row they freeze.
type PlanEvalRule struct {
	ID           string `gorm:"column:id;type:char(64);primaryKey"`
	Version      int    `gorm:"column:version;primaryKey"`
	Name         string `gorm:"column:name;size:128;not null"`
	Description  string `gorm:"column:description;type:text;not null"`
	ArtifactType string `gorm:"column:artifact_type;size:32;not null"`
	// Source is the JavaScript program defining `run(input)`.
	Source    string    `gorm:"column:source;type:longtext;not null"`
	CreatedAt time.Time `gorm:"column:created_at"`
}

func (PlanEvalRule) TableName() string { return "plan_eval_rules" }

// PlanEvalTask is one evaluation run: a single agent version against a frozen
// list of scenarios. Re-running on purpose creates a new task.
type PlanEvalTask struct {
	ID           string `gorm:"column:id;type:char(36);primaryKey"`
	AgentVersion string `gorm:"column:agent_version;size:64;not null;index"`
	Status       string `gorm:"column:status;size:16;not null"`
	ScenarioID   string `gorm:"column:scenario_id;type:char(36);not null"`
	// Submitter is the admin JWT subject that created the task; idempotency
	// keys are scoped to it.
	Submitter         string `gorm:"column:submitter;size:64;not null;uniqueIndex:idx_plan_eval_tasks_idem,priority:1"`
	IdempotencyKey    string `gorm:"column:idempotency_key;size:128;not null;uniqueIndex:idx_plan_eval_tasks_idem,priority:2"`
	ParamsFingerprint string `gorm:"column:params_fingerprint;size:64;not null"`
	// LaunchConfigID is the effective launch configuration the task ran with.
	LaunchConfigID string `gorm:"column:launch_config_id;type:char(36)"`
	LaunchReplicas int    `gorm:"column:launch_replicas;not null;default:1"`
	LaunchEnvNames string `gorm:"column:launch_env_names;type:json"`
	// LaunchError records a failed publish/start after the task row was
	// committed (the task and its queued executions stay).
	LaunchError string     `gorm:"column:launch_error;type:text"`
	LaunchedAt  *time.Time `gorm:"column:launched_at"`
	CreatedAt   time.Time  `gorm:"column:created_at"`
	UpdatedAt   time.Time  `gorm:"column:updated_at"`
	CompletedAt *time.Time `gorm:"column:completed_at"`
}

func (PlanEvalTask) TableName() string { return "plan_eval_tasks" }

// PlanEvalLaunchConfig is the effective start configuration of one agent
// version. Tasks on the same version share it: the worker Deployment consumes
// all their executions. EnvNames is what the workbench may echo; the values are
// stored encrypted (EnvCipher) and used only to start the Deployment.
type PlanEvalLaunchConfig struct {
	ID           string `gorm:"column:id;type:char(36);primaryKey"`
	AgentVersion string `gorm:"column:agent_version;size:64;not null;uniqueIndex"`
	Replicas     int    `gorm:"column:replicas;not null"`
	// EnvNames is a JSON array of variable names, sorted.
	EnvNames       string    `gorm:"column:env_names;type:json;not null"`
	EnvCipher      []byte    `gorm:"column:env_cipher;type:blob"`
	EnvFingerprint string    `gorm:"column:env_fingerprint;size:64"`
	CreatedAt      time.Time `gorm:"column:created_at"`
	UpdatedAt      time.Time `gorm:"column:updated_at"`
}

func (PlanEvalLaunchConfig) TableName() string { return "plan_eval_launch_configs" }

// PlanEvalFrozenRule is a task's copy of the rule implementation it runs, so
// later publishes never change how a historical task is judged.
type PlanEvalFrozenRule struct {
	ID           uint64 `gorm:"column:id;primaryKey;autoIncrement"`
	TaskID       string `gorm:"column:task_id;type:char(36);not null;index"`
	CheckID      string `gorm:"column:check_id;type:char(64);not null"`
	Version      int    `gorm:"column:version;not null"`
	ArtifactType string `gorm:"column:artifact_type;size:32;not null"`
	Source       string `gorm:"column:source;type:longtext;not null"`
}

func (PlanEvalFrozenRule) TableName() string { return "plan_eval_frozen_rules" }

// PlanEvalExecution is one scenario × snapshot: its frozen inputs, the
// generate lease and the pointer to the artifact it produced.
type PlanEvalExecution struct {
	ID             string `gorm:"column:id;type:char(36);primaryKey"`
	TaskID         string `gorm:"column:task_id;type:char(36);not null;index"`
	ScenarioID     string `gorm:"column:scenario_id;type:char(36);not null"`
	SnapshotID     string `gorm:"column:snapshot_id;type:char(36);not null"`
	GenerateStatus string `gorm:"column:generate_status;size:16;not null"`
	Attempts       int    `gorm:"column:attempts;not null;default:0"`
	// LeaseEpoch counts takeovers: a result or renewal carrying an older
	// epoch is refused. LeaseExpiresAt is server time.
	LeaseEpoch     int        `gorm:"column:lease_epoch;not null;default:0"`
	LeaseExpiresAt *time.Time `gorm:"column:lease_expires_at"`
	LeaseWorker    string     `gorm:"column:lease_worker;size:191"`
	// ArtifactID points at the artifact a done execution produced ("" = none).
	ArtifactID           string `gorm:"column:artifact_id;type:char(36)"`
	GenerateErrorCode    string `gorm:"column:generate_error_code;size:64"`
	GenerateErrorMessage string `gorm:"column:generate_error_message;type:text"`
	EvaluateStatus       string `gorm:"column:evaluate_status;size:16;not null"`
	// EvaluateLeaseUntil fences the in-API evaluation step across replicas.
	EvaluateLeaseUntil *time.Time `gorm:"column:evaluate_lease_until"`
	// AsOf / RequestJSON / SnapshotJSON are the frozen inputs, byte-exact.
	AsOf         string     `gorm:"column:as_of;size:40;not null"`
	RequestJSON  string     `gorm:"column:request_json;type:longtext;not null"`
	SnapshotJSON string     `gorm:"column:snapshot_json;type:longtext;not null"`
	CreatedAt    time.Time  `gorm:"column:created_at"`
	UpdatedAt    time.Time  `gorm:"column:updated_at"`
	CompletedAt  *time.Time `gorm:"column:completed_at"`
}

func (PlanEvalExecution) TableName() string { return "plan_eval_executions" }

// PlanEvalArtifact is the raw output of one Generate: at most one per
// execution, stored byte-exact so its digest can be re-verified.
type PlanEvalArtifact struct {
	ID           string `gorm:"column:id;type:char(36);primaryKey"`
	ExecutionID  string `gorm:"column:execution_id;type:char(36);not null;uniqueIndex"`
	TaskID       string `gorm:"column:task_id;type:char(36);not null;index"`
	ArtifactType string `gorm:"column:artifact_type;size:32;not null"`
	Content      string `gorm:"column:content;type:longtext;not null"`
	Sha256       string `gorm:"column:sha256;size:64;not null"`
	// SizeBytes is filled by the metadata listing (OCTET_LENGTH(content)); it
	// is not a column.
	SizeBytes int `gorm:"-"`
	// SchemaValid / SchemaErrors hold the SchemaCheck verdict written in the
	// same transaction as the generate terminal state.
	SchemaValid  bool      `gorm:"column:schema_valid;not null"`
	SchemaErrors *string   `gorm:"column:schema_errors;type:json"`
	CreatedAt    time.Time `gorm:"column:created_at"`
}

func (PlanEvalArtifact) TableName() string { return "plan_eval_artifacts" }

// PlanEvalReceipt is the persisted confirmation returned to the worker once a
// generate terminal state is durable; a replayed submit returns the same one.
type PlanEvalReceipt struct {
	ID          string `gorm:"column:id;type:char(36);primaryKey"`
	ExecutionID string `gorm:"column:execution_id;type:char(36);not null;uniqueIndex"`
	// ResponseJSON is the exact acknowledgment body.
	ResponseJSON string    `gorm:"column:response_json;type:json;not null"`
	CreatedAt    time.Time `gorm:"column:created_at"`
}

func (PlanEvalReceipt) TableName() string { return "plan_eval_receipts" }

// Check verdicts.
const (
	PlanEvalCheckPass  = "pass"
	PlanEvalCheckFail  = "fail"
	PlanEvalCheckError = "error"
)

// PlanEvalCheckResult is one check's verdict on one artifact. (artifact_id,
// check_id) is unique: a check is recorded once per artifact no matter how many
// times evaluation is retried or taken over.
type PlanEvalCheckResult struct {
	ID          string `gorm:"column:id;type:char(36);primaryKey"`
	ArtifactID  string `gorm:"column:artifact_id;type:char(36);not null;uniqueIndex:idx_plan_eval_check_results_dedupe,priority:1"`
	CheckID     string `gorm:"column:check_id;type:char(64);not null;uniqueIndex:idx_plan_eval_check_results_dedupe,priority:2"`
	RuleVersion int    `gorm:"column:rule_version;not null;default:0"`
	// Status is pass | fail | error.
	Status     string    `gorm:"column:status;size:16;not null"`
	Reason     string    `gorm:"column:reason;type:text"`
	DetailJSON *string   `gorm:"column:detail_json;type:json"`
	ErrorJSON  *string   `gorm:"column:error_json;type:json"`
	CreatedAt  time.Time `gorm:"column:created_at"`
}

func (PlanEvalCheckResult) TableName() string { return "plan_eval_check_results" }
