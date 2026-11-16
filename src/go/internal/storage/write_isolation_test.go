// write_isolation_test.go is the devops#1005 AC5 integration suite: real
// MySQL (STRIDE_WORKER_TEST_MYSQL_DSN) + a real FileStore blob backend,
// exercising the whole isolation story end to end — binding revisions on
// identity events, lease takeover with fencing, the stale-worker late upload,
// blob-succeeded/transaction-refused, idempotent retries, and v1/v2 read
// coexistence.
package storage

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/zhaochy1990/stride/internal/tsstore"
)

// openIsolationStore is openTestStore with the blob backend swapped to a real
// FileStore in a temp dir (AC5: 隔离真实 MySQL/FileStore).
func openIsolationStore(t *testing.T) (*Store, *tsstore.FileStore) {
	t.Helper()
	st := openTestStore(t) // skips without STRIDE_WORKER_TEST_MYSQL_DSN
	ctx := context.Background()
	// The erasure test drives DeleteUserData end to end, which sweeps every
	// user-owned table; migrating the deletion model list itself (plus the
	// three special-SQL tables) guarantees the schema exists no matter which
	// domain migrates come and go.
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	for _, migrate := range []func(context.Context) error{
		st.AutoMigrateBodyComposition,
		st.AutoMigrateTeamLikes,
		st.AutoMigrateFeedback,
	} {
		if err := migrate(ctx); err != nil {
			t.Fatalf("migrate: %v", err)
		}
	}
	if err := st.db.WithContext(ctx).AutoMigrate(userOwnedDeletionModels...); err != nil {
		t.Fatalf("automigrate deletion models: %v", err)
	}
	fs, err := tsstore.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("filestore: %v", err)
	}
	st.SetTSBlobStore(fs)
	return st, fs
}

// isoUser returns a fresh canonical UUID — the CI database persists across
// runs, so fixed ids would collide with earlier runs' rows.
func isoUser(t *testing.T) string {
	t.Helper()
	return uuid.NewString()
}

func isoActivity(uid, label string, hr int) *Activity {
	return &Activity{
		UserID: uid, LabelID: label, SportType: 100,
		Date:      time.Date(2026, 5, 9, 1, 2, 3, 0, time.UTC),
		Sport:     strptr("run_outdoor"),
		DistanceM: fptr(10000),
		Provider:  "coros", SyncedAt: time.Now().UTC(),
	}
}

func isoPoints(hr int) []TimeseriesPoint {
	ts := make([]TimeseriesPoint, 3)
	for i := range ts {
		v := int64(i + 1)
		h := hr
		ts[i] = TimeseriesPoint{Timestamp: &v, HeartRate: &h}
	}
	return ts
}

// publish runs an activity write under a publish session — the same public
// surface (UpsertActivity*) the provider syncs call, with the session riding
// in ctx exactly as the watch_sync handler threads it.
func publish(ctx context.Context, st *Store, sess *PublishSession, a *Activity, ts []TimeseriesPoint, preserveEmpty bool) error {
	if preserveEmpty {
		return st.UpsertActivityPreservingEmptyChildren(WithPublishSession(ctx, sess), a, nil, ts, nil)
	}
	return st.UpsertActivity(WithPublishSession(ctx, sess), a, nil, ts, nil)
}

func isoFenceReason(t *testing.T, err error) string {
	t.Helper()
	var fv *FenceViolationError
	if !errors.As(err, &fv) {
		t.Fatalf("error %v is not a fence violation", err)
	}
	return fv.Reason
}

