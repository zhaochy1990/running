package storage

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestPutWeeklyFeedbackUpsertsIsolatedUserWeek(t *testing.T) {
	store := openTestStore(t)
	ctx := context.Background()
	if err := store.AutoMigrateWeeklyFeedback(ctx); err != nil {
		t.Fatalf("automigrate: %v", err)
	}
	userID, otherUser := uuid.NewString(), uuid.NewString()
	weekStart := "2026-07-27"
	first, err := store.PutWeeklyFeedback(ctx, userID, weekStart, "first")
	if err != nil {
		t.Fatalf("first put: %v", err)
	}
	oldUpdatedAt := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	if err := store.db.Model(&WeeklyFeedback{}).
		Where("user_id = ? AND week_start = ?", userID, weekStart).
		Update("updated_at", oldUpdatedAt).Error; err != nil {
		t.Fatalf("backdate updated_at: %v", err)
	}
	second, err := store.PutWeeklyFeedback(ctx, userID, weekStart, "")
	if err != nil {
		t.Fatalf("second put: %v", err)
	}
	other, err := store.PutWeeklyFeedback(ctx, otherUser, weekStart, "other")
	if err != nil {
		t.Fatalf("other put: %v", err)
	}
	if second.ContentMD != "" || !second.CreatedAt.Equal(first.CreatedAt) || !second.UpdatedAt.After(oldUpdatedAt) {
		t.Fatalf("upsert first=%+v second=%+v", first, second)
	}
	if other.UserID != otherUser || other.ContentMD != "other" {
		t.Fatalf("tenant isolation=%+v", other)
	}
	var count int64
	if err := store.db.Model(&WeeklyFeedback{}).Where("user_id = ? AND week_start = ?", userID, weekStart).Count(&count).Error; err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("rows=%d want 1", count)
	}
}

func TestPutWeeklyFeedbackRejectsInvalidWeekStart(t *testing.T) {
	store := openTestStore(t)
	for _, weekStart := range []string{"not-a-date", "2026-07-28"} {
		if _, err := store.PutWeeklyFeedback(context.Background(), uuid.NewString(), weekStart, "x"); err == nil {
			t.Fatalf("week_start %q must fail", weekStart)
		}
	}
}
