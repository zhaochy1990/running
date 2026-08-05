package storage

import (
	"context"
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
