package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/zhaochy1990/stride/internal/storage"
)

// Internal rolling channel tests (#858 PR-A): batch-apply weekly docs + list
// materialized weeks, following the fake-store harness in weekly_plan_test.go.

// rollingWeeklyPlanDoc is a valid structured weekly plan carrying the rolling
// extension fields (week_index/phase_name/... — the regenerated schema admits
// them as optional), the shape the rolling kernel materializes.
func rollingWeeklyPlanDoc(weekName string) map[string]any {
	var document map[string]any
	if err := json.Unmarshal([]byte(validAppliedWeeklyPlan(weekName)), &document); err != nil {
		panic(err)
	}
	document["week_index"] = 7
	document["phase_name"] = "base"
	document["phase_goal"] = "build the aerobic base"
	document["target_weekly_km_low"] = 66
	document["target_weekly_km_high"] = 66
	document["is_recovery_week"] = false
	document["planned_dose"] = 312.4
	document["km_deviation_pct"] = 0
	document["source"] = "llm"
	return document
}

func batchApplyBody(masterPlanID string, weekNames ...string) string {
	weeks := make([]string, 0, len(weekNames))
	for _, weekName := range weekNames {
		raw, _ := json.Marshal(rollingWeeklyPlanDoc(weekName))
		weeks = append(weeks, string(raw))
	}
	return fmt.Sprintf(`{"master_plan_id":%q,"weeks":[%s]}`, masterPlanID, strings.Join(weeks, ","))
}

func TestInternalBatchApplyInsertsRollingWeeksAndListsThem(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	userID := "d31c2cbc-c3f5-4a10-92d0-73fa3281a101"
	masterPlanID := "937f592a-9354-4ee4-8a5c-5b2593511001"
	body := batchApplyBody(masterPlanID, "2026-08-17_08-23", "2026-08-24_08-30", "2026-08-31_09-06")

	resp := h.doBody(http.MethodPost, "/api/internal/users/"+userID+"/plan/weeks/batch-apply", internalHdr(), strings.NewReader(body))
	if resp.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var applied batchApplyWeeklyPlansResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &applied); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(applied.Results) != 3 {
		t.Fatalf("results=%+v", applied.Results)
	}
	for index, result := range applied.Results {
		if result.Revision != 1 || result.Replaced || result.PlanID == "" {
			t.Fatalf("result[%d]=%+v", index, result)
		}
	}
	if applied.Results[0].WeekStart != "2026-08-17" || applied.Results[2].WeekStart != "2026-08-31" {
		t.Fatalf("week order=%+v", applied.Results)
	}
	// The rows link to the requested master plan (rolling channel passes the
	// exact plan id it generated against), not a derived current-plan link.
	if h.store.lastAppliedMasterPlan != masterPlanID {
		t.Fatalf("master link=%q", h.store.lastAppliedMasterPlan)
	}
	if !h.store.lastAppliedContinueRev {
		t.Fatalf("rolling batch must ask for revision continuation")
	}

	// List returns exactly the batch weeks, oldest first, linked + revisioned.
	list := h.do(http.MethodGet, "/api/internal/users/"+userID+"/plan/weeks?master_plan_id="+masterPlanID, internalHdr())
	if list.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", list.Code, list.Body.String())
	}
	var listed listInternalWeeksResponse
	if err := json.Unmarshal(list.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(listed.Weeks) != 3 || listed.Weeks[0].WeekStart != "2026-08-17" || listed.Weeks[2].WeekStart != "2026-08-31" {
		t.Fatalf("weeks=%+v", listed.Weeks)
	}
	if listed.Weeks[0].MasterPlanID == nil || *listed.Weeks[0].MasterPlanID != masterPlanID || listed.Weeks[0].Revision != 1 {
		t.Fatalf("week row=%+v", listed.Weeks[0])
	}
}

