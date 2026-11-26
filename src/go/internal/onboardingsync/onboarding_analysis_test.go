// onboarding_analysis_test.go is the devops#1009 (T05) orchestrator suite:
// the analysis stage's structural dependency on recent_raw (armed only after
// the raw stage terminalizes), the changed-input refresh sweep (fingerprint
// supersede, stale flag, merged single re-dispatch, refresh horizon), and the
// view's explicit analysis readiness levels. Real MySQL + the real service
// and sweep, like the rest of the package.
package onboardingsync

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// analysisHarness builds a harness with an overridable refresh horizon.
func analysisHarness(t *testing.T, horizon time.Duration) *harness {
	t.Helper()
	return newHarnessWithHorizon(t, horizon)
}

// hasAnalysisDispatch reports whether the session's analysis dispatch exists.
func hasAnalysisDispatch(t *testing.T, st *storage.Store, sessionID string) *storage.OnboardingSyncDispatch {
	t.Helper()
	disp, err := st.ListOnboardingSyncDispatches(context.Background(), sessionID)
	if err != nil {
		t.Fatalf("list dispatches: %v", err)
	}
	for _, d := range disp {
		if d.Stage == storage.OnboardingSyncStageRecentAnalysis {
			return d
		}
	}
	return nil
}

// completeThroughAnalysis walks both stages to completion: the raw job
// terminal-succeeds with full observed coverage, the sweep arms + dispatches
// the analysis stage, the analysis job terminal-succeeds, and the published
// result row lands with the given status/fingerprint.
func completeThroughAnalysis(t *testing.T, h *harness, uid string, status string) *storage.OnboardingSyncSession {
	t.Helper()
	ctx := context.Background()
	sess := createDispatched(t, h, uid)

	disp, _ := h.store.ListOnboardingSyncDispatches(ctx, sess.SessionID)
	j, _ := h.store.JobByID(ctx, *disp[0].JobID)
	anchor, _ := time.Parse("2006-01-02", sess.AnchorDay)
	obsFrom := anchor.AddDate(0, 0, -89).Format("2006-01-02")
	to := sess.AnchorDay
	b, _ := json.Marshal(StageResult{
		Stage: storage.OnboardingSyncStageRecentRaw, Status: "completed",
		ScannedFrom: &obsFrom, ScannedTo: &to, ObservedFrom: &obsFrom, ObservedTo: &to,
	})
	now := time.Now().UTC()
	j.Status = job.StatusDone
	j.ResultJSON = string(b)
	j.CompletedAt = &now
	if err := h.store.Jobs().Update(ctx, j); err != nil {
		t.Fatalf("raw job done: %v", err)
	}
	h.sweepN(ctx, 5)

	ad := hasAnalysisDispatch(t, h.store, sess.SessionID)
	if ad == nil || ad.JobID == nil {
		t.Fatalf("analysis dispatch = %+v, want armed+dispatched after raw completion", ad)
	}
	aj, _ := h.store.JobByID(ctx, *ad.JobID)
	ab, _ := json.Marshal(StageResult{
		Stage: storage.OnboardingSyncStageRecentAnalysis, Status: "completed",
		ScannedFrom: &obsFrom, ScannedTo: &to, ObservedFrom: &obsFrom, ObservedTo: &to,
	})
	aj.Status = job.StatusDone
	aj.ResultJSON = string(ab)
	aj.CompletedAt = &now
	if err := h.store.Jobs().Update(ctx, aj); err != nil {
		t.Fatalf("analysis job done: %v", err)
	}
	domains := `{"calibration":{"status":"ready"},"load":{"status":"` + domainStatusFor(status) + `"},"zones":{"status":"` + domainStatusFor(status) + `"},"ability":{"status":"` + domainStatusFor(status) + `"}}`
	// Publish with the CURRENT fingerprint so the refresh sweep converges
	// (a placeholder would re-arm an endless refresh in every later sweep —
	// in production the executor publishes exactly this value).
	fingerprint := currentFingerprint(t, h, sess)
	if err := h.store.UpsertOnboardingRecentAnalysis(ctx, &storage.OnboardingRecentAnalysis{
		SessionID: sess.SessionID, UserID: uid, AsOfDay: to, AnchorDay: sess.AnchorDay,
		InputFingerprint: fingerprint, Status: status,
		DomainsJSON: &domains, ComputedAt: now,
	}); err != nil {
		t.Fatalf("analysis row: %v", err)
	}
	h.sweepN(ctx, 5)
	// Shared database: a completed session whose row can never converge (no
	// executor here) would churn refreshes into every later test's enqueuer.
	// Superseding isolates it exactly like a rebind would.
	t.Cleanup(func() {
		_ = h.store.SetOnboardingSyncSessionState(context.Background(), sess.SessionID,
			storage.OnboardingSyncStateSuperseded, nil)
	})
	return sess
}

