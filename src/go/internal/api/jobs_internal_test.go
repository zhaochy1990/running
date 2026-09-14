package api

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/job"
)

// --- internal create ---------------------------------------------------------

func TestCreateInternalJobPersistsWithoutPublishing(t *testing.T) {
	h := newHarness(t)
	body := `{"job_id":"11111111-1111-4111-8111-111111111111","user_id":"u-1","job_type":"generate_weekly_plan","input_json":"{\"request_id\":\"r\"}","idempotency_key":"idem-1"}`

	resp := h.do(http.MethodPost, "/api/internal/jobs", body, internalHdr())
	if resp.Code != http.StatusCreated {
		t.Fatalf("create code = %d (%s)", resp.Code, resp.Body.String())
	}
	var out createInternalJobResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !out.Created || out.JobID != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("response = %+v", out)
	}

	// Idempotent replay returns the existing row with created=false.
	resp = h.do(http.MethodPost, "/api/internal/jobs", body, internalHdr())
	if resp.Code != http.StatusOK {
		t.Fatalf("replay code = %d (%s)", resp.Code, resp.Body.String())
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal replay: %v", err)
	}
	if out.Created || out.JobID != "11111111-1111-4111-8111-111111111111" {
		t.Fatalf("replay response = %+v", out)
	}
}

func TestCreateInternalJobRequiresInternalTier(t *testing.T) {
	h := newPipelineAdminHarness(t)
	body := `{"job_id":"11111111-1111-4111-8111-111111111111","user_id":"u-1","job_type":"generate_weekly_plan"}`

	if resp := h.do(http.MethodPost, "/api/internal/jobs", body, h.bearerWithClaims(t, "u-1", testAudience, "")); resp.Code != http.StatusForbidden {
		t.Fatalf("user create code = %d, want 403 (%s)", resp.Code, resp.Body.String())
	}
	admin := h.bearerWithClaims(t, "admin-1", testAdminAudience, "admin")
	if resp := h.do(http.MethodPost, "/api/internal/jobs", body, admin); resp.Code != http.StatusForbidden {
		t.Fatalf("admin create code = %d, want 403 (%s)", resp.Code, resp.Body.String())
	}
}

// --- internal get ------------------------------------------------------------

func TestGetInternalJobReturnsFullRow(t *testing.T) {
	h := newHarness(t)
	created := `{"job_id":"22222222-2222-4222-8222-222222222222","user_id":"u-1","job_type":"generate_master_plan","input_json":"{\"mode\":\"new_season\"}"}`
	if resp := h.do(http.MethodPost, "/api/internal/jobs", created, internalHdr()); resp.Code != http.StatusCreated {
		t.Fatalf("create code = %d (%s)", resp.Code, resp.Body.String())
	}

	resp := h.do(http.MethodGet, "/api/internal/jobs/22222222-2222-4222-8222-222222222222", "", internalHdr())
	if resp.Code != http.StatusOK {
		t.Fatalf("get code = %d (%s)", resp.Code, resp.Body.String())
	}
	var out jobStateResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.JobType != "generate_master_plan" || out.InputJSON != `{"mode":"new_season"}` || out.Status != "queued" {
		t.Fatalf("job = %+v", out)
	}

	if resp := h.do(http.MethodGet, "/api/internal/jobs/does-not-exist", "", internalHdr()); resp.Code != http.StatusNotFound {
		t.Fatalf("missing get code = %d, want 404", resp.Code)
	}
}

// --- transition ---------------------------------------------------------------

func TestTransitionJobClaimThenDone(t *testing.T) {
	h := newHarness(t)
	id := "33333333-3333-4333-8333-333333333333"
	created := `{"job_id":"` + id + `","user_id":"u-1","job_type":"generate_weekly_plan"}`
	if resp := h.do(http.MethodPost, "/api/internal/jobs", created, internalHdr()); resp.Code != http.StatusCreated {
		t.Fatalf("create code = %d (%s)", resp.Code, resp.Body.String())
	}

	// Claim: queued -> running with the From guard.
	claim := `{"from":"queued","to":"running","attempts":1,"stage":"planning","progress_pct":10,"heartbeat_at":"2026-09-14T01:00:00Z"}`
	resp := h.do(http.MethodPost, "/api/internal/jobs/"+id+"/transition", claim, internalHdr())
	if resp.Code != http.StatusOK {
		t.Fatalf("claim code = %d (%s)", resp.Code, resp.Body.String())
	}
	var out jobStateResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Status != "running" || out.Attempts != 1 || out.Stage != "planning" || out.ProgressPct != 10 {
		t.Fatalf("claimed = %+v", out)
	}

	// A second claim from queued fails the CAS guard -> 409.
	resp = h.do(http.MethodPost, "/api/internal/jobs/"+id+"/transition", claim, internalHdr())
	if resp.Code != http.StatusConflict {
		t.Fatalf("re-claim code = %d, want 409 (%s)", resp.Code, resp.Body.String())
	}

	// Done stamps completed_at even when the caller omits it.
	done := `{"from":"running","to":"done","progress_pct":100,"stage":"outputting","result_json":"{\"draft_id\":\"d-1\"}"}`
	resp = h.do(http.MethodPost, "/api/internal/jobs/"+id+"/transition", done, internalHdr())
	if resp.Code != http.StatusOK {
		t.Fatalf("done code = %d (%s)", resp.Code, resp.Body.String())
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal done: %v", err)
	}
	if out.Status != "done" || out.CompletedAt == nil || out.ResultJSON != `{"draft_id":"d-1"}` {
		t.Fatalf("done = %+v", out)
	}
}

