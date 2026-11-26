package planeval

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/storage"
	"go.uber.org/zap"
)

// Config is what the service needs beyond its dependencies.
type Config struct {
	// AgentVersions lists the published worker tags that carry the eval entry.
	AgentVersions []string
	// MaxReplicas bounds the worker replicas one task may ask for.
	MaxReplicas        int
	LeaseTTL           time.Duration
	RuleTimeout        time.Duration
	RuleMemoryLimit    int64
	EvaluateSweepEvery time.Duration
}

// queueBroker is the slice of the broker the service uses; *Broker is the
// real one, tests substitute an in-memory queue.
type queueBroker interface {
	EnsureQueue(name string) error
	Publish(ctx context.Context, queue string, message ExecuteMessage) error
	QueueDepth(ctx context.Context, queue string) (QueueDepth, error)
}

// Service is the plan-evaluation API: the single place that decides what gets
// frozen, when a worker may take over, and when a Deployment may be removed.
type Service struct {
	store    *storage.Store
	broker   queueBroker
	deployer Deployer
	secrets  *SecretKey
	cfg      Config
	log      *zap.Logger
	// evaluateMu keeps this replica's sweeps from overlapping; cross-replica
	// safety comes from the compare-and-set claim in storage.
	evaluateMu sync.Mutex
}

func NewService(store *storage.Store, broker queueBroker, deployer Deployer, secrets *SecretKey, cfg Config, log *zap.Logger) *Service {
	if cfg.MaxReplicas <= 0 {
		cfg.MaxReplicas = 8
	}
	// The list arrives from YAML or from one environment variable written
	// either comma- or space-separated.
	cfg.AgentVersions = normalizeAgentVersions(cfg.AgentVersions)
	return &Service{store: store, broker: broker, deployer: deployer, secrets: secrets, cfg: cfg, log: log}
}

// normalizeAgentVersions splits, trims and de-duplicates the configured tags,
// dropping blanks and anything unusable as a queue/object name.
func normalizeAgentVersions(raw []string) []string {
	seen := make(map[string]bool, len(raw))
	out := make([]string, 0, len(raw))
	for _, entry := range raw {
		for _, tag := range strings.FieldsFunc(entry, func(r rune) bool { return r == ',' || r == ' ' || r == '\t' || r == '\n' }) {
			tag = strings.TrimSpace(tag)
			if tag == "" || seen[tag] || !validAgentVersion(tag) {
				continue
			}
			seen[tag] = true
			out = append(out, tag)
		}
	}
	return out
}

// Error is a request-level failure carrying the HTTP status and a stable code.
type Error struct {
	Status int
	Code   string
	Detail string
	// Extra fields merged into the error body (never secrets).
	Extra map[string]any
}

func (e *Error) Error() string { return e.Code + ": " + e.Detail }

func fail(status int, code, detail string) *Error {
	return &Error{Status: status, Code: code, Detail: detail}
}

// ---- views ----

// LaunchConfigView is what the workbench may echo: replicas and variable
// names, never values.
type LaunchConfigView struct {
	Replicas int      `json:"replicas"`
	EnvNames []string `json:"env_names"`
}

type DeploymentView struct {
	Replicas      int32 `json:"replicas"`
	ReadyReplicas int32 `json:"ready_replicas"`
}

type AgentVersionView struct {
	AgentVersion string            `json:"agent_version"`
	LaunchConfig *LaunchConfigView `json:"launch_config"`
	Deployment   *DeploymentView   `json:"deployment"`
}

type TaskProgress struct {
	Total          int `json:"total"`
	Finished       int `json:"finished"`
	GenerateFailed int `json:"generate_failed"`
	RuleFailed     int `json:"rule_failed"`
}

type TaskView struct {
	ID            string       `json:"id"`
	AgentVersion  string       `json:"agent_version"`
	Status        string       `json:"status"`
	ScenarioID    string       `json:"scenario_id"`
	Progress      TaskProgress `json:"progress"`
	Replicas      int          `json:"replicas"`
	EnvNames      []string     `json:"env_names"`
	LaunchError   string       `json:"launch_error"`
	LaunchPending bool         `json:"launch_pending"`
	CreatedAt     time.Time    `json:"created_at"`
	UpdatedAt     time.Time    `json:"updated_at"`
	CompletedAt   *time.Time   `json:"completed_at"`
}

