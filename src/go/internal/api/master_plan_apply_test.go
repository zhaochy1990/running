package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
)

func mustAppliedContent(t *testing.T, goalID string) map[string]any {
	t.Helper()
	var content map[string]any
	if err := json.Unmarshal([]byte(samplePlanJSON), &content); err != nil {
		t.Fatalf("unmarshal sample plan: %v", err)
	}
	content["plan_id"] = uuid.NewString()
	if goal, ok := content["goal"].(map[string]any); ok {
		goal["goal_id"] = goalID
	}
	return content
}

func doApply(t *testing.T, h *mpHarness, headers map[string]string, userID string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/users/"+userID+"/master-plans", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.svc.Router().ServeHTTP(w, req)
	return w
}

func applyRequestBody(content map[string]any, replace bool, planID *string, revision *int64) map[string]any {
	body := map[string]any{"content": content, "replace_existing": replace}
	if planID != nil {
		body["expected_active_plan_id"] = *planID
	}
	if revision != nil {
		body["expected_active_revision"] = *revision
	}
	return body
}

func TestApplyMasterPlanHandler(t *testing.T) {
	h := newMPHarness(t)
	admin := h.bearerWithClaims(t, uuid.NewString(), testAdminAudience, "admin")

	t.Run("apply new plan", func(t *testing.T) {
		userID, goalID := uuid.NewString(), uuid.NewString()
		w := doApply(t, h, admin, userID, applyRequestBody(mustAppliedContent(t, goalID), false, nil, nil))
		if w.Code != http.StatusCreated {
			t.Fatalf("code = %d, want 201 (%s)", w.Code, w.Body.String())
		}
		var resp applyMasterPlanResponse
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if !resp.Success || resp.Plan.PlanID == "" {
			t.Fatalf("unexpected response: %+v", resp)
		}
		if resp.ReplacedPlanID != nil {
			t.Fatalf("first apply must not replace anything, got %v", *resp.ReplacedPlanID)
		}
		active, err := h.store.GetCurrentMasterPlan(t.Context(), userID)
		if err != nil || active == nil || active.PlanID != resp.Plan.PlanID {
			t.Fatalf("stored active plan = %+v, err=%v", active, err)
		}
	})

	t.Run("replace active plan", func(t *testing.T) {
		userID, goalID := uuid.NewString(), uuid.NewString()
		first := doApply(t, h, admin, userID, applyRequestBody(mustAppliedContent(t, goalID), false, nil, nil))
		if first.Code != http.StatusCreated {
			t.Fatalf("first code = %d (%s)", first.Code, first.Body.String())
		}
		var firstResp applyMasterPlanResponse
		if err := json.Unmarshal(first.Body.Bytes(), &firstResp); err != nil {
			t.Fatalf("unmarshal first: %v", err)
		}

		revision := int64(1)
		w := doApply(t, h, admin, userID, applyRequestBody(mustAppliedContent(t, goalID), true, &firstResp.Plan.PlanID, &revision))
		if w.Code != http.StatusCreated {
			t.Fatalf("code = %d, want 201 (%s)", w.Code, w.Body.String())
		}
		var resp applyMasterPlanResponse
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if resp.ReplacedPlanID == nil || *resp.ReplacedPlanID != firstResp.Plan.PlanID {
			t.Fatalf("replaced_plan_id = %v, want %s", resp.ReplacedPlanID, firstResp.Plan.PlanID)
		}
		active, err := h.store.GetCurrentMasterPlan(t.Context(), userID)
		if err != nil || active == nil || active.PlanID != resp.Plan.PlanID {
			t.Fatalf("stored active plan = %+v, err=%v", active, err)
		}
	})

	t.Run("invalid user id", func(t *testing.T) {
		goalID := uuid.NewString()
		w := doApply(t, h, admin, "not-a-uuid", applyRequestBody(mustAppliedContent(t, goalID), false, nil, nil))
		if w.Code != http.StatusBadRequest {
			t.Fatalf("code = %d, want 400 (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("missing content", func(t *testing.T) {
		userID := uuid.NewString()
		w := doApply(t, h, admin, userID, map[string]any{"replace_existing": false})
		if w.Code != http.StatusUnprocessableEntity {
			t.Fatalf("code = %d, want 422 (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("incomplete replacement", func(t *testing.T) {
		userID, goalID := uuid.NewString(), uuid.NewString()
		w := doApply(t, h, admin, userID, applyRequestBody(mustAppliedContent(t, goalID), true, nil, nil))
		if w.Code != http.StatusUnprocessableEntity {
			t.Fatalf("code = %d, want 422 (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("invalid goal", func(t *testing.T) {
		userID := uuid.NewString()
		content := mustAppliedContent(t, uuid.NewString())
		if goal, ok := content["goal"].(map[string]any); ok {
			goal["goal_id"] = "not-a-uuid"
		}
		w := doApply(t, h, admin, userID, applyRequestBody(content, false, nil, nil))
		if w.Code != http.StatusUnprocessableEntity {
			t.Fatalf("code = %d, want 422 (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("exists without replacement", func(t *testing.T) {
		userID, goalID := uuid.NewString(), uuid.NewString()
		if w := doApply(t, h, admin, userID, applyRequestBody(mustAppliedContent(t, goalID), false, nil, nil)); w.Code != http.StatusCreated {
			t.Fatalf("seed code = %d (%s)", w.Code, w.Body.String())
		}
		w := doApply(t, h, admin, userID, applyRequestBody(mustAppliedContent(t, goalID), false, nil, nil))
		if w.Code != http.StatusConflict {
			t.Fatalf("code = %d, want 409 (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("stale replacement", func(t *testing.T) {
		userID, goalID := uuid.NewString(), uuid.NewString()
		first := doApply(t, h, admin, userID, applyRequestBody(mustAppliedContent(t, goalID), false, nil, nil))
		if first.Code != http.StatusCreated {
			t.Fatalf("seed code = %d (%s)", first.Code, first.Body.String())
		}
		var firstResp applyMasterPlanResponse
		if err := json.Unmarshal(first.Body.Bytes(), &firstResp); err != nil {
			t.Fatalf("unmarshal first: %v", err)
		}
		stale := int64(2)
		w := doApply(t, h, admin, userID, applyRequestBody(mustAppliedContent(t, goalID), true, &firstResp.Plan.PlanID, &stale))
		if w.Code != http.StatusConflict {
			t.Fatalf("code = %d, want 409 (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("user applies own plan", func(t *testing.T) {
		userID, goalID := uuid.NewString(), uuid.NewString()
		w := doApply(t, h, h.bearer(t, userID), userID, applyRequestBody(mustAppliedContent(t, goalID), false, nil, nil))
		if w.Code != http.StatusCreated {
			t.Fatalf("code = %d, want 201 (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("user cannot apply another user", func(t *testing.T) {
		userID, otherID, goalID := uuid.NewString(), uuid.NewString(), uuid.NewString()
		w := doApply(t, h, h.bearer(t, userID), otherID, applyRequestBody(mustAppliedContent(t, goalID), false, nil, nil))
		if w.Code != http.StatusForbidden {
			t.Fatalf("code = %d, want 403 (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("internal tier forbidden", func(t *testing.T) {
		userID, goalID := uuid.NewString(), uuid.NewString()
		w := doApply(t, h, internalHdr(), userID, applyRequestBody(mustAppliedContent(t, goalID), false, nil, nil))
		if w.Code != http.StatusForbidden {
			t.Fatalf("code = %d, want 403 (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("no auth", func(t *testing.T) {
		userID, goalID := uuid.NewString(), uuid.NewString()
		w := doApply(t, h, nil, userID, applyRequestBody(mustAppliedContent(t, goalID), false, nil, nil))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("code = %d, want 401 (%s)", w.Code, w.Body.String())
		}
	})
}
