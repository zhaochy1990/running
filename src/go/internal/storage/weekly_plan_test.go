package storage

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func migrateWeeklyPlan(t *testing.T, store *Store) {
	t.Helper()
	if err := store.AutoMigrateWeeklyPlan(context.Background()); err != nil {
		t.Fatalf("automigrate weekly_plan: %v", err)
	}
}

func weeklyPlanRow(userID, weekStart, status string) *WeeklyPlan {
	slot := status
	if status == WeeklyPlanStatusArchived {
		slot = ""
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	row := &WeeklyPlan{
		PlanID: uuid.NewString(), UserID: userID, WeekStart: weekStart,
		ContentVersion: WeeklyPlanContentStructured,
		Content:        `{"sessions":[],"nutrition":[]}`,
		Status:         status, Revision: 1, CreatedAt: now, UpdatedAt: now,
	}
	if slot != "" {
		row.StatusSlot = &slot
	}
	return row
}

func seedWeeklyPlan(t *testing.T, store *Store, row *WeeklyPlan) {
	t.Helper()
	if err := store.db.WithContext(context.Background()).Create(row).Error; err != nil {
		t.Fatalf("seed weekly plan: %v", err)
	}
}

func TestWeeklyPlanReadsReturnOnlyActiveRows(t *testing.T) {
	store := openTestStore(t)
	migrateWeeklyPlan(t, store)
	userID := uuid.NewString()
	otherUser := uuid.NewString()

	older := weeklyPlanRow(userID, "2026-07-20", WeeklyPlanStatusActive)
	newer := weeklyPlanRow(userID, "2026-07-27", WeeklyPlanStatusActive)
	seedWeeklyPlan(t, store, older)
	seedWeeklyPlan(t, store, newer)
	seedWeeklyPlan(t, store, weeklyPlanRow(userID, "2026-07-27", WeeklyPlanStatusDraft))
	seedWeeklyPlan(t, store, weeklyPlanRow(userID, "2026-07-27", WeeklyPlanStatusArchived))
	seedWeeklyPlan(t, store, weeklyPlanRow(otherUser, "2026-07-27", WeeklyPlanStatusActive))

	plans, err := store.ListActiveWeeklyPlans(context.Background(), userID)
	if err != nil {
		t.Fatalf("list active: %v", err)
	}
	if len(plans) != 2 || plans[0].PlanID != newer.PlanID || plans[1].PlanID != older.PlanID {
		t.Fatalf("active plans=%+v", plans)
	}

	plan, err := store.GetActiveWeeklyPlan(context.Background(), userID, "2026-07-27")
	if err != nil || plan == nil || plan.PlanID != newer.PlanID {
		t.Fatalf("get active: plan=%+v err=%v", plan, err)
	}
	missing, err := store.GetActiveWeeklyPlan(context.Background(), userID, "2026-08-03")
	if err != nil || missing != nil {
		t.Fatalf("missing active: plan=%+v err=%v", missing, err)
	}
}

func TestListWeekSummariesFiltersMasterPlanAndAggregatesShanghaiWeek(t *testing.T) {
	store := openWatchTestStore(t)
	migrateWeeklyPlan(t, store)
	if err := store.AutoMigrateWeeklyFeedback(context.Background()); err != nil {
		t.Fatalf("automigrate feedback: %v", err)
	}
	userID := uuid.NewString()
	masterID := uuid.NewString()
	otherMasterID := uuid.NewString()
	week := weeklyPlanRow(userID, "2026-07-27", WeeklyPlanStatusActive)
	week.MasterPlanID = &masterID
	seedWeeklyPlan(t, store, week)
	other := weeklyPlanRow(userID, "2026-08-03", WeeklyPlanStatusActive)
	other.MasterPlanID = &otherMasterID
	seedWeeklyPlan(t, store, other)
	distance := 5000.0
	duration := 1800.0
	seedActivity(t, store, userID, &Activity{
		LabelID: "week-activity", Date: time.Date(2026, 7, 26, 16, 30, 0, 0, time.UTC),
		DistanceM: &distance, DurationS: &duration,
	}, nil, nil, nil)
	seedActivity(t, store, userID, &Activity{
		LabelID: "activity-only", Date: time.Date(2026, 7, 19, 16, 0, 0, 0, time.UTC),
		DistanceM: &distance, DurationS: &duration,
	}, nil, nil, nil)
	if _, err := store.PutWeeklyFeedback(context.Background(), userID, "2026-07-13", "feedback-only"); err != nil {
		t.Fatalf("put feedback-only: %v", err)
	}

	weeks, err := store.ListWeekSummaries(context.Background(), userID, masterID)
	if err != nil {
		t.Fatalf("list summaries: %v", err)
	}
	if len(weeks) != 1 {
		t.Fatalf("weeks=%+v", weeks)
	}
	got := weeks[0]
	if got.PlanID != week.PlanID || got.ActivityCount != 1 || got.TotalKM != 5 || got.TotalDurationS != 1800 {
		t.Fatalf("summary=%+v", got)
	}
}

func TestListWeekSummariesReturnsUnfilteredSourceUnion(t *testing.T) {
	store := openWatchTestStore(t)
	migrateWeeklyPlan(t, store)
	if err := store.AutoMigrateWeeklyFeedback(context.Background()); err != nil {
		t.Fatalf("automigrate feedback: %v", err)
	}
	userID, otherUser := uuid.NewString(), uuid.NewString()
	plan := weeklyPlanRow(userID, "2026-08-03", WeeklyPlanStatusActive)
	seedWeeklyPlan(t, store, plan)
	seedWeeklyPlan(t, store, weeklyPlanRow(userID, "2026-07-27", WeeklyPlanStatusDraft))
	distance, duration := 5000.0, 1800.0
	seedActivity(t, store, userID, &Activity{
		LabelID: "shanghai-monday", Date: time.Date(2026, 7, 26, 16, 0, 0, 0, time.UTC),
		DistanceM: &distance, DurationS: &duration,
	}, nil, nil, nil)
	if _, err := store.PutWeeklyFeedback(context.Background(), userID, "2026-07-20", "done"); err != nil {
		t.Fatalf("put feedback: %v", err)
	}
	if _, err := store.PutWeeklyFeedback(context.Background(), userID, "2026-07-13", ""); err != nil {
		t.Fatalf("put empty feedback: %v", err)
	}
	if _, err := store.PutWeeklyFeedback(context.Background(), otherUser, "2026-07-06", "private"); err != nil {
		t.Fatalf("put other feedback: %v", err)
	}
	otherPlan := weeklyPlanRow(otherUser, "2026-06-29", WeeklyPlanStatusActive)
	seedWeeklyPlan(t, store, otherPlan)
	seedActivity(t, store, otherUser, &Activity{
		LabelID: "other-activity", Date: time.Date(2026, 6, 29, 1, 0, 0, 0, time.UTC),
		DistanceM: &distance, DurationS: &duration,
	}, nil, nil, nil)

	weeks, err := store.ListWeekSummaries(context.Background(), userID, "")
	if err != nil {
		t.Fatalf("list summaries: %v", err)
	}
	if len(weeks) != 4 {
		t.Fatalf("weeks=%+v", weeks)
	}
	if weeks[0].WeekStart != "2026-08-03" || weeks[0].PlanID != plan.PlanID {
		t.Fatalf("plan week=%+v", weeks[0])
	}
	if weeks[1].WeekStart != "2026-07-27" || weeks[1].PlanID != "" || weeks[1].ActivityCount != 1 || weeks[1].TotalKM != 5 {
		t.Fatalf("activity week=%+v", weeks[1])
	}
	if weeks[2].WeekStart != "2026-07-20" || !weeks[2].FeedbackRowExists || !weeks[2].HasFeedback {
		t.Fatalf("feedback week=%+v", weeks[2])
	}
	if weeks[3].WeekStart != "2026-07-13" || !weeks[3].FeedbackRowExists || weeks[3].HasFeedback {
		t.Fatalf("empty feedback week=%+v", weeks[3])
	}
}

func TestListWeekActivitiesUsesShanghaiDatesAndChronologicalOrder(t *testing.T) {
	store := openWatchTestStore(t)
	userID := uuid.NewString()
	otherUser := uuid.NewString()
	distance := 5000.0
	seedActivity(t, store, userID, &Activity{
		LabelID: "late", Date: time.Date(2026, 8, 2, 15, 59, 0, 0, time.UTC), DistanceM: &distance,
	}, nil, nil, nil)
	seedActivity(t, store, userID, &Activity{
		LabelID: "early", Date: time.Date(2026, 7, 26, 16, 0, 0, 0, time.UTC), DistanceM: &distance,
	}, nil, nil, nil)
	seedActivity(t, store, userID, &Activity{
		LabelID: "outside", Date: time.Date(2026, 8, 2, 16, 0, 0, 0, time.UTC), DistanceM: &distance,
	}, nil, nil, nil)
	seedActivity(t, store, otherUser, &Activity{
		LabelID: "other", Date: time.Date(2026, 7, 27, 1, 0, 0, 0, time.UTC), DistanceM: &distance,
	}, nil, nil, nil)

	rows, err := store.ListWeekActivities(context.Background(), userID, "2026-07-27", "2026-08-02")
	if err != nil {
		t.Fatalf("list week activities: %v", err)
	}
	if len(rows) != 2 || rows[0].LabelID != "early" || rows[1].LabelID != "late" {
		t.Fatalf("activities=%+v", rows)
	}
}

func TestWeeklyPlanStatusSlotsAreUniquePerWeek(t *testing.T) {
	store := openTestStore(t)
	migrateWeeklyPlan(t, store)
	userID := uuid.NewString()

	seedWeeklyPlan(t, store, weeklyPlanRow(userID, "2026-07-27", WeeklyPlanStatusActive))
	if err := store.db.Create(weeklyPlanRow(userID, "2026-07-27", WeeklyPlanStatusActive)).Error; !isDuplicateKey(err) {
		t.Fatalf("second active must be duplicate key, got %v", err)
	}

	seedWeeklyPlan(t, store, weeklyPlanRow(userID, "2026-07-27", WeeklyPlanStatusDraft))
	if err := store.db.Create(weeklyPlanRow(userID, "2026-07-27", WeeklyPlanStatusDraft)).Error; !isDuplicateKey(err) {
		t.Fatalf("second draft must be duplicate key, got %v", err)
	}

	seedWeeklyPlan(t, store, weeklyPlanRow(userID, "2026-07-27", WeeklyPlanStatusArchived))
	seedWeeklyPlan(t, store, weeklyPlanRow(userID, "2026-07-27", WeeklyPlanStatusArchived))
}

func TestWeeklyPlanCheckConstraints(t *testing.T) {
	store := openTestStore(t)
	migrateWeeklyPlan(t, store)

	invalidJSON := weeklyPlanRow(uuid.NewString(), "2026-07-27", WeeklyPlanStatusActive)
	invalidJSON.Content = "not-json"
	if err := store.db.Create(invalidJSON).Error; err == nil {
		t.Fatal("structured content must be valid JSON")
	}

	invalidRevision := weeklyPlanRow(uuid.NewString(), "2026-07-27", WeeklyPlanStatusActive)
	invalidRevision.Revision = 0
	if err := store.db.Create(invalidRevision).Error; err == nil {
		t.Fatal("revision must be at least 1")
	}

	invalidSlot := weeklyPlanRow(uuid.NewString(), "2026-07-27", WeeklyPlanStatusActive)
	draftSlot := WeeklyPlanStatusDraft
	invalidSlot.StatusSlot = &draftSlot
	if err := store.db.Create(invalidSlot).Error; err == nil {
		t.Fatal("status_slot must match status")
	}

	missingSlot := weeklyPlanRow(uuid.NewString(), "2026-07-27", WeeklyPlanStatusActive)
	missingSlot.StatusSlot = nil
	if err := store.db.Create(missingSlot).Error; err == nil {
		t.Fatal("active rows must carry a non-null status_slot")
	}
}

func TestApplyStructuredWeeklyPlanCreatesAndReplacesAtomically(t *testing.T) {
	store := openTestStore(t)
	migrateWeeklyPlan(t, store)
	ctx := context.Background()
	userID := uuid.NewString()
	weekStart := "2026-08-17"
	content := "{\"schema\":\"weekly-plan/v1\",\"week_folder\":\"2026-08-17_08-23\",\"sessions\":[],\"nutrition\":[]}"

	first, replaced, err := store.ApplyStructuredWeeklyPlan(ctx, userID, weekStart, content, false)
	if err != nil || replaced != nil || first == nil || first.Status != WeeklyPlanStatusActive || first.Revision != 1 {
		t.Fatalf("first=%+v replaced=%+v err=%v", first, replaced, err)
	}
	if _, _, err := store.ApplyStructuredWeeklyPlan(ctx, userID, weekStart, content, false); !errors.Is(err, ErrWeeklyPlanExists) {
		t.Fatalf("apply without replacement err=%v", err)
	}

	second, replaced, err := store.ApplyStructuredWeeklyPlan(ctx, userID, weekStart, content, true)
	if err != nil || replaced == nil || replaced.PlanID != first.PlanID || second == nil || second.Revision != 1 {
		t.Fatalf("second=%+v replaced=%+v err=%v", second, replaced, err)
	}
	var rows []WeeklyPlan
	if err := store.db.Where("user_id = ? AND week_start = ?", userID, weekStart).Order("revision").Find(&rows).Error; err != nil {
		t.Fatalf("list rows: %v", err)
	}
	if len(rows) != 2 || rows[0].Status != WeeklyPlanStatusArchived || rows[0].StatusSlot != nil || rows[1].Status != WeeklyPlanStatusActive || rows[1].StatusSlot == nil || *rows[1].StatusSlot != WeeklyPlanStatusActive {
		t.Fatalf("rows=%+v", rows)
	}
}

func TestApplyStructuredWeeklyPlanRejectsNonMonday(t *testing.T) {
	store := openTestStore(t)
	migrateWeeklyPlan(t, store)
	userID := uuid.NewString()
	if _, _, err := store.ApplyStructuredWeeklyPlan(context.Background(), userID, "2026-08-18", "{}", false); err == nil {
		t.Fatal("non-Monday week_start must fail")
	}
}

func TestApplyStructuredWeeklyPlanConcurrentFirstApplyReturnsConflict(t *testing.T) {
	store := openTestStore(t)
	migrateWeeklyPlan(t, store)
	ctx := context.Background()
	userID := uuid.NewString()
	content := "{\"schema\":\"weekly-plan/v1\",\"week_folder\":\"2026-08-17_08-23\",\"sessions\":[],\"nutrition\":[]}"
	start := make(chan struct{})
	errs := make(chan error, 2)
	for range 2 {
		go func() {
			<-start
			_, _, err := store.ApplyStructuredWeeklyPlan(ctx, userID, "2026-08-17", content, false)
			errs <- err
		}()
	}
	close(start)

	var successes, conflicts int
	for range 2 {
		err := <-errs
		switch {
		case err == nil:
			successes++
		case errors.Is(err, ErrWeeklyPlanExists):
			conflicts++
		default:
			t.Fatalf("concurrent apply returned unexpected error: %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("successes=%d conflicts=%d, want 1 each", successes, conflicts)
	}
}