// TestWriteIsolation_BindingRevision pins AC1's revision semantics: bump on
// unbind / provider switch / account switch, no bump on token refresh or
// NULL→value account backfill, and monotonic across a rebind.
func TestWriteIsolation_BindingRevision(t *testing.T) {
	st, _ := openIsolationStore(t)
	ctx := context.Background()
	uid := isoUser(t)
	acct := func(s string) *string { return &s }
	cred := func(provider string, account *string) *ProviderCredential {
		return &ProviderCredential{UserID: uid, Provider: provider,
			ProviderUserID: account, UpdatedAt: time.Now().UTC()}
	}

	rev := func() int64 {
		b, err := st.GetWatchBinding(ctx, uid)
		if err != nil {
			t.Fatalf("get binding: %v", err)
		}
		if b == nil {
			t.Fatal("binding row missing")
		}
		return b.Revision
	}

	// First credential save creates the binding at revision 1.
	if err := st.SaveCredential(ctx, cred("coros", acct("coros-acct-1"))); err != nil {
		t.Fatalf("save credential: %v", err)
	}
	if rev() != 1 {
		t.Fatalf("initial revision = %d, want 1", rev())
	}
	// Token refresh (same identity): revision unchanged.
	if err := st.SaveCredential(ctx, cred("coros", acct("coros-acct-1"))); err != nil {
		t.Fatalf("token refresh save: %v", err)
	}
	if rev() != 1 {
		t.Fatalf("revision after token refresh = %d, want 1", rev())
	}
	// Account switch (same provider, different account): bump.
	if err := st.SaveCredential(ctx, cred("coros", acct("coros-acct-2"))); err != nil {
		t.Fatalf("account switch save: %v", err)
	}
	if rev() != 2 {
		t.Fatalf("revision after account switch = %d, want 2", rev())
	}
	// Provider switch: bump.
	if err := st.SaveCredential(ctx, cred("garmin", acct("garmin-acct-1"))); err != nil {
		t.Fatalf("provider switch save: %v", err)
	}
	if rev() != 3 {
		t.Fatalf("revision after provider switch = %d, want 3", rev())
	}
	// NULL→value backfill (credential saved before account ids were
	// captured): no bump.
	if err := st.SaveCredential(ctx, cred("garmin", nil)); err != nil {
		t.Fatalf("backfill-none save: %v", err)
	}
	if rev() != 3 {
		t.Fatalf("revision after nil-account save = %d, want 3 (backfill is not a switch)", rev())
	}
	if err := st.SaveCredential(ctx, cred("garmin", acct("garmin-acct-1"))); err != nil {
		t.Fatalf("backfill save: %v", err)
	}
	if rev() != 3 {
		t.Fatalf("revision after NULL→value backfill = %d, want 3", rev())
	}
	// Unbind: bump + tombstone (provider cleared, row kept).
	if err := st.DeleteCredential(ctx, uid, "garmin"); err != nil {
		t.Fatalf("delete credential: %v", err)
	}
	b, err := st.GetWatchBinding(ctx, uid)
	if err != nil || b == nil {
		t.Fatalf("binding after unbind: %v %v", b, err)
	}
	if b.Revision != 4 {
		t.Fatalf("revision after unbind = %d, want 4", b.Revision)
	}
	if b.Provider != nil {
		t.Fatalf("tombstone provider = %v, want nil", *b.Provider)
	}
	// Rebind continues the monotonic revision (no reset to 1).
	if err := st.SaveCredential(ctx, cred("coros", acct("coros-acct-9"))); err != nil {
		t.Fatalf("rebind save: %v", err)
	}
	if rev() != 5 {
		t.Fatalf("revision after rebind = %d, want 5 (monotonic across tombstone)", rev())
	}
}

