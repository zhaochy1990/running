package storage

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

// migrateUsers ensures the user tables exist for the integration test (the
// shared openTestStore only migrates jobs/pipeline_runs).
func migrateUsers(t *testing.T, st *Store) {
	t.Helper()
	if err := st.AutoMigrateUsers(context.Background()); err != nil {
		t.Fatalf("automigrate users: %v", err)
	}
}

func TestUserProfile_UpsertPreservesCreatedAt(t *testing.T) {
	st := openTestStore(t)
	migrateUsers(t, st)
	ctx := context.Background()
	uid := uuid.NewString()

	if err := st.UpsertUserProfile(ctx, &UserProfile{
		UserID: uid, DisplayName: "Zhao", DOB: "1990-05-01", Sex: "male", HeightCm: 178, WeightKg: 70,
	}); err != nil {
		t.Fatalf("insert: %v", err)
	}
	first, err := st.GetUserProfile(ctx, uid)
	if err != nil || first == nil {
		t.Fatalf("get after insert: %v (nil=%v)", err, first == nil)
	}
	created := first.CreatedAt

	// Update the value columns; created_at must survive.
	if err := st.UpsertUserProfile(ctx, &UserProfile{
		UserID: uid, DisplayName: "Zhao Updated", DOB: "1990-05-02", Sex: "male", HeightCm: 179, WeightKg: 71,
	}); err != nil {
		t.Fatalf("update: %v", err)
	}
	second, err := st.GetUserProfile(ctx, uid)
	if err != nil || second == nil {
		t.Fatalf("get after update: %v", err)
	}
	if second.DisplayName != "Zhao Updated" || second.WeightKg != 71 {
		t.Errorf("values not updated: %+v", second)
	}
	if !second.CreatedAt.Equal(created) {
		t.Errorf("created_at not preserved: got %v want %v", second.CreatedAt, created)
	}
}

func TestUserOnboarding_FlagIsolation(t *testing.T) {
	st := openTestStore(t)
	migrateUsers(t, st)
	ctx := context.Background()
	uid := uuid.NewString()

	if err := st.SetWatchReady(ctx, uid); err != nil {
		t.Fatalf("set watch_ready: %v", err)
	}
	if err := st.SetProfileReady(ctx, uid); err != nil {
		t.Fatalf("set profile_ready: %v", err)
	}
	o, err := st.GetUserOnboarding(ctx, uid)
	if err != nil || o == nil {
		t.Fatalf("get onboarding: %v", err)
	}
	// SetProfileReady must not have clobbered watch_ready.
	if !o.WatchReady || !o.ProfileReady {
		t.Errorf("flags = %+v, want both true", o)
	}
	if o.CompletedAt != nil {
		t.Errorf("completed_at = %v, want nil (sync port not implemented)", o.CompletedAt)
	}
}

func TestUser_AbsentReturnsNil(t *testing.T) {
	st := openTestStore(t)
	migrateUsers(t, st)
	ctx := context.Background()
	uid := uuid.NewString()

	if p, err := st.GetUserProfile(ctx, uid); err != nil || p != nil {
		t.Errorf("absent profile: got %v, %v; want nil, nil", p, err)
	}
	if o, err := st.GetUserOnboarding(ctx, uid); err != nil || o != nil {
		t.Errorf("absent onboarding: got %v, %v; want nil, nil", o, err)
	}
}
