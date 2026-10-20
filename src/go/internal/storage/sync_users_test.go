package storage

import (
	"context"
	"sort"
	"testing"
	"time"

	"github.com/google/uuid"
)

// TestListSyncableUserIDs covers the devops#661 enumeration: distinct
// user_ids from provider_credentials only (a sync_meta row alone must NOT
// make the list — that is how erasure-race orphans stay invisible, devops#664).
// The users are random per run, so a shared/scratch DB needs no empty-table
// precondition; cleanup removes only what this test wrote.
func TestListSyncableUserIDs(t *testing.T) {
	st := openTestStore(t)
	// DisconnectWatch locks a user_onboarding row, so the users migration must
	// run alongside the watch one.
	migrateUserWatchTables(t, st)
	ctx := context.Background()
	a, b, orphan := uuid.NewString(), uuid.NewString(), uuid.NewString()
	save := func(uid, provider string) {
		t.Helper()
		if err := st.SaveCredential(ctx, &ProviderCredential{UserID: uid, Provider: provider, Secret: []byte("s"), UpdatedAt: time.Now().UTC()}); err != nil {
			t.Fatalf("save credential %s/%s: %v", uid, provider, err)
		}
	}
	t.Cleanup(func() {
		_ = st.DeleteCredential(ctx, a, "coros")
		_ = st.DeleteCredential(ctx, b, "coros")
		_ = st.DeleteCredential(ctx, b, "garmin")
		_ = st.DeleteCredential(ctx, orphan, "coros")
		// No production DeleteMeta exists (nothing needs it yet); clean the
		// probe row directly so a shared test DB stays pristine.
		_ = st.db.Where("user_id = ? AND meta_key = ?", orphan, "last_sync_time").Delete(&SyncMeta{}).Error
	})

	// Baseline before this test writes anything.
	before, err := st.ListSyncableUserIDs(ctx)
	if err != nil {
		t.Fatalf("list baseline: %v", err)
	}

	// Two providers for one user, one for another: distinct user_ids, sorted.
	save(b, "coros")
	save(b, "garmin")
	save(a, "coros")

	got, err := st.ListSyncableUserIDs(ctx)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if !sort.StringsAreSorted(got) {
		t.Fatalf("list not sorted: %v", got)
	}
	count := func(ids []string, want string) int {
		n := 0
		for _, id := range ids {
			if id == want {
				n++
			}
		}
		return n
	}
	if n := count(got, b); n != 1 {
		t.Fatalf("dual-provider user %s appeared %d times, want exactly 1", b, n)
	}
	if count(got, a) != 1 || len(got) != len(before)+2 {
		t.Fatalf("list = %v (baseline %v): want both new users exactly once", got, before)
	}

	// A sync_meta row without a credential does not join the list (devops#664).
	if err := st.SetMeta(ctx, orphan, "last_sync_time", "2026-09-25T08:54:24Z"); err != nil {
		t.Fatalf("set meta: %v", err)
	}
	got, err = st.ListSyncableUserIDs(ctx)
	if err != nil {
		t.Fatalf("list with orphan: %v", err)
	}
	if count(got, orphan) != 0 {
		t.Fatalf("credential-less sync_meta user %s leaked into the list", orphan)
	}

	// Deleting the credential drops the user from the list (watch disconnect).
	if err := st.DisconnectWatch(ctx, a, "coros"); err != nil {
		t.Fatalf("disconnect: %v", err)
	}
	got, err = st.ListSyncableUserIDs(ctx)
	if err != nil {
		t.Fatalf("list after disconnect: %v", err)
	}
	if count(got, a) != 0 {
		t.Fatalf("disconnected user %s still listed", a)
	}
}