// TestWriteIsolation_LeaseLifecycle covers AC1's cross-worker execution
// control: contention, renewal, release, expiry takeover, and fencing-token
// increments.
func TestWriteIsolation_LeaseLifecycle(t *testing.T) {
	st, _ := openIsolationStore(t)
	ctx := context.Background()
	uid := isoUser(t)
	const ttl = 50 * time.Millisecond

	t1, err := st.AcquireWatchExecLease(ctx, uid, "worker-a/job-1", ttl)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	if t1 != 1 {
		t.Fatalf("first token = %d, want 1", t1)
	}
	// Contention: a second live holder is refused.
	if _, err := st.AcquireWatchExecLease(ctx, uid, "worker-b/job-2", ttl); !errors.Is(err, ErrLeaseHeld) {
		t.Fatalf("second acquire err = %v, want ErrLeaseHeld", err)
	}
	// Renewal keeps the holder in charge.
	if err := st.RenewWatchExecLease(ctx, uid, "worker-a/job-1", t1, ttl); err != nil {
		t.Fatalf("renew: %v", err)
	}
	// A stale-token renewal is refused (takeover happened in between is
	// simulated after the takeover below).

	// Expiry takeover: backdate the heartbeat past the TTL.
	if err := st.db.WithContext(ctx).Model(&WatchExecLease{}).
		Where("user_id = ?", uid).
		Update("heartbeat_at", time.Now().UTC().Add(-2*ttl)).Error; err != nil {
		t.Fatalf("backdate heartbeat: %v", err)
	}
	t2, err := st.AcquireWatchExecLease(ctx, uid, "worker-b/job-2", ttl)
	if err != nil {
		t.Fatalf("takeover acquire: %v", err)
	}
	if t2 != t1+1 {
		t.Fatalf("takeover token = %d, want %d (increment)", t2, t1+1)
	}
	// The old holder's renewal now fails — its token is fenced out.
	if err := st.RenewWatchExecLease(ctx, uid, "worker-a/job-1", t1, ttl); !errors.Is(err, ErrLeaseHeld) {
		t.Fatalf("stale renewal err = %v, want ErrLeaseHeld", err)
	}
	// Release by the rightful holder; a re-acquire starts fresh but keeps
	// climbing the token (never reuses a fenced number).
	if err := st.ReleaseWatchExecLease(ctx, uid, "worker-b/job-2", t2); err != nil {
		t.Fatalf("release: %v", err)
	}
	t3, err := st.AcquireWatchExecLease(ctx, uid, "worker-c/job-3", ttl)
	if err != nil {
		t.Fatalf("re-acquire: %v", err)
	}
	if t3 <= t2 {
		t.Fatalf("re-acquire token = %d, want > %d", t3, t2)
	}
}

