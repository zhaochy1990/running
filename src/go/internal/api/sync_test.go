package api

import (
	"net/http"
	"testing"
)

// startedRun returns the pipeline run the fake recorded for runID.
func (h *harness) startedRun(t *testing.T, runID string) *runView {
	t.Helper()
	r, ok := h.runs.byID[runID]
	if !ok {
		t.Fatalf("no started run for %s", runID)
	}
	return &runView{Name: r.Name, UserID: r.UserID, InputJSON: r.InputJSON}
}

// runView is a tiny view over the started run's fields the sync tests assert on.
type runView struct {
	Name      string
	UserID    string
	InputJSON string
}

func TestSyncUser_Unauthorized(t *testing.T) {
	h := newHarness(t)
	w := h.do(http.MethodPost, "/api/user-1/sync", "", nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("code = %d, want 401", w.Code)
	}
}

func TestSyncUser_User_StartsIncrementalPipelineForOwnID(t *testing.T) {
	h := newHarness(t)
	tok := h.userToken(t, "user-123")
	w := h.do(http.MethodPost, "/api/user-123/sync", "", map[string]string{"Authorization": "Bearer " + tok})
	if w.Code != http.StatusAccepted {
		t.Fatalf("code = %d, want 202: %s", w.Code, w.Body.String())
	}
	var resp startPipelineResponse
	mustJSON(t, w, &resp)
	if resp.RunID == "" {
		t.Fatalf("resp = %+v", resp)
	}
	// Omitted mode -> incremental -> the data_sync pipeline, targeting the caller,
	// with the run input threaded so its steps see the mode.
	if resp.PipelineName != "data_sync" {
		t.Fatalf("pipeline = %q, want data_sync", resp.PipelineName)
	}
	run := h.startedRun(t, resp.RunID)
	if run.Name != "data_sync" || run.UserID != "user-123" || run.InputJSON != `{"mode":"incremental"}` {
		t.Fatalf("run = %+v, want data_sync for user-123 with incremental input", run)
	}
}

func TestSyncUser_User_ForbiddenForOtherID(t *testing.T) {
	h := newHarness(t)
	tok := h.userToken(t, "user-123")
	w := h.do(http.MethodPost, "/api/someone-else/sync", "", map[string]string{"Authorization": "Bearer " + tok})
	if w.Code != http.StatusForbidden {
		t.Fatalf("code = %d, want 403: %s", w.Code, w.Body.String())
	}
}

func TestSyncUser_Internal_AnyUUID(t *testing.T) {
	h := newHarness(t)
	const uid = "11111111-1111-4111-8111-111111111111"
	w := h.do(http.MethodPost, "/api/"+uid+"/sync", "", internalHdr())
	if w.Code != http.StatusAccepted {
		t.Fatalf("code = %d, want 202: %s", w.Code, w.Body.String())
	}
	var resp startPipelineResponse
	mustJSON(t, w, &resp)
	// The run's subject (user_id) is the path user; the response no longer echoes
	// a partition (create responses dropped it).
	if run := h.startedRun(t, resp.RunID); run.UserID != uid {
		t.Fatalf("run user_id = %q, want %q", run.UserID, uid)
	}
}

func TestSyncUser_Internal_NonUUIDRejected(t *testing.T) {
	h := newHarness(t)
	// The internal tier accepts any user, but a non-UUID path segment (which
	// could create a garbage subject) is rejected — mirrors Python's guard.
	w := h.do(http.MethodPost, "/api/not-a-uuid/sync", "", internalHdr())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400: %s", w.Code, w.Body.String())
	}
}

func TestSyncUser_FullStartsOnboardingPipeline(t *testing.T) {
	h := newHarness(t)
	tok := h.userToken(t, "user-123")
	w := h.do(http.MethodPost, "/api/user-123/sync", `{"mode":"full"}`,
		map[string]string{"Authorization": "Bearer " + tok})
	if w.Code != http.StatusAccepted {
		t.Fatalf("code = %d, want 202: %s", w.Code, w.Body.String())
	}
	var resp startPipelineResponse
	mustJSON(t, w, &resp)
	if resp.PipelineName != "onboarding" {
		t.Fatalf("pipeline = %q, want onboarding", resp.PipelineName)
	}
	run := h.startedRun(t, resp.RunID)
	if run.Name != "onboarding" || run.InputJSON != `{"mode":"full"}` {
		t.Fatalf("run = %+v, want onboarding with full input", run)
	}
}

func TestSyncUser_InvalidModeRejected(t *testing.T) {
	h := newHarness(t)
	tok := h.userToken(t, "user-123")
	w := h.do(http.MethodPost, "/api/user-123/sync", `{"mode":"sideways"}`,
		map[string]string{"Authorization": "Bearer " + tok})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400: %s", w.Code, w.Body.String())
	}
}

func TestSyncUser_MalformedBodyRejected(t *testing.T) {
	h := newHarness(t)
	tok := h.userToken(t, "user-123")
	w := h.do(http.MethodPost, "/api/user-123/sync", `{not json`,
		map[string]string{"Authorization": "Bearer " + tok})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("code = %d, want 400: %s", w.Code, w.Body.String())
	}
}