func domainStatusFor(status string) string {
	if status == storage.OnboardingAnalysisStatusReady {
		return "ready"
	}
	return "unavailable"
}

// currentFingerprint recomputes the sweep's fingerprint for a session.
func currentFingerprint(t *testing.T, h *harness, sess *storage.OnboardingSyncSession) string {
	t.Helper()
	ctx := context.Background()
	asOfDay := timefmt.ShanghaiToday().Format("2006-01-02")
	fromDay := timefmt.ShanghaiToday().AddDate(0, 0, -AnalysisDigestLookbackDays).Format("2006-01-02")
	digest, err := h.store.OnboardingAnalysisDigest(ctx, sess.UserID, fromDay, asOfDay)
	if err != nil {
		t.Fatalf("digest: %v", err)
	}
	policy, err := h.store.CalibrationPolicy(ctx)
	if err != nil {
		t.Fatalf("policy: %v", err)
	}
	return storage.AnalysisFingerprint(sess.AnchorDay, asOfDay, sess.BindingRevision, policy, digest)
}

// The analysis stage is structurally impossible before recent_raw
// terminalizes: while the raw dispatch is merely dispatched, the sweep never
// creates analysis rows (devops#1009 AC1 — independent but ordered).
func TestOnboardingSyncAnalysisNotArmedBeforeRawTerminal(t *testing.T) {
	h := analysisHarness(t, 72*time.Hour)
	ctx := context.Background()
	uid := uuid.NewString()
	sess := createDispatched(t, h, uid)

	h.sweepN(ctx, 5)
	if d := hasAnalysisDispatch(t, h.store, sess.SessionID); d != nil {
		t.Fatalf("analysis dispatch = %+v, want none while raw is in flight", d)
	}
	cov, err := h.store.GetOnboardingSyncStageCoverage(ctx, sess.SessionID, storage.OnboardingSyncStageRecentAnalysis)
	if err != nil || cov != nil {
		t.Fatalf("analysis coverage = %+v err=%v, want none", cov, err)
	}
	view, err := h.svc.View(ctx, uid)
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	if view.Readiness.RecentAnalysis != ReadinessNotStarted {
		t.Errorf("recent_analysis = %s, want not_started", view.Readiness.RecentAnalysis)
	}
	if view.RecentAnalysis != nil {
		t.Errorf("recent_analysis detail = %+v, want nil before anything published", view.RecentAnalysis)
	}
}

// A published analysis whose fingerprint matches the current inputs is NOT
// refreshed; a same-day input change (a new activity, no snapshot id moved)
// supersedes it: the row is flagged stale (keeping its true as-of), the
// dispatch re-arms under a NEW generation key, and exactly one merged refresh
// job is enqueued (devops#1009 AC4/AC5).
func TestOnboardingSyncAnalysisRefreshOnChangedInputs(t *testing.T) {
	h := analysisHarness(t, 72*time.Hour)
	ctx := context.Background()
	uid := uuid.NewString()

	sess := completeThroughAnalysis(t, h, uid, storage.OnboardingAnalysisStatusReady)
	fp := currentFingerprint(t, h, sess)
	h.sweepN(ctx, 3)
	row, _ := h.store.GetOnboardingRecentAnalysis(ctx, sess.SessionID)
	if row.Stale {
		t.Fatal("published row must not be stale while inputs are unchanged")
	}
	// devops#1010: the backfill chain keeps the session open after the
	// analysis lands, so "no refresh" is asserted on the dispatch state and
	// the generation, not on the session state.
	disp, _ := h.store.ListOnboardingSyncDispatches(ctx, sess.SessionID)
	for _, d := range disp {
		if d.Stage == storage.OnboardingSyncStageRecentAnalysis && d.Status != storage.OnboardingSyncDispatchDone {
			t.Fatalf("analysis dispatch = %s, want done (no refresh)", d.Status)
		}
	}
	got, _ := h.store.GetOnboardingSyncSessionByID(ctx, sess.SessionID)
	if got.DispatchGeneration != sess.DispatchGeneration {
		t.Fatalf("dispatch generation = %d, want unchanged %d (no refresh)", got.DispatchGeneration, sess.DispatchGeneration)
	}
	before := h.pub.count()

	// Same-day input change: a new activity lands (no snapshot id moved).
	dist, dur := 5000.0, 1500.0
	if err := h.store.UpsertActivity(ctx, &storage.Activity{
		UserID: uid, LabelID: "refresh-act-1", SportType: 1,
		Date: time.Now().UTC(), DistanceM: &dist, DurationS: &dur, Provider: "coros", SyncedAt: time.Now().UTC(),
	}, nil, nil, nil); err != nil {
		t.Fatalf("upsert activity: %v", err)
	}

	h.sweepN(ctx, 3)
	row, _ = h.store.GetOnboardingRecentAnalysis(ctx, sess.SessionID)
	if !row.Stale {
		t.Fatal("changed inputs must flag the published row stale")
	}
	if row.AsOfDay != sess.AnchorDay || row.InputFingerprint != fp {
		t.Fatalf("stale row must keep its TRUE as-of/fingerprint: %+v", row)
	}
	ad := hasAnalysisDispatch(t, h.store, sess.SessionID)
	if ad == nil || ad.Status != storage.OnboardingSyncDispatchDispatched {
		t.Fatalf("analysis dispatch = %+v, want re-dispatched refresh", ad)
	}
	if n := countJobsForKey(t, h.store, uid, ad.IdempotencyKey); n != 1 {
		t.Errorf("refresh jobs for new key = %d, want exactly 1", n)
	}
	if got, _ := h.store.GetOnboardingSyncSessionByID(ctx, sess.SessionID); got.State == storage.OnboardingSyncStateCompleted {
		t.Fatal("session must be back in flight while the refresh runs")
	}
	if n := h.pub.count() - before; n != 1 {
		t.Errorf("refresh enqueued %d jobs, want exactly 1 (merged refresh)", n)
	}
	// The view reports the published (stale) result honestly, refreshing.
	view, err := h.svc.View(ctx, uid)
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	if view.DispatchGeneration != sess.DispatchGeneration+1 || view.FailRetryCount != 0 {
		t.Errorf("refresh counters: generation=%d failure retries=%d, want %d and 0",
			view.DispatchGeneration, view.FailRetryCount, sess.DispatchGeneration+1)
	}
	if view.Readiness.RecentAnalysis != ReadinessReady {
		t.Errorf("recent_analysis = %s, want ready (published result stands while stale)", view.Readiness.RecentAnalysis)
	}
	if view.RecentAnalysis == nil || !view.RecentAnalysis.Stale || !view.RecentAnalysis.Refreshing {
		t.Errorf("recent_analysis detail = %+v, want stale+refreshing", view.RecentAnalysis)
	}
}

