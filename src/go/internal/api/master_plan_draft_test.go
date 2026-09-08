package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/storage"
)

func internalHeaders() map[string]string {
	return map[string]string{"X-Internal-Token": testToken}
}

// postJSON issues a JSON-bodied request on the master-plan harness. A nil body
// sends no request body (the plain h.do call covers GET/activate/abandon).
func (h *mpHarness) postJSON(method, path string, body any, headers map[string]string) *httptest.ResponseRecorder {
	raw, _ := json.Marshal(body)
	return h.doBody(method, path, headers, strings.NewReader(string(raw)))
}

func TestMasterPlanDraftInsertRequiresInternalToken(t *testing.T) {
	h := newMPHarness(t)
	userID, goalID, draftID := uuid.NewString(), uuid.NewString(), uuid.NewString()
	payload := map[string]any{"draft_id": draftID, "content": mustAppliedContent(t, goalID)}

	// User JWT is forbidden.
	w := h.postJSON(http.MethodPost, "/api/users/"+userID+"/master-plan/drafts", payload, h.bearer(t, userID))
	if w.Code != http.StatusForbidden {
		t.Fatalf("user insert code = %d, want 403 (%s)", w.Code, w.Body.String())
	}
	// Internal token succeeds.
	w = h.postJSON(http.MethodPost, "/api/users/"+userID+"/master-plan/drafts", payload, internalHeaders())
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
	w = h.postJSON(http.MethodPost, "/api/users/"+userID+"/master-plan/drafts", payload, internalHeaders())
	if w.Code != http.StatusOK {
		t.Fatalf("replay code = %d, want 200 (%s)", w.Code, w.Body.String())
	}
}

func TestMasterPlanDraftLifecycle(t *testing.T) {
	h := newMPHarness(t)
	userID, goalID := uuid.NewString(), uuid.NewString()
	base := "/api/users/" + userID + "/master-plan/drafts"

	draftIDs := []string{uuid.NewString(), uuid.NewString()}
	for _, id := range draftIDs {
		w := h.postJSON(http.MethodPost, base, map[string]any{"draft_id": id, "content": mustAppliedContent(t, goalID)}, internalHeaders())
		if w.Code != http.StatusCreated {
			t.Fatalf("insert %s code = %d (%s)", id, w.Code, w.Body.String())
		}
	}

	// Read the second draft as the user.
	w := h.do(http.MethodGet, base+"/"+draftIDs[1], h.bearer(t, userID))
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
	w = h.do(http.MethodPost, base+"/"+draftIDs[1]+"/activate", h.bearer(t, userID))
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
	w = h.do(http.MethodGet, base+"/"+draftIDs[0], h.bearer(t, userID))
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
	w = h.do(http.MethodPost, base+"/"+draftIDs[0]+"/abandon", h.bearer(t, userID))
	if w.Code != http.StatusOK {
		t.Fatalf("abandon code = %d (%s)", w.Code, w.Body.String())
	}
	w = h.do(http.MethodGet, base+"/"+draftIDs[0], h.bearer(t, userID))
	if w.Code != http.StatusNotFound {
		t.Fatalf("get abandoned code = %d, want 404 (%s)", w.Code, w.Body.String())
	}
}

func TestMasterPlanDraftInsertRejectsInvalidContent(t *testing.T) {
	h := newMPHarness(t)
	userID := uuid.NewString()
	w := h.postJSON(http.MethodPost, "/api/users/"+userID+"/master-plan/drafts",
		map[string]any{"draft_id": uuid.NewString(), "content": map[string]any{}}, internalHeaders())
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("code = %d, want 422 (%s)", w.Code, w.Body.String())
	}
}

func TestMasterPlanDraftActivateNotFound(t *testing.T) {
	h := newMPHarness(t)
	userID := uuid.NewString()
	w := h.do(http.MethodPost, "/api/users/"+userID+"/master-plan/drafts/"+uuid.NewString()+"/activate", h.bearer(t, userID))
	if w.Code != http.StatusNotFound {
		t.Fatalf("code = %d, want 404 (%s)", w.Code, w.Body.String())
	}
}

func TestMasterPlanDraftAdminCannotMutate(t *testing.T) {
	h := newMPHarness(t)
	userID, goalID := uuid.NewString(), uuid.NewString()
	draftID := uuid.NewString()
	w := h.postJSON(http.MethodPost, "/api/users/"+userID+"/master-plan/drafts",
		map[string]any{"draft_id": draftID, "content": mustAppliedContent(t, goalID)}, internalHeaders())
	if w.Code != http.StatusCreated {
		t.Fatalf("insert code = %d (%s)", w.Code, w.Body.String())
	}
	admin := h.bearerWithClaims(t, uuid.NewString(), testAdminAudience, "admin")
	w = h.do(http.MethodPost, "/api/users/"+userID+"/master-plan/drafts/"+draftID+"/activate", admin)
	if w.Code != http.StatusForbidden {
		t.Fatalf("admin activate code = %d, want 403 (%s)", w.Code, w.Body.String())
	}
}