// TestTransitionJobAttemptsDeltaAndBudgetGuard covers the counter CAS the
// plan-job worker needs: an atomic increment (claim) and the redelivery budget
// guard on the *current* attempts (reclaim).
func TestTransitionJobAttemptsDeltaAndBudgetGuard(t *testing.T) {
	h := newHarness(t)
	id := "44444444-4444-4444-8444-444444444444"
	created := `{"job_id":"` + id + `","user_id":"u-1","job_type":"generate_weekly_plan"}`
	if resp := h.do(http.MethodPost, "/api/internal/jobs", created, internalHdr()); resp.Code != http.StatusCreated {
		t.Fatalf("create code = %d (%s)", resp.Code, resp.Body.String())
	}

	// Claim: queued -> running, attempts incremented atomically and errors cleared.
	stale := `{"from":"queued","to":"failed","error_code":"old"}`
	if resp := h.do(http.MethodPost, "/api/internal/jobs/"+id+"/transition", stale, internalHdr()); resp.Code != http.StatusOK {
		t.Fatalf("seed stale code = %d (%s)", resp.Code, resp.Body.String())
	}
	reclaimSeed := `{"from":"failed","to":"queued","error_code":"retryable","error_message":"boom"}`
	if resp := h.do(http.MethodPost, "/api/internal/jobs/"+id+"/transition", reclaimSeed, internalHdr()); resp.Code != http.StatusOK {
		t.Fatalf("seed queued code = %d (%s)", resp.Code, resp.Body.String())
	}

	claim := `{"from":"queued","to":"running","attempts_delta":1,"clear_error":true}`
	var out jobStateResponse
	resp := h.do(http.MethodPost, "/api/internal/jobs/"+id+"/transition", claim, internalHdr())
	if resp.Code != http.StatusOK {
		t.Fatalf("claim code = %d (%s)", resp.Code, resp.Body.String())
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Attempts != 1 || out.ErrorCode != "" || out.ErrorMessage != "" {
		t.Fatalf("claim = %+v, want attempts=1 and cleared error", out)
	}

	// A second increment takes it to 2.
	resp = h.do(http.MethodPost, "/api/internal/jobs/"+id+"/transition", claim, internalHdr())
	if resp.Code != http.StatusConflict {
		t.Fatalf("re-claim code = %d, want 409 (from=queued no longer matches)", resp.Code)
	}
	bump := `{"from":"running","to":"running","attempts_delta":1}`
	if resp := h.do(http.MethodPost, "/api/internal/jobs/"+id+"/transition", bump, internalHdr()); resp.Code != http.StatusOK {
		t.Fatalf("bump code = %d (%s)", resp.Code, resp.Body.String())
	}

	// Budget guard: attempts is 2, so a "below 2" reclaim must fail the CAS while
	// "below 3" succeeds — this is the redelivery bound, checked in SQL.
	guarded := `{"from":"running","to":"running","attempts_delta":1,"attempts_lt":2}`
	if resp := h.do(http.MethodPost, "/api/internal/jobs/"+id+"/transition", guarded, internalHdr()); resp.Code != http.StatusConflict {
		t.Fatalf("exhausted budget code = %d, want 409 (%s)", resp.Code, resp.Body.String())
	}
	withinBudget := `{"from":"running","to":"running","attempts_delta":1,"attempts_lt":3}`
	resp = h.do(http.MethodPost, "/api/internal/jobs/"+id+"/transition", withinBudget, internalHdr())
	if resp.Code != http.StatusOK {
		t.Fatalf("within budget code = %d (%s)", resp.Code, resp.Body.String())
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Attempts != 3 {
		t.Fatalf("attempts = %d, want 3", out.Attempts)
	}
}

func TestTransitionJobUnknownIs404(t *testing.T) {
	h := newHarness(t)
	resp := h.do(http.MethodPost, "/api/internal/jobs/does-not-exist/transition", `{"to":"running"}`, internalHdr())
	if resp.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404 (%s)", resp.Code, resp.Body.String())
	}
}

// --- stale-running reconcile ---------------------------------------------------

func TestFailStaleRunningJobs(t *testing.T) {
	h := newHarness(t)
	now := time.Now().UTC()

	stale := &job.Job{ID: "stale", UserID: "u-1", Type: "generate_weekly_plan", Status: job.StatusRunning, HeartbeatAt: ptrTime(now.Add(-10 * time.Minute))}
	fresh := &job.Job{ID: "fresh", UserID: "u-1", Type: "generate_weekly_plan", Status: job.StatusRunning, HeartbeatAt: ptrTime(now.Add(-1 * time.Minute))}
	if err := h.jobs.Create(t.Context(), stale); err != nil {
		t.Fatalf("seed stale: %v", err)
	}
	if err := h.jobs.Create(t.Context(), fresh); err != nil {
		t.Fatalf("seed fresh: %v", err)
	}

	body := `{"older_than":"` + now.Add(-2*time.Minute).Format(time.RFC3339) + `","error_code":"stale_running"}`
	resp := h.do(http.MethodPost, "/api/internal/jobs/stale-running", body, internalHdr())
	if resp.Code != http.StatusOK {
		t.Fatalf("reconcile code = %d (%s)", resp.Code, resp.Body.String())
	}
	var out struct {
		Failed int64 `json:"failed"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Failed != 1 {
		t.Fatalf("failed = %d, want 1", out.Failed)
	}

	staleAfter, _ := h.jobs.Get(t.Context(), "stale")
	if staleAfter == nil || staleAfter.Status != job.StatusFailed || staleAfter.ErrorCode != "stale_running" {
		t.Fatalf("stale after = %+v", staleAfter)
	}
	freshAfter, _ := h.jobs.Get(t.Context(), "fresh")
	if freshAfter == nil || freshAfter.Status != job.StatusRunning {
		t.Fatalf("fresh after = %+v", freshAfter)
	}
}

// --- unified admin async list ---------------------------------------------------

func TestListAdminAsyncRunsMergesPipelinesAndJobs(t *testing.T) {
	h := newPipelineAdminHarness(t)

	h.jobs.Create(t.Context(), &job.Job{
		ID: "plan-job-1", UserID: "u-1", Type: "generate_weekly_plan", Status: job.StatusRunning,
		Stage: "evaluating", ProgressPct: 25, CreatedAt: time.Now().Add(-1 * time.Minute), UpdatedAt: time.Now().Add(-1 * time.Minute),
	})
	h.runs.seedRun(&job.PipelineRun{
		RunID: "run-1", UserID: "u-1", Name: "onboarding", Status: job.StatusDone,
		CreatedAt: time.Now().Add(-2 * time.Minute), UpdatedAt: time.Now().Add(-2 * time.Minute), CompletedAt: ptrTime(time.Now().Add(-2 * time.Minute)),
	})

	admin := h.bearerWithClaims(t, "admin-1", testAdminAudience, "admin")
	resp := h.do(http.MethodGet, "/api/admin/async-runs?limit=10", "", admin)
	if resp.Code != http.StatusOK {
		t.Fatalf("list code = %d (%s)", resp.Code, resp.Body.String())
	}
	var out asyncRunsAdminResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if out.Total != 2 || len(out.Runs) != 2 {
		t.Fatalf("runs = %+v", out)
	}
	// Newest first: the plan job (created 1m ago) before the pipeline run (2m).
	if out.Runs[0].Kind != "job" || out.Runs[0].Name != "generate_weekly_plan" || out.Runs[0].Stage != "evaluating" {
		t.Fatalf("first run = %+v", out.Runs[0])
	}
	if out.Runs[1].Kind != "pipeline" || out.Runs[1].Name != "onboarding" || out.Runs[1].CurrentStep != 0 {
		t.Fatalf("second run = %+v", out.Runs[1])
	}

	// Filter by name narrows to the plan job only.
	resp = h.do(http.MethodGet, "/api/admin/async-runs?name=generate_weekly_plan", "", admin)
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal filtered: %v", err)
	}
	if out.Total != 1 || len(out.Runs) != 1 || out.Runs[0].Kind != "job" {
		t.Fatalf("filtered = %+v", out)
	}

	// Internal token allowed; user JWT denied.
	if resp := h.do(http.MethodGet, "/api/admin/async-runs", "", internalHdr()); resp.Code != http.StatusOK {
		t.Fatalf("internal list code = %d, want 200", resp.Code)
	}
	if resp := h.do(http.MethodGet, "/api/admin/async-runs", "", h.bearerWithClaims(t, "u-1", testAudience, "")); resp.Code != http.StatusForbidden {
		t.Fatalf("user list code = %d, want 403", resp.Code)
	}
}

func ptrTime(v time.Time) *time.Time { return &v }
