package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/storage"
)

// Deviation consent-flow tests (#858 PR-C): plan_adjustment storage
// invariants are covered by storage tests (DSN-gated); these exercise the API
// semantics on an in-memory fake — pending lifecycle, choose same/changed
// reason, accept applies the payload weeks then accepts, dismiss closes the
// event, tier gating.

// fakeAdjustmentStore implements PlanAdjustmentStore in memory, delegating
// the weekly per-week channel to an embedded fakeWeeklyPlanStore.
type fakeAdjustmentStore struct {
	*fakeWeeklyPlanStore
	rows      []*storage.PlanAdjustment
	eventLock map[string]bool // (user|event) closed = accepted or dismissed
	nextID    int
}

func newAdjustmentHarness(t *testing.T) (*weeklyPlanHarness, *fakeAdjustmentStore) {
	t.Helper()
	h := newWeeklyPlanHarness(t)
	store := &fakeAdjustmentStore{fakeWeeklyPlanStore: h.store, eventLock: map[string]bool{}}
	h.svc.planAdjustment = newPlanAdjustmentRoutes(store, h.svc.log)
	return h, store
}

func (f *fakeAdjustmentStore) UpsertPendingAdjustment(
	_ context.Context, userID, masterPlanID, eventWeekStart, reason, question, payload string,
) (*storage.PlanAdjustment, error) {
	if f.eventLock[userID+"|"+eventWeekStart] {
		return nil, storage.ErrAdjustmentEventClosed
	}
	for _, row := range f.rows {
		if row.UserID == userID && row.Status == storage.PlanAdjustmentStatusPending && row.EventWeekStart != eventWeekStart {
			row.Status = storage.PlanAdjustmentStatusSuperseded
		}
	}
	for _, row := range f.rows {
		if row.UserID == userID && row.EventWeekStart == eventWeekStart && row.Status == storage.PlanAdjustmentStatusPending {
			row.Reason, row.Question, row.Payload = reason, question, &payload
			return row, nil
		}
	}
	f.nextID++
	row := &storage.PlanAdjustment{
		ID: fmt.Sprintf("adj-%02d", f.nextID), UserID: userID, MasterPlanID: masterPlanID,
		EventWeekStart: eventWeekStart, Reason: reason, Status: storage.PlanAdjustmentStatusPending,
		Payload: &payload, Question: question, UpdatedAt: time.Now().UTC(),
	}
	f.rows = append(f.rows, row)
	return row, nil
}

func (f *fakeAdjustmentStore) GetPendingAdjustment(_ context.Context, userID string) (*storage.PlanAdjustment, error) {
	for _, row := range f.rows {
		if row.UserID == userID && row.Status == storage.PlanAdjustmentStatusPending {
			return row, nil
		}
	}
	return nil, nil
}

func (f *fakeAdjustmentStore) GetAdjustmentByID(_ context.Context, userID, id string) (*storage.PlanAdjustment, error) {
	for _, row := range f.rows {
		if row.UserID == userID && row.ID == id {
			return row, nil
		}
	}
	return nil, storage.ErrAdjustmentNotFound
}

func (f *fakeAdjustmentStore) ChooseAdjustmentReason(_ context.Context, userID, id, reason string) (*storage.PlanAdjustment, error) {
	row, err := f.GetAdjustmentByID(nil, userID, id)
	if err != nil {
		return nil, err
	}
	if row.Status != storage.PlanAdjustmentStatusPending {
		return nil, storage.ErrAdjustmentState
	}
	if row.Reason == reason {
		return row, nil
	}
	row.Reason, row.Payload = reason, nil
	return row, nil
}

func (f *fakeAdjustmentStore) CompleteAdjustmentPayload(_ context.Context, userID, id, reason, payload string) (*storage.PlanAdjustment, error) {
	row, err := f.GetAdjustmentByID(nil, userID, id)
	if err != nil {
		return nil, err
	}
	if row.Status != storage.PlanAdjustmentStatusPending || row.Reason != reason {
		return nil, storage.ErrAdjustmentState
	}
	row.Payload = &payload
	return row, nil
}