// TestWriteIsolation_StaleWorkerLateUpload is THE AC2/AC5 scenario: a worker
// whose lease was taken over (or whose binding was replaced) uploads its blob
// successfully, then the storage transaction refuses the publish — the row and
// its pointer keep the new writer's data, and the stale object is left
// unreferenced for the GC.
func TestWriteIsolation_StaleWorkerLateUpload(t *testing.T) {
	st, fs := openIsolationStore(t)
	ctx := context.Background()
	uid := isoUser(t)
	const label = "act-stale"

	if _, err := st.EnsureWatchBinding(ctx, uid, "coros"); err != nil {
		t.Fatalf("ensure binding: %v", err)
	}
	// Worker A begins a session and publishes.
	sessA, err := st.BeginWatchSyncSession(ctx, uid, "coros", "worker-a/job-1", time.Minute)
	if err != nil {
		t.Fatalf("begin session A: %v", err)
	}
	if err := publish(ctx, st, sessA, isoActivity(uid, label, 150), isoPoints(150), false); err != nil {
		t.Fatalf("worker A publish: %v", err)
	}
	ptrA := isoPointer(t, st, uid, label)
	if !hasV2Prefix(ptrA) {
		t.Fatalf("worker A pointer = %+v, want a v2 key", ptrA)
	}

	// A's lease expires; worker B takes over and re-publishes with NEW data.
	if err := st.db.WithContext(ctx).Model(&WatchExecLease{}).
		Where("user_id = ?", uid).
		Update("heartbeat_at", time.Now().UTC().Add(-2*time.Minute)).Error; err != nil {
		t.Fatalf("expire A lease: %v", err)
	}
	sessB, err := st.BeginWatchSyncSession(ctx, uid, "coros", "worker-b/job-2", time.Minute)
	if err != nil {
		t.Fatalf("begin session B: %v", err)
	}
	if sessB.LeaseToken <= sessA.LeaseToken {
		t.Fatalf("takeover token %d not > %d", sessB.LeaseToken, sessA.LeaseToken)
	}
	if err := publish(ctx, st, sessB, isoActivity(uid, label, 160), isoPoints(160), false); err != nil {
		t.Fatalf("worker B publish: %v", err)
	}
	ptrB := isoPointer(t, st, uid, label)
	if ptrB == ptrA {
		t.Fatalf("worker B pointer %s did not move from A's %s", ptrB, ptrA)
	}

	// The stale worker A uploads its (older) blob and tries to publish.
	err = publish(ctx, st, sessA, isoActivity(uid, label, 140), isoPoints(140), false)
	if reason := isoFenceReason(t, err); reason != "lease_lost" {
		t.Fatalf("stale publish reason = %q, want lease_lost", reason)
	}
	// The row still serves worker B's data…
	ptrAfter := isoPointer(t, st, uid, label)
	if ptrAfter != ptrB {
		t.Fatalf("row pointer moved to %s after stale publish, want B's %s", ptrAfter, ptrB)
	}
	// …the stale worker's blob exists but is referenced by nothing (the
	// blob-succeeded / transaction-refused shape the GC must collect).
	stale := staleKey(t, fs, uid, label, ptrB)
	if su, _, _, _, ok := tsstore.ParseV2BlobKey(stale); !ok || su != uid {
		t.Fatalf("stale object %q not a %s v2 object", stale, uid)
	}
	ref, err := st.ListReferencedTSBlobKeys(ctx)
	if err != nil {
		t.Fatalf("list referenced: %v", err)
	}
	ref = isoUserKeys(ref, uid)
	if len(ref) != 1 || !ref[ptrB] {
		t.Fatalf("referenced set for %s = %v, want exactly B's key", uid, ref)
	}
	// The read path serves B's points, and A's cursor write is fenced too.
	pts, err := st.ActivityTimeseries(ctx, uid, label)
	if err != nil || len(pts) != 3 {
		t.Fatalf("read after stale publish = %d pts, %v; want 3 (worker B's)", len(pts), err)
	}
	if err := st.SetMeta(WithPublishSession(ctx, sessA), uid, "last_label_id", label); isoFenceReason(t, err) != "lease_lost" {
		t.Fatalf("stale cursor write err = %v, want lease_lost fence", err)
	}
	// No upload intent rows survived either publish.
	var intents int64
	if err := st.db.WithContext(ctx).Model(&TSUploadIntent{}).Count(&intents).Error; err != nil {
		t.Fatalf("count intents: %v", err)
	}
	if intents != 0 {
		t.Fatalf("%d upload intents survived", intents)
	}
}

// staleKey finds the leftover (referenced-by-nothing) object key for the
// label among the listed bucket keys — anything parseable that is not the
// current pointer.
func staleKey(t *testing.T, fs *tsstore.FileStore, uid, label string, exclude ...string) string {
	t.Helper()
	var found string
	ex := map[string]bool{}
	for _, k := range exclude {
		ex[k] = true
	}
	err := fs.List(context.Background(), tsstore.V2KeyPrefix+uid+"/"+label+"/", func(info tsstore.ObjectInfo) error {
		if !ex[info.Key] {
			found = info.Key
		}
		return nil
	})
	if err != nil {
		t.Fatalf("list stale candidates: %v", err)
	}
	if found == "" {
		t.Fatalf("no unreferenced object left for %s/%s (exclusions %v)", uid, label, exclude)
	}
	return found
}

// TestWriteIsolation_RebindFencesOldSession covers the rebind race: A's
// binding was replaced (account switch), so A's next publish is refused with
// binding_changed even though A's lease row is intact.
func TestWriteIsolation_RebindFencesOldSession(t *testing.T) {
	st, _ := openIsolationStore(t)
	ctx := context.Background()
	uid := isoUser(t)
	acct := "coros-acct-1"
	if err := st.SaveCredential(ctx, &ProviderCredential{UserID: uid, Provider: "coros",
		ProviderUserID: &acct, UpdatedAt: time.Now().UTC()}); err != nil {
		t.Fatalf("save credential: %v", err)
	}
	sessA, err := st.BeginWatchSyncSession(ctx, uid, "coros", "worker-a/job-1", time.Minute)
	if err != nil {
		t.Fatalf("begin session: %v", err)
	}
	// The user rebinds to a different vendor account mid-sync.
	acct2 := "coros-acct-2"
	if err := st.SaveCredential(ctx, &ProviderCredential{UserID: uid, Provider: "coros",
		ProviderUserID: &acct2, UpdatedAt: time.Now().UTC()}); err != nil {
		t.Fatalf("rebind save: %v", err)
	}
	err = publish(ctx, st, sessA, isoActivity(uid, "act-rebind", 150), isoPoints(150), false)
	if reason := isoFenceReason(t, err); reason != "binding_changed" {
		t.Fatalf("rebind-fenced publish reason = %q, want binding_changed", reason)
	}
	exists, err := st.ActivityExists(ctx, uid, "act-rebind")
	if err != nil || exists {
		t.Fatalf("activity exists after binding-changed refusal = (%v, %v), want (false, nil)", exists, err)
	}
}