type ScenarioView struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	ArtifactType string          `json:"artifact_type"`
	AsOf         string          `json:"as_of"`
	Request      json.RawMessage `json:"request"`
}

type StageError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type StageView struct {
	Status   string      `json:"status"`
	Attempts int         `json:"attempts"`
	Error    *StageError `json:"error"`
}

type ArtifactView struct {
	ID           string `json:"id"`
	ArtifactType string `json:"artifact_type"`
	Sha256       string `json:"sha256"`
	SizeBytes    int    `json:"size_bytes"`
	SchemaValid  bool   `json:"schema_valid"`
}

type ExecutionView struct {
	ID           string            `json:"id"`
	SnapshotID   string            `json:"snapshot_id"`
	SnapshotName string            `json:"snapshot_name"`
	Generate     StageView         `json:"generate"`
	Artifact     *ArtifactView     `json:"artifact"`
	Evaluate     StageView         `json:"evaluate"`
	Checks       []CheckResultView `json:"checks"`
}

type CheckResultView struct {
	CheckID string          `json:"check_id"`
	Version int             `json:"version"`
	Status  string          `json:"status"`
	Reason  string          `json:"reason"`
	Detail  json.RawMessage `json:"detail,omitempty"`
	Error   *CheckError     `json:"error,omitempty"`
}

type TaskDetailView struct {
	TaskView
	Scenario   ScenarioView    `json:"scenario"`
	Executions []ExecutionView `json:"executions"`
}

// ---- agent versions ----

func (s *Service) knownVersion(version string) bool {
	for _, candidate := range s.cfg.AgentVersions {
		if candidate == version {
			return true
		}
	}
	return false
}

// AgentVersions lists every registered agent version with its effective launch
// configuration (names only) and Deployment state.
func (s *Service) AgentVersions(ctx context.Context) ([]AgentVersionView, error) {
	configs, err := s.store.ListPlanEvalLaunchConfigs(ctx)
	if err != nil {
		return nil, err
	}
	byVersion := make(map[string]*storage.PlanEvalLaunchConfig, len(configs))
	for i := range configs {
		byVersion[configs[i].AgentVersion] = &configs[i]
	}
	versions := append([]string(nil), s.cfg.AgentVersions...)
	sort.Strings(versions)
	views := make([]AgentVersionView, 0, len(versions))
	for _, version := range versions {
		view := AgentVersionView{AgentVersion: version}
		if config := byVersion[version]; config != nil {
			var names []string
			if err := json.Unmarshal([]byte(config.EnvNames), &names); err != nil {
				return nil, err
			}
			view.LaunchConfig = &LaunchConfigView{Replicas: config.Replicas, EnvNames: names}
		}
		status, err := s.deployer.Status(ctx, version)
		if err != nil {
			return nil, err
		}
		if status.Present {
			view.Deployment = &DeploymentView{Replicas: status.Replicas, ReadyReplicas: status.ReadyReplicas}
		}
		views = append(views, view)
	}
	return views, nil
}

// ---- task creation ----

type EnvVar struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type CreateTaskRequest struct {
	AgentVersion string   `json:"agent_version"`
	Replicas     int      `json:"replicas"`
	Env          []EnvVar `json:"env"`
}

var envNamePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// reservedEnvPrefixes stop a launch form from re-pointing a worker at another
// queue or back into production mode.
var reservedEnvPrefixes = []string{"PLAN_WORKER_", "STRIDE_COACH_ENV"}

func (s *Service) validateEnv(vars []EnvVar) (map[string]string, []string, *Error) {
	env := make(map[string]string, len(vars))
	for _, variable := range vars {
		if !envNamePattern.MatchString(variable.Name) {
			return nil, nil, fail(422, "invalid_request", fmt.Sprintf("环境变量名 %q 不合法", variable.Name))
		}
		for _, reserved := range reservedEnvPrefixes {
			if variable.Name == reserved || strings.HasPrefix(variable.Name, reserved) {
				return nil, nil, fail(422, "invalid_request", fmt.Sprintf("环境变量 %q 由测评平台管理，不能在表单里设置", variable.Name))
			}
		}
		if _, duplicate := env[variable.Name]; duplicate {
			return nil, nil, fail(422, "invalid_request", fmt.Sprintf("环境变量 %q 重复", variable.Name))
		}
		env[variable.Name] = variable.Value
	}
	names := make([]string, 0, len(env))
	for name := range env {
		names = append(names, name)
	}
	sort.Strings(names)
	return env, names, nil
}

