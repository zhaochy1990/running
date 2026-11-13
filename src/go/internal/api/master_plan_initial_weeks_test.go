package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

func TestMasterPlanApplyRejectsMalformedInitialWeek(t *testing.T) {
	for _, admin := range []bool{false, true} {
		h := newMPHarness(t)
		uid := uuid.NewString()
		content := mustAppliedContent(t, uuid.NewString())
		content["weekly_docs"] = []any{map[string]any{"week_name": "not-a-week"}}
		var code int
		if admin {
			resp := doApply(t, h, h.bearerWithClaims(t, uuid.NewString(), testAdminAudience, "admin"), uid, applyRequestBody(content, false, nil, nil))
			code = resp.Code
		} else {
			resp := doApplyFromContent(t, h, h.bearer(t, uid), map[string]any{"content": content, "apply_token": uuid.NewString()})
			code = resp.Code
		}
		if code != http.StatusUnprocessableEntity {
			t.Fatalf("admin=%v: status=%d, want 422", admin, code)
		}
		if h.store.current[uid] != nil {
			t.Fatalf("admin=%v: invalid candidate changed active plan", admin)
		}
	}
}

func TestMasterPlanApplyPassesInitialWeeksToAtomicStore(t *testing.T) {
	for _, admin := range []bool{false, true} {
		h := newMPHarness(t)
		uid := uuid.NewString()
		start := timefmt.ShanghaiWeekStart(time.Now()).AddDate(0, 0, 7)
		name := start.Format("2006-01-02") + "_" + start.AddDate(0, 0, 6).Format("01-02")
		content := mustAppliedContent(t, uuid.NewString())
		alignCandidateSeason(content, start)
		doc := rollingWeeklyPlanDoc(name)
		doc["week_index"] = 1
		content["weekly_docs"] = []any{doc}
		jobID := registerCandidateFixture(t, h, uid, content)
		var code int
		if admin {
			code = doApply(t, h, h.bearerWithClaims(t, uuid.NewString(), testAdminAudience, "admin"), uid, applyRequestBody(content, false, nil, nil)).Code
		} else {
			code = doApplyFromContent(t, h, h.bearer(t, uid), map[string]any{"content": content, "apply_token": jobID}).Code
		}
		if code != http.StatusCreated || len(h.store.initialWeeks) != 1 || h.store.initialWeeks[0].WeekStart != start.Format("2006-01-02") {
			t.Fatalf("admin=%v: status=%d, weeks=%+v", admin, code, h.store.initialWeeks)
		}
	}
}

func TestMasterPlanApplyRejectsWeekOutsideCandidateSeason(t *testing.T) {
	h := newMPHarness(t)
	uid := uuid.NewString()
	start := timefmt.ShanghaiWeekStart(time.Now()).AddDate(0, 0, 7)
	name := start.Format("2006-01-02") + "_" + start.AddDate(0, 0, 6).Format("01-02")
	content := mustAppliedContent(t, uuid.NewString())
	content["weekly_docs"] = []any{rollingWeeklyPlanDoc(name)}
	response := doApplyFromContent(t, h, h.bearer(t, uid), map[string]any{"content": content, "apply_token": uuid.NewString()})
	if response.Code != http.StatusUnprocessableEntity || h.store.current[uid] != nil {
		t.Fatalf("status=%d, current=%+v", response.Code, h.store.current[uid])
	}
}

func TestMasterPlanApplyAcceptsLargeCandidate(t *testing.T) {
	h := newMPHarness(t)
	uid := uuid.NewString()
	content := mustAppliedContent(t, uuid.NewString())
	content["warnings"] = []any{strings.Repeat("x", maxRequestBytes)}
	response := doApplyFromContent(t, h, h.bearer(t, uid), map[string]any{"content": content, "apply_token": uuid.NewString()})
	if response.Code != http.StatusCreated {
		t.Fatalf("status=%d", response.Code)
	}
}

func TestMasterPlanApplyNewCurrentWeekPublishesOnlyFutureSessions(t *testing.T) {
	today := timefmt.ShanghaiToday()
	if today.Weekday() == time.Sunday {
		t.Skip("no future day in current week")
	}
	h := newMPHarness(t)
	uid := uuid.NewString()
	start := timefmt.ShanghaiWeekStart(time.Now())
	name := start.Format("2006-01-02") + "_" + start.AddDate(0, 0, 6).Format("01-02")
	content := mustAppliedContent(t, uuid.NewString())
	alignCandidateSeason(content, start)
	doc := rollingWeeklyPlanDoc(name)
	doc["week_index"] = 1
	doc["sessions"].([]any)[0].(map[string]any)["date"] = today.AddDate(0, 0, 1).Format("2006-01-02")
	content["weekly_docs"] = []any{doc}
	jobID := registerCandidateFixture(t, h, uid, content)
	response := doApplyFromContent(t, h, h.bearer(t, uid), map[string]any{"content": content, "apply_token": jobID})
	if response.Code != http.StatusCreated || len(h.store.initialWeeks) != 1 {
		t.Fatalf("status=%d, items=%+v", response.Code, h.store.initialWeeks)
	}
	var saved map[string]any
	if err := json.Unmarshal([]byte(h.store.initialWeeks[0].Content), &saved); err != nil {
		t.Fatal(err)
	}
	for _, session := range saved["sessions"].([]any) {
		if session.(map[string]any)["date"].(string) <= today.Format("2006-01-02") {
			t.Fatalf("past session=%v", session)
		}
	}
}

func TestAdminPatchCannotApplyCandidateWeeks(t *testing.T) {
	h := newMPHarness(t)
	uid, goal := uuid.NewString(), uuid.NewString()
	admin := h.bearerWithClaims(t, uuid.NewString(), testAdminAudience, "admin")
	first := doApply(t, h, admin, uid, applyRequestBody(mustAppliedContent(t, goal), false, nil, nil))
	if first.Code != http.StatusCreated {
		t.Fatalf("seed=%d", first.Code)
	}
	old := h.store.current[uid]
	content := mustAppliedContent(t, goal)
	content["weekly_docs"] = []any{}
	response := doUpdate(t, h, admin, uid, updateRequestBody(content, &old.PlanID, old.Revision))
	if response.Code != http.StatusUnprocessableEntity || *h.store.current[uid].Revision != 1 {
		t.Fatalf("status=%d current=%+v", response.Code, h.store.current[uid])
	}
}

func alignCandidateSeason(content map[string]any, start time.Time) {
	content["start_date"] = start.Format("2006-01-02")
	content["end_date"] = start.AddDate(0, 0, 13).Format("2006-01-02")
	phase := content["phases"].([]any)[0].(map[string]any)
	phase["start_date"] = content["start_date"]
	phase["end_date"] = content["end_date"]
	for i, raw := range content["weeks"].([]any) {
		raw.(map[string]any)["week_start"] = start.AddDate(0, 0, 7*i).Format("2006-01-02")
	}
}
