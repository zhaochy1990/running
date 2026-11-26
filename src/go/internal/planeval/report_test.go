package planeval

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

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
	if active := h.admin(http.MethodGet, prefix+"/tasks/"+created.ID+"/report", nil, nil); active.status != 409 || !bytes.Contains(active.body, []byte("task_not_final")) {
		t.Fatalf("active report: %d", active.status)
	}
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

func TestWriteTaskReportMatchesV1Encoding(t *testing.T) {
	detail := &TaskDetailView{TaskView: TaskView{ID: "task", Status: "done"}, Executions: []ExecutionView{{ID: "z", Artifact: &ArtifactView{ID: "a"}}, {ID: "a", Artifact: &ArtifactView{ID: "z"}}}}
	inputs := map[string]ReportInputView{}
	artifacts := map[string]string{}
	readInput := func(_ context.Context, id string) (*storage.PlanEvalExecution, error) {
		input := &storage.PlanEvalExecution{ID: id, TaskID: detail.ID, AsOf: "clock", RequestJSON: "{\n\"id\":\"" + id + "\"}", SnapshotJSON: "<原始>&\n\t\"snapshot\""}
		inputs[id] = ReportInputView{AsOf: input.AsOf, RequestJSON: input.RequestJSON, SnapshotJSON: input.SnapshotJSON, RequestSHA256: documentSHA256(input.RequestJSON), SnapshotSHA256: documentSHA256(input.SnapshotJSON)}
		return input, nil
	}
	readArtifact := func(_ context.Context, id string) (*storage.PlanEvalArtifact, error) {
		artifacts[id] = "invalid JSON <原始>&\r\n" + id
		return &storage.PlanEvalArtifact{ID: id, TaskID: detail.ID, Content: artifacts[id]}, nil
	}
	var output bytes.Buffer
	if err := writeTaskReport(context.Background(), &output, detail, readInput, readArtifact); err != nil {
		t.Fatal(err)
	}
	want, err := json.Marshal(TaskReportView{TaskDetailView: *detail, Schema: "plan-eval-report/v1", TaskID: detail.ID, ExecutionInputs: inputs, ArtifactContents: artifacts})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(output.Bytes(), want) {
		t.Fatal("spooled encoding differs from v1")
	}
}

