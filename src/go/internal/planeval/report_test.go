package planeval

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/storage"
)

func TestReportSummaryCountsExecutionsAndPreservesErrors(t *testing.T) {
	valid := &ArtifactView{SchemaValid: true}
	cases := []struct {
		name string
		e    ExecutionView
		want string
	}{
		{"queued", ExecutionView{Generate: StageView{Status: "queued"}}, "running"},
		{"generate error", ExecutionView{Generate: StageView{Status: "failed"}, Evaluate: StageView{Status: "skipped"}}, "error"},
		{"schema fail", ExecutionView{Generate: StageView{Status: "done"}, Artifact: &ArtifactView{}, Evaluate: StageView{Status: "skipped"}}, "fail"},
		{"evaluate pending", ExecutionView{Generate: StageView{Status: "done"}, Artifact: valid, Evaluate: StageView{Status: "pending"}}, "running"},
		{"evaluate failed", ExecutionView{Generate: StageView{Status: "done"}, Artifact: valid, Evaluate: StageView{Status: "failed"}}, "error"},
		{"pass", ExecutionView{Generate: StageView{Status: "done"}, Artifact: valid, Evaluate: StageView{Status: "done"}, Checks: []CheckResultView{{Status: "pass"}}}, "pass"},
		{"multiple fails count once", ExecutionView{Generate: StageView{Status: "done"}, Artifact: valid, Evaluate: StageView{Status: "done"}, Checks: []CheckResultView{{Status: "fail"}, {Status: "fail"}}}, "fail"},
		{"error outranks fail", ExecutionView{Generate: StageView{Status: "done"}, Artifact: valid, Evaluate: StageView{Status: "done"}, Checks: []CheckResultView{{Status: "fail"}, {Status: "error"}}}, "error"},
	}
	detail := &TaskDetailView{}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := executionResult(tc.e); got != tc.want {
				t.Fatalf("result = %s, want %s", got, tc.want)
			}
		})
		tc.e.Result = executionResult(tc.e)
		tc.e.ScenarioID = "new"
		if i >= 5 {
			tc.e.ScenarioID = "rolling"
		}
		detail.Executions = append(detail.Executions, tc.e)
	}
	detail.summarize([]ScenarioView{{ID: "new"}, {ID: "rolling"}})
	if detail.Summary != (ResultSummary{Pass: 1, Fail: 2, Error: 3, Running: 2}) || detail.Result != "running" {
		t.Fatalf("task: %+v", detail)
	}
	if detail.Scenarios[0].Summary != (ResultSummary{Fail: 1, Error: 2, Running: 2}) || detail.Scenarios[1].Summary != (ResultSummary{Pass: 1, Fail: 1, Error: 1}) || detail.Scenarios[1].Result != "error" {
		t.Fatalf("scenarios: %+v", detail.Scenarios)
	}
	if detail.Progress != (TaskProgress{Total: 8, Finished: 6, GenerateFailed: 1, RuleFailed: 3}) {
		t.Fatalf("progress: %+v", detail.Progress)
	}
}

