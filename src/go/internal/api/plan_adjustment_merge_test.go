package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/storage"
)

// Accept-time adjustment merge integration tests (#952): the weekly row the
// accept endpoint stores keeps the active week's arrangement through the day
// the athlete accepts, even when the proposal was generated days earlier.

func adjustmentMergeUpsertBody(eventWeek, reason string, document map[string]any) string {
	payload := map[string]any{
		"reason": reason, "window": map[string]int{"start_week": 4, "end_week": 4},
		"weekly_docs": []any{document}, "diff": []any{}, "evidence": "test",
	}
	raw, _ := json.Marshal(payload)
	quoted, _ := json.Marshal(string(raw))
	return fmt.Sprintf(`{"master_plan_id":%q,"event_week_start":%q,"reason":%q,"question":"q","payload":%s}`,
		adjMasterPlanID, eventWeek, reason, string(quoted))
}

func seedActiveAdjustmentWeek(h *weeklyPlanHarness, weekStart string, document map[string]any) {
	content := make(map[string]any, len(document))
	for key, value := range document {
		content[key] = value
	}
	delete(content, "schema")
	delete(content, "week_name")
	raw, _ := json.Marshal(content)
	masterPlanID := adjMasterPlanID
	h.store.plans[adjUserID] = append(h.store.plans[adjUserID], storage.WeeklyPlan{
		PlanID: "old-plan", UserID: adjUserID, WeekStart: weekStart, MasterPlanID: &masterPlanID,
		ContentVersion: storage.WeeklyPlanContentStructured, Content: string(raw),
		Status: storage.WeeklyPlanStatusActive, Revision: 1,
	})
}

func createAdjustmentProposal(t *testing.T, h *weeklyPlanHarness, eventWeek string, document map[string]any) string {
	t.Helper()
	resp := h.doBody(
		http.MethodPost, "/api/internal/users/"+adjUserID+"/plan-adjustments", internalHdr(),
		strings.NewReader(adjustmentMergeUpsertBody(eventWeek, "no_time", document)),
	)
	if resp.Code != http.StatusCreated {
		t.Fatalf("upsert status=%d body=%s", resp.Code, resp.Body.String())
	}
	var created struct {
		Adjustment adjustmentDTO `json:"adjustment"`
	}
	if err := json.Unmarshal(resp.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return created.Adjustment.ID
}

func acceptAdjustment(t *testing.T, h *weeklyPlanHarness, adjustmentID string) acceptAdjustmentResponse {
	t.Helper()
	resp := h.do(http.MethodPost, "/api/users/"+adjUserID+"/plan-adjustments/"+adjustmentID+"/accept", h.bearer(t, adjUserID))
	if resp.Code != http.StatusOK {
		t.Fatalf("accept status=%d body=%s", resp.Code, resp.Body.String())
	}
	var applied acceptAdjustmentResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &applied); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return applied
}

func storedWeekSessions(t *testing.T, h *weeklyPlanHarness, weekStart string) ([]any, int64) {
	t.Helper()
	for _, row := range h.store.plans[adjUserID] {
		if strings.TrimSuffix(row.WeekStart, "T00:00:00Z") != weekStart || row.Status != storage.WeeklyPlanStatusActive {
			continue
		}
		var content map[string]any
		if err := json.Unmarshal([]byte(row.Content), &content); err != nil {
			t.Fatalf("decode stored content: %v", err)
		}
		sessions, _ := content["sessions"].([]any)
		return sessions, row.Revision
	}
	t.Fatalf("no active weekly row for %s", weekStart)
	return nil, 0
}

func TestAdjustmentAcceptKeepsArrangementsThroughToday(t *testing.T) {
	h, _ := newAdjustmentHarness(t)
	weekStart := "2026-08-24"
	seedActiveAdjustmentWeek(h, weekStart, mergeTestDoc(weekStart, "old", []int{0, 2}, 10))
	h.svc.planAdjustment.now = func() time.Time { return time.Date(2026, 8, 26, 12, 0, 0, 0, time.UTC) }

	adjustmentID := createAdjustmentProposal(t, h, weekStart, mergeTestDoc(weekStart, "new", []int{3, 5}, 20))
	applied := acceptAdjustment(t, h, adjustmentID)
	if len(applied.Applied) != 1 || !applied.Applied[0].Replaced {
		t.Fatalf("applied=%+v", applied)
	}
	sessions, revision := storedWeekSessions(t, h, weekStart)
	if revision != 2 {
		t.Fatalf("revision=%d want 2", revision)
	}
	for offset := range 3 {
		if got := summaryAt(t, weekStart, sessions, offset); got != fmt.Sprintf("old-%d", offset) {
			t.Fatalf("offset %d stored %q, want old arrangement", offset, got)
		}
	}
	for offset := 3; offset < 7; offset++ {
		if got := summaryAt(t, weekStart, sessions, offset); got != fmt.Sprintf("new-%d", offset) {
			t.Fatalf("offset %d stored %q, want new arrangement", offset, got)
		}
	}
}

func TestAdjustmentAcceptDelayedProtectsDaysThatBecamePast(t *testing.T) {
	h, _ := newAdjustmentHarness(t)
	weekStart := "2026-08-24"
	seedActiveAdjustmentWeek(h, weekStart, mergeTestDoc(weekStart, "old", []int{0, 4}, 10))
	// Proposal generated Wednesday, accepted Friday.
	h.svc.planAdjustment.now = func() time.Time { return time.Date(2026, 8, 28, 12, 0, 0, 0, time.UTC) }

	adjustmentID := createAdjustmentProposal(t, h, weekStart, mergeTestDoc(weekStart, "new", []int{3, 5}, 20))
	acceptAdjustment(t, h, adjustmentID)
	sessions, _ := storedWeekSessions(t, h, weekStart)
	if got := summaryAt(t, weekStart, sessions, 3); got != "old-3" {
		t.Fatalf("newly-past day overwritten: %q", got)
	}
	if got := summaryAt(t, weekStart, sessions, 4); got != "old-4" {
		t.Fatalf("today overwritten: %q", got)
	}
	if got := summaryAt(t, weekStart, sessions, 5); got != "new-5" {
		t.Fatalf("tomorrow did not take the new arrangement: %q", got)
	}
}

func TestAdjustmentAcceptSundayKeepsActiveWeek(t *testing.T) {
	h, _ := newAdjustmentHarness(t)
	weekStart := "2026-08-24"
	seedActiveAdjustmentWeek(h, weekStart, mergeTestDoc(weekStart, "old", []int{0, 2}, 10))
	h.svc.planAdjustment.now = func() time.Time { return time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC) }

	adjustmentID := createAdjustmentProposal(t, h, weekStart, mergeTestDoc(weekStart, "new", []int{3, 5}, 20))
	applied := acceptAdjustment(t, h, adjustmentID)
	if len(applied.Applied) != 0 {
		t.Fatalf("Sunday must not replace the week: %+v", applied)
	}
	sessions, revision := storedWeekSessions(t, h, weekStart)
	if revision != 1 {
		t.Fatalf("revision=%d want untouched 1", revision)
	}
	for offset := range 7 {
		if got := summaryAt(t, weekStart, sessions, offset); got != fmt.Sprintf("old-%d", offset) {
			t.Fatalf("offset %d stored %q, want old arrangement", offset, got)
		}
	}
}