func TestInternalBatchApplyReplacesSamePlanWeeksWithRevisionPlusOne(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	userID := "d31c2cbc-c3f5-4a10-92d0-73fa3281a102"
	masterPlanID := "937f592a-9354-4ee4-8a5c-5b2593511002"
	weekName := "2026-08-17_08-23"
	first := h.doBody(http.MethodPost, "/api/internal/users/"+userID+"/plan/weeks/batch-apply", internalHdr(), strings.NewReader(batchApplyBody(masterPlanID, weekName)))
	if first.Code != http.StatusCreated {
		t.Fatalf("first status=%d body=%s", first.Code, first.Body.String())
	}

	// Same batch redelivered: each week replaces with revision+1, no duplicates.
	again := h.doBody(http.MethodPost, "/api/internal/users/"+userID+"/plan/weeks/batch-apply", internalHdr(), strings.NewReader(batchApplyBody(masterPlanID, weekName)))
	if again.Code != http.StatusCreated {
		t.Fatalf("again status=%d body=%s", again.Code, again.Body.String())
	}
	var applied batchApplyWeeklyPlansResponse
	if err := json.Unmarshal(again.Body.Bytes(), &applied); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(applied.Results) != 1 || applied.Results[0].Revision != 2 || !applied.Results[0].Replaced {
		t.Fatalf("results=%+v", applied.Results)
	}
	if len(h.store.plans[userID]) != 1 {
		t.Fatalf("rows after redelivery=%+v", h.store.plans[userID])
	}
	listed := h.do(http.MethodGet, "/api/internal/users/"+userID+"/plan/weeks?master_plan_id="+masterPlanID, internalHdr())
	var rows listInternalWeeksResponse
	_ = json.Unmarshal(listed.Body.Bytes(), &rows)
	if len(rows.Weeks) != 1 || rows.Weeks[0].Revision != 2 {
		t.Fatalf("listed=%+v", rows.Weeks)
	}
}

