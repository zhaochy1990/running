// onboarding_sync_test.go is the devops#1006 storage suite: real MySQL
// (STRIDE_WORKER_TEST_MYSQL_DSN), exercising the atomic claim semantics —
// create-with-intents, multi-client idempotent claim, rebind isolation, and
// the dispatch/work-item/coverage state machines.
package storage

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func openOnboardingSyncStore(t *testing.T) *Store {
	t.Helper()
	st := openTestStore(t) // skips without STRIDE_WORKER_TEST_MYSQL_DSN
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	if err := st.AutoMigrateOnboardingSync(ctx); err != nil {
		t.Fatalf("automigrate onboarding sync: %v", err)
	}
	return st
}

func claimSpec(uid string) OnboardingSyncClaimSpec {
	anchor := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	return OnboardingSyncClaimSpec{
		UserID: uid, Provider: "coros",
		AnchorDay: "2026-11-16", AnchorAtUTC: anchor,
		StageNames: []string{OnboardingSyncStageRecentRaw},
		WorkItems: map[string][]OnboardingSyncWorkItemSpec{
			OnboardingSyncStageRecentRaw: {
				{Kind: "activities", RangeFrom: "2026-08-18", RangeTo: "2026-11-16"},
				{Kind: "health", RangeFrom: "2026-10-19", RangeTo: "2026-11-16"},
			},
		},
		IdempotencyKey: func(stage, sessionID string, rev int64) string {
			return "onbsync:" + sessionID + ":" + stage + ":rev" + fmt.Sprintf("%d", rev)
		},
	}
}

func TestOnboardingSyncClaim_CreatesSessionWithIntents(t *testing.T) {
	st := openOnboardingSyncStore(t)
	ctx := context.Background()
	uid := uuid.NewString()

	res, err := st.ClaimOrCreateOnboardingSyncSession(ctx, claimSpec(uid))
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if !res.Created || res.Claimed {
		t.Fatalf("want created, got created=%v claimed=%v", res.Created, res.Claimed)
	}
	sess := res.Session
	if !sess.ShellReady {
		t.Error("shell_ready must be true once session + dispatch record are persisted")
	}
	if sess.BindingRevision != 1 {
		t.Errorf("first-seen binding revision = %d, want 1", sess.BindingRevision)
	}
	// Dispatch intent, work items and coverage row all landed with the session.
	disp, err := st.ListOnboardingSyncDispatches(ctx, sess.SessionID)
	if err != nil || len(disp) != 1 {
		t.Fatalf("dispatches = %v err=%v, want 1", disp, err)
	}
	if disp[0].Status != OnboardingSyncDispatchPending || disp[0].IdempotencyKey == "" {
		t.Errorf("dispatch = %+v, want pending with key", disp[0])
	}
	items, err := st.ListOnboardingSyncWorkItems(ctx, sess.SessionID, "")
	if err != nil || len(items) != 2 {
		t.Fatalf("work items = %v err=%v, want 2", items, err)
	}
	cov, err := st.GetOnboardingSyncStageCoverage(ctx, sess.SessionID, OnboardingSyncStageRecentRaw)
	if err != nil || cov == nil {
		t.Fatalf("coverage missing: %v", err)
	}
	if cov.TargetFrom != "2026-08-18" || cov.TargetTo != "2026-11-16" {
		t.Errorf("target window = %s..%s, want 2026-08-18..2026-11-16", cov.TargetFrom, cov.TargetTo)
	}
	if cov.ObservedFrom != nil {
		t.Error("observed must start NULL — nothing is inferred")
	}
}

func TestOnboardingSyncClaim_RepeatClaimsSameSession(t *testing.T) {
	st := openOnboardingSyncStore(t)
	ctx := context.Background()
	uid := uuid.NewString()

	first, err := st.ClaimOrCreateOnboardingSyncSession(ctx, claimSpec(uid))
	if err != nil {
		t.Fatalf("first claim: %v", err)
	}
	second, err := st.ClaimOrCreateOnboardingSyncSession(ctx, claimSpec(uid))
	if err != nil {
		t.Fatalf("second claim: %v", err)
	}
	if !second.Claimed || second.Created {
		t.Fatalf("want claimed, got created=%v claimed=%v", second.Created, second.Claimed)
	}
	if second.Session.SessionID != first.Session.SessionID {
		t.Errorf("repeat claim session = %s, want %s", second.Session.SessionID, first.Session.SessionID)
	}
	disp, err := st.ListOnboardingSyncDispatches(ctx, first.Session.SessionID)
	if err != nil || len(disp) != 1 {
		t.Fatalf("repeat claim must not add dispatch rows: %v err=%v", disp, err)
	}
}