func TestTaskReportFrozenInputAndCleanupRoundTrip(t *testing.T) {
	h := openHarness(t)
	ctx := context.Background()
	if err := h.svc.SeedRules(ctx); err != nil {
		t.Fatal(err)
	}
	prefix := adminPrefix
	snapshotIDs := []string{}
	for i := 0; i < 4; i++ {
		r := h.admin(http.MethodPost, prefix+"/snapshots", testSnapshot(t), nil)
		if r.status != 200 {
			t.Fatalf("snapshot: %d %s", r.status, r.body)
		}
		var doc map[string]any
		_ = json.Unmarshal(r.body, &doc)
		snapshotIDs = append(snapshotIDs, doc["snapshot_id"].(string))
	}
	sceneIDs := []string{}
	for _, name := range []string{"new", "another scene"} {
		scene := ScenarioView{Name: name, ArtifactType: "master_plan", SnapshotIDs: snapshotIDs, Rules: []RuleRef{{ID: PresetRuleID, Version: 2}}}
		r := h.admin(http.MethodPost, prefix+"/scenarios", scene, nil)
		if r.status != 200 {
			t.Fatalf("scene: %d %s", r.status, r.body)
		}
		var saved ScenarioView
		_ = json.Unmarshal(r.body, &saved)
		sceneIDs = append(sceneIDs, saved.ID)
	}
	created, _, err := h.svc.CreateTask(ctx, "admin", uuid.NewString(), CreateTaskRequest{AgentVersion: h.version, ScenarioIDs: sceneIDs, Env: []EnvVar{{Name: "DEEPSEEK_API_KEY", Value: "never-in-report"}}})
	if err != nil || len(created.Executions) != 8 {
		t.Fatalf("create: %+v %v", created, err)
	}
	artifact, _ := os.ReadFile("testdata/valid_master_plan_artifact.json")
	for i, e := range created.Executions {
		_, err := h.svc.Claim(ctx, claimRequest{SnapshotExecutionID: e.ID, AgentVersion: h.version, WorkerID: "report-worker", ClaimRequestID: uuid.NewString()})
		if err != nil {
			t.Fatal(err)
		}
		result := reportedResult{Kind: "artifact", ArtifactType: "master_plan", Content: string(artifact)}
		if i == 0 {
			result = reportedResult{Kind: "failed", Error: &reportedError{Code: "snapshot_not_covered", Message: "HRV missing, history uncovered"}}
		} else if i == 1 {
			result.Content = "not valid JSON <keep raw bytes>"
		}
		r := h.worker(http.MethodPost, internalPrefix+"/executions/"+e.ID+"/result", submitRequest{PlanEvalWorkerLease: storage.PlanEvalWorkerLease{AgentVersion: h.version, WorkerID: "report-worker", LeaseEpoch: 1}, SubmitID: uuid.NewString(), Result: result})
		if r.status != 200 {
			t.Fatalf("submit: %d %s", r.status, r.body)
		}
	}
	h.svc.EvaluatePending(ctx)
	path := prefix + "/tasks/" + created.ID + "/report"
	r := h.admin(http.MethodGet, path, nil, nil)
	if r.status != 200 || r.header.Get("Cache-Control") != "no-store" || r.header.Get("Content-Disposition") == "" {
		t.Fatalf("export: %d %s", r.status, r.body)
	}
	if bytes.Contains(r.body, []byte("never-in-report")) {
		t.Fatal("launch credential leaked")
	}
	var report TaskReportView
	if err := json.Unmarshal(r.body, &report); err != nil {
		t.Fatal(err)
	}
	if report.Schema != "plan-eval-report/v1" || report.TaskID != created.ID || report.AgentVersion != h.version || len(report.ExecutionInputs) != 8 || len(report.ArtifactContents) != 7 || len(report.FrozenRules) != 2 || report.Summary.Pass+report.Summary.Fail+report.Summary.Error != 8 || report.Summary.Running != 0 {
		t.Fatalf("report envelope: %+v", report)
	}
	for _, e := range report.Executions {
		input := report.ExecutionInputs[e.ID]
		if input.SnapshotSHA256 != documentSHA256(input.SnapshotJSON) || input.RequestSHA256 != documentSHA256(input.RequestJSON) || input.AsOf != e.AsOf {
			t.Fatalf("input lineage: %+v", input)
		}
		if e.Artifact != nil && e.Artifact.Sha256 != documentSHA256(report.ArtifactContents[e.Artifact.ID]) {
			t.Fatal("raw artifact changed")
		}
	}
	if report.Executions[0].Evaluate.Error.Code != "snapshot_not_covered" || report.Executions[1].Evaluate.Error.Code != "schema_invalid" {
		t.Fatal("skipped reasons missing")
	}
	// Editing both live sources must not change a historical export.
	doc := testSnapshot(t)
	doc["username"] = "changed"
	if res := h.admin(http.MethodPut, prefix+"/snapshots/"+snapshotIDs[0], doc, nil); res.status != 200 {
		t.Fatalf("edit snapshot: %d %s", res.status, res.body)
	}
	if res := h.admin(http.MethodPut, prefix+"/scenarios/"+sceneIDs[0], ScenarioView{Name: "changed", ArtifactType: "master_plan", SnapshotIDs: snapshotIDs, Rules: []RuleRef{{ID: PresetRuleID, Version: 1}}}, nil); res.status != 200 {
		t.Fatalf("edit scene: %d %s", res.status, res.body)
	}
	h.broker.depth[QueueName(h.version)] = QueueDepth{}
	if err := h.svc.Cleanup(ctx, h.version); err != nil {
		t.Fatal(err)
	}
	if after := h.admin(http.MethodGet, path, nil, nil); string(after.body) != string(r.body) {
		t.Fatalf("export changed after source edits / cleanup: %d", after.status)
	}
	if res := h.admin(http.MethodGet, prefix+"/tasks/"+uuid.NewString()+"/report", nil, nil); res.status != 404 {
		t.Fatalf("missing report: %d", res.status)
	}
	if res := h.call(http.MethodGet, path, nil, nil); res.status != 401 {
		t.Fatalf("anonymous report: %d", res.status)
	}
	if res := h.call(http.MethodGet, path, nil, map[string]string{"Authorization": "Bearer " + h.mint(map[string]any{"sub": "user", "aud": testAdminAud, "role": "user", "exp": 9999999999})}); res.status != 401 {
		t.Fatalf("non-admin report: %d", res.status)
	}
}
