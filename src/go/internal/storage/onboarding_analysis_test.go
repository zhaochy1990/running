// onboarding_analysis_test.go is the devops#1009 (T05) storage suite: the
// recent-analysis stage rows (ensure-once, idempotent work-item append,
// forward-only target extension), the published result row lifecycle
// (upsert-supersede / stale), and the input digest + fingerprint that drive
// refresh invalidation. Real MySQL like the rest of the onboarding-sync
// storage suite (skips without STRIDE_WORKER_TEST_MYSQL_DSN).
package storage

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestOnboardingSyncAnalysisStageRows(t *testing.T) {
	st := openOnboardingSyncStore(t)
	ctx := context.Background()
	uid := uuid.NewString()

	res, err := st.ClaimOrCreateOnboardingSyncSession(ctx, claimSpec(uid))
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	sid := res.Session.SessionID

	// Ensure is idempotent: a second call (a concurrent sweep racing the
	// advance pass) must not create a second dispatch/coverage row.
	if err := st.EnsureOnboardingSyncStage(ctx, sid, OnboardingSyncStageRecentAnalysis,
		"2026-08-18", "2026-11-16", "key1"); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	if err := st.EnsureOnboardingSyncStage(ctx, sid, OnboardingSyncStageRecentAnalysis,
		"2026-08-18", "2026-11-16", "key2"); err != nil {
		t.Fatalf("ensure again: %v", err)
	}
	disp, err := st.ListOnboardingSyncDispatches(ctx, sid)
	if err != nil {
		t.Fatalf("list dispatches: %v", err)
	}
	var analysis *OnboardingSyncDispatch
	for _, d := range disp {
		if d.Stage == OnboardingSyncStageRecentAnalysis {
			if analysis != nil {
				t.Fatal("duplicate analysis dispatch")
			}
			analysis = d
		}
	}
	if analysis == nil {
		t.Fatal("missing analysis dispatch")
	}
	cov, err := st.GetOnboardingSyncStageCoverage(ctx, sid, OnboardingSyncStageRecentAnalysis)
	if err != nil || cov == nil {
		t.Fatalf("analysis coverage = %+v err=%v, want a row", cov, err)
	}
	if cov.TargetFrom != "2026-08-18" || cov.TargetTo != "2026-11-16" {
		t.Fatalf("analysis coverage target = %s..%s, want 2026-08-18..2026-11-16", cov.TargetFrom, cov.TargetTo)
	}

	// Work-item append is idempotent and preserves existing terminal state.
	items := []OnboardingSyncWorkItemSpec{
		{Kind: "activities", RangeFrom: "2026-11-17", RangeTo: "2026-11-18"},
		{Kind: "health", RangeFrom: "2026-11-17", RangeTo: "2026-11-18"},
		{Kind: "dashboard", RangeFrom: "2026-11-18", RangeTo: "2026-11-18"},
	}
	for i := 0; i < 2; i++ {
		if err := st.AppendOnboardingSyncWorkItems(ctx, sid, OnboardingSyncStageRecentRaw, items); err != nil {
			t.Fatalf("append #%d: %v", i, err)
		}
	}
	rows, err := st.ListOnboardingSyncWorkItems(ctx, sid, OnboardingSyncStageRecentRaw)
	if err != nil {
		t.Fatalf("list items: %v", err)
	}
	want := 5 // 2 claim items + 3 appended
	if len(rows) != want {
		t.Fatalf("want %d work items after double append, got %d", want, len(rows))
	}

	// The refresh requeue supersedes a DONE dispatch (devops#1009): done →
	// pending under the new key, while the retry requeue keeps its
	// "done is never re-armed" contract (see TestOnboardingSyncDispatchStateMachine).
	if _, err := st.MarkOnboardingSyncDispatchDispatched(ctx, analysis, "job-x"); err != nil {
		t.Fatalf("dispatch mark: %v", err)
	}
	if _, err := st.MarkOnboardingSyncDispatchDone(ctx, analysis.ID, "job-x"); err != nil {
		t.Fatalf("terminal mark: %v", err)
	}
	observed := analysis
	keyFor := func(int) string { return "refresh-key" }
	if err := st.SetOnboardingSyncSessionState(ctx, sid, OnboardingSyncStateCompleted, nil); err != nil {
		t.Fatalf("completed session: %v", err)
	}
	if changed, err := st.RefreshOnboardingSyncAnalysis(ctx, observed, keyFor); err != nil || !changed {
		t.Fatalf("refresh requeue: changed=%v err=%v", changed, err)
	}
	after, err := st.ListOnboardingSyncDispatches(ctx, sid)
	if err != nil {
		t.Fatalf("list after refresh: %v", err)
	}
	for _, d := range after {
		if d.Stage == OnboardingSyncStageRecentAnalysis {
			analysis = d
			if d.Status != OnboardingSyncDispatchPending || d.IdempotencyKey != "refresh-key" {
				t.Fatalf("refresh-requeued analysis dispatch = %+v, want pending/refresh-key", d)
			}
		}
	}

	// A delayed sweep of the old key loses even after the new job is done.
	if marked, err := st.MarkOnboardingSyncDispatchDispatched(ctx, analysis, "job-refresh"); err != nil || !marked {
		t.Fatalf("dispatch refresh: marked=%v err=%v", marked, err)
	}
	if changed, err := st.MarkOnboardingSyncDispatchDone(ctx, analysis.ID, "job-refresh"); err != nil || !changed {
		t.Fatalf("complete refresh: changed=%v err=%v", changed, err)
	}
	if changed, err := st.RefreshOnboardingSyncAnalysis(ctx, observed, keyFor); err != nil || changed {
		t.Fatalf("stale refresh observation: changed=%v err=%v", changed, err)
	}
	sess, err := st.GetOnboardingSyncSessionByID(ctx, sid)
	if err != nil || sess.DispatchGeneration != 1 || sess.FailRetryCount != 0 {
		t.Fatalf("refresh counters: %+v err=%v", sess, err)
	}

	// Target extension is forward-only.
	if err := st.ExtendOnboardingSyncStageTarget(ctx, sid, OnboardingSyncStageRecentRaw, "2026-11-18"); err != nil {
		t.Fatalf("extend: %v", err)
	}
	rawCov, err := st.GetOnboardingSyncStageCoverage(ctx, sid, OnboardingSyncStageRecentRaw)
	if err != nil || rawCov.TargetTo != "2026-11-18" {
		t.Fatalf("raw target_to = %+v err=%v, want 2026-11-18", rawCov, err)
	}
	if err := st.ExtendOnboardingSyncStageTarget(ctx, sid, OnboardingSyncStageRecentRaw, "2026-11-10"); err != nil {
		t.Fatalf("extend backwards: %v", err)
	}
	rawCov, err = st.GetOnboardingSyncStageCoverage(ctx, sid, OnboardingSyncStageRecentRaw)
	if err != nil || rawCov.TargetTo != "2026-11-18" {
		t.Fatalf("raw target_to must stay 2026-11-18, got %+v err=%v", rawCov, err)
	}
}