func TestInternalBatchApplyRejectsWeekOwnedByAnotherMasterPlan(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	userID := "d31c2cbc-c3f5-4a10-92d0-73fa3281a103"
	otherMaster := "598c03de-dbe5-4a17-93c2-bb2ed99532e9"
	prior := weeklyPlanFixture("11111111-2222-3333-4444-555555555501", userID, "2026-08-17", storage.WeeklyPlanContentStructured, `{"sessions":[],"nutrition":[]}`)
	prior.MasterPlanID = &otherMaster
	h.store.plans[userID] = []storage.WeeklyPlan{prior}

	body := batchApplyBody("937f592a-9354-4ee4-8a5c-5b2593511003", "2026-08-17_08-23")
	resp := h.doBody(http.MethodPost, "/api/internal/users/"+userID+"/plan/weeks/batch-apply", internalHdr(), strings.NewReader(body))
	if resp.Code != http.StatusConflict || resp.Body.String() != "{\"error\":\"weekly_plan_master_plan_conflict\"}" {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	// The prior row is untouched.
	if len(h.store.plans[userID]) != 1 || h.store.plans[userID][0].PlanID != prior.PlanID {
		t.Fatalf("rows=%+v", h.store.plans[userID])
	}
}

func TestInternalBatchApplyRejectsInvalidBatchWithoutPartialWrites(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	userID := "d31c2cbc-c3f5-4a10-92d0-73fa3281a104"
	// One valid week then one whose week_name does not parse: phase-1 validation
	// must reject the whole batch before anything is applied.
	valid := rollingWeeklyPlanDoc("2026-08-17_08-23")
	raw, _ := json.Marshal(valid)
	body := fmt.Sprintf(`{"master_plan_id":"937f592a-9354-4ee4-8a5c-5b2593511004","weeks":[%s,%s]}`, string(raw), `{"schema":"weekly-plan/v1","week_name":"not-a-week"}`)
	resp := h.doBody(http.MethodPost, "/api/internal/users/"+userID+"/plan/weeks/batch-apply", internalHdr(), strings.NewReader(body))
	if resp.Code != http.StatusUnprocessableEntity || resp.Body.String() != "{\"error\":\"invalid_content\"}" {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	if len(h.store.plans[userID]) != 0 {
		t.Fatalf("batch rejected but rows exist: %+v", h.store.plans[userID])
	}

	// Duplicate week inside one batch is rejected the same way.
	dup := fmt.Sprintf(`{"master_plan_id":"937f592a-9354-4ee4-8a5c-5b2593511004","weeks":[%s,%s]}`, string(raw), string(raw))
	dupResp := h.doBody(http.MethodPost, "/api/internal/users/"+userID+"/plan/weeks/batch-apply", internalHdr(), strings.NewReader(dup))
	if dupResp.Code != http.StatusUnprocessableEntity || dupResp.Body.String() != "{\"error\":\"duplicate_week\"}" {
		t.Fatalf("dup status=%d body=%s", dupResp.Code, dupResp.Body.String())
	}
}

func TestInternalBatchApplyAndListGuardRequests(t *testing.T) {
	userID := "d31c2cbc-c3f5-4a10-92d0-73fa3281a105"
	path := "/api/internal/users/" + userID + "/plan/weeks/batch-apply"
	cases := []struct {
		name   string
		method string
		path   string
		header func(*testing.T, *weeklyPlanHarness) map[string]string
		body   string
		status int
		error  string
	}{
		{
			name: "admin token cannot batch apply", method: http.MethodPost, path: path,
			header: func(t *testing.T, h *weeklyPlanHarness) map[string]string { return h.adminBearer(t, "admin") },
			body:   batchApplyBody("937f592a-9354-4ee4-8a5c-5b2593511005", "2026-08-17_08-23"),
			status: http.StatusForbidden, error: "forbidden",
		},
		{
			name: "user token cannot batch apply", method: http.MethodPost, path: path,
			header: func(t *testing.T, h *weeklyPlanHarness) map[string]string { return h.bearer(t, userID) },
			body:   batchApplyBody("937f592a-9354-4ee4-8a5c-5b2593511005", "2026-08-17_08-23"),
			status: http.StatusForbidden, error: "forbidden",
		},
		{
			name: "invalid user id", method: http.MethodPost, path: "/api/internal/users/not-a-uuid/plan/weeks/batch-apply",
			header: func(*testing.T, *weeklyPlanHarness) map[string]string { return internalHdr() },
			body:   batchApplyBody("937f592a-9354-4ee4-8a5c-5b2593511005", "2026-08-17_08-23"),
			status: http.StatusBadRequest, error: "invalid_user",
		},
		{
			name: "invalid master plan id", method: http.MethodPost, path: path,
			header: func(*testing.T, *weeklyPlanHarness) map[string]string { return internalHdr() },
			body:   batchApplyBody("not-a-uuid", "2026-08-17_08-23"),
			status: http.StatusBadRequest, error: "invalid_master_plan",
		},
		{
			name: "empty weeks", method: http.MethodPost, path: path,
			header: func(*testing.T, *weeklyPlanHarness) map[string]string { return internalHdr() },
			body:   `{"master_plan_id":"937f592a-9354-4ee4-8a5c-5b2593511005","weeks":[]}`,
			status: http.StatusBadRequest, error: "empty_weeks",
		},
		{
			name: "list without master plan filter", method: http.MethodGet, path: "/api/internal/users/" + userID + "/plan/weeks",
			header: func(*testing.T, *weeklyPlanHarness) map[string]string { return internalHdr() },
			status: http.StatusBadRequest, error: "invalid_master_plan",
		},
		{
			name: "list with malformed master plan filter", method: http.MethodGet, path: "/api/internal/users/" + userID + "/plan/weeks?master_plan_id=abc",
			header: func(*testing.T, *weeklyPlanHarness) map[string]string { return internalHdr() },
			status: http.StatusBadRequest, error: "invalid_master_plan",
		},
		{
			name: "list rejects user tier", method: http.MethodGet, path: "/api/internal/users/" + userID + "/plan/weeks?master_plan_id=937f592a-9354-4ee4-8a5c-5b2593511005",
			header: func(t *testing.T, h *weeklyPlanHarness) map[string]string { return h.bearer(t, userID) },
			status: http.StatusForbidden, error: "forbidden",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			h := newWeeklyPlanHarness(t)
			var resp *httptest.ResponseRecorder
			if testCase.method == http.MethodGet {
				resp = h.do(testCase.method, testCase.path, testCase.header(t, h))
			} else {
				resp = h.doBody(testCase.method, testCase.path, testCase.header(t, h), strings.NewReader(testCase.body))
			}
			if resp.Code != testCase.status || resp.Body.String() != "{\"error\":\""+testCase.error+"\"}" {
				t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
			}
		})
	}
}

func TestInternalListWeeksFiltersOtherMasterPlans(t *testing.T) {
	h := newWeeklyPlanHarness(t)
	userID := "d31c2cbc-c3f5-4a10-92d0-73fa3281a106"
	masterPlanID := "937f592a-9354-4ee4-8a5c-5b2593511006"
	otherMaster := "598c03de-dbe5-4a17-93c2-bb2ed99532e9"
	owned := weeklyPlanFixture("11111111-2222-3333-4444-555555555502", userID, "2026-08-17", storage.WeeklyPlanContentStructured, `{"sessions":[],"nutrition":[]}`)
	owned.MasterPlanID = &masterPlanID
	unlinked := weeklyPlanFixture("11111111-2222-3333-4444-555555555503", userID, "2026-08-24", storage.WeeklyPlanContentStructured, `{"sessions":[],"nutrition":[]}`)
	unlinked.MasterPlanID = &otherMaster
	h.store.plans[userID] = []storage.WeeklyPlan{owned, unlinked}

	resp := h.do(http.MethodGet, "/api/internal/users/"+userID+"/plan/weeks?master_plan_id="+masterPlanID, internalHdr())
	if resp.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", resp.Code, resp.Body.String())
	}
	var listed listInternalWeeksResponse
	if err := json.Unmarshal(resp.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(listed.Weeks) != 1 || listed.Weeks[0].WeekStart != "2026-08-17" {
		t.Fatalf("weeks=%+v", listed.Weeks)
	}
}