// TestWriteIsolation_IdempotentRetry pins AC2's idempotency: retrying the
// same content under the same session rewrites the identical key and leaves
// one consistent pointer; genuinely new content moves the pointer and
// orphans the old object.
func TestWriteIsolation_IdempotentRetry(t *testing.T) {
	st, fs := openIsolationStore(t)
	ctx := context.Background()
	uid := isoUser(t)
	const label = "act-idem"

	sess, err := st.BeginWatchSyncSession(ctx, uid, "coros", "worker-a/job-1", time.Minute)
	if err != nil {
		t.Fatalf("begin session: %v", err)
	}
	pts := isoPoints(150)
	if err := publish(ctx, st, sess, isoActivity(uid, label, 150), pts, false); err != nil {
		t.Fatalf("first publish: %v", err)
	}
	ptr1 := isoPointer(t, st, uid, label)
	// Same session, same content: idempotent.
	if err := publish(ctx, st, sess, isoActivity(uid, label, 150), pts, false); err != nil {
		t.Fatalf("retry publish: %v", err)
	}
	ptr2 := isoPointer(t, st, uid, label)
	if ptr1 != ptr2 {
		t.Fatalf("retry moved the pointer: %s -> %s", ptr1, ptr2)
	}
	var rows int64
	if err := st.db.WithContext(ctx).Model(&Activity{}).
		Where("user_id = ? AND label_id = ?", uid, label).Count(&rows).Error; err != nil || rows != 1 {
		t.Fatalf("activity rows = %d (%v), want 1", rows, err)
	}
	// New content under the same session: new key, pointer moves, old object
	// becomes unreferenced.
	if err := publish(ctx, st, sess, isoActivity(uid, label, 160), isoPoints(160), false); err != nil {
		t.Fatalf("re-publish new content: %v", err)
	}
	ptr3 := isoPointer(t, st, uid, label)
	if ptr3 == ptr2 {
		t.Fatal("new content did not move the pointer")
	}
	ref, err := st.ListReferencedTSBlobKeys(ctx)
	if err != nil {
		t.Fatalf("list referenced: %v", err)
	}
	ref = isoUserKeys(ref, uid)
	if len(ref) != 1 || !ref[ptr3] {
		t.Fatalf("referenced set for %s = %v, want exactly the newest key", uid, ref)
	}
	if _, err := fs.Get(context.Background(), ptr2); err != nil {
		t.Fatalf("superseded object vanished before GC: %v", err)
	}
}