// taskParams is the fingerprinted parameter set: same submitter, same
// idempotency key and same parameters replay the original task; any
// difference is a conflict.
type taskParams struct {
	AgentVersion string            `json:"agent_version"`
	ScenarioID   string            `json:"scenario_id"`
	Replicas     int               `json:"replicas"`
	Env          map[string]string `json:"env"` // name → sha256(value)
}

// CreateTask freezes the inputs and starts the evaluation. replayed reports
// that the idempotency key matched an existing task, which is then returned
// without publishing again.
func (s *Service) CreateTask(ctx context.Context, submitter, idempotencyKey string, req CreateTaskRequest) (view *TaskDetailView, replayed bool, err *Error) {
	lockErr := s.withVersion(ctx, req.AgentVersion, func(ctx context.Context) *Error {
		view, replayed, err = s.createTask(ctx, submitter, idempotencyKey, req)
		return err
	})
	return view, replayed, lockErr
}

func (s *Service) withVersion(ctx context.Context, version string, run func(context.Context) *Error) *Error {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 45*time.Second)
	defer cancel()
	err := s.store.WithPlanEvalVersionLock(ctx, version, func(ctx context.Context) error {
		if err := run(ctx); err != nil {
			return err
		}
		return nil
	})
	return s.mapStorageError(err)
}

func (s *Service) createTask(ctx context.Context, submitter, idempotencyKey string, req CreateTaskRequest) (*TaskDetailView, bool, *Error) {
	if idempotencyKey == "" || len(idempotencyKey) > 128 {
		return nil, false, fail(400, "invalid_request", "Idempotency-Key 请求头必填，且不超过 128 字符")
	}
	if !s.knownVersion(req.AgentVersion) || !validAgentVersion(req.AgentVersion) {
		return nil, false, fail(422, "invalid_request", "未登记的 Agent 版本："+req.AgentVersion)
	}
	replicas := req.Replicas
	if replicas < 0 || replicas > s.cfg.MaxReplicas {
		return nil, false, fail(422, "invalid_request", fmt.Sprintf("副本数须在 1–%d 之间", s.cfg.MaxReplicas))
	}
	env, names, err := s.validateEnv(req.Env)
	if err != nil {
		return nil, false, err
	}

	scenario, serr := s.loadScenario(ctx, PresetScenarioID)
	if serr != nil {
		return nil, false, serr
	}
	executions, frozenRules, serr := s.freeze(ctx, scenario)
	if serr != nil {
		return nil, false, serr
	}

	envDigests := digestEnv(env)
	params := taskParams{AgentVersion: req.AgentVersion, ScenarioID: scenario.ID, Replicas: replicas, Env: envDigests}
	encoded, _ := json.Marshal(params)
	sum := sha256.Sum256(encoded)
	if params.Replicas == 0 {
		params.Replicas = 1
	}
	legacySum := sha256.Sum256(mustJSON(params))
	cipher, cerr := s.secrets.Seal(env)
	if cerr != nil {
		return nil, false, s.internal(cerr)
	}
	launch := &storage.PlanEvalLaunchConfig{ID: uuid.NewString(), AgentVersion: req.AgentVersion, Replicas: replicas}
	launch.EnvNames = string(mustJSON(names))
	envFingerprint := sha256.Sum256(mustJSON(envDigests))
	launch.EnvFingerprint = hex.EncodeToString(envFingerprint[:])
	task := &storage.PlanEvalTask{
		ID: uuid.NewString(), AgentVersion: req.AgentVersion, ScenarioID: scenario.ID,
		Submitter: submitter, IdempotencyKey: idempotencyKey, ParamsFingerprint: "v2:" + hex.EncodeToString(sum[:]),
	}
	created, replayed, derr := s.store.CreatePlanEvalTask(ctx, &storage.PlanEvalTaskCreate{
		Task: task, LegacyParamsFingerprint: hex.EncodeToString(legacySum[:]), LaunchConfig: launch, EnvCipher: cipher, Executions: executions, FrozenRules: frozenRules,
	})
	if derr != nil {
		return nil, false, s.mapStorageError(derr)
	}
	if launchErr := s.launchAndRecord(ctx, created); launchErr != nil {
		return nil, replayed, launchErr
	}
	view, viewErr := s.TaskDetail(ctx, created.ID)
	return view, replayed, viewErr
}

