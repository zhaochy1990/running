package storage

import (
	"context"
	"errors"
	"sync"
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

// TestUserOnboarding_ClearWatchReady verifies the compatibility mutation leaves
// unrelated flags untouched. Production disconnect uses DisconnectWatch.
func TestUserOnboarding_ClaimRequiresConnectedWatch(t *testing.T) {
	st := openTestStore(t)
	migrateUsers(t, st)
	claimed, err := st.ClaimOnboardingRun(context.Background(), uuid.NewString(), "run-1", time.Now().UTC().Add(-5*time.Minute))
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if claimed {
		t.Fatal("claim must require watch_ready")
	}
}

func TestUserOnboarding_FreshWatchReadyRowClaimsNullableRunID(t *testing.T) {
	st := openTestStore(t)
	migrateUserWatchTables(t, st)
	ctx := context.Background()
	uid := uuid.NewString()
	saveTestCredential(t, st, uid)
	if err := st.SetWatchReady(ctx, uid); err != nil {
		t.Fatalf("set watch_ready: %v", err)
	}
	before, err := st.GetUserOnboarding(ctx, uid)
	if err != nil || before == nil || before.OnboardingRunID != nil {
		t.Fatalf("fresh readiness row = %+v, err=%v; want nullable absent run", before, err)
	}

	staleBefore := time.Now().UTC().Add(-time.Minute)
	claimed, err := st.ClaimOnboardingRun(ctx, uid, "run-a", staleBefore)
	if err != nil || !claimed {
		t.Fatalf("first claim from NULL: claimed=%v err=%v", claimed, err)
	}
	claimed, err = st.ClaimOnboardingRun(ctx, uid, "run-b", staleBefore)
	if err != nil {
		t.Fatalf("second claim: %v", err)
	}
	if claimed {
		t.Fatal("fresh missing-run claim must not be replaced")
	}
	o, err := st.GetUserOnboarding(ctx, uid)
	if err != nil || o == nil || o.OnboardingRunID == nil || *o.OnboardingRunID != "run-a" {
		t.Fatalf("onboarding = %+v, err=%v; want run-a", o, err)
	}
}

func TestUserOnboarding_StaleMissingRunClaimCanBeRecovered(t *testing.T) {
	st := openTestStore(t)
	migrateUserWatchTables(t, st)
	ctx := context.Background()
	uid := uuid.NewString()
	saveTestCredential(t, st, uid)
	if err := st.SetWatchReady(ctx, uid); err != nil {
		t.Fatalf("set watch_ready: %v", err)
	}
	claimed, err := st.ClaimOnboardingRun(ctx, uid, "run-a", time.Now().UTC().Add(-time.Minute))
	if err != nil || !claimed {
		t.Fatalf("first claim: claimed=%v err=%v", claimed, err)
	}
	staleAt := time.Now().UTC().Add(-2 * time.Minute)
	if err := st.db.WithContext(ctx).Model(&UserOnboarding{}).Where("user_id = ?", uid).Update("updated_at", staleAt).Error; err != nil {
		t.Fatalf("age claim: %v", err)
	}
	claimed, err = st.ClaimOnboardingRun(ctx, uid, "run-b", time.Now().UTC().Add(-time.Minute))
	if err != nil || !claimed {
		t.Fatalf("stale replacement: claimed=%v err=%v", claimed, err)
	}
	o, err := st.GetUserOnboarding(ctx, uid)
	if err != nil || o == nil || o.OnboardingRunID == nil || *o.OnboardingRunID != "run-b" {
		t.Fatalf("onboarding = %+v, err=%v; want run-b", o, err)
	}
}

func TestUserOnboarding_ConcurrentMissingRunClaimsHaveOneWinner(t *testing.T) {
	st := openTestStore(t)
	migrateUserWatchTables(t, st)
	ctx := context.Background()
	uid := uuid.NewString()
	saveTestCredential(t, st, uid)
	if err := st.SetWatchReady(ctx, uid); err != nil {
		t.Fatalf("set watch_ready: %v", err)
	}
	staleBefore := time.Now().UTC().Add(-time.Minute)
	start := make(chan struct{})
	claimed := make(chan bool, 2)
	errs := make(chan error, 2)
	for _, runID := range []string{"run-a", "run-b"} {
		go func(runID string) {
			<-start
			ok, err := st.ClaimOnboardingRun(ctx, uid, runID, staleBefore)
			claimed <- ok
			errs <- err
		}(runID)
	}
	close(start)
	winners := 0
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatalf("claim: %v", err)
		}
		if <-claimed {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("successful claims = %d, want 1", winners)
	}
}

func TestUserOnboarding_ClearOnboardingRunAndCompletionGuards(t *testing.T) {
	st := openTestStore(t)
	migrateUserWatchTables(t, st)
	ctx := context.Background()
	uid := uuid.NewString()
	saveTestCredential(t, st, uid)

	if err := st.SetWatchReady(ctx, uid); err != nil {
		t.Fatalf("set watch_ready: %v", err)
	}
	claimed, err := st.ClaimOnboardingRun(ctx, uid, "run-current", time.Now().UTC().Add(-5*time.Minute))
	if err != nil || !claimed {
		t.Fatalf("claim: claimed=%v err=%v", claimed, err)
	}
	if err := st.CompleteOnboardingRun(ctx, uid, "run-old"); err != nil {
		t.Fatalf("complete old run: %v", err)
	}
	o, err := st.GetUserOnboarding(ctx, uid)
	if err != nil || o == nil || o.CompletedAt != nil {
		t.Fatalf("old run must not complete onboarding: %+v, err=%v", o, err)
	}
	if err := st.ClearOnboardingRun(ctx, uid, "run-old"); err != nil {
		t.Fatalf("clear old run: %v", err)
	}
	o, err = st.GetUserOnboarding(ctx, uid)
	if err != nil || o.OnboardingRunID == nil || *o.OnboardingRunID != "run-current" {
		t.Fatalf("old run must not clear current claim: %+v, err=%v", o, err)
	}
	if err := st.ClearOnboardingRun(ctx, uid, "run-current"); err != nil {
		t.Fatalf("clear current run: %v", err)
	}
	o, err = st.GetUserOnboarding(ctx, uid)
	if err != nil || o.OnboardingRunID != nil {
		t.Fatalf("current claim must clear: %+v, err=%v", o, err)
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
	claimed, err := st.ClaimOnboardingRun(ctx, uid, "run-current", time.Now().UTC().Add(-5*time.Minute))
	if err != nil || !claimed {
		t.Fatalf("claim: claimed=%v err=%v", claimed, err)
	}
	if err := st.CompleteOnboardingRun(ctx, uid, "run-current"); err != nil {
		t.Fatalf("complete current run: %v", err)
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
	claimed, err := st.ClaimOnboardingRun(ctx, uid, "run-current", time.Now().UTC().Add(-5*time.Minute))
	if err != nil || !claimed {
		t.Fatalf("claim: claimed=%v err=%v", claimed, err)
	}
	if err := st.CompleteOnboardingRun(ctx, uid, "run-current"); err != nil {
		t.Fatalf("complete: %v", err)
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
	if err != nil || o == nil || !o.WatchReady || o.CompletedAt == nil || o.OnboardingRunID == nil || *o.OnboardingRunID != "run-current" {
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
