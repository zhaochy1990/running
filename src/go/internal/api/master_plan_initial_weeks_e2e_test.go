package api

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// The HTTP write boundary uses an isolated, real MySQL store. A successful
// confirmation must expose both the season and full materialized sessions.
func TestMasterPlanInitialWeeksMySQLE2E(t *testing.T) {
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("set STRIDE_WORKER_TEST_MYSQL_DSN to run MySQL integration tests")
	}
	store, err := storage.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	ctx := t.Context()
	for _, migrate := range []func(ctx context.Context) error{store.AutoMigrate, store.AutoMigrateMasterPlan, store.AutoMigrateWeeklyPlan, store.AutoMigrateWorkout, store.AutoMigratePlanAdjustment} {
		if err := migrate(ctx); err != nil {
			t.Fatal(err)
		}
	}
	h := newMPHarness(t)
	verifier, err := NewJWTVerifierFromKeyWithAdmin(&h.key.PublicKey, testIssuer, testAudience, testAdminAudience)
	if err != nil {
		t.Fatal(err)
	}
	h.svc = NewService(Config{Auth: NewAuthenticator(testToken, verifier), MasterPlanStore: store, Jobs: store.Jobs()})
	uid := uuid.NewString()
	start := timefmt.ShanghaiWeekStart(time.Now()).AddDate(0, 0, 7)
	weekStart := start.Format("2006-01-02")
	weekName := weekStart + "_" + start.AddDate(0, 0, 6).Format("01-02")
	content := mustAppliedContent(t, uuid.NewString())
	content["master_plan_id"] = uuid.NewString()
	alignCandidateSeason(content, start)
	doc := rollingWeeklyPlanDoc(weekName)
	doc["week_index"] = 1
	content["weekly_docs"] = []any{doc}
	jobID := registerMySQLCandidate(t, store, uid, content)
	body := map[string]any{"content": content, "apply_token": jobID}
	first := doApplyFromContent(t, h, h.bearer(t, uid), body)
	if first.Code != 201 {
		t.Fatalf("first apply: %d %s", first.Code, first.Body.String())
	}
	plan, err := store.GetCurrentMasterPlan(ctx, uid)
	if err != nil || plan == nil {
		t.Fatalf("current plan=%+v err=%v", plan, err)
	}
	week, err := store.GetActiveWeeklyPlan(ctx, uid, weekStart)
	if err != nil || week == nil || week.MasterPlanID == nil || *week.MasterPlanID != plan.PlanID {
		t.Fatalf("week=%+v plan=%+v err=%v", week, plan, err)
	}
	workouts, err := store.ListPlanSessions(ctx, uid, weekStart, start.AddDate(0, 0, 6).Format("2006-01-02"))
	if err != nil || len(workouts) != 2 {
		t.Fatalf("workouts=%+v err=%v", workouts, err)
	}
	again := doApplyFromContent(t, h, h.bearer(t, uid), body)
	if again.Code != 201 {
		t.Fatalf("replay: %d %s", again.Code, again.Body.String())
	}
	replayed, err := store.ListPlanSessions(ctx, uid, weekStart, start.AddDate(0, 0, 6).Format("2006-01-02"))
	if err != nil || len(replayed) != 2 || replayed[0].WorkoutID != workouts[0].WorkoutID {
		t.Fatalf("replayed workouts=%+v err=%v", replayed, err)
	}
}

