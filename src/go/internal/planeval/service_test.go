package planeval

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/api"
	"github.com/zhaochy1990/stride/internal/storage"
	"go.uber.org/zap"
)

const (
	testVersion     = "2026.11.30"
	testWorkerToken = "worker-secret"
	testAdminAud    = "app-admin"
)

// ---- in-memory stand-ins for the broker and the cluster ----

type fakeBroker struct {
	mu       sync.Mutex
	queues   map[string][]ExecuteMessage
	depth    map[string]QueueDepth
	publish  func(queue string) error
	declared []string
}

func (b *fakeBroker) EnsureQueue(_ context.Context, name string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.queues[name]; !ok {
		b.queues[name] = nil
	}
	b.declared = append(b.declared, name)
	return nil
}

func (b *fakeBroker) Publish(_ context.Context, queue string, message ExecuteMessage) error {
	if b.publish != nil {
		if err := b.publish(queue); err != nil {
			return err
		}
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.queues[queue] = append(b.queues[queue], message)
	return nil
}

func (b *fakeBroker) QueueDepth(_ context.Context, queue string) (QueueDepth, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if depth, ok := b.depth[queue]; ok {
		return depth, nil
	}
	return QueueDepth{Ready: len(b.queues[queue])}, nil
}

type fakeDeployer struct {
	mu      sync.Mutex
	ensure  func(WorkerSpec) error
	delete  func(string) error
	ensured []WorkerSpec
	deleted []string
}

func (d *fakeDeployer) Ensure(_ context.Context, spec WorkerSpec) error {
	if d.ensure != nil {
		if err := d.ensure(spec); err != nil {
			return err
		}
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ensured = append(d.ensured, spec)
	return nil
}

func (d *fakeDeployer) Scale(ctx context.Context, version string, replicas int, revision uint64) error {
	return d.Ensure(ctx, WorkerSpec{AgentVersion: version, Replicas: replicas, RuntimeRevision: revision})
}

func (d *fakeDeployer) Delete(_ context.Context, version string, _ DeploymentStatus) error {
	if d.delete != nil {
		if err := d.delete(version); err != nil {
			return err
		}
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.deleted = append(d.deleted, version)
	return nil
}

func (d *fakeDeployer) Status(_ context.Context, version string) (DeploymentStatus, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, spec := range d.ensured {
		if spec.AgentVersion == version {
			return DeploymentStatus{Present: true, Replicas: int32(spec.Replicas), ReadyReplicas: int32(spec.Replicas)}, nil
		}
	}
	return DeploymentStatus{}, nil
}

// ---- wiring ----

type harness struct {
	t *testing.T
	// version is this harness's own agent version, so tests sharing one
	// database never see each other's executions.
	version  string
	router   *gin.Engine
	broker   *fakeBroker
	deployer *fakeDeployer
	svc      *Service
	key      *rsa.PrivateKey
}

func openHarness(t *testing.T) *harness {
	t.Helper()
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("set STRIDE_WORKER_TEST_MYSQL_DSN to run plan-eval integration tests")
	}
	store, err := storage.Open(dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if err := store.AutoMigratePlanEval(context.Background()); err != nil {
		t.Fatalf("automigrate: %v", err)
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := api.NewJWTVerifierFromKeyWithAdmin(&key.PublicKey, "auth-service", "", testAdminAud)
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{
		t: t, key: key, version: testVersion + "-" + uuid.NewString()[:8],
		broker:   &fakeBroker{queues: map[string][]ExecuteMessage{}, depth: map[string]QueueDepth{}},
		deployer: &fakeDeployer{},
	}
	secrets, _ := NewSecretKey("MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=")
	// Each run gets its own versions so repeated runs against a persistent
	// database never collide; the HTTP-facing version stays readable.
	h.svc = NewService(store, h.broker, h.deployer, secrets, Config{
		AgentVersions: []string{h.version}, LeaseTTL: time.Minute, RuleTimeout: 5 * time.Second,
		RuleMemoryLimit: DefaultRuleMemoryLimit, EvaluateSweepEvery: time.Hour,
	}, zap.NewNop())
	snapshot := []byte(`{
		"schema": "plan-eval-runner-snapshot/v1",
		"snapshot_id": "88888888-5555-4444-aaaa-000000000001",
		"username": "fixture-marathon-runner",
		"generation_kind": "new_season",
		"event": "FM",
		"target_time": "3:10:00",
		"as_of_day": "2026-10-23",
		"constraints": {"max_run_days_per_week": 5, "no_run_days": []},
		"records": {}
	}`)
	if err := h.svc.seedPreset(context.Background(), snapshot); err != nil {
		t.Fatalf("seed presets: %v", err)
	}
	gin.SetMode(gin.TestMode)
	h.router = h.svc.Router(api.NewAuthenticator("", verifier).RequireAdmin(), api.AdminCallerID, testWorkerToken,
		func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) }, zap.NewNop())
	return h
}

// mint signs arbitrary RS256 claims with the auth-service key.
func (h *harness) mint(claims jwt.MapClaims) string {
	h.t.Helper()
	claims["iss"], claims["iat"] = "auth-service", time.Now().Add(-time.Minute).Unix()
	signed, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(h.key)
	if err != nil {
		h.t.Fatal(err)
	}
	return signed
}

// adminToken is what the dashboard presents: the admin audience + role.
func (h *harness) adminToken() string {
	return h.mint(jwt.MapClaims{"sub": "admin-1", "aud": testAdminAud, "role": "admin", "exp": time.Now().Add(time.Hour).Unix()})
}

type response struct {
	status int
	body   []byte
	header http.Header
}

func (h *harness) call(method, path string, body any, headers map[string]string) response {
	h.t.Helper()
	var reader *bytes.Reader
	if body != nil {
		reader = bytes.NewReader(mustJSON(body))
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	for name, value := range headers {
		req.Header.Set(name, value)
	}
	recorder := httptest.NewRecorder()
	h.router.ServeHTTP(recorder, req)
	return response{status: recorder.Code, body: recorder.Body.Bytes(), header: recorder.Header()}
}

func (h *harness) admin(method, path string, body any, extra map[string]string) response {
	headers := map[string]string{"Authorization": "Bearer " + h.adminToken()}
	for name, value := range extra {
		headers[name] = value
	}
	return h.call(method, path, body, headers)
}

func (h *harness) worker(method, path string, body any) response {
	return h.call(method, path, body, map[string]string{workerTokenHeader: versionWorkerToken(testWorkerToken, h.version)})
}

// json decodes a response body or fails the test.
func (h *harness) json(res response) map[string]any {
	h.t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal(res.body, &decoded); err != nil {
		h.t.Fatalf("decode %s: %v", res.body, err)
	}
	return decoded
}

// createBody is the launch form: this harness's version plus environment variables.
func (h *harness) createBody(env ...[2]string) map[string]any {
	vars := make([]map[string]string, 0, len(env))
	for _, pair := range env {
		vars = append(vars, map[string]string{"name": pair[0], "value": pair[1]})
	}
	return map[string]any{"agent_version": h.version, "env": vars}
}

// ---- tests ----

func TestHTTP_AdminSurfaceAdmitsOnlyAdministrators(t *testing.T) {
	h := openHarness(t)
	const path = "/api/admin/plan-eval/tasks"
	cases := map[string]map[string]string{
		"anonymous":              {},
		"end user":               {"Authorization": "Bearer " + h.mint(jwt.MapClaims{"sub": "user-1", "aud": "app-user", "exp": time.Now().Add(time.Hour).Unix()})},
		"admin audience no role": {"Authorization": "Bearer " + h.mint(jwt.MapClaims{"sub": "user-1", "aud": testAdminAud, "exp": time.Now().Add(time.Hour).Unix()})},
		"role without audience":  {"Authorization": "Bearer " + h.mint(jwt.MapClaims{"sub": "user-1", "aud": "app-user", "role": "admin", "exp": time.Now().Add(time.Hour).Unix()})},
		"expired admin":          {"Authorization": "Bearer " + h.mint(jwt.MapClaims{"sub": "admin-1", "aud": testAdminAud, "role": "admin", "exp": time.Now().Add(-time.Hour).Unix()})},
		"garbage bearer":         {"Authorization": "Bearer not-a-jwt"},
		"worker identity":        {workerTokenHeader: testWorkerToken},
		"Go API internal token":  {"X-Internal-Token": testWorkerToken},
	}
	for name, headers := range cases {
		if res := h.call(http.MethodGet, path, nil, headers); res.status != http.StatusUnauthorized {
			t.Errorf("%s: status %d, want 401", name, res.status)
		}
	}
	if res := h.admin(http.MethodGet, path, nil, nil); res.status != http.StatusOK {
		t.Fatalf("administrator: %d %s", res.status, res.body)
	} else if _, ok := h.json(res)["tasks"]; !ok {
		t.Fatalf("list body: %s", res.body)
	}
}

func TestHTTP_WorkerSurfaceRequiresTheWorkerIdentity(t *testing.T) {
	h := openHarness(t)
	const path = "/api/internal/plan-eval/executions/claim"
	body := map[string]any{"snapshot_execution_id": uuid.NewString(), "agent_version": h.version, "worker_id": "w", "claim_request_id": "claim-1"}
	for name, headers := range map[string]map[string]string{
		"anonymous":      {},
		"wrong token":    {workerTokenHeader: "nope"},
		"admin identity": {"Authorization": "Bearer " + h.adminToken()},
	} {
		if res := h.call(http.MethodPost, path, body, headers); res.status != http.StatusUnauthorized {
			t.Errorf("%s: status %d, want 401", name, res.status)
		}
	}
	if res := h.worker(http.MethodPost, path, body); res.status != http.StatusNotFound {
		t.Fatalf("a real worker asking for an unknown execution: %d %s", res.status, res.body)
	}
}

func TestHTTP_CreateTask_FreezesLaunchesAndReplays(t *testing.T) {
	h := openHarness(t)
	const path = "/api/admin/plan-eval/tasks"
	const secret = "sk-test-value"

	// Validation.
	if res := h.admin(http.MethodPost, path, h.createBody([2]string{"DEEPSEEK_API_KEY", secret}), nil); res.status != http.StatusBadRequest {
		t.Errorf("no Idempotency-Key: %d", res.status)
	}
	withKey := map[string]string{"Idempotency-Key": uuid.NewString()}
	for name, body := range map[string]map[string]any{
		"unknown version": {"agent_version": "1999.1.1"},
		"reserved name":   {"agent_version": h.version, "env": []map[string]string{{"name": "PLAN_WORKER_MODE", "value": "prod"}}},
		"bad name":        {"agent_version": h.version, "env": []map[string]string{{"name": "1bad", "value": "x"}}},
		"too many":        {"agent_version": h.version, "replicas": 99},
	} {
		if res := h.admin(http.MethodPost, path, body, withKey); res.status != http.StatusUnprocessableEntity {
			t.Errorf("%s: %d %s", name, res.status, res.body)
		}
	}

	// Create.
	res := h.admin(http.MethodPost, path, h.createBody([2]string{"DEEPSEEK_API_KEY", secret}), withKey)
	if res.status != http.StatusCreated {
		t.Fatalf("create: %d %s", res.status, res.body)
	}
	if bytes.Contains(res.body, []byte(secret)) {
		t.Fatalf("the launch value leaked into the response: %s", res.body)
	}
	task := h.json(res)
	taskID := task["id"].(string)
	if names := task["env_names"].([]any); len(names) != 1 || names[0] != "DEEPSEEK_API_KEY" || task["replicas"].(float64) != 1 {
		t.Fatalf("launch echo: env_names=%v replicas=%v", task["env_names"], task["replicas"])
	}
	if progress := task["progress"].(map[string]any); progress["total"].(float64) != 1 {
		t.Fatalf("progress: %v", progress)
	}
	executionID := task["executions"].([]any)[0].(map[string]any)["id"].(string)
	queue := QueueName(h.version)
	if messages := h.broker.queues[queue]; len(messages) != 1 || messages[0].SnapshotExecutionID != executionID || messages[0].SchemaVersion != 1 {
		t.Fatalf("published: %+v", messages)
	}
	if len(h.deployer.ensured) != 1 || h.deployer.ensured[0].Env["DEEPSEEK_API_KEY"] != secret || h.deployer.ensured[0].Replicas != 1 {
		t.Fatalf("deployment: %+v", h.deployer.ensured)
	}

	// Replay: the original task answers, nothing is published or started again.
	replay := h.admin(http.MethodPost, path, h.createBody([2]string{"DEEPSEEK_API_KEY", secret}), withKey)
	if replay.status != http.StatusOK || h.json(replay)["id"] != taskID || len(h.broker.queues[queue]) != 1 || len(h.deployer.ensured) != 1 {
		t.Fatalf("replay: %d %s", replay.status, replay.body)
	}
	// Same key, different parameters.
	if res := h.admin(http.MethodPost, path, h.createBody([2]string{"DEEPSEEK_API_KEY", "another"}), withKey); res.status != http.StatusConflict || h.json(res)["error"] != "idempotency_conflict" {
		t.Fatalf("idempotency conflict: %d %s", res.status, res.body)
	}
	// Another task on the version with a different variable set.
	if res := h.admin(http.MethodPost, path, h.createBody([2]string{"OTHER", "x"}), map[string]string{"Idempotency-Key": uuid.NewString()}); res.status != http.StatusConflict || h.json(res)["error"] != "launch_config_conflict" {
		t.Fatalf("launch conflict: %d %s", res.status, res.body)
	}
	if res := h.admin(http.MethodPost, path, h.createBody([2]string{"DEEPSEEK_API_KEY", "changed"}), map[string]string{"Idempotency-Key": uuid.NewString()}); res.status != http.StatusConflict || h.json(res)["error"] != "launch_config_conflict" {
		t.Fatalf("same-name launch value conflict: %d %s", res.status, res.body)
	}
	// Left blank: the running configuration is reused.
	reusedConfig := h.admin(http.MethodPost, path, h.createBody(), map[string]string{"Idempotency-Key": uuid.NewString()})
	if reusedConfig.status != http.StatusCreated {
		t.Fatalf("reuse launch configuration: %d %s", reusedConfig.status, reusedConfig.body)
	}
	secondTaskID := h.json(reusedConfig)["id"].(string)
	if secondTaskID == taskID {
		t.Fatalf("a new idempotency key reused task %s", taskID)
	}

	versions := h.json(h.admin(http.MethodGet, "/api/admin/plan-eval/agent-versions", nil, nil))["versions"].([]any)
	version := versions[0].(map[string]any)
	launch := version["launch_config"].(map[string]any)
	deployment := version["deployment"].(map[string]any)
	if version["agent_version"] != h.version || launch["replicas"].(float64) != 1 || deployment["ready_replicas"].(float64) != 1 {
		t.Fatalf("agent version view: %v", version)
	}
	if bytes.Contains(h.admin(http.MethodGet, "/api/admin/plan-eval/agent-versions", nil, nil).body, []byte(secret)) {
		t.Fatalf("the launch value leaked into the agent-versions view")
	}

	// Other versions can already have tasks in the integration database.
	list := h.json(h.admin(http.MethodGet, path+"?limit=200", nil, nil))
	listed := map[string]int{}
	for _, value := range list["tasks"].([]any) {
		row := value.(map[string]any)
		if row["agent_version"] == h.version {
			listed[row["id"].(string)]++
		}
	}
	if len(listed) != 2 || listed[taskID] != 1 || listed[secondTaskID] != 1 {
		t.Fatalf("tasks listed for version %s: %v, want %s and %s", h.version, listed, taskID, secondTaskID)
	}
}

func TestHTTP_WorkerHandoverAndEvaluation(t *testing.T) {
	h := openHarness(t)
	res := h.admin(http.MethodPost, "/api/admin/plan-eval/tasks", h.createBody(), map[string]string{"Idempotency-Key": uuid.NewString()})
	if res.status != http.StatusCreated {
		t.Fatalf("create: %d %s", res.status, res.body)
	}
	task := h.json(res)
	executionID := task["executions"].([]any)[0].(map[string]any)["id"].(string)
	detailPath := "/api/admin/plan-eval/tasks/" + task["id"].(string)

	// A worker of another version is refused before it sees any input.
	if res := h.worker(http.MethodPost, "/api/internal/plan-eval/executions/claim", map[string]any{"snapshot_execution_id": executionID, "agent_version": "2026.11.29", "worker_id": "w", "claim_request_id": "claim-1"}); res.status != http.StatusConflict {
		t.Fatalf("wrong version claim: %d %s", res.status, res.body)
	}
	claim := h.worker(http.MethodPost, "/api/internal/plan-eval/executions/claim", map[string]any{"snapshot_execution_id": executionID, "agent_version": h.version, "worker_id": "worker-1", "claim_request_id": "claim-1"})
	if claim.status != http.StatusOK {
		t.Fatalf("claim: %d %s", claim.status, claim.body)
	}
	leased := h.json(claim)
	if leased["status"] != "leased" || leased["lease_epoch"].(float64) != 1 {
		t.Fatalf("claim: %s", claim.body)
	}
	input := leased["input"].(map[string]any)
	if input["artifact_type"] != "master_plan" || input["as_of"] != "2026-10-23T23:59:59+08:00" {
		t.Fatalf("input envelope: %v", input)
	}
	if snapshot := input["snapshot"].(map[string]any); snapshot["username"] != "fixture-marathon-runner" || snapshot["as_of_day"] != "2026-10-23" {
		t.Fatalf("the frozen snapshot is not the preset full-marathon runner: username=%v", snapshot["username"])
	}
	request := input["request"].(map[string]any)
	if request["requested_as_of"] != "2026-10-23T23:59:59+08:00" || request["request_id"] != "plan-eval-"+executionID || request["requested_mode"] != "new_season" {
		t.Fatalf("the frozen request is not stamped: %v", request)
	}
	// While the lease is valid another delivery is told to wait.
	if busy := h.worker(http.MethodPost, "/api/internal/plan-eval/executions/claim", map[string]any{"snapshot_execution_id": executionID, "agent_version": h.version, "worker_id": "worker-2", "claim_request_id": "claim-1"}); h.json(busy)["status"] != "busy" || h.json(busy)["retry_after_ms"].(float64) <= 0 || h.json(busy)["retry_after_ms"].(float64) > 5000 {
		t.Fatalf("busy: %s", busy.body)
	}
	if res := h.worker(http.MethodPost, "/api/internal/plan-eval/executions/"+executionID+"/renew", map[string]any{"agent_version": h.version, "worker_id": "worker-1", "submit_id": "submit-1", "lease_epoch": 1}); res.status != http.StatusOK {
		t.Fatalf("renew: %d %s", res.status, res.body)
	}
	if res := h.worker(http.MethodPost, "/api/internal/plan-eval/executions/"+executionID+"/renew", map[string]any{"agent_version": h.version, "worker_id": "worker-2", "lease_epoch": 1}); res.status != http.StatusConflict || h.json(res)["error"] != "stale_lease" {
		t.Fatalf("stale renew: %d %s", res.status, res.body)
	}

	// An artifact that is not valid JSON is kept verbatim, the schema verdict
	// says why, and business rules are skipped.
	bad := map[string]any{"agent_version": h.version, "worker_id": "worker-1", "submit_id": "submit-1", "lease_epoch": 1, "result": map[string]any{"kind": "artifact", "artifact_type": "master_plan", "content": "{\"not json"}}
	settled := h.worker(http.MethodPost, "/api/internal/plan-eval/executions/"+executionID+"/result", bad)
	if settled.status != http.StatusOK {
		t.Fatalf("submit: %d %s", settled.status, settled.body)
	}
	ack := h.json(settled)
	if ack["generate_status"] != "done" || ack["evaluate_status"] != "skipped" || ack["artifact_id"] == "" {
		t.Fatalf("ack: %s", settled.body)
	}
	replayed := h.json(h.worker(http.MethodPost, "/api/internal/plan-eval/executions/"+executionID+"/result", bad))
	if replayed["receipt_id"] != ack["receipt_id"] {
		t.Fatalf("a replayed submit must return the original receipt: %s", settled.body)
	}
	if terminal := h.json(h.worker(http.MethodPost, "/api/internal/plan-eval/executions/claim", map[string]any{"snapshot_execution_id": executionID, "agent_version": h.version, "worker_id": "worker-3", "claim_request_id": "claim-1"})); terminal["status"] != "terminal" {
		t.Fatalf("settled execution: %v", terminal)
	}
	execution := h.json(h.admin(http.MethodGet, detailPath, nil, nil))["executions"].([]any)[0].(map[string]any)
	if generate := execution["generate"].(map[string]any); generate["status"] != "done" {
		t.Fatalf("generate: %v", generate)
	}
	if artifact := execution["artifact"].(map[string]any); artifact["schema_valid"] != false || artifact["sha256"] != sha256Hex("{\"not json") {
		t.Fatalf("artifact: %v", artifact)
	}
	if evaluate := execution["evaluate"].(map[string]any); evaluate["status"] != "skipped" {
		t.Fatalf("evaluate: %v", evaluate)
	}
	checks := execution["checks"].([]any)
	if len(checks) != 1 || checks[0].(map[string]any)["check_id"] != SchemaCheckID || checks[0].(map[string]any)["status"] != "fail" {
		t.Fatalf("checks: %v", checks)
	}

	// A valid artifact: the schema gate passes, the preset rule runs on it.
	res = h.admin(http.MethodPost, "/api/admin/plan-eval/tasks", h.createBody(), map[string]string{"Idempotency-Key": uuid.NewString()})
	validTask := h.json(res)
	validID := validTask["executions"].([]any)[0].(map[string]any)["id"].(string)
	leased = h.json(h.worker(http.MethodPost, "/api/internal/plan-eval/executions/claim", map[string]any{"snapshot_execution_id": validID, "agent_version": h.version, "worker_id": "worker-1", "claim_request_id": "claim-1"}))
	validArtifact, err := os.ReadFile("testdata/valid_master_plan_artifact.json")
	if err != nil {
		t.Fatal(err)
	}
	ack = h.json(h.worker(http.MethodPost, "/api/internal/plan-eval/executions/"+validID+"/result", map[string]any{
		"agent_version": h.version, "worker_id": "worker-1", "submit_id": "submit-1",
		"lease_epoch": int(leased["lease_epoch"].(float64)),
		"result":      map[string]any{"kind": "artifact", "artifact_type": "master_plan", "content": string(validArtifact)},
	}))
	if ack["evaluate_status"] != "pending" {
		t.Fatalf("valid artifact ack: %v", ack)
	}
	h.svc.EvaluatePending(context.Background())
	detail := h.json(h.admin(http.MethodGet, "/api/admin/plan-eval/tasks/"+validTask["id"].(string), nil, nil))
	if detail["status"] != storage.PlanEvalTaskDone {
		t.Fatalf("task status: %v", detail["status"])
	}
	execution = detail["executions"].([]any)[0].(map[string]any)
	if evaluate := execution["evaluate"].(map[string]any); evaluate["status"] != "done" {
		t.Fatalf("evaluate: %v", evaluate)
	}
	verdicts := map[string]string{}
	for _, check := range execution["checks"].([]any) {
		verdicts[check.(map[string]any)["check_id"].(string)] = check.(map[string]any)["status"].(string)
	}
	if verdicts[SchemaCheckID] != "pass" || verdicts[PresetRuleID] != "pass" {
		t.Fatalf("checks: %v", execution["checks"])
	}
	if progress := detail["progress"].(map[string]any); progress["finished"].(float64) != 1 || progress["rule_failed"].(float64) != 0 {
		t.Fatalf("progress: %v", progress)
	}
	artifactID := execution["artifact"].(map[string]any)["id"].(string)
	raw := h.admin(http.MethodGet, "/api/admin/plan-eval/artifacts/"+artifactID, nil, nil)
	if raw.status != http.StatusOK || !bytes.Equal(raw.body, validArtifact) || raw.header.Get("X-Plan-Eval-Sha256") != sha256Hex(string(validArtifact)) {
		t.Fatalf("artifact endpoint: %d sha=%s", raw.status, raw.header.Get("X-Plan-Eval-Sha256"))
	}

	// A failed generate records its reason and skips Evaluate.
	res = h.admin(http.MethodPost, "/api/admin/plan-eval/tasks", h.createBody(), map[string]string{"Idempotency-Key": uuid.NewString()})
	failedID := h.json(res)["executions"].([]any)[0].(map[string]any)["id"].(string)
	h.worker(http.MethodPost, "/api/internal/plan-eval/executions/claim", map[string]any{"snapshot_execution_id": failedID, "agent_version": h.version, "worker_id": "worker-1", "claim_request_id": "claim-1"})
	ack = h.json(h.worker(http.MethodPost, "/api/internal/plan-eval/executions/"+failedID+"/result", map[string]any{
		"agent_version": h.version, "worker_id": "worker-1", "submit_id": "submit-1",
		"lease_epoch": 1,
		"result":      map[string]any{"kind": "failed", "error": map[string]string{"code": "model_timeout", "message": "生成模型调用超时。"}},
	}))
	if ack["generate_status"] != "failed" || ack["artifact_id"] != "" || ack["evaluate_status"] != "skipped" {
		t.Fatalf("failed generate ack: %v", ack)
	}
	executions := h.json(h.admin(http.MethodGet, "/api/admin/plan-eval/tasks/"+h.json(res)["id"].(string), nil, nil))["executions"].([]any)
	if stageErr := executions[0].(map[string]any)["generate"].(map[string]any)["error"].(map[string]any); stageErr["code"] != "model_timeout" || stageErr["message"] != "生成模型调用超时。" {
		t.Fatalf("generate error: %v", stageErr)
	}
}

func TestHTTP_ConcurrentCreateReplaysOneLaunch(t *testing.T) {
	h := openHarness(t)
	const path = "/api/admin/plan-eval/tasks"
	key := map[string]string{"Idempotency-Key": uuid.NewString()}
	responses := make(chan response, 2)
	for range 2 {
		go func() { responses <- h.admin(http.MethodPost, path, h.createBody(), key) }()
	}
	first, second := <-responses, <-responses
	if first.status == http.StatusOK {
		first, second = second, first
	}
	if first.status != http.StatusCreated || second.status != http.StatusOK {
		t.Fatalf("concurrent submissions: %d and %d", first.status, second.status)
	}
	if h.json(first)["id"] != h.json(second)["id"] || len(h.broker.queues[QueueName(h.version)]) != 1 || len(h.deployer.ensured) != 1 {
		t.Fatal("concurrent replay created another task, message, or Deployment")
	}
}

func TestHTTP_ExplicitConfigCanBeReusedWithMultipleVariables(t *testing.T) {
	h := openHarness(t)
	path := "/api/admin/plan-eval/tasks"
	request := h.createBody([2]string{"DEEPSEEK_API_KEY", "test-key"}, [2]string{"ANOTHER_KEY", "test-value"})
	for range 2 {
		res := h.admin(http.MethodPost, path, request, map[string]string{"Idempotency-Key": uuid.NewString()})
		if res.status != http.StatusCreated {
			t.Fatalf("reuse explicit configuration: %d %s", res.status, res.body)
		}
	}
}

func TestHTTP_CleanupRequiresAnIdleVersion(t *testing.T) {
	h := openHarness(t)
	path := "/api/admin/plan-eval/agent-versions/" + h.version + "/cleanup"
	if res := h.admin(http.MethodPost, path, nil, nil); res.status != http.StatusOK || h.json(res)["deleted"] != true {
		t.Fatalf("an idle version cleans up: %d %s", res.status, res.body)
	}
	if res := h.admin(http.MethodPost, "/api/admin/plan-eval/agent-versions/9.9.9/cleanup", nil, nil); res.status != http.StatusUnprocessableEntity {
		t.Fatalf("unknown version: %d", res.status)
	}

	// A queued execution blocks the cleanup.
	created := h.json(h.admin(http.MethodPost, "/api/admin/plan-eval/tasks", h.createBody([2]string{"DEEPSEEK_API_KEY", "test-before-cleanup"}), map[string]string{"Idempotency-Key": uuid.NewString()}))
	executionID := created["executions"].([]any)[0].(map[string]any)["id"].(string)
	blocked := h.admin(http.MethodPost, path, nil, nil)
	if blocked.status != http.StatusConflict || h.json(blocked)["error"] != "cleanup_blocked" || !strings.Contains(h.json(blocked)["detail"].(string), "执行项") {
		t.Fatalf("active generates: %d %s", blocked.status, blocked.body)
	}

	// Every generate settled, but an unacknowledged message is still in flight.
	h.worker(http.MethodPost, "/api/internal/plan-eval/executions/claim", map[string]any{"snapshot_execution_id": executionID, "agent_version": h.version, "worker_id": "worker-1", "claim_request_id": "claim-1"})
	settled := h.worker(http.MethodPost, "/api/internal/plan-eval/executions/"+executionID+"/result", map[string]any{
		"agent_version": h.version, "worker_id": "worker-1", "submit_id": "submit-1",
		"lease_epoch": 1,
		"result":      map[string]any{"kind": "failed", "error": map[string]string{"code": "model_timeout", "message": "生成模型调用超时。"}},
	})
	if h.json(settled)["generate_status"] != "failed" {
		t.Fatalf("settle: %s", settled.body)
	}
	h.broker.depth[QueueName(h.version)] = QueueDepth{Ready: 0, Unacked: 1}
	if res := h.admin(http.MethodPost, path, nil, nil); res.status != http.StatusConflict || !strings.Contains(h.json(res)["detail"].(string), "未确认") {
		t.Fatalf("unacknowledged message: %d %s", res.status, res.body)
	}
	h.broker.depth[QueueName(h.version)] = QueueDepth{}
	if res := h.admin(http.MethodPost, path, nil, nil); res.status != http.StatusOK {
		t.Fatalf("drained version: %d %s", res.status, res.body)
	}
	// The queue itself is kept for the next evaluation of this version.
	if _, kept := h.broker.queues[QueueName(h.version)]; !kept {
		t.Fatalf("cleanup removed the version queue")
	}
	next := h.admin(http.MethodPost, "/api/admin/plan-eval/tasks", h.createBody([2]string{"OTHER", "test-after-cleanup"}), map[string]string{"Idempotency-Key": uuid.NewString()})
	if next.status != http.StatusCreated {
		t.Fatalf("launch new configuration after cleanup: %d %s", next.status, next.body)
	}
	previous := h.json(h.admin(http.MethodGet, "/api/admin/plan-eval/tasks/"+created["id"].(string), nil, nil))
	if string(mustJSON(previous["env_names"])) != `["DEEPSEEK_API_KEY"]` {
		t.Fatalf("historical launch names changed: %v", previous["env_names"])
	}
}

func TestHTTP_LaunchFailureKeepsTheTaskAndReportsIt(t *testing.T) {
	h := openHarness(t)
	h.broker.publish = func(string) error { return errors.New("broker nacked") }
	key := map[string]string{"Idempotency-Key": uuid.NewString()}
	res := h.admin(http.MethodPost, "/api/admin/plan-eval/tasks", h.createBody(), key)
	body := h.json(res)
	if res.status != http.StatusBadGateway || body["error"] != "launch_failed" || !strings.Contains(body["detail"].(string), "broker nacked") || body["task_id"] == "" {
		t.Fatalf("launch failure: %d %s", res.status, res.body)
	}
	// Nothing was started, and the task (with its reason) is still readable.
	if len(h.deployer.ensured) != 0 {
		t.Fatalf("a failed launch still started workers: %+v", h.deployer.ensured)
	}
	detail := h.json(h.admin(http.MethodGet, "/api/admin/plan-eval/tasks/"+body["task_id"].(string), nil, nil))
	if !strings.Contains(detail["launch_error"].(string), "broker nacked") || detail["progress"].(map[string]any)["total"].(float64) != 1 {
		t.Fatalf("detail after a failed launch: %s", mustJSON(detail))
	}
	h.broker.publish = nil
	retry := h.admin(http.MethodPost, "/api/admin/plan-eval/tasks/"+body["task_id"].(string)+"/retry-launch", nil, nil)
	if retry.status != http.StatusOK {
		t.Fatalf("retry launch: %d %s", retry.status, retry.body)
	}
	retried := h.json(retry)
	if retried["id"] != body["task_id"] || retried["launch_error"] != "" || len(h.broker.queues[QueueName(h.version)]) != 1 {
		t.Fatalf("retry must start the original task: %s", retry.body)
	}
	replay := h.admin(http.MethodPost, "/api/admin/plan-eval/tasks", h.createBody(), key)
	if replay.status != http.StatusOK || len(h.broker.queues[QueueName(h.version)]) != 1 {
		t.Fatalf("retrying original request after a successful launch must be idempotent: %d %s", replay.status, replay.body)
	}
}

func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func TestHTTP_TwoVersionsScaleAndCleanupRace(t *testing.T) {
	h := openHarness(t)
	ctx := context.Background()
	otherVersion := h.version + "b"
	h.svc.cfg.AgentVersions = append(h.svc.cfg.AgentVersions, otherVersion)
	create := func(version string) *TaskDetailView {
		view, _, err := h.svc.CreateTask(ctx, "admin-1", uuid.NewString(), CreateTaskRequest{AgentVersion: version, Replicas: 2, Env: []EnvVar{{Name: "MODEL_KEY", Value: "not-a-real-secret"}}})
		if err != nil {
			t.Fatal(err)
		}
		return view
	}
	first, second := create(h.version), create(otherVersion)
	if QueueName(first.AgentVersion) == QueueName(second.AgentVersion) || WorkerName(first.AgentVersion) == WorkerName(second.AgentVersion) {
		t.Fatal("versions share runtime")
	}
	path := "/api/admin/plan-eval/agent-versions/" + h.version + "/scale"
	if res := h.admin(http.MethodPost, path, map[string]int{"replicas": 3}, nil); res.status != http.StatusOK {
		t.Fatalf("scale: %d %s", res.status, res.body)
	}
	if res := h.admin(http.MethodPost, path, map[string]int{"replicas": 0}, nil); res.status != http.StatusUnprocessableEntity {
		t.Fatalf("invalid scale: %d", res.status)
	}
	configs, err := h.svc.store.ListPlanEvalLaunchConfigs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, config := range configs {
		if config.AgentVersion == h.version && config.Replicas != 3 {
			t.Fatal("scaled count not persisted")
		}
		if config.AgentVersion == otherVersion && config.Replicas != 2 {
			t.Fatal("another version was scaled")
		}
	}
	// An omitted count and variables keep the version's effective configuration.
	shared, _, serr := h.svc.CreateTask(ctx, "admin-1", uuid.NewString(), CreateTaskRequest{AgentVersion: h.version})
	if serr != nil || shared.Replicas != 3 {
		t.Fatalf("blank launch config: %+v %v", shared, serr)
	}
	for _, view := range []*TaskDetailView{first, shared} {
		id := view.Executions[0].ID
		if _, err := h.svc.Claim(ctx, claimRequest{SnapshotExecutionID: id, AgentVersion: h.version, WorkerID: "w", ClaimRequestID: "claim-1"}); err != nil {
			t.Fatal(err)
		}
		if _, err := h.svc.Submit(ctx, id, submitRequest{PlanEvalWorkerLease: storage.PlanEvalWorkerLease{AgentVersion: h.version, WorkerID: "w", LeaseEpoch: 1}, SubmitID: "submit-1", Result: reportedResult{Kind: "failed", Error: &reportedError{Code: "timeout"}}}); err != nil {
			t.Fatal(err)
		}
	}
	h.broker.depth[QueueName(h.version)] = QueueDepth{}
	deleting := make(chan struct{})
	release := make(chan struct{})
	h.deployer.delete = func(version string) error {
		if version == h.version {
			close(deleting)
			<-release
		}
		return nil
	}
	cleaned := make(chan *Error, 1)
	go func() { cleaned <- h.svc.Cleanup(ctx, h.version) }()
	<-deleting
	// A second API replica runs the same code, not the same process mutex.
	replica := NewService(h.svc.store, h.broker, h.deployer, h.svc.secrets, h.svc.cfg, zap.NewNop())
	created := make(chan *Error, 1)
	go func() {
		_, _, err := replica.CreateTask(ctx, "admin-1", uuid.NewString(), CreateTaskRequest{AgentVersion: h.version})
		created <- err
	}()
	if err := replica.Scale(ctx, otherVersion, 4); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-created:
		t.Fatalf("submit passed an unfinished cleanup: %v", err)
	case <-time.After(30 * time.Millisecond):
	}
	close(release)
	if err := <-cleaned; err != nil {
		t.Fatal(err)
	}
	if err := <-created; err != nil {
		t.Fatal(err)
	}
	if len(h.deployer.deleted) != 1 || h.deployer.deleted[0] != h.version || h.deployer.ensured[len(h.deployer.ensured)-1].AgentVersion != h.version {
		t.Fatal("new task did not recreate the cleaned version")
	}
}

func TestHTTP_DeploymentFailureRetriesOriginalDispatch(t *testing.T) {
	h := openHarness(t)
	h.deployer.ensure = func(WorkerSpec) error { return errors.New("injected deployment fault") }
	key := map[string]string{"Idempotency-Key": uuid.NewString()}
	failed := h.admin(http.MethodPost, "/api/admin/plan-eval/tasks", h.createBody(), key)
	if failed.status != http.StatusBadGateway {
		t.Fatalf("launch: %d %s", failed.status, failed.body)
	}
	taskID := h.json(failed)["task_id"].(string)
	before := h.json(h.admin(http.MethodGet, "/api/admin/plan-eval/tasks/"+taskID, nil, nil))
	if !strings.Contains(before["launch_error"].(string), "deployment") {
		t.Fatal("failure phase missing")
	}
	h.deployer.ensure = nil
	retried := h.admin(http.MethodPost, "/api/admin/plan-eval/tasks/"+taskID+"/retry-launch", nil, nil)
	if retried.status != http.StatusOK {
		t.Fatalf("retry: %d %s", retried.status, retried.body)
	}
	after := h.json(retried)
	if after["id"] != before["id"] || len(h.broker.queues[QueueName(h.version)]) != 1 {
		t.Fatal("retry recreated or republished confirmed execution")
	}
	beforeID := before["executions"].([]any)[0].(map[string]any)["id"]
	afterID := after["executions"].([]any)[0].(map[string]any)["id"]
	if beforeID != afterID {
		t.Fatal("retry changed execution ID")
	}
}

func TestHTTP_WorkerCannotImpersonateAnotherVersion(t *testing.T) {
	h := openHarness(t)
	other := h.version + "b"
	h.svc.cfg.AgentVersions = append(h.svc.cfg.AgentVersions, other)
	view, _, err := h.svc.CreateTask(context.Background(), "admin-1", uuid.NewString(), CreateTaskRequest{AgentVersion: other})
	if err != nil {
		t.Fatal(err)
	}
	// An authentic version-A credential cannot self-report version B.
	res := h.worker(http.MethodPost, "/api/internal/plan-eval/executions/claim", map[string]any{"snapshot_execution_id": view.Executions[0].ID, "agent_version": other, "worker_id": "w", "claim_request_id": "claim-1"})
	if res.status != http.StatusConflict || h.json(res)["error"] != "agent_version_mismatch" {
		t.Fatalf("cross-version credential: %d %s", res.status, res.body)
	}
	row, err2 := h.svc.store.PlanEvalExecutionInput(context.Background(), view.Executions[0].ID)
	if err2 != nil || row.LeaseEpoch != 0 {
		t.Fatalf("unauthorized claim touched lease: %+v %v", row, err2)
	}
}

func TestPlanEval_StampRequestUsesArtifactClock(t *testing.T) {
	for _, artifact := range []string{"master_plan", "weekly_plan_batch"} {
		stamped, err := stampRequest(`{"request_id":"old"}`, "execution", "2026-11-26T08:00:00+08:00", artifact)
		if err != nil {
			t.Fatal(err)
		}
		var request map[string]string
		if err := json.Unmarshal([]byte(stamped), &request); err != nil {
			t.Fatal(err)
		}
		clock := "requested_as_of"
		if artifact == "weekly_plan_batch" {
			clock = "as_of"
		}
		if len(request) != 2 || request["request_id"] != "plan-eval-execution" || request[clock] != "2026-11-26T08:00:00+08:00" {
			t.Fatalf("%s request: %s", artifact, stamped)
		}
	}
	if _, err := stampRequest(`null`, "execution", "instant", "master_plan"); err == nil {
		t.Fatal("null template accepted")
	}
}

func TestHTTP_OmittedReplicasDifferFromExplicitOne(t *testing.T) {
	h := openHarness(t)
	ctx := context.Background()
	if _, _, err := h.svc.CreateTask(ctx, "admin-1", uuid.NewString(), CreateTaskRequest{AgentVersion: h.version, Replicas: 3}); err != nil {
		t.Fatal(err)
	}
	key := uuid.NewString()
	view, _, err := h.svc.CreateTask(ctx, "admin-1", key, CreateTaskRequest{AgentVersion: h.version})
	if err != nil || view.Replicas != 3 {
		t.Fatalf("omitted replicas: %+v %v", view, err)
	}
	if _, _, err := h.svc.CreateTask(ctx, "admin-1", key, CreateTaskRequest{AgentVersion: h.version, Replicas: 1}); err == nil || err.Code != "idempotency_conflict" {
		t.Fatalf("changed params replayed: %v", err)
	}
}