// RetryLaunch restarts a frozen task without requiring the original browser to
// retain the idempotency key or the model credentials.
func (s *Service) RetryLaunch(ctx context.Context, id string) (*TaskDetailView, *Error) {
	task, err := s.store.GetPlanEvalTask(ctx, id)
	if err != nil {
		return nil, s.mapStorageError(err)
	}
	var view *TaskDetailView
	lockErr := s.withVersion(ctx, task.AgentVersion, func(ctx context.Context) *Error {
		task, err := s.store.GetPlanEvalTask(ctx, id)
		if err != nil {
			return s.mapStorageError(err)
		}
		if launchErr := s.launchAndRecord(ctx, task); launchErr != nil {
			return launchErr
		}
		var viewErr *Error
		view, viewErr = s.TaskDetail(ctx, task.ID)
		return viewErr
	})
	return view, lockErr
}

func (s *Service) launchAndRecord(ctx context.Context, task *storage.PlanEvalTask) *Error {
	if task.LaunchedAt != nil || task.CompletedAt != nil {
		return nil
	}
	if !s.knownVersion(task.AgentVersion) {
		return fail(422, "invalid_request", "该任务的 Agent 版本已停用。")
	}
	// Once frozen, finish the launch attempt even if the browser disconnects.
	// Any unconfirmed publish can be retried with the original task key.
	launchCtx, cancelLaunch := context.WithTimeout(ctx, 30*time.Second)
	lerr := s.launch(launchCtx, task)
	cancelLaunch()
	resultCtx, cancelResult := context.WithTimeout(ctx, 5*time.Second)
	defer cancelResult()
	if lerr != nil {
		if uerr := s.store.RecordPlanEvalLaunch(resultCtx, task.ID, lerr.Error()); uerr != nil {
			s.log.Error("plan-eval: record launch error", zap.Error(uerr))
		}
		return &Error{Status: 502, Code: "launch_failed", Detail: lerr.Error(), Extra: map[string]any{"task_id": task.ID}}
	}
	if uerr := s.store.RecordPlanEvalLaunch(resultCtx, task.ID, ""); uerr != nil {
		return s.internal(uerr)
	}
	return nil
}

func (s *Service) internal(err error) *Error {
	s.log.Error("plan-eval: internal error", zap.Error(err))
	return fail(500, "internal_error", "服务内部错误")
}

func (s *Service) mapStorageError(err error) *Error {
	switch e := err.(type) {
	case *Error:
		return e
	case *storage.PlanEvalIdempotencyConflictError:
		return &Error{Status: 409, Code: "idempotency_conflict", Detail: "同一幂等键已用于参数不同的任务。", Extra: map[string]any{"task_id": e.ExistingTaskID}}
	case *storage.PlanEvalLaunchConfigConflictError:
		return &Error{Status: 409, Code: "launch_config_conflict", Detail: "该 Agent 版本已有一份启动配置。环境变量留空则沿用；要更换请先清理该版本的 Deployment。"}
	case nil:
		return nil
	}
	if errors.Is(err, storage.ErrPlanEvalVersionBusy) {
		return fail(409, "version_busy", "该版本正在启动、扩缩容或清理，请稍后重试。")
	}
	if errors.Is(err, storage.ErrPlanEvalNotFound) {
		return fail(404, "not_found", "对象不存在")
	}
	return s.internal(err)
}

// scenarioDocument is a scenario with its references decoded.
type scenarioDocument struct {
	storage.PlanEvalScenario
	SnapshotIDs []string
	Rules       []RuleRef
}

func (s *Service) loadScenario(ctx context.Context, id string) (*scenarioDocument, *Error) {
	row, err := s.store.GetPlanEvalScenario(ctx, id)
	if err != nil {
		return nil, s.mapStorageError(err)
	}
	doc := &scenarioDocument{PlanEvalScenario: *row}
	if err := json.Unmarshal([]byte(row.SnapshotIDs), &doc.SnapshotIDs); err != nil {
		return nil, s.internal(err)
	}
	if err := json.Unmarshal([]byte(row.RuleRefs), &doc.Rules); err != nil {
		return nil, s.internal(err)
	}
	return doc, nil
}

