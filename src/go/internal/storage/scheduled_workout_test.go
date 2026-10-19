// Integration tests for the scheduled_workout table (requires a real MySQL via
// STRIDE_WORKER_TEST_MYSQL_DSN; skipped otherwise — same gate as the rest of
// the storage package).
package storage

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestScheduledWorkoutRecordAndSupersede(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateScheduledWorkout(ctx); err != nil {
		t.Fatalf("automigrate scheduled_workout: %v", err)
	}
	// Unique user per run: this suite runs against a long-lived shared local
	// MySQL, so a hardcoded uid would collide with rows left by earlier runs.
	uid := uuid.NewString()
	weekFolder := "2026-08-10"
	t.Cleanup(func() {
		_ = st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&ScheduledWorkout{}).Error
	})

	// No prior row yet.
	prior, err := st.GetLatestScheduledWorkoutForPlanSession(ctx, uid, weekFolder, "2026-08-10", 0)
	if err != nil {
		t.Fatalf("get (empty): %v", err)
	}
	if prior != nil {
		t.Fatalf("expected nil prior, got %+v", prior)
	}

	id1, err := st.RecordPushedScheduledWorkout(ctx, uid, RecordPushedWorkoutInput{
		WeekFolder: weekFolder, PlannedDate: "2026-08-10", SessionIndex: 0,
		PushDate: "2026-08-11", Kind: "run", Name: "[STRIDE] Easy 10K",
		SpecJSON: `{"schema":"run-workout/v1","name":"x","date":"2026-08-11","blocks":[]}`,
		Provider: "coros", ProviderWorkoutID: "R-1",
	})
	if err != nil {
		t.Fatalf("record 1: %v", err)
	}
	if id1 <= 0 {
		t.Fatalf("id1 = %d", id1)
	}

	// Re-push supersedes the prior row.
	priorID := id1
	id2, err := st.RecordPushedScheduledWorkout(ctx, uid, RecordPushedWorkoutInput{
		WeekFolder: weekFolder, PlannedDate: "2026-08-10", SessionIndex: 0,
		PushDate: "2026-08-12", Kind: "run", Name: "[STRIDE] Easy 10K",
		SpecJSON: `{"schema":"run-workout/v1","name":"x","date":"2026-08-12","blocks":[]}`,
		Provider: "coros", ProviderWorkoutID: "R-2",
		PriorID: &priorID,
	})
	if err != nil {
		t.Fatalf("record 2: %v", err)
	}

	// Latest row is the newest; prior must now be superseded.
	latest, err := st.GetLatestScheduledWorkoutForPlanSession(ctx, uid, weekFolder, "2026-08-10", 0)
	if err != nil {
		t.Fatalf("get latest: %v", err)
	}
	if latest == nil || latest.ID != id2 {
		t.Fatalf("latest = %+v, want id %d", latest, id2)
	}
	if latest.Status != ScheduledWorkoutStatusPushed || latest.ProviderWorkoutID == nil || *latest.ProviderWorkoutID != "R-2" {
		t.Errorf("latest row = %+v", latest)
	}
	if latest.PushedAt == nil || latest.PushedAt.After(time.Now()) {
		t.Errorf("pushed_at not stamped: %v", latest.PushedAt)
	}

	var priorRow ScheduledWorkout
	if err := st.db.WithContext(ctx).First(&priorRow, id1).Error; err != nil {
		t.Fatalf("read prior: %v", err)
	}
	if priorRow.Status != ScheduledWorkoutStatusSuperseded {
		t.Errorf("prior status = %q, want superseded", priorRow.Status)
	}

	// A different session index is untouched.
	other, err := st.GetLatestScheduledWorkoutForPlanSession(ctx, uid, weekFolder, "2026-08-10", 1)
	if err != nil {
		t.Fatalf("get other session: %v", err)
	}
	if other != nil {
		t.Errorf("other session unexpectedly found: %+v", other)
	}
}

func TestScheduledWorkoutRejectsNonUUIDUser(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateScheduledWorkout(ctx); err != nil {
		t.Fatalf("automigrate: %v", err)
	}
	_, err := st.RecordPushedScheduledWorkout(ctx, "not-a-uuid", RecordPushedWorkoutInput{
		WeekFolder: "w", PlannedDate: "2026-08-10", SessionIndex: 0,
		PushDate: "2026-08-10", Kind: "run", Name: "x", SpecJSON: "{}",
		Provider: "coros", ProviderWorkoutID: "1",
	})
	if err == nil {
		t.Fatal("expected error for non-UUID user")
	}
}

// Custom-workout pushes carry workout_id as canonical identity; the plan triple
// stays NULL and a re-push supersedes by workout_id (devops#587).
func TestScheduledWorkoutCustomIdentity(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateScheduledWorkout(ctx); err != nil {
		t.Fatalf("automigrate scheduled_workout: %v", err)
	}
	uid := uuid.NewString()
	t.Cleanup(func() {
		_ = st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&ScheduledWorkout{}).Error
	})

	if prior, err := st.GetLatestScheduledWorkoutForWorkout(ctx, uid, "w-1"); err != nil || prior != nil {
		t.Fatalf("get (empty): %v %+v", err, prior)
	}
	id1, err := st.RecordPushedScheduledWorkout(ctx, uid, RecordPushedWorkoutInput{
		WorkoutID: "w-1", PushDate: "2026-08-12", Kind: "run", Name: "[STRIDE] 4km×3组",
		SpecJSON: `{"schema":"run-workout/v1"}`, Provider: "coros", ProviderWorkoutID: "R-1",
	})
	if err != nil {
		t.Fatalf("record 1: %v", err)
	}
	row, err := st.GetLatestScheduledWorkoutForWorkout(ctx, uid, "w-1")
	if err != nil || row == nil || row.ID != id1 {
		t.Fatalf("get latest: %v %+v", err, row)
	}
	if row.WorkoutID == nil || *row.WorkoutID != "w-1" {
		t.Fatalf("workout_id = %v, want w-1", row.WorkoutID)
	}
	if row.WeekFolder != nil || row.PlannedDate != nil || row.SessionIndex != nil {
		t.Fatalf("custom row must not carry plan identity: %+v", row)
	}

	// Re-push supersedes by workout identity.
	id2, err := st.RecordPushedScheduledWorkout(ctx, uid, RecordPushedWorkoutInput{
		WorkoutID: "w-1", PushDate: "2026-08-13", Kind: "run", Name: "[STRIDE] 4km×3组",
		SpecJSON: `{"schema":"run-workout/v1"}`, Provider: "coros", ProviderWorkoutID: "R-2",
		PriorID: &id1,
	})
	if err != nil {
		t.Fatalf("record 2: %v", err)
	}
	latest, err := st.GetLatestScheduledWorkoutForWorkout(ctx, uid, "w-1")
	if err != nil || latest == nil || latest.ID != id2 {
		t.Fatalf("latest after re-push: %v %+v", err, latest)
	}
	var first ScheduledWorkout
	if err := st.db.WithContext(ctx).Where("id = ?", id1).First(&first).Error; err != nil {
		t.Fatalf("reload prior: %v", err)
	}
	if first.Status != ScheduledWorkoutStatusSuperseded {
		t.Errorf("prior status = %q, want superseded", first.Status)
	}

	// Other workout ids and plan-session lookups stay isolated.
	if other, err := st.GetLatestScheduledWorkoutForWorkout(ctx, uid, "w-2"); err != nil || other != nil {
		t.Errorf("other workout unexpectedly found: %v %+v", err, other)
	}
}