// TestWriteIsolation_V1V2ReadCoexistence pins AC4's read compatibility: the
// read path serves whatever the row points at — a legacy v1 fixed key and a
// v2 immutable key side by side.
func TestWriteIsolation_V1V2ReadCoexistence(t *testing.T) {
	st, _ := openIsolationStore(t)
	ctx := context.Background()
	uid := isoUser(t)

	// Legacy write (no session): v1 fixed key.
	if err := st.UpsertActivity(ctx, isoActivity(uid, "act-v1", 150), nil, isoPoints(150), nil); err != nil {
		t.Fatalf("legacy v1 write: %v", err)
	}
	p1 := isoPointer(t, st, uid, "act-v1")
	if !hasV1Prefix(p1) {
		t.Fatalf("v1 pointer = %s", p1)
	}
	// Fenced write (session): v2 immutable key.
	sess, err := st.BeginWatchSyncSession(ctx, uid, "coros", "worker-a/job-1", time.Minute)
	if err != nil {
		t.Fatalf("begin session: %v", err)
	}
	if err := publish(ctx, st, sess, isoActivity(uid, "act-v2", 160), isoPoints(160), false); err != nil {
		t.Fatalf("fenced v2 write: %v", err)
	}
	p2 := isoPointer(t, st, uid, "act-v2")
	if !hasV2Prefix(p2) {
		t.Fatalf("v2 pointer = %s", p2)
	}
	// Both read back through the same surface with verified checksums.
	for label, wantHR := range map[string]int{"act-v1": 150, "act-v2": 160} {
		pts, err := st.ActivityTimeseries(ctx, uid, label)
		if err != nil {
			t.Fatalf("read %s: %v", label, err)
		}
		if len(pts) != 3 || pts[0].HeartRate == nil || *pts[0].HeartRate != wantHR {
			t.Fatalf("read %s = %+v…, want HR %d on every point", label, pts[:1], wantHR)
		}
	}
	// The audit sampling frame carries both actual keys (scoped to this
	// user — the shared CI database accumulates other runs' rows).
	pointers, err := st.ListTSBlobPointers(ctx)
	if err != nil {
		t.Fatalf("list pointers: %v", err)
	}
	got := map[string]string{}
	for _, p := range pointers {
		if p.UserID == uid {
			got[p.Label] = p.BlobKey
		}
	}
	if got["act-v1"] != p1 || got["act-v2"] != p2 {
		t.Fatalf("pointer frames = %v, want actual keys %s / %s", got, p1, p2)
	}
}

// TestWriteIsolation_UserEditsPreserved pins AC3's edit-preservation on the
// fenced path: a provider payload never carries feel_note, so the athlete's
// words survive a fenced re-publish.
func TestWriteIsolation_UserEditsPreserved(t *testing.T) {
	st, _ := openIsolationStore(t)
	ctx := context.Background()
	uid := isoUser(t)
	const label = "act-edits"

	sess, err := st.BeginWatchSyncSession(ctx, uid, "coros", "worker-a/job-1", time.Minute)
	if err != nil {
		t.Fatalf("begin session: %v", err)
	}
	if err := publish(ctx, st, sess, isoActivity(uid, label, 150), isoPoints(150), false); err != nil {
		t.Fatalf("publish: %v", err)
	}
	const note = "前面4组体感6，最后两组7-8"
	ok, err := st.SetActivityFeelNote(ctx, uid, label, note)
	if err != nil || !ok {
		t.Fatalf("set feel note = (%v, %v)", ok, err)
	}
	if err := publish(ctx, st, sess, isoActivity(uid, label, 151), isoPoints(151), false); err != nil {
		t.Fatalf("re-publish: %v", err)
	}
	var a Activity
	if err := st.db.WithContext(ctx).Where("user_id = ? AND label_id = ?", uid, label).First(&a).Error; err != nil {
		t.Fatalf("reload activity: %v", err)
	}
	if a.FeelNote == nil || *a.FeelNote != note {
		t.Fatalf("feel_note after fenced re-publish = %v, want %q", a.FeelNote, note)
	}
}