// freeze copies the scenario's inputs into per-execution rows: the request
// (stamped with the execution's own id and the frozen instant), the snapshot
// document and the rule implementations. An invalid reference refuses the
// whole batch before anything is written.
func (s *Service) freeze(ctx context.Context, scenario *scenarioDocument) ([]*storage.PlanEvalExecution, []*storage.PlanEvalFrozenRule, *Error) {
	if len(scenario.SnapshotIDs) == 0 {
		return nil, nil, fail(422, "invalid_request", "场景 "+scenario.ID+" 没有引用任何测试数据")
	}
	rules := make([]*storage.PlanEvalFrozenRule, 0, len(scenario.Rules))
	for _, ref := range scenario.Rules {
		rule, err := s.store.GetPlanEvalRule(ctx, ref.ID, ref.Version)
		if err != nil {
			if errors.Is(err, storage.ErrPlanEvalNotFound) {
				return nil, nil, fail(422, "invalid_request", fmt.Sprintf("场景 %s 引用的规则 %s v%d 不存在", scenario.ID, ref.ID, ref.Version))
			}
			return nil, nil, s.internal(err)
		}
		if rule.ArtifactType != scenario.ArtifactType {
			return nil, nil, fail(422, "invalid_request", fmt.Sprintf("规则 %s v%d 适用于 %s，场景 %s 需要 %s", ref.ID, ref.Version, rule.ArtifactType, scenario.ID, scenario.ArtifactType))
		}
		rules = append(rules, &storage.PlanEvalFrozenRule{CheckID: rule.ID, Version: rule.Version, ArtifactType: rule.ArtifactType, Source: rule.Source})
	}
	executions := make([]*storage.PlanEvalExecution, 0, len(scenario.SnapshotIDs))
	for _, snapshotID := range scenario.SnapshotIDs {
		snapshot, err := s.store.GetPlanEvalRunnerSnapshot(ctx, snapshotID)
		if err != nil {
			if errors.Is(err, storage.ErrPlanEvalNotFound) {
				return nil, nil, fail(422, "invalid_request", fmt.Sprintf("场景 %s 引用的测试数据 %s 不存在", scenario.ID, snapshotID))
			}
			return nil, nil, s.internal(err)
		}
		executionID := uuid.NewString()
		request, rerr := stampRequest(scenario.RequestJSON, executionID, scenario.AsOf, scenario.ArtifactType)
		if rerr != nil {
			return nil, nil, s.internal(rerr)
		}
		executions = append(executions, &storage.PlanEvalExecution{
			ID: executionID, ScenarioID: scenario.ID, SnapshotID: snapshotID,
			GenerateStatus: storage.PlanEvalGenerateQueued, EvaluateStatus: storage.PlanEvalEvaluatePending,
			AsOf: scenario.AsOf, RequestJSON: request, SnapshotJSON: snapshot.SnapshotJSON,
		})
	}
	return executions, rules, nil
}

// stampRequest writes the two fields that are per-execution into the request
// template: its id and the frozen instant the kernel reads the clock from.
func stampRequest(template string, executionID, asOf, artifactType string) (string, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(template), &fields); err != nil {
		return "", fmt.Errorf("scenario request template: %w", err)
	}
	if fields == nil {
		return "", fmt.Errorf("scenario request template must be an object")
	}
	id, _ := json.Marshal("plan-eval-" + executionID)
	instant, _ := json.Marshal(asOf)
	timeField := "requested_as_of"
	if artifactType == "weekly_plan_batch" {
		timeField = "as_of"
	}
	fields["request_id"], fields[timeField] = id, instant
	return string(mustJSON(fields)), nil
}

func mustJSON(value any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return encoded
}

func digestEnv(env map[string]string) map[string]string {
	out := make(map[string]string, len(env))
	for name, value := range env {
		sum := sha256.Sum256([]byte(value))
		out[name] = hex.EncodeToString(sum[:])
	}
	return out
}

// launch makes the version runnable: queue, pointer messages, Deployment.
func (s *Service) launch(ctx context.Context, task *storage.PlanEvalTask) error {
	queue := QueueName(task.AgentVersion)
	if err := s.broker.EnsureQueue(queue); err != nil {
		return err
	}
	executions, err := s.store.ListPlanEvalExecutions(ctx, task.ID)
	if err != nil {
		return err
	}
	for _, execution := range executions {
		if storage.PlanEvalGenerateTerminal(execution.GenerateStatus) || execution.DispatchedAt != nil {
			continue
		}
		if err := s.broker.Publish(ctx, queue, ExecuteMessage{SchemaVersion: ExecuteMessageSchemaVersion, SnapshotExecutionID: execution.ID}); err != nil {
			return fmt.Errorf("publish: %w", err)
		}
		if err := s.store.RecordPlanEvalDispatch(ctx, execution.ID); err != nil {
			return err
		}
	}
	config, err := s.store.GetPlanEvalLaunchConfig(ctx, task.LaunchConfigID)
	if err != nil {
		return err
	}
	return s.applyLaunchConfig(ctx, config)
}