func (f *fakeAdjustmentStore) SetAdjustmentStatus(_ context.Context, userID, id, status string) error {
	row, err := f.GetAdjustmentByID(nil, userID, id)
	if err != nil {
		return err
	}
	if row.Status == status {
		return nil
	}
	if row.Status != storage.PlanAdjustmentStatusPending {
		return storage.ErrAdjustmentState
	}
	row.Status = status
	if status == storage.PlanAdjustmentStatusAccepted || status == storage.PlanAdjustmentStatusDismissed {
		f.eventLock[userID+"|"+row.EventWeekStart] = true
	}
	return nil
}

// ── tests ───────────────────────────────────────────────────────────────────

const (
	adjUserID       = "d31c2cbc-c3f5-4a10-92d0-73fa3281a202"
	adjMasterPlanID = "937f592a-9354-4ee4-8a5c-5b2593512002"
)

func upsertAdjustmentBody(eventWeek, reason string) string {
	payload := map[string]any{
		"reason": reason, "window": map[string]int{"start_week": 4, "end_week": 6},
		"weekly_docs": []any{rollingWeeklyPlanDoc("2026-08-24_08-30")},
		"diff":        []any{map[string]any{"week": 4, "old_km": 66, "new_km": 54}},
		"evidence":    "周量 42/66km（64%）",
	}
	raw, _ := json.Marshal(payload)
	quoted, _ := json.Marshal(string(raw))
	return fmt.Sprintf(`{"master_plan_id":%q,"event_week_start":%q,"reason":%q,"question":"上周完成得不理想，主要是？","payload":%s}`,
		adjMasterPlanID, eventWeek, reason, string(quoted))
}

func rollingWeeklyPlanDocJSON(weekName string) string {
	raw, _ := json.Marshal(rollingWeeklyPlanDoc(weekName))
	return string(raw)
}