func TestOnboardingSyncAnalysisResultRowLifecycle(t *testing.T) {
	st := openOnboardingSyncStore(t)
	ctx := context.Background()
	uid := uuid.NewString()

	res, err := st.ClaimOrCreateOnboardingSyncSession(ctx, claimSpec(uid))
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	sid := res.Session.SessionID

	if row, err := st.GetOnboardingRecentAnalysis(ctx, sid); err != nil || row != nil {
		t.Fatalf("get before publish = %+v err=%v, want nil", row, err)
	}
	now := time.Now().UTC()
	first := &OnboardingRecentAnalysis{
		SessionID: sid, UserID: uid, AsOfDay: "2026-11-16", AnchorDay: "2026-11-16",
		InputFingerprint: "fp-old", PolicyVersion: 4, PolicyRevision: 1,
		Status: OnboardingAnalysisStatusReady, Stale: false, ComputedAt: now,
	}
	if err := st.UpsertOnboardingRecentAnalysis(ctx, first); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	// A changed input revision only flags the published row stale: its true
	// as-of stays readable until the superseding run lands.
	if err := st.MarkOnboardingRecentAnalysisStale(ctx, sid, true); err != nil {
		t.Fatalf("mark stale: %v", err)
	}
	row, err := st.GetOnboardingRecentAnalysis(ctx, sid)
	if err != nil || row == nil {
		t.Fatalf("get: %+v %v", row, err)
	}
	if !row.Stale || row.AsOfDay != "2026-11-16" || row.InputFingerprint != "fp-old" {
		t.Fatalf("stale row must keep its true as-of/fingerprint: %+v", row)
	}
	// The refresh lands and supersedes in place (one live row per session).
	second := &OnboardingRecentAnalysis{
		SessionID: sid, UserID: uid, AsOfDay: "2026-11-17", AnchorDay: "2026-11-16",
		InputFingerprint: "fp-new", PolicyVersion: 4, PolicyRevision: 1,
		Status: OnboardingAnalysisStatusPartial, Stale: false, ComputedAt: time.Now().UTC(),
	}
	if err := st.UpsertOnboardingRecentAnalysis(ctx, second); err != nil {
		t.Fatalf("upsert 2: %v", err)
	}
	row, err = st.GetOnboardingRecentAnalysis(ctx, sid)
	if err != nil || row == nil {
		t.Fatalf("get 2: %+v %v", row, err)
	}
	if row.InputFingerprint != "fp-new" || row.AsOfDay != "2026-11-17" || row.Stale {
		t.Fatalf("superseding row = %+v, want fp-new/2026-11-17/not stale", row)
	}
}