// ---- reads ----

func (s *Service) ListTasks(ctx context.Context, limit, offset int) ([]TaskView, int64, *Error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	tasks, total, err := s.store.ListPlanEvalTasks(ctx, limit, offset)
	if err != nil {
		return nil, 0, s.internal(err)
	}
	views, verr := s.taskViews(ctx, tasks)
	if verr != nil {
		return nil, 0, verr
	}
	return views, total, nil
}

// taskViews attaches each task's progress and its launch configuration's
// replicas and variable names (never the values).
func (s *Service) taskViews(ctx context.Context, tasks []storage.PlanEvalTask) ([]TaskView, *Error) {
	ids := make([]string, len(tasks))
	for i := range tasks {
		ids[i] = tasks[i].ID
	}
	counts, err := s.store.PlanEvalTaskCounts(ctx, ids)
	if err != nil {
		return nil, s.internal(err)
	}
	configs, err := s.store.ListPlanEvalLaunchConfigs(ctx)
	if err != nil {
		return nil, s.internal(err)
	}
	launchByID := make(map[string]*storage.PlanEvalLaunchConfig, len(configs))
	for i := range configs {
		launchByID[configs[i].ID] = &configs[i]
	}
	views := make([]TaskView, len(tasks))
	for i := range tasks {
		task := tasks[i]
		count := counts[task.ID]
		view := TaskView{
			ID: task.ID, AgentVersion: task.AgentVersion, Status: task.Status, ScenarioID: task.ScenarioID,
			Progress: TaskProgress{Total: int(count.Total), Finished: int(count.Finished), GenerateFailed: int(count.GenerateFailed), RuleFailed: int(count.RuleFailed)},
			EnvNames: []string{}, LaunchError: task.LaunchError,
			LaunchPending: task.LaunchedAt == nil && task.CompletedAt == nil && s.knownVersion(task.AgentVersion),
			CreatedAt:     task.CreatedAt, UpdatedAt: task.UpdatedAt, CompletedAt: task.CompletedAt,
		}
		if task.LaunchEnvNames != "" {
			view.Replicas = task.LaunchReplicas
			if err := json.Unmarshal([]byte(task.LaunchEnvNames), &view.EnvNames); err != nil {
				return nil, s.internal(err)
			}
		} else if launch := launchByID[task.LaunchConfigID]; launch != nil {
			view.Replicas = launch.Replicas
			if err := json.Unmarshal([]byte(launch.EnvNames), &view.EnvNames); err != nil {
				return nil, s.internal(err)
			}
		}
		views[i] = view
	}
	return views, nil
}

