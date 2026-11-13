package storage

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// Uses the real isolated MySQL store: a failure in the second week must also
// roll back the season transition and the first week's workout materialization.
func TestMasterPlanInitialWeeksCommitOrRollbackTogether(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	migrateBatchWeeklyPlans(t, st)
	ctx := context.Background()
	if err := st.AutoMigratePlanAdjustment(ctx); err != nil {
		t.Fatal(err)
	}
	uid, goal := uuid.NewString(), uuid.NewString()
	old, _, err := st.ApplyStructuredMasterPlan(ctx, uid, goal, `{"goal":{}}`, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	week1 := timefmt.ShanghaiWeekStart(time.Now()).AddDate(0, 0, 7).Format("2006-01-02")
	week2 := timefmt.ShanghaiWeekStart(time.Now()).AddDate(0, 0, 14).Format("2006-01-02")
	previous := seedBatchWeek(t, st, uid, old.PlanID, week2, week2, "old")
	items := []WeeklyPlanBatchItem{
		{WeekStart: week1, Content: batchWeeklyContent(week1, week1, "new first")},
		{WeekStart: week2, Content: batchWeeklyContent(week2, week2, "new second"), Replacement: &WeeklyPlanReplacement{PlanID: previous.PlanID, Revision: previous.Revision + 1}},
	}
	token := uuid.NewString()
	replacement := &MasterPlanReplacement{PlanID: old.PlanID, Revision: *old.Revision}
	_, _, err = st.ApplyStructuredMasterPlanWithWeeks(ctx, uid, goal, `{"goal":{}}`, token, replacement, items)
	if !errors.Is(err, ErrWeeklyPlanConflict) {
		t.Fatalf("error = %v, want week conflict", err)
	}
	current, err := st.GetCurrentMasterPlan(ctx, uid)
	if err != nil || current.PlanID != old.PlanID {
		t.Fatalf("current = %+v, err=%v", current, err)
	}
	first, err := st.GetActiveWeeklyPlan(ctx, uid, week1)
	if err != nil || first != nil {
		t.Fatalf("first week = %+v, err=%v", first, err)
	}
	oldWeek, err := st.GetActiveWeeklyPlan(ctx, uid, week2)
	if err != nil || oldWeek.PlanID != previous.PlanID {
		t.Fatalf("old week = %+v, err=%v", oldWeek, err)
	}
	workouts, err := st.ListPlanSessions(ctx, uid, week1, week2)
	if err != nil || len(workouts) != 1 || workouts[0].Name != "old" {
		t.Fatalf("workouts = %+v, err=%v", workouts, err)
	}

	items[1].Replacement.Revision = previous.Revision
	created, _, err := st.ApplyStructuredMasterPlanWithWeeks(ctx, uid, goal, `{"goal":{}}`, token, replacement, items)
	if err != nil {
		t.Fatal(err)
	}
	for _, day := range []string{week1, week2} {
		week, err := st.GetActiveWeeklyPlan(ctx, uid, day)
		if err != nil || week == nil || week.MasterPlanID == nil || *week.MasterPlanID != created.PlanID {
			t.Fatalf("week %s = %+v, err=%v", day, week, err)
		}
	}
	workouts, err = st.ListPlanSessions(ctx, uid, week1, week2)
	if err != nil || len(workouts) != 2 {
		t.Fatalf("workouts = %+v, err=%v", workouts, err)
	}
	replayed, _, err := st.ApplyStructuredMasterPlanWithWeeks(ctx, uid, goal, `{"goal":{}}`, token, replacement, items)
	if err != nil || replayed.PlanID != created.PlanID {
		t.Fatalf("replay = %+v, err=%v", replayed, err)
	}
	again, err := st.ListPlanSessions(ctx, uid, week1, week2)
	if err != nil || len(again) != 2 || again[0].WorkoutID != workouts[0].WorkoutID {
		t.Fatalf("replayed workouts = %+v, err=%v", again, err)
	}
}

func TestMasterPlanInitialWeekPreservesPastWorkoutIdentity(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	migrateBatchWeeklyPlans(t, st)
	ctx := context.Background()
	if err := st.AutoMigratePlanAdjustment(ctx); err != nil {
		t.Fatal(err)
	}
	uid, goal := uuid.NewString(), uuid.NewString()
	old, _, err := st.ApplyStructuredMasterPlan(ctx, uid, goal, `{"goal":{}}`, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	today := timefmt.ShanghaiToday()
	if today.Weekday() == time.Sunday {
		t.Skip("no future day left in current week")
	}
	start := timefmt.ShanghaiWeekStart(time.Now()).Format("2006-01-02")
	day := today.Format("2006-01-02")
	previous := seedBatchWeek(t, st, uid, old.PlanID, start, day, "preserved")
	before, err := st.ListPlanSessions(ctx, uid, day, day)
	if err != nil || len(before) != 1 {
		t.Fatalf("before = %+v, err=%v", before, err)
	}
	item := WeeklyPlanBatchItem{WeekStart: start, Content: batchWeeklyContent(start, day, "preserved"), Replacement: &WeeklyPlanReplacement{PlanID: previous.PlanID, Revision: previous.Revision}, ProtectThrough: day}
	_, _, err = st.ApplyStructuredMasterPlanWithWeeks(ctx, uid, goal, `{"goal":{}}`, "", &MasterPlanReplacement{PlanID: old.PlanID, Revision: *old.Revision}, []WeeklyPlanBatchItem{item})
	if err != nil {
		t.Fatal(err)
	}
	after, err := st.ListPlanSessions(ctx, uid, day, day)
	if err != nil || len(after) != 1 || after[0].WorkoutID != before[0].WorkoutID || after[0].UpdatedAt != before[0].UpdatedAt {
		t.Fatalf("after = %+v, before=%+v, err=%v", after, before, err)
	}
}

func TestMasterPlanInitialWeeksCollisionKeepsPlanIDsConsistent(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	migrateBatchWeeklyPlans(t, st)
	ctx := context.Background()
	if err := st.AutoMigratePlanAdjustment(ctx); err != nil {
		t.Fatal(err)
	}
	goal := uuid.NewString()
	taken, _, err := st.ApplyStructuredMasterPlan(ctx, uuid.NewString(), goal, `{"goal":{}}`, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	content := `{"master_plan_id":"` + taken.PlanID + `","goal":{},"weekly_docs":[]}`
	created, _, err := st.ApplyStructuredMasterPlanWithWeeks(ctx, uuid.NewString(), goal, content, "", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(created.Content), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["master_plan_id"] != created.PlanID {
		t.Fatalf("content id=%v row id=%s", decoded["master_plan_id"], created.PlanID)
	}
}

func TestMasterPlanSwitchKeepsCurrentHistoryAndRemovesOnlyOldFuture(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	migrateBatchWeeklyPlans(t, st)
	ctx := context.Background()
	if err := st.AutoMigratePlanAdjustment(ctx); err != nil {
		t.Fatal(err)
	}
	uid, goal := uuid.NewString(), uuid.NewString()
	old, _, err := st.ApplyStructuredMasterPlan(ctx, uid, goal, `{"goal":{}}`, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	today := timefmt.ShanghaiToday().Format("2006-01-02")
	current := timefmt.ShanghaiWeekStart(time.Now()).Format("2006-01-02")
	future := timefmt.ShanghaiWeekStart(time.Now()).AddDate(0, 0, 7).Format("2006-01-02")
	other := timefmt.ShanghaiWeekStart(time.Now()).AddDate(0, 0, 14).Format("2006-01-02")
	previous := seedBatchWeek(t, st, uid, old.PlanID, current, today, "history")
	seedBatchWeek(t, st, uid, old.PlanID, future, future, "old future")
	independent := seedBatchWeek(t, st, uid, uuid.NewString(), other, other, "independent")
	_, _, err = st.ApplyStructuredMasterPlanWithWeeks(ctx, uid, goal, `{"goal":{}}`, "", &MasterPlanReplacement{PlanID: old.PlanID, Revision: *old.Revision}, nil)
	if err != nil {
		t.Fatal(err)
	}
	kept, _ := st.GetActiveWeeklyPlan(ctx, uid, current)
	deleted, _ := st.GetActiveWeeklyPlan(ctx, uid, future)
	untouched, _ := st.GetActiveWeeklyPlan(ctx, uid, other)
	if kept == nil || kept.PlanID != previous.PlanID || deleted != nil || untouched == nil || untouched.PlanID != independent.PlanID {
		t.Fatalf("current=%+v future=%+v other=%+v", kept, deleted, untouched)
	}
	history, err := st.ListPlanSessions(ctx, uid, today, today)
	if err != nil || len(history) != 1 || history[0].Name != "history" {
		t.Fatalf("history=%+v err=%v", history, err)
	}
	oldFuture, err := st.ListPlanSessions(ctx, uid, future, future)
	if err != nil || len(oldFuture) != 0 {
		t.Fatalf("future=%+v err=%v", oldFuture, err)
	}
}

func TestMasterPlanSwitchRejectsUnconfirmedOtherPlanWeek(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	migrateBatchWeeklyPlans(t, st)
	ctx := context.Background()
	if err := st.AutoMigratePlanAdjustment(ctx); err != nil {
		t.Fatal(err)
	}
	uid, goal := uuid.NewString(), uuid.NewString()
	old, _, err := st.ApplyStructuredMasterPlan(ctx, uid, goal, `{"goal":{}}`, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	week := timefmt.ShanghaiWeekStart(time.Now()).AddDate(0, 0, 7).Format("2006-01-02")
	other := seedBatchWeek(t, st, uid, uuid.NewString(), week, week, "independent")
	items := []WeeklyPlanBatchItem{{WeekStart: week, Content: batchWeeklyContent(week, week, "new"), Replacement: &WeeklyPlanReplacement{PlanID: other.PlanID, Revision: other.Revision}}}
	_, _, err = st.ApplyStructuredMasterPlanWithWeeks(ctx, uid, goal, `{"goal":{}}`, "", &MasterPlanReplacement{PlanID: old.PlanID, Revision: *old.Revision}, items)
	if !errors.Is(err, ErrWeeklyPlanMasterPlanConflict) {
		t.Fatalf("error = %v", err)
	}
	current, err := st.GetCurrentMasterPlan(ctx, uid)
	if err != nil || current.PlanID != old.PlanID {
		t.Fatalf("current=%+v err=%v", current, err)
	}
}

func TestMasterPlanSwitchRejectsOrphanFutureWorkouts(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	migrateBatchWeeklyPlans(t, st)
	ctx := context.Background()
	if err := st.AutoMigratePlanAdjustment(ctx); err != nil {
		t.Fatal(err)
	}
	uid, goal := uuid.NewString(), uuid.NewString()
	old, _, err := st.ApplyStructuredMasterPlan(ctx, uid, goal, `{"goal":{}}`, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	week := timefmt.ShanghaiWeekStart(time.Now()).AddDate(0, 0, 7).Format("2006-01-02")
	prior := seedBatchWeek(t, st, uid, old.PlanID, week, week, "orphan")
	if err := st.db.WithContext(ctx).Where("plan_id = ?", prior.PlanID).Delete(&WeeklyPlan{}).Error; err != nil {
		t.Fatal(err)
	}
	items := []WeeklyPlanBatchItem{{WeekStart: week, Content: batchWeeklyContent(week, week, "new")}}
	_, _, err = st.ApplyStructuredMasterPlanWithWeeks(ctx, uid, goal, `{"goal":{}}`, "", &MasterPlanReplacement{PlanID: old.PlanID, Revision: *old.Revision}, items)
	if !errors.Is(err, ErrWeeklyPlanConflict) {
		t.Fatalf("error=%v, want conflict", err)
	}
	rows, err := st.ListPlanSessions(ctx, uid, week, week)
	if err != nil || len(rows) != 1 || rows[0].Name != "orphan" {
		t.Fatalf("workouts=%+v err=%v", rows, err)
	}
}

func TestMasterPlanSwitchRollsBackWhenAdjustmentCleanupFails(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	migrateBatchWeeklyPlans(t, st)
	ctx := context.Background()
	if err := st.AutoMigratePlanAdjustment(ctx); err != nil {
		t.Fatal(err)
	}
	uid, goal := uuid.NewString(), uuid.NewString()
	old, _, err := st.ApplyStructuredMasterPlan(ctx, uid, goal, `{"goal":{}}`, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	week := timefmt.ShanghaiWeekStart(time.Now()).AddDate(0, 0, 7).Format("2006-01-02")
	prior := seedBatchWeek(t, st, uid, old.PlanID, week, week, "old")
	proposal, err := st.UpsertPendingAdjustment(ctx, uid, old.PlanID, week, "no_time", "question", `{"v":1}`)
	if err != nil {
		t.Fatal(err)
	}
	trigger := "trg_master_fail_" + strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	sqlDB, err := st.db.DB()
	if err != nil {
		t.Fatal(err)
	}
	statement := "CREATE TRIGGER " + trigger + " BEFORE UPDATE ON plan_adjustment FOR EACH ROW BEGIN IF NEW.status = 'superseded' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'induced failure'; END IF; END"
	if _, err := sqlDB.ExecContext(ctx, statement); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = sqlDB.ExecContext(context.Background(), "DROP TRIGGER IF EXISTS "+trigger) })
	items := []WeeklyPlanBatchItem{{WeekStart: week, Content: batchWeeklyContent(week, week, "new"), Replacement: &WeeklyPlanReplacement{PlanID: prior.PlanID, Revision: prior.Revision}}}
	_, _, err = st.ApplyStructuredMasterPlanWithWeeks(ctx, uid, goal, `{"goal":{}}`, "", &MasterPlanReplacement{PlanID: old.PlanID, Revision: *old.Revision}, items)
	if err == nil {
		t.Fatal("expected cleanup failure")
	}
	current, err := st.GetCurrentMasterPlan(ctx, uid)
	if err != nil || current.PlanID != old.PlanID {
		t.Fatalf("current=%+v err=%v", current, err)
	}
	currentWeek, err := st.GetActiveWeeklyPlan(ctx, uid, week)
	if err != nil || currentWeek == nil || currentWeek.PlanID != prior.PlanID {
		t.Fatalf("week=%+v err=%v", currentWeek, err)
	}
	workouts, err := st.ListPlanSessions(ctx, uid, week, week)
	if err != nil || len(workouts) != 1 || workouts[0].Name != "old" {
		t.Fatalf("workouts=%+v err=%v", workouts, err)
	}
	stored, err := st.GetAdjustmentByID(ctx, uid, proposal.ID)
	if err != nil || stored.Status != PlanAdjustmentStatusPending {
		t.Fatalf("proposal=%+v err=%v", stored, err)
	}
}

// A completed job may be changed by an internal transition after the API has
// read it. The transaction must reject that stale confirmation before writing.
func TestMasterPlanRejectsChangedCandidateJob(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	migrateBatchWeeklyPlans(t, st)
	ctx := context.Background()
	if err := st.AutoMigrate(ctx); err != nil {
		t.Fatal(err)
	}
	uid, goal, id := uuid.NewString(), uuid.NewString(), uuid.NewString()
	content := fmt.Sprintf(`{"candidate_job_id":%q,"candidate_user_id":%q,"weekly_docs":[],"goal":{}}`, id, uid)
	result := fmt.Sprintf(`{"content":%s}`, content)
	row := jobModel{ID: id, UserID: &uid, Type: "generate_master_plan", Status: "done", ResultJSON: result, CreatedAt: time.Now(), UpdatedAt: time.Now()}
	if err := st.db.Create(&row).Error; err != nil {
		t.Fatal(err)
	}
	if err := st.db.Model(&row).Update("result_json", `{"content":{"changed":true}}`).Error; err != nil {
		t.Fatal(err)
	}
	_, _, err := st.ApplyStructuredMasterPlanWithWeeks(ctx, uid, goal, content, id, nil, []WeeklyPlanBatchItem{})
	if !errors.Is(err, ErrMasterPlanConflict) {
		t.Fatalf("changed candidate: %v", err)
	}
	current, err := st.GetCurrentMasterPlan(ctx, uid)
	if err != nil || current != nil {
		t.Fatalf("current=%+v err=%v", current, err)
	}
}

// A merge prepared on the prior Shanghai day must not commit on the new day.
func TestMasterPlanRejectsStaleActivationDay(t *testing.T) {
	st := openTestStore(t)
	migrateMasterPlan(t, st)
	migrateBatchWeeklyPlans(t, st)
	ctx := context.Background()
	uid, goal := uuid.NewString(), uuid.NewString()
	old, _, err := st.ApplyStructuredMasterPlan(ctx, uid, goal, `{"goal":{}}`, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	yesterday := timefmt.ShanghaiToday().AddDate(0, 0, -1).Format("2006-01-02")
	replacement := &MasterPlanReplacement{PlanID: old.PlanID, Revision: *old.Revision}
	_, _, err = st.ApplyStructuredMasterPlanWithWeeks(ctx, uid, goal, `{"goal":{}}`, uuid.NewString(), replacement, []WeeklyPlanBatchItem{}, yesterday)
	if !errors.Is(err, ErrMasterPlanConflict) {
		t.Fatalf("stale day err=%v", err)
	}
	current, err := st.GetCurrentMasterPlan(ctx, uid)
	if err != nil || current == nil || current.PlanID != old.PlanID {
		t.Fatalf("current=%+v err=%v", current, err)
	}
}