func TestOnboardingSyncAnalysisDigestAndFingerprint(t *testing.T) {
	st := openOnboardingSyncStore(t)
	ctx := context.Background()
	uid := uuid.NewString()

	dist, dur := 8000.0, 2400.0
	if err := st.UpsertActivity(ctx, &Activity{
		UserID: uid, LabelID: "act-1", SportType: 1, Date: time.Date(2026, 11, 14, 2, 0, 0, 0, time.UTC),
		DistanceM: &dist, DurationS: &dur, Provider: "coros", SyncedAt: time.Now().UTC(),
	}, nil, nil, nil); err != nil {
		t.Fatalf("upsert activity: %v", err)
	}
	rhr := 48
	if err := st.UpsertDailyHealth(ctx, &DailyHealth{UserID: uid, Date: "2026-11-14", RHR: &rhr}); err != nil {
		t.Fatalf("upsert health: %v", err)
	}
	hrv := 62
	if err := st.UpsertDailyHRV(ctx, &DailyHRV{UserID: uid, Date: "2026-11-14", LastNightAvg: &hrv}); err != nil {
		t.Fatalf("upsert hrv: %v", err)
	}

	d1, err := st.OnboardingAnalysisDigest(ctx, uid, "2026-11-01", "2026-11-16")
	if err != nil {
		t.Fatalf("digest: %v", err)
	}
	if d1.ActivityCount != 1 || d1.HealthDayCount != 1 || d1.HRVDayCount != 1 {
		t.Fatalf("digest = %+v, want 1/1/1 rows", d1)
	}
	if d1.ActivityMaxSyncedAt == nil || d1.HealthMaxDate == nil || *d1.HealthMaxDate != "2026-11-14" {
		t.Fatalf("digest maxes = %+v", d1)
	}
	// Out-of-window rows do not count.
	d2, err := st.OnboardingAnalysisDigest(ctx, uid, "2026-11-15", "2026-11-16")
	if err != nil {
		t.Fatalf("digest 2: %v", err)
	}
	if d2.ActivityCount != 0 || d2.HealthDayCount != 0 || d2.HRVDayCount != 0 {
		t.Fatalf("empty-window digest = %+v, want 0/0/0", d2)
	}

	policy := DefaultCalibrationPolicy()
	fp1 := AnalysisFingerprint("2026-11-16", "2026-11-16", 1, policy, d1)
	if fp2 := AnalysisFingerprint("2026-11-16", "2026-11-16", 1, policy, d1); fp1 != fp2 {
		t.Fatal("fingerprint must be deterministic for identical inputs")
	}
	if fp3 := AnalysisFingerprint("2026-11-16", "2026-11-17", 1, policy, d1); fp3 == fp1 {
		t.Fatal("as-of day must participate in the fingerprint (cross-midnight invalidation)")
	}
	if fp4 := AnalysisFingerprint("2026-11-16", "2026-11-16", 2, policy, d1); fp4 == fp1 {
		t.Fatal("binding revision must participate in the fingerprint")
	}
	policyBumped := policy
	policyBumped.Revision = policy.Revision + 1
	if fp5 := AnalysisFingerprint("2026-11-16", "2026-11-16", 1, policyBumped, d1); fp5 == fp1 {
		t.Fatal("policy revision must participate in the fingerprint")
	}
	// A same-day new activity changes the digest, not any snapshot id —
	// exactly the AC5 invalidation case.
	if err := st.UpsertActivity(ctx, &Activity{
		UserID: uid, LabelID: "act-2", SportType: 1, Date: time.Date(2026, 11, 15, 2, 0, 0, 0, time.UTC),
		DistanceM: &dist, DurationS: &dur, Provider: "coros", SyncedAt: time.Now().UTC(),
	}, nil, nil, nil); err != nil {
		t.Fatalf("upsert activity 2: %v", err)
	}
	d3, err := st.OnboardingAnalysisDigest(ctx, uid, "2026-11-01", "2026-11-16")
	if err != nil {
		t.Fatalf("digest 3: %v", err)
	}
	if fp6 := AnalysisFingerprint("2026-11-16", "2026-11-16", 1, policy, d3); fp6 == fp1 {
		t.Fatal("changed input data must invalidate the fingerprint without any snapshot id moving")
	}
}