func TestAdjustmentConsentFlowHappyPath(t *testing.T) {
	h, store := newAdjustmentHarness(t)
	// internal: nightly scan creates the pending proposal
	resp := h.doBody(http.MethodPost, "/api/internal/users/"+adjUserID+"/plan-adjustments", internalHdr(), strings.NewReader(upsertAdjustmentBody("2026-08-17", "no_time")))
	if resp.Code != http.StatusCreated {
		t.Fatalf("upsert status=%d body=%s", resp.Code, resp.Body.String())
	}
	var created struct {
		Adjustment adjustmentDTO `json:"adjustment"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// user: popup reads pending
	userHeaders := h.bearer(t, adjUserID)
	resp = h.do(http.MethodGet, "/api/users/"+adjUserID+"/plan-adjustment/pending", userHeaders)
	if resp.Code != http.StatusOK {
		t.Fatalf("pending status=%d body=%s", resp.Code, resp.Body.String())
	}
	// user: choose same reason → instant payload (200)
	resp = h.doBody(http.MethodPost, "/api/users/"+adjUserID+"/plan-adjustments/"+created.Adjustment.ID+"/choose", userHeaders, strings.NewReader(`{"reason":"no_time"}`))
	if resp.Code != http.StatusOK {
		t.Fatalf("choose same status=%d body=%s", resp.Code, resp.Body.String())
	}
	// user: accept applies the payload weeks (linked to the same master plan)
	resp = h.do(http.MethodPost, "/api/users/"+adjUserID+"/plan-adjustments/"+created.Adjustment.ID+"/accept", userHeaders)
	if resp.Code != http.StatusOK {
		t.Fatalf("accept status=%d body=%s", resp.Code, resp.Body.String())
	}
	var applied acceptAdjustmentResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &applied); err != nil || len(applied.Applied) != 1 {
		t.Fatalf("accept decode=%v applied=%+v", err, applied)
	}
	// accepted is terminal: a second accept conflicts, re-upsert of the event 409
	resp = h.do(http.MethodPost, "/api/users/"+adjUserID+"/plan-adjustments/"+created.Adjustment.ID+"/accept", userHeaders)
	if resp.Code != http.StatusConflict {
		t.Fatalf("second accept status=%d", resp.Code)
	}
	resp = h.doBody(http.MethodPost, "/api/internal/users/"+adjUserID+"/plan-adjustments", internalHdr(), strings.NewReader(upsertAdjustmentBody("2026-08-17", "no_time")))
	if resp.Code != http.StatusConflict {
		t.Fatalf("closed-event upsert status=%d", resp.Code)
	}
	_ = store
}

func TestAdjustmentChooseChangedReasonRegenerates(t *testing.T) {
	h, _ := newAdjustmentHarness(t)
	adjID := upsertFirstAdjustment(t, h)
	userHeaders := h.bearer(t, adjUserID)
	// choose a different reason → 202 + payload cleared
	resp := h.doBody(http.MethodPost, "/api/users/"+adjUserID+"/plan-adjustments/"+adjID+"/choose", userHeaders, strings.NewReader(`{"reason":"over_delivered"}`))
	if resp.Code != http.StatusAccepted {
		t.Fatalf("choose changed status=%d body=%s", resp.Code, resp.Body.String())
	}
	var chosen struct {
		Adjustment adjustmentDTO `json:"adjustment"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &chosen); err != nil || chosen.Adjustment.Payload != nil {
		t.Fatalf("choose changed decode=%v payload=%v", err, chosen.Adjustment.Payload)
	}
	// accept before regeneration finishes → 422
	resp = h.do(http.MethodPost, "/api/users/"+adjUserID+"/plan-adjustments/"+adjID+"/accept", userHeaders)
	if resp.Code != http.StatusUnprocessableEntity {
		t.Fatalf("accept while regenerating status=%d", resp.Code)
	}
	// worker refills via internal channel (wrong reason rejected)
	resp = h.doBody(http.MethodPost, "/api/internal/users/"+adjUserID+"/plan-adjustments/adj-01/payload", internalHdr(), strings.NewReader(`{"reason":"no_time","payload":"{}"}`))
	if resp.Code != http.StatusConflict {
		t.Fatalf("refill wrong reason status=%d", resp.Code)
	}
	resp = h.doBody(http.MethodPost, "/api/internal/users/"+adjUserID+"/plan-adjustments/adj-01/payload", internalHdr(), strings.NewReader(fmt.Sprintf(`{"reason":"over_delivered","payload":%s}`, refillPayloadJSON())))
	if resp.Code != http.StatusOK {
		t.Fatalf("refill status=%d body=%s", resp.Code, resp.Body.String())
	}
	// payload back → accept succeeds
	resp = h.do(http.MethodPost, "/api/users/"+adjUserID+"/plan-adjustments/"+adjID+"/accept", userHeaders)
	if resp.Code != http.StatusOK {
		t.Fatalf("accept after refill status=%d body=%s", resp.Code, resp.Body.String())
	}
}

