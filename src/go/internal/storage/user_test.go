package storage

import (
	"context"
	"testing"
	"time"

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

func TestUserProfile_PatchSelectiveUpdate(t *testing.T) {
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

	name := "New Name"
	weight := 69.5
	updated, err := st.PatchUserProfile(ctx, uid, UserProfilePatch{DisplayName: &name, WeightKg: &weight})
	if err != nil {
		t.Fatalf("patch: %v", err)
	}
	if updated == nil {
		t.Fatal("patch returned nil profile")
	}
	if updated.DisplayName != name || updated.WeightKg != weight {
		t.Errorf("patched values = %+v", updated)
	}
	if updated.DOB != first.DOB || updated.Sex != first.Sex || updated.HeightCm != first.HeightCm {
		t.Errorf("omitted values changed: before=%+v after=%+v", first, updated)
	}
	if !updated.CreatedAt.Equal(first.CreatedAt) {
		t.Errorf("created_at changed: got %v want %v", updated.CreatedAt, first.CreatedAt)
	}
}

func TestUserProfile_PatchEmptyReadsWithoutUpdating(t *testing.T) {
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

	got, err := st.PatchUserProfile(ctx, uid, UserProfilePatch{})
	if err != nil || got == nil {
		t.Fatalf("empty patch: %v (nil=%v)", err, got == nil)
	}
	if !got.UpdatedAt.Equal(first.UpdatedAt) {
		t.Errorf("empty patch changed updated_at: got %v want %v", got.UpdatedAt, first.UpdatedAt)
	}
}

func TestUserProfile_PatchMissingDoesNotInsert(t *testing.T) {
	st := openTestStore(t)
	migrateUsers(t, st)
	ctx := context.Background()
	uid := uuid.NewString()
	name := "First"

	got, err := st.PatchUserProfile(ctx, uid, UserProfilePatch{DisplayName: &name})
	if err != nil {
		t.Fatalf("patch absent profile: %v", err)
	}
	if got != nil {
		t.Fatalf("patch absent profile = %+v, want nil", got)
	}
	if profile, err := st.GetUserProfile(ctx, uid); err != nil || profile != nil {
		t.Errorf("absent patch inserted row: got %v, %v", profile, err)
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

// TestUserOnboarding_ClearWatchReady verifies disconnect (ClearWatchReady) flips
// only watch_ready, leaving profile_ready and completed_at untouched (ADR 0018).
func TestUserOnboarding_ClearWatchReady(t *testing.T) {
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
	// Stamp completed_at directly (there is no setter yet) to prove disconnect
	// leaves the onboarding gate untouched.
	now := time.Now().UTC()
	if err := st.db.WithContext(ctx).Model(&UserOnboarding{}).
		Where("user_id = ?", uid).Update("completed_at", now).Error; err != nil {
		t.Fatalf("stamp completed_at: %v", err)
	}

	if err := st.ClearWatchReady(ctx, uid); err != nil {
		t.Fatalf("clear watch_ready: %v", err)
	}

	o, err := st.GetUserOnboarding(ctx, uid)
	if err != nil || o == nil {
		t.Fatalf("get onboarding: %v", err)
	}
	if o.WatchReady {
		t.Errorf("watch_ready = true, want false after ClearWatchReady")
	}
	if !o.ProfileReady {
		t.Errorf("profile_ready must be preserved on disconnect")
	}
	if o.CompletedAt == nil {
		t.Errorf("completed_at must be left untouched on disconnect (ADR 0018)")
	}
}
