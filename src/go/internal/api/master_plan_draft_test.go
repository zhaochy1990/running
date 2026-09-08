package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/storage"
)

func mustDraftInsertBody(t *testing.T, draftID, goalID string) map[string]any {
	t.Helper()
	content := mustAppliedContent(t, goalID)
	return map[string]any{"draft_id": draftID, "content": content}
}

func doJSON(t *testing.T, h *mpHarness, method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body == "" {
		reader = bytes.NewReader(nil)
	} else {
		reader = bytes.NewReader([]byte(body))
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.svc.Router().ServeHTTP(w, req)
	return w
}

func internalHeaders() map[string]string {
	return map[string]string{"X-Internal-Token": testToken}
}

func TestMasterPlanDraftInsertRequiresInternalToken(t *testing.T) {
	h := newMPHarness(t)
	userID, goalID, draftID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	body := map[string]any{"draft_id": draftID, "content": mustAppliedContent(t, goalID)}
	raw, _ := json.Marshal(body)

	// User JWT is forbidden.
	user := h.bearer(t, userID)
	w := doJSON(t, h, "POST", "/api/users/"+userID+"/master-plan/drafts", string(raw), user)
	if w.Code != http.StatusForbidden {
		t.Fatalf("user insert code = %d, want 403 (%s)", w.Code, w.Body.String())
	}
	// Internal token succeeds.
	w = doJSON(t, h, "POST", "/api/users/"+userID+"/master-plan/drafts", string(raw), internalHeaders())
	if w.Code != http.StatusCreated {
		t.Fatalf("internal insert code = %d, want 201 (%s)", w.Code, w.Body.String())
	}
	var resp draftIDResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !resp.Success || resp.PlanID != draftID || resp.Status != storage.MasterPlanStatusDraft {
		t.Fatalf("unexpected response: %+v", resp)
	}

	// Idempotent replay returns 200 (not 201).
	w2 := doJSON(t, h, "POST", "/api/users/"+userID+"/master-plan/drafts", string(raw), internalHeaders())
	if w2.Code != http.StatusOK {
		t.Fatalf("replay code = %d, want 200 (%s)", w2.Code, w2.Body.String())
	}
}

func TestMasterPlanDraftLifecycle(t *testing.T) {
	h := newMPHarness(t)
	userID, goalID := uuid.NewString(), uuid.NewString()
	user := h.bearer(t, userID)
	base := "/api/users/" + userID + "/master-plan/drafts"

	// Insert two drafts as internal token.
	draftIDs := []string{uuid.NewString(), uuid.NewString()}
	for _, id := range draftIDs {
		raw, _ := json.Marshal(map[string]any{"draft_id": id, "content": mustAppliedContent(t, goalID)})
		w := doJSON(t, h, "POST", base, string(raw), internalHeaders())
		if w.Code != http.StatusCreated {
			t.Fatalf("insert %s code = %d (%s)", id, w.Code, w.Body.String())
		}
	}

	// Read the second draft as the user.
	w := doJSON(t, h, "GET", base+"/"+draftIDs[1], "", user)
	if w.Code != http.StatusOK {
		t.Fatalf("get draft code = %d (%s)", w.Code, w.Body.String())
	}
	var draftResp masterPlanDraftResponse
	if err := json.Unmarshal(w.Body.Bytes(), &draftResp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if draftResp.PlanID != draftIDs[1] || draftResp.Status != storage.MasterPlanStatusDraft {
		t.Fatalf("draft = %+v", draftResp)
	}

	// Activate the second draft as the user.
	w = doJSON(t, h, "POST", base+"/"+draftIDs[1]+"/activate", "", user)
	if w.Code != http.StatusOK {
		t.Fatalf("activate code = %d (%s)", w.Code, w.Body.String())
	}
	var activateResp activateMasterPlanDraftResponse
	if err := json.Unmarshal(w.Body.Bytes(), &activateResp); err != nil {
		t.Fatalf("unmarshal activate: %v", err)
	}
	if !activateResp.Success || activateResp.Plan.PlanID != draftIDs[1] {
		t.Fatalf("activate response = %+v", activateResp)
	}

	// The sibling draft remains draft.
	w = doJSON(t, h, "GET", base+"/"+draftIDs[0], "", user)
	if w.Code != http.StatusOK {
		t.Fatalf("get sibling code = %d (%s)", w.Code, w.Body.String())
	}
	var sibling masterPlanDraftResponse
	if err := json.Unmarshal(w.Body.Bytes(), &sibling); err != nil {
		t.Fatalf("unmarshal sibling: %v", err)
	}
	if sibling.Status != storage.MasterPlanStatusDraft {
		t.Fatalf("sibling status = %s, want draft", sibling.Status)
	}

	// Abandon the first draft.
	w = doJSON(t, h, "POST", base+"/"+draftIDs[0]+"/abandon", "", user)
	if w.Code != http.StatusOK {
		t.Fatalf("abandon code = %d (%s)", w.Code, w.Body.String())
	}
	// It no longer resolves as a draft.
	w = doJSON(t, h, "GET", base+"/"+draftIDs[0], "", user)
	if w.Code != http.StatusNotFound {
		t.Fatalf("get abandoned code = %d, want 404 (%s)", w.Code, w.Body.String())
	}
}

func TestMasterPlanDraftInsertRejectsInvalidContent(t *testing.T) {
	h := newMPHarness(t)
	userID := uuid.NewString()
	raw, _ := json.Marshal(map[string]any{"draft_id": uuid.NewString(), "content": map[string]any{}})
	w := doJSON(t, h, "POST", "/api/users/"+userID+"/master-plan/drafts", string(raw), internalHeaders())
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("code = %d, want 422 (%s)", w.Code, w.Body.String())
	}
}

func TestMasterPlanDraftActivateNotFound(t *testing.T) {
	h := newMPHarness(t)
	userID := uuid.NewString()
	w := doJSON(t, h, "POST", "/api/users/"+userID+"/master-plan/drafts/"+uuid.NewString()+"/activate", "", h.bearer(t, userID))
	if w.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404 (%s)", w.Code, w.Body.String())
	}
}
