package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestWeeklyPlanDraftInsertRequiresInternalToken(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	userID := "8f22e4c5-3d6a-4b32-a11e-3c6a9d0b7f11"
	weekName := "2026-08-17_08-23"
	content := validAppliedWeeklyPlan(weekName)
	ins := "{\"draft_id\":\"draft-a\",\"content\":" + content + "}"

	// User JWT is forbidden.
	resp := h.doBody(http.MethodPost, "/api/"+userID+"/plan/weeks/"+weekName+"/drafts", h.bearer(t, userID), strings.NewReader(ins))
	if resp.Code != http.StatusForbidden {
		t.Fatalf("user insert code = %d, want 403 (%s)", resp.Code, resp.Body.String())
	}
	// Internal token succeeds.
	resp = h.doBody(http.MethodPost, "/api/"+userID+"/plan/weeks/"+weekName+"/drafts", internalHeaders(), strings.NewReader(ins))
	if resp.Code != http.StatusCreated {
		t.Fatalf("internal insert code = %d, want 201 (%s)", resp.Code, resp.Body.String())
	}
	var out weeklyDraftIDResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !out.Success || out.PlanID != "draft-a" {
		t.Fatalf("response = %+v", out)
	}
	// Idempotent replay returns 200.
	resp = h.doBody(http.MethodPost, "/api/"+userID+"/plan/weeks/"+weekName+"/drafts", internalHeaders(), strings.NewReader(ins))
	if resp.Code != http.StatusOK {
		t.Fatalf("replay code = %d, want 200 (%s)", resp.Code, resp.Body.String())
	}
}

func TestWeeklyPlanDraftInsertRejectsInvalidContent(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	userID := "8f22e4c5-3d6a-4b32-a11e-3c6a9d0b7f11"
	weekName := "2026-08-17_08-23"
	ins := `{"draft_id":"draft-b","content":{"schema":"weekly-plan/v1","week_name":"2026-08-17_08-23"}}`
	resp := h.doBody(http.MethodPost, "/api/"+userID+"/plan/weeks/"+weekName+"/drafts", internalHeaders(), strings.NewReader(ins))
	if resp.Code != http.StatusUnprocessableEntity {
		t.Fatalf("code = %d, want 422 (%s)", resp.Code, resp.Body.String())
	}
}

func TestWeeklyPlanDraftLifecycle(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	userID := "8f22e4c5-3d6a-4b32-a11e-3c6a9d0b7f11"
	weekName := "2026-08-17_08-23"
	content := validAppliedWeeklyPlan(weekName)
	user := h.bearer(t, userID)

	// Insert two drafts as internal token.
	for _, id := range []string{"draft-1", "draft-2"} {
		ins := "{\"draft_id\":\"" + id + "\",\"content\":" + content + "}"
		resp := h.doBody(http.MethodPost, "/api/"+userID+"/plan/weeks/"+weekName+"/drafts", internalHeaders(), strings.NewReader(ins))
		if resp.Code != http.StatusCreated {
			t.Fatalf("insert %s code = %d (%s)", id, resp.Code, resp.Body.String())
		}
	}

	// Read draft-2 as the user.
	resp := h.do(http.MethodGet, "/api/"+userID+"/plan/drafts/draft-2", user)
	if resp.Code != http.StatusOK {
		t.Fatalf("get draft code = %d (%s)", resp.Code, resp.Body.String())
	}
	var draft weeklyPlanDraftResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &draft); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if draft.PlanID != "draft-2" || draft.Status != "draft" {
		t.Fatalf("draft = %+v", draft)
	}

	// Activate draft-2.
	resp = h.do(http.MethodPost, "/api/"+userID+"/plan/drafts/draft-2/activate", user)
	if resp.Code != http.StatusOK {
		t.Fatalf("activate code = %d (%s)", resp.Code, resp.Body.String())
	}
	var activate activateWeeklyPlanDraftResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &activate); err != nil {
		t.Fatalf("unmarshal activate: %v", err)
	}
	if !activate.Success || activate.Plan.PlanID != "draft-2" {
		t.Fatalf("activate = %+v", activate)
	}

	// Sibling still draft.
	resp = h.do(http.MethodGet, "/api/"+userID+"/plan/drafts/draft-1", user)
	if resp.Code != http.StatusOK {
		t.Fatalf("get sibling code = %d (%s)", resp.Code, resp.Body.String())
	}
	var sibling weeklyPlanDraftResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &sibling); err != nil {
		t.Fatalf("unmarshal sibling: %v", err)
	}
	if sibling.Status != "draft" {
		t.Fatalf("sibling status = %s, want draft", sibling.Status)
	}

	// Abandon draft-1.
	resp = h.do(http.MethodPost, "/api/"+userID+"/plan/drafts/draft-1/abandon", user)
	if resp.Code != http.StatusOK {
		t.Fatalf("abandon code = %d (%s)", resp.Code, resp.Body.String())
	}
	// It no longer resolves as a draft.
	resp = h.do(http.MethodGet, "/api/"+userID+"/plan/drafts/draft-1", user)
	if resp.Code != http.StatusNotFound {
		t.Fatalf("get abandoned code = %d, want 404 (%s)", resp.Code, resp.Body.String())
	}
}