func TestMasterPlanCurrentWeekReplacementMySQLE2E(t *testing.T) {
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("set STRIDE_WORKER_TEST_MYSQL_DSN")
	}
	today := timefmt.ShanghaiToday()
	if today.Weekday() == time.Sunday {
		t.Skip("no future day in current week")
	}
	store, err := storage.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	ctx := t.Context()
	for _, migrate := range []func(context.Context) error{store.AutoMigrate, store.AutoMigrateMasterPlan, store.AutoMigrateWeeklyPlan, store.AutoMigrateWorkout, store.AutoMigratePlanAdjustment} {
		if err := migrate(ctx); err != nil {
			t.Fatal(err)
		}
	}
	h := newMPHarness(t)
	verifier, err := NewJWTVerifierFromKeyWithAdmin(&h.key.PublicKey, testIssuer, testAudience, testAdminAudience)
	if err != nil {
		t.Fatal(err)
	}
	h.svc = NewService(Config{Auth: NewAuthenticator(testToken, verifier), MasterPlanStore: store, Jobs: store.Jobs()})
	uid, goal := uuid.NewString(), uuid.NewString()
	initial := mustAppliedContent(t, goal)
	first := doApplyFromContent(t, h, h.bearer(t, uid), map[string]any{"content": initial, "apply_token": uuid.NewString()})
	if first.Code != 201 {
		t.Fatalf("initial=%d %s", first.Code, first.Body.String())
	}
	old, err := store.GetCurrentMasterPlan(ctx, uid)
	if err != nil || old == nil {
		t.Fatalf("old=%+v err=%v", old, err)
	}
	start := timefmt.ShanghaiWeekStart(time.Now())
	week := start.Format("2006-01-02")
	name := week + "_" + start.AddDate(0, 0, 6).Format("01-02")
	oldDoc := rollingWeeklyPlanDoc(name)
	oldSessions := oldDoc["sessions"].([]any)
	oldSessions[0].(map[string]any)["date"] = today.Format("2006-01-02")
	oldSessions[0].(map[string]any)["summary"] = "existing today"
	oldSessions[1].(map[string]any)["date"] = today.AddDate(0, 0, 1).Format("2006-01-02")
	oldBytes, err := validateAppliedWeeklyPlan(oldDoc, name)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = store.ApplyStructuredWeeklyPlan(ctx, uid, week, string(oldBytes), nil, storage.WeeklyPlanApplyOptions{MasterPlanID: &old.PlanID})
	if err != nil {
		t.Fatal(err)
	}
	before, err := store.ListPlanSessions(ctx, uid, today.Format("2006-01-02"), today.Format("2006-01-02"))
	if err != nil || len(before) != 1 {
		t.Fatalf("before=%+v err=%v", before, err)
	}
	content := mustAppliedContent(t, goal)
	alignCandidateSeason(content, start)
	candidate := rollingWeeklyPlanDoc(name)
	candidate["week_index"] = 1
	sessions := candidate["sessions"].([]any)
	sessions[0].(map[string]any)["date"] = today.AddDate(0, 0, 1).Format("2006-01-02")
	sessions[1].(map[string]any)["date"] = today.Format("2006-01-02")
	content["weekly_docs"] = []any{candidate}
	jobID := registerMySQLCandidate(t, store, uid, content)
	body := map[string]any{"content": content, "apply_token": jobID, "expected_active_plan_id": old.PlanID, "expected_active_revision": *old.Revision}
	response := doApplyFromContent(t, h, h.bearer(t, uid), body)
	if response.Code != 201 {
		t.Fatalf("replace=%d %s", response.Code, response.Body.String())
	}
	after, err := store.ListPlanSessions(ctx, uid, today.Format("2006-01-02"), today.AddDate(0, 0, 1).Format("2006-01-02"))
	if err != nil || len(after) != 2 || after[0].WorkoutID != before[0].WorkoutID || after[0].Name != "existing today" || after[1].Name != "Easy run" {
		t.Fatalf("before=%+v after=%+v err=%v", before, after, err)
	}
}

func registerMySQLCandidate(t *testing.T, store *storage.Store, uid string, content map[string]any) string {
	t.Helper()
	id := uuid.NewString()
	content["candidate_job_id"], content["candidate_user_id"] = id, uid
	result, err := json.Marshal(map[string]any{"content": content})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	entry := &job.Job{ID: id, UserID: uid, Type: "generate_master_plan", Status: job.StatusDone, ResultJSON: string(result), CreatedAt: now, UpdatedAt: now}
	if err := store.Jobs().Create(t.Context(), entry); err != nil {
		t.Fatal(err)
	}
	return id
}
