package planeval

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/storage"
	"go.uber.org/zap"
)

func TestHTTP_RuleTrialAcceptsFullCheckInput(t *testing.T) {
	svc := &Service{cfg: Config{RuleTimeout: 10 * time.Second, RuleMemoryLimit: DefaultRuleMemoryLimit}}
	router := svc.Router(func(*gin.Context) {}, func(*gin.Context) string { return "admin-test" }, "", func(*gin.Context) {}, zap.NewNop())
	input := ruleInput(t, loadValidArtifact(t), 5)
	const prefix, suffix = `{"history":"`, `"}`
	input.Snapshot = json.RawMessage(prefix + strings.Repeat("a", (16<<20)-len(prefix)-len(suffix)) + suffix)
	payload, err := json.Marshal(ruleTrialRequest{
		Rule:  storage.PlanEvalRule{ID: "trial-size", Version: 1, Name: "trial size", ArtifactType: "master_plan", Source: `function run(input) { return {status:"pass",reason:String(input.snapshot.history.length)}; }`},
		Input: input,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(payload) <= 16<<20 {
		t.Fatalf("trial payload must exceed snapshot-only limit, got %d bytes", len(payload))
	}
	request := httptest.NewRequest(http.MethodPost, adminPrefix+"/rules/trial", bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	var result CheckResult
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.Status != "pass" {
		t.Fatalf("large trial: %d %s", response.Code, response.Body.String())
	}
}

func TestHTTP_RuleCapacityWaitPastLeaseIsRetryable(t *testing.T) {
	h := openHarness(t)
	ctx := context.Background()
	task, _, err := h.svc.CreateTask(ctx, "admin", uuid.NewString(), CreateTaskRequest{AgentVersion: h.version})
	if err != nil {
		t.Fatal(err)
	}
	executionID := task.Executions[0].ID
	_, err = h.svc.Claim(ctx, claimRequest{SnapshotExecutionID: executionID, AgentVersion: h.version, WorkerID: "w", ClaimRequestID: uuid.NewString()})
	if err != nil {
		t.Fatal(err)
	}
	artifact, readErr := os.ReadFile("testdata/valid_master_plan_artifact.json")
	if readErr != nil {
		t.Fatal(readErr)
	}
	func() {
		h.svc.evaluateMu.Lock()
		defer h.svc.evaluateMu.Unlock()
		_, err := h.svc.Submit(ctx, executionID, submitRequest{
			PlanEvalWorkerLease: storage.PlanEvalWorkerLease{AgentVersion: h.version, WorkerID: "w", LeaseEpoch: 1},
			SubmitID:            uuid.NewString(), Result: reportedResult{Kind: "artifact", ArtifactType: "master_plan", Content: string(artifact)},
		})
		if err != nil {
			t.Fatal(err)
		}
		work, storageErr := h.svc.store.ClaimPlanEvalEvaluations(ctx, time.Now().UTC(), 500*time.Millisecond, 1)
		if storageErr != nil || len(work) != 1 {
			t.Fatalf("evaluate claim: %d records, error: %v", len(work), storageErr)
		}
		select {
		case ruleRuntimeSlot <- struct{}{}:
		case <-time.After(time.Second):
			t.Fatal("could not reserve the rule slot")
		}
		defer func() { <-ruleRuntimeSlot }()
		h.svc.evaluate(ctx, work[0])
		detail, err := h.svc.TaskDetail(ctx, task.ID)
		if err != nil || len(detail.Executions[0].Checks) != 1 || detail.Executions[0].Checks[0].CheckID != SchemaCheckID {
			t.Fatalf("slot wait should leave only the schema result: %+v, %v", detail, err)
		}
	}()
	h.svc.EvaluatePending(ctx)
	detail, err := h.svc.TaskDetail(ctx, task.ID)
	if err != nil || detail.Executions[0].Evaluate.Status != storage.PlanEvalEvaluateDone || len(detail.Executions[0].Checks) != 2 || detail.Executions[0].Checks[1].Status != "pass" {
		t.Fatalf("evaluation should resume after the slot is released: %+v, %v", detail, err)
	}
}

func TestHTTP_RulePublishingTrialAndFrozenEvaluation(t *testing.T) {
	h := openHarness(t)
	const prefix = "/api/admin/plan-eval"
	id := "rule-" + uuid.NewString()
	v1 := storage.PlanEvalRule{ID: id, Version: 1, Name: "时钟与参数", Description: "多行\n说明", ArtifactType: "*", Source: `function run(input) {const max = 5; return {status:"pass", reason: "v1:"+max+":"+Date.now()+":"+Math.random()+":"+input.scenario.request.goals[0].distance};}`}
	publish := func(rule storage.PlanEvalRule, want int) {
		t.Helper()
		r := h.admin(http.MethodPost, prefix+"/rules", rule, nil)
		if r.status != want {
			t.Fatalf("publish: %d %s", r.status, r.body)
		}
	}
	for _, methodPath := range []struct{ method, path string }{{"POST", "/rules"}, {"POST", "/rules/trial"}, {"GET", "/rules/" + id + "/1"}} {
		for _, headers := range []map[string]string{{}, {"Authorization": "Bearer " + h.mint(map[string]any{"sub": "user", "aud": "app-user", "exp": time.Now().Add(time.Hour).Unix()})}, {workerTokenHeader: testWorkerToken}} {
			r := h.call(methodPath.method, prefix+methodPath.path, v1, headers)
			if r.status != http.StatusUnauthorized {
				t.Fatalf("private route: %d %s", r.status, r.body)
			}
		}
	}
	publish(v1, 201)
	textRule := v1
	textRule.ID = "text-" + uuid.NewString()
	textRule.Description = strings.Repeat("跑", 21845)
	publish(textRule, 201)
	textRule.Version++
	textRule.Description += "x"
	publish(textRule, 422)
	publish(v1, 409)
	bad := v1
	bad.ID = "schema"
	publish(bad, 422)
	bad = v1
	bad.Version = 3
	publish(bad, 409)
	bad = v1
	bad.Source = "function run( {"
	publish(bad, 422)
	detail := h.admin(http.MethodGet, prefix+"/rules/"+id+"/1", nil, nil)
	if detail.status != 200 || h.json(detail)["Source"] != v1.Source || h.json(detail)["Description"] != v1.Description {
		t.Fatalf("version detail: %d %s", detail.status, detail.body)
	}
	if r := h.admin(http.MethodGet, prefix+"/rules/"+id+"/99", nil, nil); r.status != 404 {
		t.Fatalf("unknown version: %d", r.status)
	}
	if r := h.admin(http.MethodGet, prefix+"/rules", nil, nil); r.status != 200 {
		t.Fatal(r.status)
	}
	// Create an editable snapshot and scene through the public admin contracts.
	snap := h.json(h.admin(http.MethodPost, prefix+"/snapshots", testSnapshot(t), nil))
	sceneBody := ScenarioView{Name: "rule scene", ArtifactType: "master_plan", Request: json.RawMessage(`{}`), SnapshotIDs: []string{snap["snapshot_id"].(string)}, Rules: []RuleRef{{ID: id, Version: 1}}}
	sceneRes := h.admin(http.MethodPost, prefix+"/scenarios", sceneBody, nil)
	if sceneRes.status != 200 {
		t.Fatalf("scene: %d %s", sceneRes.status, sceneRes.body)
	}
	sceneID := h.json(sceneRes)["id"].(string)
	create := func() *TaskDetailView {
		t.Helper()
		r := h.admin(http.MethodPost, prefix+"/tasks", CreateTaskRequest{AgentVersion: h.version, ScenarioIDs: []string{sceneID}}, map[string]string{"Idempotency-Key": uuid.NewString()})
		if r.status != 201 {
			t.Fatalf("task: %d %s", r.status, r.body)
		}
		var v TaskDetailView
		_ = json.Unmarshal(r.body, &v)
		return &v
	}
	old := create()
	v2 := v1
	v2.Version = 2
	v2.Source = `function run() {const max = 2; return {status:"fail",reason:"v2",violations:[{week_name:"week 1",expected:max,actual:5}]};}`
	publish(v2, 201)
	// One malformed result followed by a valid one must not abort the batch.
	broken := v1
	broken.ID = "broken-" + uuid.NewString()
	broken.Source = `function run(){while(true){}}`
	publish(broken, 201)
	following := v1
	following.ID = "following-" + uuid.NewString()
	following.Source = `function run(){return {status:"pass",reason:"after error"};}`
	publish(following, 201)
	sceneBody.Rules = []RuleRef{{ID: id, Version: 2}, {ID: broken.ID, Version: 1}, {ID: following.ID, Version: 1}}
	if r := h.admin(http.MethodPut, prefix+"/scenarios/"+sceneID, sceneBody, nil); r.status != 200 {
		t.Fatalf("switch: %d %s", r.status, r.body)
	}
	duplicate := sceneBody
	duplicate.Rules = append(duplicate.Rules, RuleRef{ID: id, Version: 1})
	if r := h.admin(http.MethodPut, prefix+"/scenarios/"+sceneID, duplicate, nil); r.status != 422 {
		t.Fatalf("two versions accepted: %d %s", r.status, r.body)
	}
	newer := create()
	frozen, err := h.svc.store.ListPlanEvalFrozenRules(context.Background(), old.ID)
	if err != nil || len(frozen) != 1 || frozen[0].Version != 1 || frozen[0].Source != v1.Source {
		t.Fatalf("old rule changed: %+v %v", frozen, err)
	}
	// Execute reads the same frozen request, even after the scenario switch.
	artifact, _ := os.ReadFile("testdata/valid_master_plan_artifact.json")
	submit := func(task *TaskDetailView, content string) {
		t.Helper()
		eid := task.Executions[0].ID
		r := h.worker(http.MethodPost, "/api/internal/plan-eval/executions/claim", claimRequest{SnapshotExecutionID: eid, AgentVersion: h.version, WorkerID: "w", ClaimRequestID: uuid.NewString()})
		if r.status != 200 {
			t.Fatalf("claim: %d %s", r.status, r.body)
		}
		r = h.worker(http.MethodPost, "/api/internal/plan-eval/executions/"+eid+"/result", submitRequest{PlanEvalWorkerLease: storage.PlanEvalWorkerLease{AgentVersion: h.version, WorkerID: "w", LeaseEpoch: 1}, SubmitID: uuid.NewString(), Result: reportedResult{Kind: "artifact", ArtifactType: "master_plan", Content: content}})
		if r.status != 200 {
			t.Fatalf("submit: %d %s", r.status, r.body)
		}
	}
	submit(old, string(artifact))
	h.svc.EvaluatePending(context.Background())
	oldDetail, e := h.svc.TaskDetail(context.Background(), old.ID)
	if e != nil {
		t.Fatal(e)
	}
	checks := oldDetail.Executions[0].Checks
	if len(checks) != 2 || checks[1].Version != 1 || checks[1].Status != "pass" {
		t.Fatalf("old checks: %+v", checks)
	}
	input, e := h.svc.ExecutionInput(context.Background(), old.ID, old.Executions[0].ID)
	if e != nil {
		t.Fatal(e)
	}
	trialInput := CheckInput{Artifact: artifact, Snapshot: input.Snapshot, Scenario: ScenarioInput{ScenarioID: sceneID, Request: input.Request}, AsOf: input.AsOf}
	trialRes := h.admin(http.MethodPost, prefix+"/rules/trial", ruleTrialRequest{Rule: v1, Input: trialInput}, nil)
	var trial CheckResult
	_ = json.Unmarshal(trialRes.body, &trial)
	if trialRes.status != 200 || !reflect.DeepEqual(checkResultView(*checkResultRow(trial, oldDetail.Executions[0].Artifact.ID)), checks[1]) {
		t.Fatalf("trial differs: %s vs %+v", trialRes.body, checks[1])
	}
	// A restart/sweep reuses completed (artifact, check ID) results verbatim.
	before := checks[1]
	h.svc.EvaluatePending(context.Background())
	oldDetail, e = h.svc.TaskDetail(context.Background(), old.ID)
	if e != nil || !reflect.DeepEqual(before, oldDetail.Executions[0].Checks[1]) {
		t.Fatal("completed result was rerun")
	}
	h.svc.cfg.RuleTimeout = 100 * time.Millisecond
	submit(newer, string(artifact))
	h.svc.EvaluatePending(context.Background())
	latest, e := h.svc.TaskDetail(context.Background(), newer.ID)
	if e != nil {
		t.Fatal(e)
	}
	seen := map[string]CheckResultView{}
	for _, check := range latest.Executions[0].Checks {
		seen[check.CheckID] = check
	}
	if seen[id].Version != 2 || seen[id].Status != "fail" || seen[broken.ID].Error == nil || seen[broken.ID].Error.Code != errRuleTimeout || seen[following.ID].Status != "pass" || latest.Executions[0].Evaluate.Status != "done" {
		t.Fatalf("new checks: %+v", seen)
	}
	// The admin trial's schema gate also refuses invalid artifacts.
	invalid := create()
	submit(invalid, "{invalid")
	invalidDetail, e := h.svc.TaskDetail(context.Background(), invalid.ID)
	if e != nil || invalidDetail.Executions[0].Evaluate.Status != "skipped" || len(invalidDetail.Executions[0].Checks) != 1 {
		t.Fatalf("schema skip: %+v %v", invalidDetail, e)
	}
	trialInput.Artifact = json.RawMessage(`{"type":"master_plan","plan":{}}`)
	trialRes = h.admin(http.MethodPost, prefix+"/rules/trial", ruleTrialRequest{Rule: broken, Input: trialInput}, nil)
	_ = json.Unmarshal(trialRes.body, &trial)
	if trialRes.status != 200 || trial.CheckID != SchemaCheckID || trial.Status != "fail" {
		t.Fatalf("trial schema gate: %s", trialRes.body)
	}
}
