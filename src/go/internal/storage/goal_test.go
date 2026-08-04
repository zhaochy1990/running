package storage

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// migrateGoals ensures the race_goal table exists for the integration test (the
// shared openTestStore only migrates jobs/pipeline_runs).
func migrateGoals(t *testing.T, st *Store) {
	t.Helper()
	if err := st.AutoMigrateGoals(context.Background()); err != nil {
		t.Fatalf("automigrate goals: %v", err)
	}
}

// sampleGoal builds a minimal valid RaceGoal for the given user.
func sampleGoal(uid string) *RaceGoal {
	return &RaceGoal{
		UserID:             uid,
		RaceDate:           "2027-03-14",
		RaceDistance:       "FM",
		WeeklyTrainingDays: 5,
		AvailableTimeSlots: []string{"morning", "evening"},
	}
}

func TestRaceGoal_CreateMintsIDAndGet(t *testing.T) {
	st := openTestStore(t)
	migrateGoals(t, st)
	ctx := context.Background()
	uid := uuid.NewString()

	created, err := st.CreateRaceGoal(ctx, sampleGoal(uid))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if created.GoalID == "" {
		t.Fatalf("goal_id was not minted")
	}
	if created.Status != RaceGoalStatusActive || created.ActiveFlag == nil || *created.ActiveFlag != 1 {
		t.Fatalf("created goal not active: status=%q active_flag=%v", created.Status, created.ActiveFlag)
	}
	if created.CreatedAt.IsZero() || created.UpdatedAt.IsZero() {
		t.Fatalf("timestamps not stamped: %+v", created)
	}

	got, err := st.GetActiveRaceGoal(ctx, uid)
	if err != nil || got == nil {
		t.Fatalf("get after create: %v (nil=%v)", err, got == nil)
	}
	if got.GoalID != created.GoalID {
		t.Fatalf("get returned goal_id %q, want %q", got.GoalID, created.GoalID)
	}
	if got.RaceDistance != "FM" || got.WeeklyTrainingDays != 5 {
		t.Fatalf("fields not persisted: %+v", got)
	}
	// available_time_slots round-trips as a JSON array, never null.
	if len(got.AvailableTimeSlots) != 2 || got.AvailableTimeSlots[0] != "morning" {
		t.Fatalf("time slots not round-tripped: %v", got.AvailableTimeSlots)
	}
}

func TestRaceGoal_CreateArchivesPrior(t *testing.T) {
	st := openTestStore(t)
	migrateGoals(t, st)
	ctx := context.Background()
	uid := uuid.NewString()

	first, err := st.CreateRaceGoal(ctx, sampleGoal(uid))
	if err != nil {
		t.Fatalf("create first: %v", err)
	}

	second := sampleGoal(uid)
	second.RaceDistance = "HM"
	second.RaceDate = "2027-06-20"
	secondCreated, err := st.CreateRaceGoal(ctx, second)
	if err != nil {
		t.Fatalf("create second: %v", err)
	}
	if secondCreated.GoalID == first.GoalID {
		t.Fatalf("second create reused first goal_id")
	}

	// Only the second goal is active now.
	active, err := st.GetActiveRaceGoal(ctx, uid)
	if err != nil || active == nil {
		t.Fatalf("get active: %v", err)
	}
	if active.GoalID != secondCreated.GoalID || active.RaceDistance != "HM" {
		t.Fatalf("active goal = %+v, want the second (HM) goal", active)
	}

	// The prior goal is archived with a NULL active_flag (audit trail).
	var prior RaceGoal
	if err := st.db.WithContext(ctx).
		Where("goal_id = ?", first.GoalID).First(&prior).Error; err != nil {
		t.Fatalf("load archived prior: %v", err)
	}
	if prior.Status != RaceGoalStatusArchived || prior.ActiveFlag != nil {
		t.Fatalf("prior goal not archived: status=%q active_flag=%v", prior.Status, prior.ActiveFlag)
	}
}

func TestRaceGoal_UpdateMatch(t *testing.T) {
	st := openTestStore(t)
	migrateGoals(t, st)
	ctx := context.Background()
	uid := uuid.NewString()

	created, err := st.CreateRaceGoal(ctx, sampleGoal(uid))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// Baseline created_at from a DB read (the Create return keeps microsecond
	// precision; MySQL datetime(3) truncates to ms, so compare DB-read to
	// DB-read — same discipline as TestUserProfile_UpsertPreservesCreatedAt).
	base, err := st.GetActiveRaceGoal(ctx, uid)
	if err != nil || base == nil {
		t.Fatalf("get after create: %v", err)
	}

	upd := sampleGoal(uid)
	upd.GoalID = created.GoalID
	upd.RaceDistance = "10K"
	upd.WeeklyTrainingDays = 4
	upd.RaceName = strptr("Spring 10K")
	updated, err := st.UpdateActiveRaceGoal(ctx, upd)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated == nil {
		t.Fatalf("update returned nil for a matching goal_id (want the updated row)")
	}
	if updated.GoalID != created.GoalID {
		t.Fatalf("update changed goal_id: %q -> %q", created.GoalID, updated.GoalID)
	}
	if updated.RaceDistance != "10K" || updated.WeeklyTrainingDays != 4 || updated.RaceName == nil || *updated.RaceName != "Spring 10K" {
		t.Fatalf("mutable fields not updated: %+v", updated)
	}
	// Identity/status invariants preserved.
	if updated.Status != RaceGoalStatusActive || updated.ActiveFlag == nil || *updated.ActiveFlag != 1 {
		t.Fatalf("update disturbed status/active_flag: status=%q active_flag=%v", updated.Status, updated.ActiveFlag)
	}
	if !updated.CreatedAt.Equal(base.CreatedAt) {
		t.Fatalf("created_at not preserved on update: got %v want %v", updated.CreatedAt, base.CreatedAt)
	}
}

func TestRaceGoal_UpdateMismatchReturnsNil(t *testing.T) {
	st := openTestStore(t)
	migrateGoals(t, st)
	ctx := context.Background()
	uid := uuid.NewString()

	if _, err := st.CreateRaceGoal(ctx, sampleGoal(uid)); err != nil {
		t.Fatalf("create: %v", err)
	}

	stale := sampleGoal(uid)
	stale.GoalID = uuid.NewString() // not the active goal's id
	got, err := st.UpdateActiveRaceGoal(ctx, stale)
	if err != nil {
		t.Fatalf("update mismatch: unexpected error %v", err)
	}
	if got != nil {
		t.Fatalf("update with mismatched goal_id returned %+v, want nil (404)", got)
	}
}

func TestRaceGoal_AbsentReturnsNil(t *testing.T) {
	st := openTestStore(t)
	migrateGoals(t, st)
	ctx := context.Background()
	uid := uuid.NewString()

	got, err := st.GetActiveRaceGoal(ctx, uid)
	if err != nil || got != nil {
		t.Errorf("absent active goal: got %v, %v; want nil, nil", got, err)
	}
}