func TestOnboardingSyncClaim_ConcurrentClaimsSameSession(t *testing.T) {
	st := openOnboardingSyncStore(t)
	ctx := context.Background()
	uid := uuid.NewString()

	const n = 8
	ids := make(chan string, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			res, err := st.ClaimOrCreateOnboardingSyncSession(ctx, claimSpec(uid))
			if err != nil {
				t.Errorf("concurrent claim: %v", err)
				return
			}
			ids <- res.Session.SessionID
		}()
	}
	wg.Wait()
	close(ids)
	first := ""
	for id := range ids {
		if first == "" {
			first = id
			continue
		}
		if id != first {
			t.Fatalf("concurrent claims resolved to different sessions: %s vs %s", id, first)
		}
	}
}

func TestOnboardingSyncClaim_RebindIsolatesOldSession(t *testing.T) {
	st := openOnboardingSyncStore(t)
	ctx := context.Background()
	uid := uuid.NewString()

	old, err := st.ClaimOrCreateOnboardingSyncSession(ctx, claimSpec(uid))
	if err != nil {
		t.Fatalf("old claim: %v", err)
	}
	// Unbind (tombstone, revision bump) then rebind to Garmin (bump again).
	if err := st.DeleteCredential(ctx, uid, "coros"); err != nil {
		t.Fatalf("unbind: %v", err)
	}
	garmin := "garmin"
	acct := "g-1"
	if err := st.SaveCredential(ctx, &ProviderCredential{
		UserID: uid, Provider: garmin, ProviderUserID: &acct,
		UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("rebind: %v", err)
	}

	spec := claimSpec(uid)
	spec.Provider = garmin
	res, err := st.ClaimOrCreateOnboardingSyncSession(ctx, spec)
	if err != nil {
		t.Fatalf("new claim: %v", err)
	}
	if !res.Created {
		t.Fatalf("rebind must create a fresh session, got claimed")
	}
	if res.Session.BindingRevision <= old.Session.BindingRevision {
		t.Errorf("new session revision = %d, want > %d", res.Session.BindingRevision, old.Session.BindingRevision)
	}
	// The old session is superseded and invisible to the user's current view.
	got, err := st.GetOnboardingSyncSession(ctx, uid)
	if err != nil {
		t.Fatalf("get current: %v", err)
	}
	if got.SessionID != res.Session.SessionID {
		t.Errorf("current session = %s, want the new %s", got.SessionID, res.Session.SessionID)
	}
	oldRow, err := st.GetOnboardingSyncSessionByID(ctx, old.Session.SessionID)
	if err != nil || oldRow == nil {
		t.Fatalf("old session row: %v %v", oldRow, err)
	}
	if oldRow.State != OnboardingSyncStateSuperseded {
		t.Errorf("old session state = %s, want superseded", oldRow.State)
	}
	if !oldRow.Terminal() {
		t.Error("superseded session must read as terminal")
	}
}

func TestOnboardingSyncClaim_RejectsProviderMismatch(t *testing.T) {
	st := openOnboardingSyncStore(t)
	ctx := context.Background()
	uid := uuid.NewString()
	if _, err := st.EnsureWatchBinding(ctx, uid, "coros"); err != nil {
		t.Fatalf("ensure binding: %v", err)
	}
	spec := claimSpec(uid)
	spec.Provider = "garmin" // binding says coros
	if _, err := st.ClaimOrCreateOnboardingSyncSession(ctx, spec); err != ErrOnboardingSyncStaleBinding {
		t.Fatalf("mismatched provider err = %v, want ErrOnboardingSyncStaleBinding", err)
	}
}

func TestOnboardingSyncDispatchStateMachine(t *testing.T) {
	st := openOnboardingSyncStore(t)
	ctx := context.Background()
	uid := uuid.NewString()
	res, err := st.ClaimOrCreateOnboardingSyncSession(ctx, claimSpec(uid))
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	disp, _ := st.ListOnboardingSyncDispatches(ctx, res.Session.SessionID)
	d := disp[0]

	// pending → dispatched (guarded; second mark is a no-op).
	if err := st.MarkOnboardingSyncDispatchDispatched(ctx, d.ID, "job-1"); err != nil {
		t.Fatalf("mark dispatched: %v", err)
	}
	if err := st.MarkOnboardingSyncDispatchDispatched(ctx, d.ID, "job-2"); err != nil {
		t.Fatalf("double mark should be a silent no-op: %v", err)
	}
	rows, _ := st.ListOnboardingSyncDispatches(ctx, res.Session.SessionID)
	if rows[0].JobID == nil || *rows[0].JobID != "job-1" || rows[0].Attempts != 1 {
		t.Errorf("dispatch = %+v, want job-1 attempts=1", rows[0])
	}

	// dispatched → failed re-arms under a fresh key (the retry generation).
	if err := st.MarkOnboardingSyncDispatchTerminal(ctx, d.ID, OnboardingSyncDispatchFailed); err != nil {
		t.Fatalf("mark failed: %v", err)
	}
	if err := st.RequeueOnboardingSyncDispatchForRetry(ctx, d.ID, "onbsync:new-key"); err != nil {
		t.Fatalf("requeue: %v", err)
	}
	rows, _ = st.ListOnboardingSyncDispatches(ctx, res.Session.SessionID)
	if rows[0].Status != OnboardingSyncDispatchPending || rows[0].IdempotencyKey != "onbsync:new-key" {
		t.Fatalf("requeued dispatch = %+v", rows[0])
	}

	// Re-dispatch, then done. A done dispatch is never re-armed (successful
	// work is reused, not re-fetched).
	if err := st.MarkOnboardingSyncDispatchDispatched(ctx, d.ID, "job-2"); err != nil {
		t.Fatalf("re-dispatch: %v", err)
	}
	if err := st.MarkOnboardingSyncDispatchTerminal(ctx, d.ID, OnboardingSyncDispatchDone); err != nil {
		t.Fatalf("mark done: %v", err)
	}
	if err := st.RequeueOnboardingSyncDispatchForRetry(ctx, d.ID, "onbsync:another"); err != nil {
		t.Fatalf("requeue done should be a silent no-op: %v", err)
	}
	rows, _ = st.ListOnboardingSyncDispatches(ctx, res.Session.SessionID)
	if rows[0].Status != OnboardingSyncDispatchDone {
		t.Errorf("done dispatch re-armed: %+v", rows[0])
	}
}

func TestOnboardingSyncWorkItemTransitions(t *testing.T) {
	st := openOnboardingSyncStore(t)
	ctx := context.Background()
	uid := uuid.NewString()
	res, err := st.ClaimOrCreateOnboardingSyncSession(ctx, claimSpec(uid))
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	items, _ := st.ListOnboardingSyncWorkItems(ctx, res.Session.SessionID, "")
	cred := "complete-fetch:abc123"
	if err := st.MarkOnboardingSyncWorkItem(ctx, items[0].ID, OnboardingSyncItemDone, cred, nil); err != nil {
		t.Fatalf("mark done: %v", err)
	}
	// A done item never re-transitions (the credential is the reuse proof).
	if err := st.MarkOnboardingSyncWorkItem(ctx, items[0].ID, OnboardingSyncItemFailed, "", strptrTest("boom")); err != nil {
		t.Fatalf("re-mark done should be a no-op error-free: %v", err)
	}
	rows, _ := st.ListOnboardingSyncWorkItems(ctx, res.Session.SessionID, "")
	if rows[0].Status != OnboardingSyncItemDone || rows[0].FetchCredential == nil || *rows[0].FetchCredential != cred {
		t.Errorf("item = %+v, want done with credential", rows[0])
	}

	// failed → retry reset arms it again; gap items are never reset.
	msg := "429"
	_ = st.MarkOnboardingSyncWorkItem(ctx, items[1].ID, OnboardingSyncItemFailed, "", &msg)
	n, err := st.ResetFailedOnboardingSyncWorkItems(ctx, res.Session.SessionID, OnboardingSyncStageRecentRaw)
	if err != nil || n != 1 {
		t.Fatalf("reset failed items n=%d err=%v, want 1", n, err)
	}
	rows, _ = st.ListOnboardingSyncWorkItems(ctx, res.Session.SessionID, "")
	if rows[1].Status != OnboardingSyncItemPending {
		t.Errorf("failed item after reset = %s, want pending", rows[1].Status)
	}
	// A gap item keeps its derived credential (devops#1010): the executor
	// derives a storage-backed observed window even for gap outcomes, and the
	// stage aggregation reads that window back out of the persisted row.
	gapCred := "coros:v1:range:health:2026-10-19..2026-11-16:obs=2026-10-26..2026-11-16:n=22"
	_ = st.MarkOnboardingSyncWorkItem(ctx, items[1].ID, OnboardingSyncItemGap, gapCred, strptrTest("vendor lacks hr"))
	if _, err := st.ResetFailedOnboardingSyncWorkItems(ctx, res.Session.SessionID, OnboardingSyncStageRecentRaw); err != nil {
		t.Fatalf("reset again: %v", err)
	}
	rows, _ = st.ListOnboardingSyncWorkItems(ctx, res.Session.SessionID, "")
	if rows[1].Status != OnboardingSyncItemGap {
		t.Errorf("gap item after reset = %s, want gap (permanent)", rows[1].Status)
	}
	if rows[1].FetchCredential == nil || *rows[1].FetchCredential != gapCred {
		t.Errorf("gap item credential = %v, want the derived credential persisted", rows[1].FetchCredential)
	}
}

func strptrTest(s string) *string { return &s }
