package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/storage"
)

func doUpdate(t *testing.T, h *mpHarness, headers map[string]string, userID string, body map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	req := httptest.NewRequest(http.MethodPatch, "/api/users/"+userID+"/master-plan", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.svc.Router().ServeHTTP(w, req)
	return w
}

func updateRequestBody(content map[string]any, planID *string, revision *int64) map[string]any {
	body := map[string]any{"content": content}
	if planID != nil {
		body["expected_active_plan_id"] = *planID
	}
	if revision != nil {
		body["expected_active_revision"] = *revision
	}
	return body
}

func TestUpdateMasterPlanHandler(t *testing.T) {
	h := newMPHarness(t)
	admin := h.bearerWithClaims(t, uuid.NewString(), testAdminAudience, "admin")

	seedActive := func(t *testing.T, userID, goalID string) applyMasterPlanResponse {
		t.Helper()
		w := doApply(t, h, admin, userID, applyRequestBody(mustAppliedContent(t, goalID), false, nil, nil))
		if w.Code != http.StatusCreated {
			t.Fatalf("seed code = %d (%s)", w.Code, w.Body.String())
		}
		var resp applyMasterPlanResponse
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("unmarshal seed: %v", err)
		}
		return resp
	}

	t.Run("updates in place with revision bump", func(t *testing.T) {
		userID, goalID := uuid.NewString(), uuid.NewString()
		seeded := seedActive(t, userID, goalID)
		rev := int64(1)
		w := doUpdate(t, h, admin, userID, updateRequestBody(mustAppliedContent(t, goalID), &seeded.Plan.PlanID, &rev))
		if w.Code != http.StatusOK {
			t.Fatalf("code = %d, want 200 (%s)", w.Code, w.Body.String())
		}
		var resp updateMasterPlanResponse
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if !resp.Success {
			t.Fatalf("success = false")
		}
		if resp.Plan.PlanID != seeded.Plan.PlanID {
			t.Fatalf("plan_id changed: %s -> %s", seeded.Plan.PlanID, resp.Plan.PlanID)
		}
		if resp.Plan.Revision == nil || *resp.Plan.Revision != 2 {
			t.Fatalf("revision = %v, want 2", resp.Plan.Revision)
		}
		active, err := h.store.GetCurrentMasterPlan(t.Context(), userID)
		if err != nil || active == nil {
			t.Fatalf("stored active = %+v, err=%v", active, err)
		}
		if active.PlanID != seeded.Plan.PlanID || active.Revision == nil || *active.Revision != 2 {
			t.Fatalf("stored active = %+v, want same plan_id at revision 2", active)
		}
	})

	t.Run("stale revision conflicts", func(t *testing.T) {
		userID, goalID := uuid.NewString(), uuid.NewString()
		seeded := seedActive(t, userID, goalID)
		stale := int64(2)
		w := doUpdate(t, h, admin, userID, updateRequestBody(mustAppliedContent(t, goalID), &seeded.Plan.PlanID, &stale))
		if w.Code != http.StatusConflict {
			t.Fatalf("code = %d, want 409 (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("no active plan returns 404", func(t *testing.T) {
		userID, goalID := uuid.NewString(), uuid.NewString()
		planID, rev := uuid.NewString(), int64(1)
		w := doUpdate(t, h, admin, userID, updateRequestBody(mustAppliedContent(t, goalID), &planID, &rev))
		if w.Code != http.StatusNotFound {
			t.Fatalf("code = %d, want 404 (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("markdown active plan conflicts", func(t *testing.T) {
		userID, goalID := uuid.NewString(), uuid.NewString()
		now := time.Now().UTC().Truncate(time.Millisecond)
		legacy := &storage.MasterPlan{
			PlanID: uuid.NewString(), UserID: userID, GoalID: goalID,
			ContentVersion: storage.MasterPlanContentMarkdown, Content: "# legacy plan",
			Status: storage.MasterPlanStatusActive, Revision: nil,
			CreatedAt: now, UpdatedAt: now,
		}
		h.store.current[userID] = legacy
		rev := int64(1)
		w := doUpdate(t, h, admin, userID, updateRequestBody(mustAppliedContent(t, goalID), &legacy.PlanID, &rev))
		if w.Code != http.StatusConflict {
			t.Fatalf("code = %d, want 409 (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("missing expectation is 422", func(t *testing.T) {
		userID, goalID := uuid.NewString(), uuid.NewString()
		w := doUpdate(t, h, admin, userID, updateRequestBody(mustAppliedContent(t, goalID), nil, nil))
		if w.Code != http.StatusUnprocessableEntity {
			t.Fatalf("code = %d, want 422 (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("invalid structure is 422 and writes nothing", func(t *testing.T) {
		userID, goalID := uuid.NewString(), uuid.NewString()
		seeded := seedActive(t, userID, goalID)
		rev := int64(1)
		content := map[string]any{"goal": map[string]any{"goal_id": goalID}}
		w := doUpdate(t, h, admin, userID, updateRequestBody(content, &seeded.Plan.PlanID, &rev))
		if w.Code != http.StatusUnprocessableEntity {
			t.Fatalf("code = %d, want 422 (%s)", w.Code, w.Body.String())
		}
		active, err := h.store.GetCurrentMasterPlan(t.Context(), userID)
		if err != nil || active == nil || active.Revision == nil || *active.Revision != 1 {
			t.Fatalf("active must stay untouched: %+v err=%v", active, err)
		}
	})

	t.Run("user tier forbidden", func(t *testing.T) {
		userID, goalID := uuid.NewString(), uuid.NewString()
		planID, rev := uuid.NewString(), int64(1)
		w := doUpdate(t, h, h.bearer(t, userID), userID, updateRequestBody(mustAppliedContent(t, goalID), &planID, &rev))
		if w.Code != http.StatusForbidden {
			t.Fatalf("code = %d, want 403 (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("internal tier forbidden", func(t *testing.T) {
		userID, goalID := uuid.NewString(), uuid.NewString()
		planID, rev := uuid.NewString(), int64(1)
		w := doUpdate(t, h, internalHdr(), userID, updateRequestBody(mustAppliedContent(t, goalID), &planID, &rev))
		if w.Code != http.StatusForbidden {
			t.Fatalf("code = %d, want 403 (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("no auth", func(t *testing.T) {
		userID, goalID := uuid.NewString(), uuid.NewString()
		planID, rev := uuid.NewString(), int64(1)
		w := doUpdate(t, h, nil, userID, updateRequestBody(mustAppliedContent(t, goalID), &planID, &rev))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("code = %d, want 401 (%s)", w.Code, w.Body.String())
		}
	})

	t.Run("too large", func(t *testing.T) {
		userID, goalID := uuid.NewString(), uuid.NewString()
		planID, rev := uuid.NewString(), int64(1)
		body := updateRequestBody(mustAppliedContent(t, goalID), &planID, &rev)
		body["padding"] = strings.Repeat("x", maxRequestBytes)
		w := doUpdate(t, h, admin, userID, body)
		if w.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("code = %d, want 413 (%s)", w.Code, w.Body.String())
		}
	})
}