// Beyond the refresh horizon the sweep leaves completed sessions alone — the
// standing sync pipelines own analysis freshness there.
func TestOnboardingSyncAnalysisRefreshHorizonBounds(t *testing.T) {
	h := analysisHarness(t, time.Millisecond)
	ctx := context.Background()
	uid := uuid.NewString()
	sess := completeThroughAnalysis(t, h, uid, storage.OnboardingAnalysisStatusReady)
	time.Sleep(5 * time.Millisecond) // age the session past the horizon

	h.sweepN(ctx, 3)
	row, _ := h.store.GetOnboardingRecentAnalysis(ctx, sess.SessionID)
	if row.Stale {
		t.Fatal("beyond the horizon the row must not be flagged stale")
	}
	if d := hasAnalysisDispatch(t, h.store, sess.SessionID); d == nil || d.Status != storage.OnboardingSyncDispatchDone {
		t.Fatalf("analysis dispatch = %+v, want untouched done", d)
	}
}

// The view reports analysis availability EXPLICITLY from the published row:
// partial and unavailable are first-class levels, never folded into ready.
func TestOnboardingSyncAnalysisViewReadinessLevels(t *testing.T) {
	h := analysisHarness(t, 72*time.Hour)
	ctx := context.Background()
	uid := uuid.NewString()
	sess := completeThroughAnalysis(t, h, uid, storage.OnboardingAnalysisStatusPartial)

	view, err := h.svc.View(ctx, uid)
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	if view.Readiness.RecentAnalysis != ReadinessPartial {
		t.Fatalf("recent_analysis = %s, want partial", view.Readiness.RecentAnalysis)
	}
	if view.RecentAnalysis == nil || view.RecentAnalysis.Status != storage.OnboardingAnalysisStatusPartial {
		t.Fatalf("detail = %+v, want partial status", view.RecentAnalysis)
	}

	// Flip the published row to unavailable: the level follows the row, not
	// any pipeline-done bit.
	if err := h.store.UpsertOnboardingRecentAnalysis(ctx, &storage.OnboardingRecentAnalysis{
		SessionID: sess.SessionID, UserID: uid, AsOfDay: sess.AnchorDay, AnchorDay: sess.AnchorDay,
		InputFingerprint: "fp-unavail", Status: storage.OnboardingAnalysisStatusUnavailable,
		ComputedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("analysis row: %v", err)
	}
	view, err = h.svc.View(ctx, uid)
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	if view.Readiness.RecentAnalysis != ReadinessUnavailable {
		t.Fatalf("recent_analysis = %s, want unavailable", view.Readiness.RecentAnalysis)
	}
}
