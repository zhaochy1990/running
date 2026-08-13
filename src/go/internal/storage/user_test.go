package storage

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/activityarea"
	"github.com/zhaochy1990/stride/internal/job"
)

// migrateUsers ensures the user tables exist for the integration test (the
// shared openTestStore only migrates jobs/pipeline_runs).
func migrateUsers(t *testing.T, st *Store) {
	t.Helper()
	if err := st.AutoMigrateUsers(context.Background()); err != nil {
		t.Fatalf("automigrate users: %v", err)
	}
}

func migrateUserWatchTables(t *testing.T, st *Store) {
	t.Helper()
	migrateUsers(t, st)
	if err := st.AutoMigrateWatch(context.Background()); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
}

func saveTestCredential(t *testing.T, st *Store, uid string) {
	t.Helper()
	if err := st.SaveCredential(context.Background(), &ProviderCredential{UserID: uid, Provider: "coros", Secret: []byte("secret"), UpdatedAt: time.Now().UTC()}); err != nil {
		t.Fatalf("save credential: %v", err)
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

func TestUsualActivityArea_RoundTripAndCoreWritesPreserveDerivedFields(t *testing.T) {
	st := openTestStore(t)
	migrateUsers(t, st)
	ctx := context.Background()
	uid := uuid.NewString()
	if err := st.UpsertUserProfile(ctx, &UserProfile{
		UserID: uid, DisplayName: "Runner", DOB: "1990-05-01", Sex: "male", HeightCm: 178, WeightKg: 70,
	}); err != nil {
		t.Fatalf("insert profile: %v", err)
	}
	computedAt := time.Date(2026, 8, 13, 8, 0, 0, 123000000, time.UTC)
	found, err := st.SaveUsualActivityArea(ctx, uid, &activityarea.Area{
		Latitude: 31.2304, Longitude: 121.4737, SupportingActivityCount: 42,
	}, computedAt)
	if err != nil || !found {
		t.Fatalf("save area = found %v, err %v", found, err)
	}
	snapshot, err := st.UsualActivityArea(ctx, uid)
	if err != nil || snapshot == nil || !snapshot.Computed || snapshot.Area == nil || snapshot.Area.SupportingActivityCount != 42 {
		t.Fatalf("read area = %+v, %v", snapshot, err)
	}

	if err := st.UpsertUserProfile(ctx, &UserProfile{
		UserID: uid, DisplayName: "Runner Updated", DOB: "1990-05-01", Sex: "male", HeightCm: 178, WeightKg: 71,
	}); err != nil {
		t.Fatalf("core upsert: %v", err)
	}
	name := "Runner Patched"
	if _, err := st.PatchUserProfile(ctx, uid, UserProfilePatch{DisplayName: &name}); err != nil {
		t.Fatalf("core patch: %v", err)
	}
	snapshot, err = st.UsualActivityArea(ctx, uid)
	if err != nil || snapshot == nil || !snapshot.Computed || snapshot.Area == nil || snapshot.Area.Latitude != 31.2304 || snapshot.Area.SupportingActivityCount != 42 {
		t.Fatalf("derived area after core writes = %+v, %v", snapshot, err)
	}
}

func TestUsualActivityArea_CachesUnknownAndDoesNotCreateSparseProfile(t *testing.T) {
	st := openTestStore(t)
	migrateUsers(t, st)
	ctx := context.Background()
	uid := uuid.NewString()
	computedAt := time.Now().UTC().Truncate(time.Microsecond)
	found, err := st.SaveUsualActivityArea(ctx, uid, nil, computedAt)
	if err != nil || found {
		t.Fatalf("missing profile save = found %v, err %v", found, err)
	}
	if profile, err := st.GetUserProfile(ctx, uid); err != nil || profile != nil {
		t.Fatalf("sparse profile = %+v, %v", profile, err)
	}

	if err := st.UpsertUserProfile(ctx, &UserProfile{UserID: uid, DisplayName: "Runner"}); err != nil {
		t.Fatalf("insert profile: %v", err)
	}
	found, err = st.SaveUsualActivityArea(ctx, uid, nil, computedAt)
	if err != nil || !found {
		t.Fatalf("save unknown = found %v, err %v", found, err)
	}
	snapshot, err := st.UsualActivityArea(ctx, uid)
	if err != nil || snapshot == nil || !snapshot.Computed || snapshot.Area != nil {
		t.Fatalf("unknown snapshot = %+v, %v", snapshot, err)
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
	migrateUserWatchTables(t, st)
	ctx := context.Background()
	uid := uuid.NewString()
	saveTestCredential(t, st, uid)

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

func TestUserOnboarding_FinalizeRequiresBothPrerequisites(t *testing.T) {
	st := openTestStore(t)
	migrateUserWatchTables(t, st)
	ctx := context.Background()
	uid := uuid.NewString()
	saveTestCredential(t, st, uid)

	if wrote, err := st.FinalizeOnboardingRun(ctx, uid, uuid.NewString()); err != nil || wrote {
		t.Fatalf("finalize without prerequisites: wrote=%v err=%v", wrote, err)
	}
	if err := st.SetWatchReady(ctx, uid); err != nil {
		t.Fatalf("set watch_ready: %v", err)
	}
	if wrote, err := st.FinalizeOnboardingRun(ctx, uid, uuid.NewString()); err != nil || wrote {
		t.Fatalf("finalize without profile: wrote=%v err=%v", wrote, err)
	}
	if err := st.SetProfileReady(ctx, uid); err != nil {
		t.Fatalf("set profile_ready: %v", err)
	}
	if wrote, err := st.FinalizeOnboardingRun(ctx, uid, uuid.NewString()); err != nil || !wrote {
		t.Fatalf("finalize with both prerequisites: wrote=%v err=%v", wrote, err)
	}
	if wrote, err := st.FinalizeOnboardingRun(ctx, uid, uuid.NewString()); err != nil || wrote {
		t.Fatalf("repeat finalization: wrote=%v err=%v", wrote, err)
	}
	if err := st.DisconnectWatch(ctx, uid, "coros"); err != nil {
		t.Fatalf("disconnect: %v", err)
	}
	if wrote, err := st.FinalizeOnboardingRun(ctx, uid, uuid.NewString()); err != nil || wrote {
		t.Fatalf("finalize disconnected user: wrote=%v err=%v", wrote, err)
	}
}

func TestUserOnboarding_SetWatchReadyRequiresCredential(t *testing.T) {
	st := openTestStore(t)
	migrateUserWatchTables(t, st)
	ctx := context.Background()
	uid := uuid.NewString()

	if err := st.SetWatchReady(ctx, uid); !errors.Is(err, ErrNoProviderCredential) {
		t.Fatalf("set watch_ready without credential = %v, want ErrNoProviderCredential", err)
	}
	o, err := st.GetUserOnboarding(ctx, uid)
	if err != nil || o == nil || o.WatchReady {
		t.Fatalf("missing credential must leave readiness false: %+v, err=%v", o, err)
	}

	if err := st.SaveCredential(ctx, &ProviderCredential{UserID: uid, Provider: "coros", Secret: []byte("secret"), UpdatedAt: time.Now().UTC()}); err != nil {
		t.Fatalf("save credential: %v", err)
	}
	if err := st.SetWatchReady(ctx, uid); err != nil {
		t.Fatalf("set watch_ready with credential: %v", err)
	}
	o, err = st.GetUserOnboarding(ctx, uid)
	if err != nil || o == nil || !o.WatchReady {
		t.Fatalf("credential must allow readiness: %+v, err=%v", o, err)
	}
}

func TestUserOnboarding_DisconnectWatchCreatesMissingOnboardingRow(t *testing.T) {
	st := openTestStore(t)
	migrateUserWatchTables(t, st)
	ctx := context.Background()
	uid := uuid.NewString()

	if err := st.SaveCredential(ctx, &ProviderCredential{UserID: uid, Provider: "coros", Secret: []byte("secret"), UpdatedAt: time.Now().UTC()}); err != nil {
		t.Fatalf("save credential: %v", err)
	}
	if err := st.DisconnectWatch(ctx, uid, "coros"); err != nil {
		t.Fatalf("disconnect credential without onboarding row: %v", err)
	}
	if cred, err := st.GetCredential(ctx, uid, "coros"); err != nil || cred != nil {
		t.Fatalf("credential = %+v, err=%v; want removed", cred, err)
	}
	o, err := st.GetUserOnboarding(ctx, uid)
	if err != nil || o == nil || o.WatchReady || o.ProfileReady || o.OnboardingRunID != nil || o.CompletedAt != nil {
		t.Fatalf("created default onboarding state = %+v, err=%v", o, err)
	}
}

func TestUserOnboarding_ConcurrentReadyAndDisconnectPreserveCredentialInvariant(t *testing.T) {
	st := openTestStore(t)
	migrateUserWatchTables(t, st)
	ctx := context.Background()
	uid := uuid.NewString()

	saveTestCredential(t, st, uid)
	start := make(chan struct{})
	errs := make(chan error, 2)
	go func() {
		<-start
		errs <- st.SetWatchReady(ctx, uid)
	}()
	go func() {
		<-start
		errs <- st.DisconnectWatch(ctx, uid, "coros")
	}()
	close(start)

	var sawMissingCredential bool
	for range 2 {
		err := <-errs
		if errors.Is(err, ErrNoProviderCredential) {
			sawMissingCredential = true
			continue
		}
		if err != nil {
			t.Fatalf("concurrent ready/disconnect: %v", err)
		}
	}
	o, err := st.GetUserOnboarding(ctx, uid)
	if err != nil || o == nil {
		t.Fatalf("get onboarding: %+v, err=%v", o, err)
	}
	var credentialCount int64
	if err := st.db.WithContext(ctx).Model(&ProviderCredential{}).Where("user_id = ?", uid).Count(&credentialCount).Error; err != nil {
		t.Fatalf("count credentials: %v", err)
	}
	if o.WatchReady && credentialCount == 0 {
		t.Fatalf("watch_ready requires a credential: %+v", o)
	}
	if credentialCount == 0 && !sawMissingCredential && o.WatchReady {
		t.Fatal("disconnect must not leave false readiness after deleting final credential")
	}
}

func TestUserOnboarding_DisconnectWatchClearsDependentState(t *testing.T) {
	st := openTestStore(t)
	migrateUserWatchTables(t, st)
	ctx := context.Background()
	uid := uuid.NewString()
	email := "runner@example.com"

	if err := st.db.WithContext(ctx).Create(&ProviderCredential{UserID: uid, Provider: "coros", Email: &email, Secret: []byte("secret"), UpdatedAt: time.Now().UTC()}).Error; err != nil {
		t.Fatalf("create credential: %v", err)
	}
	if err := st.SetWatchReady(ctx, uid); err != nil {
		t.Fatalf("set watch_ready: %v", err)
	}
	if err := st.SetProfileReady(ctx, uid); err != nil {
		t.Fatalf("set profile_ready: %v", err)
	}
	if wrote, err := st.FinalizeOnboardingRun(ctx, uid, "run-current"); err != nil || !wrote {
		t.Fatalf("finalize current run: wrote=%v err=%v", wrote, err)
	}

	if err := st.DisconnectWatch(ctx, uid, "coros"); err != nil {
		t.Fatalf("disconnect: %v", err)
	}
	if cred, err := st.GetCredential(ctx, uid, "coros"); err != nil || cred != nil {
		t.Fatalf("credential = %+v, err=%v; want removed", cred, err)
	}
	o, err := st.GetUserOnboarding(ctx, uid)
	if err != nil || o == nil {
		t.Fatalf("get onboarding: %v", err)
	}
	if o.WatchReady || !o.ProfileReady || o.CompletedAt != nil || o.OnboardingRunID != nil {
		t.Fatalf("disconnect onboarding state = %+v", o)
	}
}

func TestUserOnboarding_DisconnectOneOfTwoProvidersPreservesState(t *testing.T) {
	st := openTestStore(t)
	migrateUserWatchTables(t, st)
	ctx := context.Background()
	uid := uuid.NewString()
	email := "runner@example.com"

	for _, provider := range []string{"coros", "garmin"} {
		if err := st.db.WithContext(ctx).Create(&ProviderCredential{UserID: uid, Provider: provider, Email: &email, Secret: []byte("secret"), UpdatedAt: time.Now().UTC()}).Error; err != nil {
			t.Fatalf("create %s credential: %v", provider, err)
		}
	}
	if err := st.SetWatchReady(ctx, uid); err != nil {
		t.Fatalf("set watch_ready: %v", err)
	}
	if err := st.SetProfileReady(ctx, uid); err != nil {
		t.Fatalf("set profile_ready: %v", err)
	}
	if wrote, err := st.FinalizeOnboardingRun(ctx, uid, "run-current"); err != nil || !wrote {
		t.Fatalf("finalize: wrote=%v err=%v", wrote, err)
	}

	if err := st.DisconnectWatch(ctx, uid, "coros"); err != nil {
		t.Fatalf("disconnect coros: %v", err)
	}
	if cred, err := st.GetCredential(ctx, uid, "coros"); err != nil || cred != nil {
		t.Fatalf("coros credential = %+v, err=%v; want removed", cred, err)
	}
	if cred, err := st.GetCredential(ctx, uid, "garmin"); err != nil || cred == nil {
		t.Fatalf("garmin credential = %+v, err=%v; want retained", cred, err)
	}
	o, err := st.GetUserOnboarding(ctx, uid)
	if err != nil || o == nil || !o.WatchReady || o.CompletedAt == nil || o.OnboardingRunID != nil {
		t.Fatalf("remaining provider must preserve onboarding state: %+v, err=%v", o, err)
	}
}

func TestUserOnboarding_ConcurrentDisconnectsClearLastCredentialState(t *testing.T) {
	st := openTestStore(t)
	migrateUserWatchTables(t, st)
	ctx := context.Background()
	uid := uuid.NewString()
	email := "runner@example.com"
	for _, provider := range []string{"coros", "garmin"} {
		if err := st.db.WithContext(ctx).Create(&ProviderCredential{UserID: uid, Provider: provider, Email: &email, Secret: []byte("secret"), UpdatedAt: time.Now().UTC()}).Error; err != nil {
			t.Fatalf("create %s credential: %v", provider, err)
		}
	}
	if err := st.SetWatchReady(ctx, uid); err != nil {
		t.Fatalf("set watch_ready: %v", err)
	}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, provider := range []string{"coros", "garmin"} {
		wg.Add(1)
		go func(provider string) {
			defer wg.Done()
			errs <- st.DisconnectWatch(ctx, uid, provider)
		}(provider)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent disconnect: %v", err)
		}
	}
	o, err := st.GetUserOnboarding(ctx, uid)
	if err != nil || o == nil || o.WatchReady || o.OnboardingRunID != nil || o.CompletedAt != nil {
		t.Fatalf("onboarding state after last disconnect = %+v, err=%v", o, err)
	}
	for _, provider := range []string{"coros", "garmin"} {
		if cred, err := st.GetCredential(ctx, uid, provider); err != nil || cred != nil {
			t.Fatalf("%s credential = %+v, err=%v; want removed", provider, cred, err)
		}
	}
}

func TestUserOnboarding_ClearWatchReady(t *testing.T) {
	st := openTestStore(t)
	migrateUserWatchTables(t, st)
	ctx := context.Background()
	uid := uuid.NewString()
	saveTestCredential(t, st, uid)

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

func TestDeleteUserData_RemovesOwnedRowsAndPreservesOtherUsers(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	for _, migrate := range []func(context.Context) error{
		st.AutoMigrateWatch,
		st.AutoMigrateUsers,
		st.AutoMigrateGoals,
		st.AutoMigrateMasterPlan,
		st.AutoMigrateWeeklyPlan,
	} {
		if err := migrate(ctx); err != nil {
			t.Fatalf("migrate: %v", err)
		}
	}

	deletedUID, keptUID := uuid.NewString(), uuid.NewString()
	for _, uid := range []string{deletedUID, keptUID} {
		if err := st.UpsertUserProfile(ctx, &UserProfile{UserID: uid, DisplayName: uid}); err != nil {
			t.Fatalf("seed profile: %v", err)
		}
		if err := st.SaveCredential(ctx, &ProviderCredential{UserID: uid, Provider: "coros", Secret: []byte("secret")}); err != nil {
			t.Fatalf("seed credential: %v", err)
		}
		if err := st.SetWatchReady(ctx, uid); err != nil {
			t.Fatalf("seed onboarding: %v", err)
		}
		now := time.Now().UTC()
		if err := st.Jobs().Create(ctx, &job.Job{
			ID: uuid.NewString(), UserID: uid, CreatedBy: uid, Type: "watch_sync",
			Status: job.StatusQueued, CreatedAt: now, UpdatedAt: now,
		}); err != nil {
			t.Fatalf("seed job: %v", err)
		}
	}

	if err := st.DeleteUserData(ctx, deletedUID); err != nil {
		t.Fatalf("DeleteUserData: %v", err)
	}
	if profile, err := st.GetUserProfile(ctx, deletedUID); err != nil || profile != nil {
		t.Fatalf("deleted profile = %v, %v; want nil, nil", profile, err)
	}
	if provider, found, err := st.ProviderForUser(ctx, deletedUID); err != nil || found {
		t.Fatalf("deleted provider = %q, %v, %v; want absent", provider, found, err)
	}
	var deletedCredentials int64
	if err := st.db.Model(&ProviderCredential{}).Where("user_id = ?", deletedUID).Count(&deletedCredentials).Error; err != nil {
		t.Fatalf("count deleted credentials: %v", err)
	}
	if deletedCredentials != 0 {
		t.Fatalf("deleted user still has %d provider credentials", deletedCredentials)
	}
	var deletedJobs int64
	if err := st.db.Model(&jobModel{}).Where("user_id = ? OR created_by = ?", deletedUID, deletedUID).Count(&deletedJobs).Error; err != nil {
		t.Fatalf("count deleted jobs: %v", err)
	}
	if deletedJobs != 0 {
		t.Fatalf("deleted user still has %d jobs", deletedJobs)
	}
	if profile, err := st.GetUserProfile(ctx, keptUID); err != nil || profile == nil {
		t.Fatalf("other user's profile was removed: %v, %v", profile, err)
	}
}