// TaskDetail assembles Generate, Artifact and Evaluate per snapshot execution.
func (s *Service) TaskDetail(ctx context.Context, id string) (*TaskDetailView, *Error) {
	task, err := s.store.GetPlanEvalTask(ctx, id)
	if err != nil {
		return nil, s.mapStorageError(err)
	}
	scenario, serr := s.loadScenario(ctx, task.ScenarioID)
	if serr != nil {
		return nil, serr
	}
	executions, err := s.store.ListPlanEvalExecutions(ctx, task.ID)
	if err != nil {
		return nil, s.internal(err)
	}
	artifacts, err := s.store.ListPlanEvalArtifactMetas(ctx, task.ID)
	if err != nil {
		return nil, s.internal(err)
	}
	artifactByExecution := make(map[string]*storage.PlanEvalArtifact, len(artifacts))
	artifactIDs := make([]string, 0, len(artifacts))
	for i := range artifacts {
		artifactByExecution[artifacts[i].ExecutionID] = &artifacts[i]
		artifactIDs = append(artifactIDs, artifacts[i].ID)
	}
	results, err := s.store.ListPlanEvalCheckResults(ctx, artifactIDs)
	if err != nil {
		return nil, s.internal(err)
	}
	checksByArtifact := make(map[string][]CheckResultView, len(results))
	for _, result := range results {
		checksByArtifact[result.ArtifactID] = append(checksByArtifact[result.ArtifactID], checkResultView(result))
	}
	snapshotIDs := make([]string, len(executions))
	for i := range executions {
		snapshotIDs[i] = executions[i].SnapshotID
	}
	usernames, err := s.store.PlanEvalSnapshotUsernames(ctx, snapshotIDs)
	if err != nil {
		return nil, s.internal(err)
	}
	summary, verr := s.taskViews(ctx, []storage.PlanEvalTask{*task})
	if verr != nil {
		return nil, verr
	}
	detail := &TaskDetailView{TaskView: summary[0], Scenario: ScenarioView{
		ID: scenario.ID, Name: scenario.Name, ArtifactType: scenario.ArtifactType, AsOf: scenario.AsOf, Request: json.RawMessage(scenario.RequestJSON),
	}, Executions: make([]ExecutionView, 0, len(executions))}
	for _, execution := range executions {
		view := ExecutionView{
			ID: execution.ID, SnapshotID: execution.SnapshotID, SnapshotName: usernames[execution.SnapshotID],
			Generate: StageView{Status: execution.GenerateStatus, Attempts: execution.Attempts},
			Evaluate: StageView{Status: execution.EvaluateStatus},
			Checks:   []CheckResultView{},
		}
		if execution.GenerateErrorCode != "" || execution.GenerateErrorMessage != "" {
			view.Generate.Error = &StageError{Code: execution.GenerateErrorCode, Message: execution.GenerateErrorMessage}
		}
		if artifact := artifactByExecution[execution.ID]; artifact != nil {
			view.Artifact = &ArtifactView{ID: artifact.ID, ArtifactType: artifact.ArtifactType, Sha256: artifact.Sha256, SizeBytes: len(artifact.Content), SchemaValid: artifact.SchemaValid}
			view.Checks = checksByArtifact[artifact.ID]
			if view.Checks == nil {
				view.Checks = []CheckResultView{}
			}
		}
		detail.Executions = append(detail.Executions, view)
	}
	return detail, nil
}

func checkResultView(result storage.PlanEvalCheckResult) CheckResultView {
	view := CheckResultView{CheckID: result.CheckID, Version: result.RuleVersion, Status: result.Status, Reason: result.Reason}
	if result.DetailJSON != nil {
		view.Detail = json.RawMessage(*result.DetailJSON)
	}
	if result.ErrorJSON != nil {
		_ = json.Unmarshal([]byte(*result.ErrorJSON), &view.Error)
	}
	return view
}

// Artifact returns one artifact's raw content and metadata.
func (s *Service) Artifact(ctx context.Context, id string) (*storage.PlanEvalArtifact, *Error) {
	artifact, err := s.store.GetPlanEvalArtifact(ctx, id)
	if err != nil {
		return nil, s.mapStorageError(err)
	}
	return artifact, nil
}

// Scale changes the shared concurrency of exactly one version.
func (s *Service) Scale(ctx context.Context, version string, replicas int) *Error {
	if !s.knownVersion(version) || replicas < 1 || replicas > s.cfg.MaxReplicas {
		return fail(422, "invalid_request", fmt.Sprintf("已登记版本的副本数须在 1–%d 之间", s.cfg.MaxReplicas))
	}
	return s.withVersion(ctx, version, func(ctx context.Context) *Error {
		config, err := s.store.PlanEvalLaunchConfigForVersion(ctx, version)
		if err != nil {
			return s.mapStorageError(err)
		}

		// Persist the desired count first: retry-launch restores it after a cluster fault.
		if err := s.store.SetPlanEvalReplicas(ctx, version, replicas); err != nil {
			return s.internal(err)
		}
		config.Replicas = replicas
		if err := s.applyLaunchConfig(ctx, config); err != nil {
			s.log.Error("plan-eval: scale", zap.Error(err))
			return fail(502, "scale_failed", "调整 Deployment 副本失败，请重试。")
		}
		return nil
	})
}

func (s *Service) applyLaunchConfig(ctx context.Context, config *storage.PlanEvalLaunchConfig) error {
	env, err := s.secrets.Open(config.EnvCipher)
	if err != nil {
		return err
	}
	if err := s.deployer.Ensure(ctx, WorkerSpec{AgentVersion: config.AgentVersion, Replicas: config.Replicas, Env: env}); err != nil {
		return fmt.Errorf("deployment: %w", err)
	}
	return nil
}
