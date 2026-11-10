package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/storage"
)

// Rolling e2e materialization gate (#858 PR-A): env-gated integration test
// driving the REAL store + the internal HTTP endpoints with the weekly docs a
// real master kernel produced (coach_agent_api/scripts/test_rolling_e2e.ts
// writes them to STRIDE_ROLL_E2E_DOCS and invokes this test).
//
// Coverage: batch insert, same-plan redelivery revision+1 without duplicates,
// list filtered by master_plan_id. Evidence (list rows) is written back to
// STRIDE_ROLL_E2E_OUT for the script to print.
//
// Env:
//   - STRIDE_ROLL_E2E_DSN  — go-sql-driver DSN of a scratch (local/testing) MySQL
//   - STRIDE_ROLL_E2E_DOCS — JSON file {user_id, master_plan_id, weeks:[...]}
//   - STRIDE_ROLL_E2E_OUT  — result JSON path (optional; asserted evidence)
//
// addDaysFormatted shifts a YYYY-MM-DD by n days (evidence window helper).
func addDaysFormatted(day string, offset int) string {
	parsed, err := time.Parse("2006-01-02", day)
	if err != nil {
		return day
	}
	return parsed.AddDate(0, 0, offset).Format("2006-01-02")
}

func TestRollingE2EBatchApplyRealDocs(t *testing.T) {
	dsn := os.Getenv("STRIDE_ROLL_E2E_DSN")
	docsPath := os.Getenv("STRIDE_ROLL_E2E_DOCS")
	if dsn == "" || docsPath == "" {
		t.Skip("set STRIDE_ROLL_E2E_DSN + STRIDE_ROLL_E2E_DOCS to run the rolling e2e materialization test")
	}

	raw, err := os.ReadFile(docsPath)
	if err != nil {
		t.Fatalf("read docs: %v", err)
	}
	var payload struct {
		UserID       string           `json:"user_id"`
		MasterPlanID string           `json:"master_plan_id"`
		Weeks        []map[string]any `json:"weeks"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("parse docs: %v", err)
	}
	if payload.UserID == "" || payload.MasterPlanID == "" || len(payload.Weeks) == 0 {
		t.Fatalf("docs need user_id, master_plan_id and at least one week (got %d weeks)", len(payload.Weeks))
	}

	store, err := storage.Open(dsn)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	defer func() { _ = store.Close() }()
	ctx := context.Background()
	if err := store.AutoMigrateWeeklyPlan(ctx); err != nil {
		t.Fatalf("migrate weekly_plan: %v", err)
	}
	if err := store.AutoMigrateWorkout(ctx); err != nil {
		t.Fatalf("migrate workout: %v", err)
	}
	if err := store.AutoMigrateMasterPlan(ctx); err != nil {
		t.Fatalf("migrate master_plan: %v", err)
	}

	svc := NewService(Config{
		Auth:            NewAuthenticator(testToken, nil),
		WeeklyPlanStore: store,
	})
	post := func(body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/internal/users/"+payload.UserID+"/plan/weeks/batch-apply", strings.NewReader(body))
		req.Header.Set("X-Internal-Token", testToken)
		rec := httptest.NewRecorder()
		svc.Router().ServeHTTP(rec, req)
		return rec
	}
	list := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/internal/users/"+payload.UserID+"/plan/weeks?master_plan_id="+payload.MasterPlanID, nil)
		req.Header.Set("X-Internal-Token", testToken)
		rec := httptest.NewRecorder()
		svc.Router().ServeHTTP(rec, req)
		return rec
	}

	// 1) First batch: every week inserts at revision 1.
	first := post(string(raw))
	if first.Code != http.StatusCreated {
		t.Fatalf("first batch status=%d body=%s", first.Code, first.Body.String())
	}
	var applied batchApplyWeeklyPlansResponse
	if err := json.Unmarshal(first.Body.Bytes(), &applied); err != nil {
		t.Fatalf("decode first: %v", err)
	}
	if len(applied.Results) != len(payload.Weeks) {
		t.Fatalf("applied %d weeks, sent %d", len(applied.Results), len(payload.Weeks))
	}
	for index, result := range applied.Results {
		if result.Revision != 1 || result.Replaced {
			t.Fatalf("first batch result[%d]=%+v", index, result)
		}
	}

	// 2) Same batch redelivered: each week replaces with revision+1, still one
	// active row per (user, week_start).
	again := post(string(raw))
	if again.Code != http.StatusCreated {
		t.Fatalf("redelivery status=%d body=%s", again.Code, again.Body.String())
	}
	var reapplied batchApplyWeeklyPlansResponse
	if err := json.Unmarshal(again.Body.Bytes(), &reapplied); err != nil {
		t.Fatalf("decode redelivery: %v", err)
	}
	if len(reapplied.Results) != len(payload.Weeks) {
		t.Fatalf("redelivery applied %d weeks", len(reapplied.Results))
	}
	for index, result := range reapplied.Results {
		if result.Revision != 2 || !result.Replaced {
			t.Fatalf("redelivery result[%d]=%+v (want revision 2, replaced)", index, result)
		}
	}

	// 3) List returns exactly the batch weeks, oldest first, revision 2.
	listed := list()
	if listed.Code != http.StatusOK {
		t.Fatalf("list status=%d body=%s", listed.Code, listed.Body.String())
	}
	var rows listInternalWeeksResponse
	if err := json.Unmarshal(listed.Body.Bytes(), &rows); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if len(rows.Weeks) != len(payload.Weeks) {
		t.Fatalf("listed %d weeks, sent %d", len(rows.Weeks), len(payload.Weeks))
	}
	for index := 1; index < len(rows.Weeks); index++ {
		if rows.Weeks[index-1].WeekStart >= rows.Weeks[index].WeekStart {
			t.Fatalf("list not ascending: %+v", rows.Weeks)
		}
	}
	for _, week := range rows.Weeks {
		if week.Revision != 2 || week.MasterPlanID == nil || *week.MasterPlanID != payload.MasterPlanID {
			t.Fatalf("week row=%+v", week)
		}
	}
	// The materialized workout rows exist: the sessions reader over the batch
	// window returns the re-inserted weekly rows (redelivery archived + inserted).
	firstWeek := rows.Weeks[0].WeekStart
	lastWeek := rows.Weeks[len(rows.Weeks)-1].WeekStart
	sessions, err := store.ListPlanSessions(ctx, payload.UserID, firstWeek, addDaysFormatted(lastWeek, 6))
	if err != nil {
		t.Fatalf("list plan sessions: %v", err)
	}
	workoutCount := int64(len(sessions))
	if workoutCount == 0 {
		t.Fatalf("no materialized weekly workout rows in %s..%s", firstWeek, lastWeek)
	}

	// 4) Adoption alignment (#858 R2): applying a master-plan content that
	// carries the same prospective master_plan_id the weekly rows are linked to
	// must adopt it, so master_plan.plan_id == weekly_plan.master_plan_id ==
	// content.master_plan_id — and the internal list keeps showing the batch
	// weeks under that very id after the plan row exists.
	goalID := "11111111-2222-3333-4444-555555555555"
	masterContent := `{"master_plan_id":` + strconv.Quote(payload.MasterPlanID) + `,"goal":{"goal_id":"` + goalID + `","target_time":"2:50:00"},"phases":[],"milestones":[],"weeks":[]}`
	created, _, err := store.ApplyStructuredMasterPlan(ctx, payload.UserID, goalID, masterContent, "", nil)
	if err != nil {
		t.Fatalf("apply master plan with prospective id: %v", err)
	}
	if created.PlanID != payload.MasterPlanID {
		t.Fatalf("applied plan_id = %s, want adopted %s", created.PlanID, payload.MasterPlanID)
	}
	current, err := store.GetCurrentMasterPlan(ctx, payload.UserID)
	if err != nil {
		t.Fatalf("get current master plan: %v", err)
	}
	if current.PlanID != payload.MasterPlanID {
		t.Fatalf("current master plan id = %s, want %s", current.PlanID, payload.MasterPlanID)
	}
	afterApply := list()
	if afterApply.Code != http.StatusOK {
		t.Fatalf("list after apply status=%d body=%s", afterApply.Code, afterApply.Body.String())
	}
	var rowsAfterApply listInternalWeeksResponse
	if err := json.Unmarshal(afterApply.Body.Bytes(), &rowsAfterApply); err != nil {
		t.Fatalf("decode list after apply: %v", err)
	}
	if len(rowsAfterApply.Weeks) != len(payload.Weeks) {
		t.Fatalf("list after apply shows %d weeks, want %d under the adopted master plan id", len(rowsAfterApply.Weeks), len(payload.Weeks))
	}

	// 5) Write the evidence file for the e2e script to print.
	if out := os.Getenv("STRIDE_ROLL_E2E_OUT"); out != "" {
		document := map[string]any{
			"applied_first":  applied.Results,
			"applied_again":  reapplied.Results,
			"listed":         rows.Weeks,
			"workout_rows":   workoutCount,
			"checked_at":     time.Now().UTC().Format(time.RFC3339),
			"master_plan_id": payload.MasterPlanID,
			"user_id":        payload.UserID,
			"weeks_sent":     len(payload.Weeks),
			"adoption": map[string]any{
				"adopted_plan_id":   created.PlanID,
				"current_plan_id":   current.PlanID,
				"weeks_after_apply": len(rowsAfterApply.Weeks),
			},
		}
		encoded, err := json.MarshalIndent(document, "", " ")
		if err != nil {
			t.Fatalf("encode evidence: %v", err)
		}
		if err := os.WriteFile(out, encoded, 0o644); err != nil {
			t.Fatalf("write evidence: %v", err)
		}
	}
}