func TestWriteTaskReportLargeOriginalDocumentsBounded(t *testing.T) {
	const records = 8
	detail := &TaskDetailView{TaskView: TaskView{ID: "large", Status: "done"}}
	for i := range records {
		id := fmt.Sprintf("%02d", i)
		detail.Executions = append(detail.Executions, ExecutionView{ID: id, Artifact: &ArtifactView{ID: id}})
	}
	file, err := os.CreateTemp(t.TempDir(), "large-*.json")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	runtime.GC()
	var baseline runtime.MemStats
	runtime.ReadMemStats(&baseline)
	var peak uint64
	original := func(id string) string { return id + strings.Repeat("原文<>&\"\n", 1<<19) } // 8 MiB before JSON escaping.
	measure := func() {
		runtime.GC()
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		if m.HeapAlloc > peak {
			peak = m.HeapAlloc
		}
	}
	readInput := func(_ context.Context, id string) (*storage.PlanEvalExecution, error) {
		measure()
		return &storage.PlanEvalExecution{ID: id, TaskID: detail.ID, RequestJSON: " {\"original\":true}\n", SnapshotJSON: original(id)}, nil
	}
	readArtifact := func(_ context.Context, id string) (*storage.PlanEvalArtifact, error) {
		measure()
		return &storage.PlanEvalArtifact{ID: id, TaskID: detail.ID, Content: original(id)}, nil
	}
	if err := writeTaskReport(context.Background(), file, detail, readInput, readArtifact); err != nil {
		t.Fatal(err)
	}
	if peak > baseline.HeapAlloc+96<<20 {
		t.Fatalf("retained blobs grew beyond one record: %d bytes", peak-baseline.HeapAlloc)
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	// Decode each document independently as a browser does after parsing its Blob;
	// hashes cover the original UTF-8 string, not reserialized JSON.
	dec := json.NewDecoder(file)
	if _, err := dec.Token(); err != nil {
		t.Fatal(err)
	}
	checked := 0
	for dec.More() {
		key, err := dec.Token()
		if err != nil {
			t.Fatal(err)
		}
		switch key {
		case "execution_inputs", "artifact_contents":
			if _, err := dec.Token(); err != nil {
				t.Fatal(err)
			}
			for dec.More() {
				id, err := dec.Token()
				if err != nil {
					t.Fatal(err)
				}
				if key == "execution_inputs" {
					var input ReportInputView
					if err := dec.Decode(&input); err != nil {
						t.Fatal(err)
					}
					if input.SnapshotJSON != original(id.(string)) || input.SnapshotSHA256 != documentSHA256(input.SnapshotJSON) || input.RequestSHA256 != documentSHA256(input.RequestJSON) {
						t.Fatal("original input changed")
					}
				} else {
					var content string
					if err := dec.Decode(&content); err != nil {
						t.Fatal(err)
					}
					if content != original(id.(string)) {
						t.Fatal("original artifact changed")
					}
				}
				checked++
			}
			if _, err := dec.Token(); err != nil {
				t.Fatal(err)
			}
		default:
			var ignored json.RawMessage
			if err := dec.Decode(&ignored); err != nil {
				t.Fatal(err)
			}
		}
	}
	if checked != 2*records {
		t.Fatalf("checked %d documents", checked)
	}
}

func TestWriteTaskReportReadWriteFailureAndCancellation(t *testing.T) {
	detail := &TaskDetailView{TaskView: TaskView{ID: "task"}, Executions: []ExecutionView{{ID: "input", Artifact: &ArtifactView{ID: "artifact"}}}}
	goodInput := func(_ context.Context, id string) (*storage.PlanEvalExecution, error) {
		return &storage.PlanEvalExecution{ID: id, TaskID: detail.ID}, nil
	}
	badArtifact := func(context.Context, string) (*storage.PlanEvalArtifact, error) { return nil, io.ErrUnexpectedEOF }
	if err := writeTaskReport(context.Background(), io.Discard, detail, goodInput, badArtifact); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("read: %v", err)
	}
	badInput := func(context.Context, string) (*storage.PlanEvalExecution, error) { return nil, io.ErrUnexpectedEOF }
	if err := writeTaskReport(context.Background(), io.Discard, detail, badInput, badArtifact); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("input read: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	reads := 0
	cancellingInput := func(ctx context.Context, id string) (*storage.PlanEvalExecution, error) {
		reads++
		cancel()
		return goodInput(ctx, id)
	}
	if err := writeTaskReport(ctx, io.Discard, detail, cancellingInput, badArtifact); !errors.Is(err, context.Canceled) || reads != 1 {
		t.Fatalf("cancel: %v, reads %d", err, reads)
	}
	limit := &reportWriter{Writer: io.Discard, remaining: 16}
	if err := writeTaskReport(context.Background(), limit, detail, goodInput, badArtifact); !errors.Is(err, errReportTooLarge) {
		t.Fatalf("limit: %v", err)
	}
	closed, err := os.CreateTemp(t.TempDir(), "closed")
	if err != nil {
		t.Fatal(err)
	}
	closed.Close()
	if err := writeTaskReport(context.Background(), closed, detail, goodInput, badArtifact); !errors.Is(err, os.ErrClosed) {
		t.Fatalf("write: %v", err)
	}
}

func TestTaskReportFrozenLaunchAndSlotLifetime(t *testing.T) {
	h := openHarness(t)
	ctx := context.Background()
	inputID := uuid.NewString()
	task, _, err := h.svc.store.CreatePlanEvalTask(ctx, &storage.PlanEvalTaskCreate{
		Task:         &storage.PlanEvalTask{ID: uuid.NewString(), AgentVersion: h.version, ScenarioID: "legacy", Submitter: "legacy", IdempotencyKey: uuid.NewString(), ParamsFingerprint: "legacy"},
		LaunchConfig: &storage.PlanEvalLaunchConfig{ID: uuid.NewString(), AgentVersion: h.version, Replicas: 2, EnvNames: "[]", EnvFingerprint: "legacy"}, EnvCipher: []byte("legacy"),
		Executions: []*storage.PlanEvalExecution{{ID: inputID, ScenarioID: "legacy", SnapshotID: "legacy", AsOf: "2026-10-26T08:00:00+08:00", RequestJSON: `{"requested_mode":"new_season"}`, SnapshotJSON: string(mustJSON(testSnapshot(t))), GenerateStatus: "queued", EvaluateStatus: "pending"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.Claim(ctx, claimRequest{SnapshotExecutionID: inputID, AgentVersion: h.version, WorkerID: "legacy-worker", ClaimRequestID: uuid.NewString()}); err != nil {
		t.Fatal(err)
	}
	result := h.worker(http.MethodPost, internalPrefix+"/executions/"+inputID+"/result", submitRequest{PlanEvalWorkerLease: storage.PlanEvalWorkerLease{AgentVersion: h.version, WorkerID: "legacy-worker", LeaseEpoch: 1}, SubmitID: uuid.NewString(), Result: reportedResult{Kind: "failed", Error: &reportedError{Code: "genuine_error", Message: "retained"}}})
	if result.status != 200 {
		t.Fatalf("terminal error submit: %d", result.status)
	}
	if _, err := h.svc.store.SetPlanEvalReplicas(ctx, h.version, 5); err != nil {
		t.Fatal(err)
	}
	ordinary, e := h.svc.TaskDetail(ctx, task.ID)
	if e != nil || ordinary.Replicas != 2 {
		t.Fatalf("ordinary legacy compatibility: %v", e)
	}
	// Exercise the same report-only view path with absent historical metadata.
	legacy := *task
	legacy.LaunchEnvNames, legacy.LaunchReplicas = "", 0
	frozen, frozenErr := h.svc.taskViewsWithLaunch(ctx, []storage.PlanEvalTask{legacy}, false)
	if frozenErr != nil || frozen[0].Replicas != 0 || len(frozen[0].EnvNames) != 0 {
		t.Fatal("legacy report inferred live configuration")
	}
	live, liveErr := h.svc.taskViews(ctx, []storage.PlanEvalTask{legacy})
	if liveErr != nil || live[0].Replicas != 5 {
		t.Fatal("ordinary legacy fallback changed")
	}
	file, cleanup, e := h.svc.TaskReport(ctx, task.ID)
	if e != nil {
		t.Fatal(e)
	}
	name := file.Name()
	t.Cleanup(cleanup)
	if len(h.svc.reportSlot) != 1 {
		t.Fatal("slot released before download")
	}
	blocked, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
	defer cancel()
	if _, _, err := h.svc.TaskReport(blocked, task.ID); err == nil {
		t.Fatal("concurrent download did not remain bounded/cancellable")
	}
	raw, err := io.ReadAll(file)
	if err != nil {
		t.Fatal(err)
	}
	cleanup()
	cleanup() // callers may cancel and defer cleanup; it is idempotent.
	if len(h.svc.reportSlot) != 0 {
		t.Fatal("download slot not released")
	}
	if _, err := os.Stat(name); !os.IsNotExist(err) {
		t.Fatal("private temp report not removed")
	}
	var report TaskReportView
	if err := json.Unmarshal(raw, &report); err != nil {
		t.Fatal(err)
	}
	if report.Replicas != 2 || len(report.EnvNames) != 0 || report.Result != "error" {
		t.Fatal("legacy report used live launch data or hid terminal error")
	}
	config, configErr := h.svc.store.BeginPlanEvalCleanup(ctx, h.version)
	if configErr != nil {
		t.Fatal(configErr)
	}
	if err := h.svc.store.FinishPlanEvalCleanup(ctx, config); err != nil {
		t.Fatal(err)
	}
	_, _, err = h.svc.store.CreatePlanEvalTask(ctx, &storage.PlanEvalTaskCreate{
		Task:         &storage.PlanEvalTask{ID: uuid.NewString(), AgentVersion: h.version, ScenarioID: "reuse", Submitter: "reuse", IdempotencyKey: uuid.NewString(), ParamsFingerprint: "reuse"},
		LaunchConfig: &storage.PlanEvalLaunchConfig{ID: uuid.NewString(), AgentVersion: h.version, Replicas: 7, EnvNames: `["NEW_ENV"]`, EnvFingerprint: "reuse"}, EnvCipher: []byte("reuse"),
		Executions: []*storage.PlanEvalExecution{{ID: uuid.NewString(), ScenarioID: "reuse", SnapshotID: "reuse", GenerateStatus: "queued", EvaluateStatus: "pending"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	after, cleanup, e := h.svc.TaskReport(ctx, task.ID)
	if e != nil {
		t.Fatal(e)
	}
	defer cleanup()
	reread, err := io.ReadAll(after)
	if err != nil || !bytes.Equal(raw, reread) {
		t.Fatal("report changed after cleanup/reuse")
	}
	cleanup()
	t.Setenv("TMPDIR", filepath.Join(t.TempDir(), "missing"))
	failed := h.admin(http.MethodGet, adminPrefix+"/tasks/"+task.ID+"/report", nil, nil)
	if failed.status != 500 || failed.header.Get("Content-Disposition") != "" || !bytes.Contains(failed.body, []byte("internal_error")) {
		t.Fatal("spool failure sent successful report headers")
	}
	if len(h.svc.reportSlot) != 0 {
		t.Fatal("failed spool leaked slot")
	}
}

func TestCatalogValidationAndAuthRejectBeforeWrites(t *testing.T) {
	h := openHarness(t)
	ctx := context.Background()
	beforeSnapshots, err := h.svc.store.ListPlanEvalSnapshots(ctx)
	if err != nil {
		t.Fatal(err)
	}
	invalid := testSnapshot(t)
	invalid["as_of"] = "2026-10-27T00:00:00+08:00"
	invalid["as_of_day"] = "2026-10-26"
	rejected := h.admin(http.MethodPost, adminPrefix+"/snapshots", invalid, nil)
	if rejected.status != 422 || !bytes.Contains(rejected.body, []byte("invalid_input")) {
		t.Fatalf("validation rejection: %d", rejected.status)
	}
	denied := h.call(http.MethodPost, adminPrefix+"/snapshots", testSnapshot(t), nil)
	if denied.status != 401 {
		t.Fatalf("auth: %d", denied.status)
	}
	afterSnapshots, err := h.svc.store.ListPlanEvalSnapshots(ctx)
	if err != nil || len(afterSnapshots) != len(beforeSnapshots) {
		t.Fatal("definitive snapshot rejection wrote data")
	}
	beforeScenarios, err := h.svc.store.ListPlanEvalScenarios(ctx)
	if err != nil {
		t.Fatal(err)
	}
	rejected = h.admin(http.MethodPost, adminPrefix+"/scenarios", ScenarioView{Name: "rejected", ArtifactType: "master_plan", SnapshotIDs: []string{"missing"}}, nil)
	if rejected.status != 422 || !bytes.Contains(rejected.body, []byte("invalid_reference")) {
		t.Fatalf("scene validation rejection: %d", rejected.status)
	}
	afterScenarios, err := h.svc.store.ListPlanEvalScenarios(ctx)
	if err != nil || len(afterScenarios) != len(beforeScenarios) {
		t.Fatal("definitive scenario rejection wrote data")
	}
}