func TestAdjustmentDismissClosesEventAndGating(t *testing.T) {
	h, _ := newAdjustmentHarness(t)
	adjID := upsertFirstAdjustment(t, h)
	userHeaders := h.bearer(t, adjUserID)
	// internal cannot read the user popup; user cannot call the internal channel
	if resp := h.do(http.MethodGet, "/api/users/"+adjUserID+"/plan-adjustment/pending", internalHdr()); resp.Code != http.StatusForbidden {
		t.Fatalf("internal on user route status=%d", resp.Code)
	}
	if resp := h.doBody(http.MethodPost, "/api/internal/users/"+adjUserID+"/plan-adjustments", h.bearer(t, adjUserID), strings.NewReader(upsertAdjustmentBody("2026-08-17", "no_time"))); resp.Code != http.StatusForbidden {
		t.Fatalf("user on internal route status=%d", resp.Code)
	}
	// another user's JWT cannot read someone else's pending
	if resp := h.do(http.MethodGet, "/api/users/"+adjUserID+"/plan-adjustment/pending", h.bearer(t, "d31c2cbc-c3f5-4a10-92d0-73fa3281a999")); resp.Code != http.StatusForbidden {
		t.Fatalf("cross-user pending status=%d", resp.Code)
	}
	// dismiss → 204, event closed for the nightly re-upsert
	if resp := h.do(http.MethodPost, "/api/users/"+adjUserID+"/plan-adjustments/"+adjID+"/dismiss", userHeaders); resp.Code != http.StatusNoContent {
		t.Fatalf("dismiss status=%d", resp.Code)
	}
	if resp := h.do(http.MethodGet, "/api/users/"+adjUserID+"/plan-adjustment/pending", userHeaders); resp.Code != http.StatusNotFound {
		t.Fatalf("pending after dismiss status=%d", resp.Code)
	}
	if resp := h.doBody(http.MethodPost, "/api/internal/users/"+adjUserID+"/plan-adjustments", internalHdr(), strings.NewReader(upsertAdjustmentBody("2026-08-17", "no_time"))); resp.Code != http.StatusConflict {
		t.Fatalf("closed event re-upsert status=%d", resp.Code)
	}
	// a NEW event week supersedes nothing closed but creates a fresh pending
	if resp := h.doBody(http.MethodPost, "/api/internal/users/"+adjUserID+"/plan-adjustments", internalHdr(), strings.NewReader(upsertAdjustmentBody("2026-08-24", "no_time"))); resp.Code != http.StatusCreated {
		t.Fatalf("new event upsert status=%d", resp.Code)
	}
}

func TestAdjustmentUpsertValidation(t *testing.T) {
	h, _ := newAdjustmentHarness(t)
	cases := []struct {
		name string
		body string
		want int
	}{
		{"bad reason", strings.Replace(upsertAdjustmentBody("2026-08-17", "no_time"), `"reason":"no_time"`, `"reason":"felt_lazy"`, 1), http.StatusBadRequest},
		{"non-monday event", strings.Replace(upsertAdjustmentBody("2026-08-17", "no_time"), "2026-08-17", "2026-08-18", 1), http.StatusBadRequest},
		{"bad master plan", strings.Replace(upsertAdjustmentBody("2026-08-17", "no_time"), adjMasterPlanID, "not-a-uuid", 1), http.StatusBadRequest},
		{"bad payload", strings.Replace(upsertAdjustmentBody("2026-08-17", "no_time"), `"payload":"`, `"payload":12345,"x":"`, 1), http.StatusBadRequest},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := h.doBody(http.MethodPost, "/api/internal/users/"+adjUserID+"/plan-adjustments", internalHdr(), strings.NewReader(tc.body))
			if resp.Code != tc.want {
				t.Fatalf("status=%d want=%d body=%s", resp.Code, tc.want, resp.Body.String())
			}
		})
	}
}

// upsertFirstAdjustment posts the nightly-scan upsert and returns the row id.
func upsertFirstAdjustment(t *testing.T, h *weeklyPlanHarness) string {
	t.Helper()
	resp := h.doBody(http.MethodPost, "/api/internal/users/"+adjUserID+"/plan-adjustments", internalHdr(), strings.NewReader(upsertAdjustmentBody("2026-08-17", "no_time")))
	if resp.Code != http.StatusCreated {
		t.Fatalf("upsert status=%d body=%s", resp.Code, resp.Body.String())
	}
	var created struct {
		Adjustment adjustmentDTO `json:"adjustment"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode upsert: %v", err)
	}
	return created.Adjustment.ID
}

// refillPayloadJSON is the escaped payload JSON the worker posts back.
func refillPayloadJSON() string {
	raw, _ := json.Marshal(map[string]any{
		"reason":      "over_delivered",
		"weekly_docs": []any{rollingWeeklyPlanDoc("2026-08-24_08-30")},
	})
	quoted, _ := json.Marshal(string(raw))
	return string(quoted)
}