// TestWriteIsolation_ErasureSweepsBothLayouts pins AC4's erasure
// compatibility: account deletion removes v1 AND v2 objects plus the
// isolation-state rows.
func TestWriteIsolation_ErasureSweepsBothLayouts(t *testing.T) {
	st, fs := openIsolationStore(t)
	ctx := context.Background()
	uid := isoUser(t)

	// A legacy v1 object and a fenced v2 object for two labels.
	if err := st.UpsertActivity(ctx, isoActivity(uid, "act-v1", 150), nil, isoPoints(150), nil); err != nil {
		t.Fatalf("v1 write: %v", err)
	}
	sess, err := st.BeginWatchSyncSession(ctx, uid, "coros", "worker-a/job-1", time.Minute)
	if err != nil {
		t.Fatalf("begin session: %v", err)
	}
	if err := publish(ctx, st, sess, isoActivity(uid, "act-v2", 160), isoPoints(160), false); err != nil {
		t.Fatalf("v2 write: %v", err)
	}
	if err := st.DeleteUserData(ctx, uid); err != nil {
		t.Fatalf("delete user data: %v", err)
	}
	for _, prefix := range tsstore.AllKeyPrefixes() {
		var keys []string
		if err := fs.List(ctx, prefix+uid+"/", func(info tsstore.ObjectInfo) error {
			keys = append(keys, info.Key)
			return nil
		}); err != nil {
			t.Fatalf("list %s after erasure: %v", prefix, err)
		}
		if len(keys) != 0 {
			t.Fatalf("%s objects survived erasure: %v", prefix, keys)
		}
	}
	for _, model := range []any{&WatchBindingState{}, &WatchExecLease{}, &TSUploadIntent{}} {
		var n int64
		if err := st.db.WithContext(ctx).Model(model).Where("user_id = ?", uid).Count(&n).Error; err != nil {
			t.Fatalf("count isolation rows: %v", err)
		}
		if n != 0 {
			t.Fatalf("%T rows survived erasure: %d", model, n)
		}
	}
}

// TestWriteIsolation_GarminPreservePathKeepsPointer checks the fenced
// Garmin empty-details shape (preserveEmpty, no points): it must not touch
// the blob or clobber the stamped pointer.
func TestWriteIsolation_GarminPreservePathKeepsPointer(t *testing.T) {
	st, _ := openIsolationStore(t)
	ctx := context.Background()
	uid := isoUser(t)
	const label = "act-empty-details"

	sess, err := st.BeginWatchSyncSession(ctx, uid, "garmin", "worker-a/job-1", time.Minute)
	if err != nil {
		t.Fatalf("begin session: %v", err)
	}
	if err := publish(ctx, st, sess, isoActivity(uid, label, 150), isoPoints(150), false); err != nil {
		t.Fatalf("full publish: %v", err)
	}
	before := isoPointer(t, st, uid, label)
	// The empty-details preserve-upsert: no points, keep children/pointer.
	if err := publish(ctx, st, sess, isoActivity(uid, label, 150), nil, true); err != nil {
		t.Fatalf("preserve publish: %v", err)
	}
	after := isoPointer(t, st, uid, label)
	if after != before {
		t.Fatalf("preserve-upsert moved pointer %s -> %s", before, after)
	}
	pts, err := st.ActivityTimeseries(ctx, uid, label)
	if err != nil || len(pts) != 3 {
		t.Fatalf("read after preserve-upsert = %d pts, %v; want 3 kept", len(pts), err)
	}
}

// --- helpers -----------------------------------------------------------------

// isoPointer returns the row's actual ts_blob_key for the activity.
func isoPointer(t *testing.T, st *Store, uid, label string) string {
	t.Helper()
	var p struct {
		TsBlobKey *string `gorm:"column:ts_blob_key"`
	}
	err := st.db.WithContext(context.Background()).Model(&Activity{}).
		Select("ts_blob_key").
		Where("user_id = ? AND label_id = ?", uid, label).
		Take(&p).Error
	if err == gorm.ErrRecordNotFound {
		t.Fatalf("activity %s/%s missing", uid, label)
	}
	if err != nil {
		t.Fatalf("read pointer: %v", err)
	}
	if p.TsBlobKey == nil {
		t.Fatalf("activity %s/%s has no blob pointer", uid, label)
	}
	return *p.TsBlobKey
}

func hasV1Prefix(key string) bool { return strings.HasPrefix(key, tsstore.KeyPrefix) }
func hasV2Prefix(key string) bool { return strings.HasPrefix(key, tsstore.V2KeyPrefix) }

// isoUserKeys filters a referenced-key set down to the given user's objects —
// the shared CI database keeps rows from earlier runs, so set-size assertions
// must scope to the test's own user.
func isoUserKeys(keys map[string]bool, uid string) map[string]bool {
	out := map[string]bool{}
	for k := range keys {
		if strings.Contains(k, "/"+uid+"/") {
			out[k] = true
		}
	}
	return out
}
