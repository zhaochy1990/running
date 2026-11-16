// onboarding_stagechain_test.go is the devops#1010 T06 suite for the session
// stage chain and the chunked backfill lifecycle: the sweep must append each
// follow-on stage only after its predecessor's coverage is terminal, continue
// a stage whose chunk reported in_progress, rescue the crash between the
// job's terminal mark and the continuation requeue, never finalize a session
// whose stage coverage is non-terminal, and keep the recent stage's coverage
// intact when the historical stage fails (历史失败不撤回近期数据).
package onboardingsync

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
)

// dispatchOf returns the session's dispatch row for a stage.
func dispatchOf(t *testing.T, h *harness, sessionID, stage string) *storage.OnboardingSyncDispatch {
	t.Helper()
	disp, err := h.store.ListOnboardingSyncDispatches(context.Background(), sessionID)
	if err != nil {
		t.Fatalf("list dispatches: %v", err)
	}
	for _, d := range disp {
		if d.Stage == stage {
			return d
		}
	}
	return nil
}

// finishDispatchedJob terminal-succeeds the stage's dispatched job with the
// given StageResult and sweeps, so the next state is observable.
func finishDispatchedJob(t *testing.T, h *harness, sessionID, stage string, res StageResult) {
	t.Helper()
	ctx := context.Background()
	d := dispatchOf(t, h, sessionID, stage)
	if d == nil || d.JobID == nil {
		t.Fatalf("stage %s has no dispatched job", stage)
	}
	j, err := h.store.JobByID(ctx, *d.JobID)
	if err != nil {
		t.Fatalf("job read: %v", err)
	}
	b, _ := json.Marshal(res)
	j.Status = job.StatusDone
	j.ResultJSON = string(b)
	now := time.Now().UTC()
	j.CompletedAt = &now
	if err := h.store.Jobs().Update(ctx, j); err != nil {
		t.Fatalf("job update: %v", err)
	}
	h.sweepN(ctx, 6)
}

// completeStage finishes a stage's dispatched job with a completed result
// covering its target window.
func completeStage(t *testing.T, h *harness, sessionID, stage string) {
	t.Helper()
	ctx := context.Background()
	cov, err := h.store.GetOnboardingSyncStageCoverage(ctx, sessionID, stage)
	if err != nil || cov == nil {
		t.Fatalf("coverage read for %s: %v", stage, err)
	}
	res := StageResult{
		Stage: stage, Status: storage.OnboardingSyncCoverageCompleted,
		ScannedFrom: &cov.TargetFrom, ScannedTo: &cov.TargetTo,
		ObservedFrom: &cov.TargetFrom, ObservedTo: &cov.TargetTo,
	}
	finishDispatchedJob(t, h, sessionID, stage, res)
}

// completeAnalysisStage terminal-succeeds the armed analysis stage's job so
// the backfill chain may advance behind it (the arm pass created it after the
// recent stage completed; no published analysis row is needed for CHAINING —
// only the refresh pass reads it, and it skips rows that do not exist).
func completeAnalysisStage(t *testing.T, h *harness, sessionID string) {
	t.Helper()
	ctx := context.Background()
	d := dispatchOf(t, h, sessionID, storage.OnboardingSyncStageRecentAnalysis)
	if d == nil {
		t.Fatalf("analysis stage not armed for %s", sessionID)
	}
	j, err := h.store.JobByID(ctx, *d.JobID)
	if err != nil {
		t.Fatalf("analysis job: %v", err)
	}
	cov, _ := h.store.GetOnboardingSyncStageCoverage(ctx, sessionID, storage.OnboardingSyncStageRecentAnalysis)
	from, to := sessAnchor(t, h, sessionID), sessAnchor(t, h, sessionID)
	if cov != nil && cov.TargetFrom != "" {
		from, to = cov.TargetFrom, cov.TargetTo
	}
	res := StageResult{
		Stage: storage.OnboardingSyncStageRecentAnalysis, Status: storage.OnboardingSyncCoverageCompleted,
		ScannedFrom: &from, ScannedTo: &to, ObservedFrom: &from, ObservedTo: &to,
	}
	b, _ := json.Marshal(res)
	j.Status = job.StatusDone
	j.ResultJSON = string(b)
	now := time.Now().UTC()
	j.CompletedAt = &now
	if err := h.store.Jobs().Update(ctx, j); err != nil {
		t.Fatalf("analysis job update: %v", err)
	}
	h.sweepN(ctx, 6)
}

func sessAnchor(t *testing.T, h *harness, sessionID string) string {
	t.Helper()
	sess, err := h.store.GetOnboardingSyncSessionByID(context.Background(), sessionID)
	if err != nil || sess == nil {
		t.Fatalf("session read: %v", err)
	}
	return sess.AnchorDay
}

// TestStageChain_AppendsStagesAfterPredecessorTerminal walks the whole chain:
// recent completes → extended appears and dispatches; extended completes →
// historical (provider-aware items); historical completes → auxiliary; the
// session only terminalizes after the last stage. COROS's historical stage
// carries no health item (只声明实际可得范围); Garmin's carries the 365-day
// health walk.
func TestOnboardingSyncStageChain_AppendsStagesAfterPredecessorTerminal(t *testing.T) {
	for _, tc := range []struct {
		provider               string
		wantHistoricalItems    int
		wantHistoricalHealth   bool
		wantHistoricalFromYear string
	}{
		{provider: "coros", wantHistoricalItems: 1, wantHistoricalHealth: false},
		{provider: "garmin", wantHistoricalItems: 2, wantHistoricalHealth: true},
	} {
		t.Run(tc.provider, func(t *testing.T) {
			h := newHarness(t)
			ctx := context.Background()
			uid := uuid.NewString()
			if err := h.store.SaveCredential(ctx, &storage.ProviderCredential{
				UserID: uid, Provider: tc.provider, UpdatedAt: time.Now().UTC(),
			}); err != nil {
				t.Fatalf("credential: %v", err)
			}
			sess, err := h.svc.CreateOrClaim(ctx, uid, tc.provider)
			if err != nil {
				t.Fatalf("create: %v", err)
			}

			completeStage(t, h, sess.SessionID, storage.OnboardingSyncStageRecentRaw)
			// T05: raw completion arms the analysis stage; the backfill chain
			// waits for it (the recent analysis settles before the history
			// walk competes for vendor quota).
			if d := dispatchOf(t, h, sess.SessionID, storage.OnboardingSyncStageRecentAnalysis); d == nil || d.Status != storage.OnboardingSyncDispatchDispatched {
				t.Fatalf("analysis dispatch after recent = %+v, want dispatched", d)
			}
			got, _ := h.store.GetOnboardingSyncSessionByID(ctx, sess.SessionID)
			if got.Terminal() {
				t.Fatalf("session terminalized after recent: %s", got.State)
			}
			completeAnalysisStage(t, h, sess.SessionID)
			if d := dispatchOf(t, h, sess.SessionID, storage.OnboardingSyncStageExtendedRaw); d == nil {
				t.Fatal("extended stage must be appended after the analysis settled")
			}

			completeStage(t, h, sess.SessionID, storage.OnboardingSyncStageExtendedRaw)
			if d := dispatchOf(t, h, sess.SessionID, storage.OnboardingSyncStageHistoricalRaw); d == nil || d.Status != storage.OnboardingSyncDispatchDispatched {
				t.Fatalf("historical dispatch after extended = %+v, want dispatched", d)
			}
			items, _ := h.store.ListOnboardingSyncWorkItems(ctx, sess.SessionID, storage.OnboardingSyncStageHistoricalRaw)
			if len(items) != tc.wantHistoricalItems {
				t.Fatalf("historical items = %d, want %d (%+v)", len(items), tc.wantHistoricalItems, items)
			}
			hasHealth := false
			for _, it := range items {
				if it.Kind == storage.OnboardingSyncItemKindHealth {
					hasHealth = true
				}
			}
			if hasHealth != tc.wantHistoricalHealth {
				t.Errorf("historical health item = %v, want %v", hasHealth, tc.wantHistoricalHealth)
			}

			completeStage(t, h, sess.SessionID, storage.OnboardingSyncStageHistoricalRaw)
			if d := dispatchOf(t, h, sess.SessionID, storage.OnboardingSyncStageAuxiliary); d == nil || d.Status != storage.OnboardingSyncDispatchDispatched {
				t.Fatalf("auxiliary dispatch after historical = %+v, want dispatched", d)
			}

			completeStage(t, h, sess.SessionID, storage.OnboardingSyncStageAuxiliary)
			got, _ = h.store.GetOnboardingSyncSessionByID(ctx, sess.SessionID)
			if got.State != storage.OnboardingSyncStateCompleted {
				t.Fatalf("session state = %s, want completed after full chain", got.State)
			}
		})
	}
}

// TestStageChain_CompletedWithGapsStillAdvances pins 阶段完成（含真实 gap）
// 仍派发后续阶段：a permanent gap is recorded honesty, not a blocker.
func TestOnboardingSyncStageChain_CompletedWithGapsStillAdvances(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	uid := uuid.NewString()
	sess := createDispatched(t, h, uid)

	cov, _ := h.store.GetOnboardingSyncStageCoverage(ctx, sess.SessionID, storage.OnboardingSyncStageRecentRaw)
	from, to := cov.TargetFrom, cov.TargetTo
	res := StageResult{
		Stage: storage.OnboardingSyncStageRecentRaw, Status: storage.OnboardingSyncCoverageCompletedWithGaps,
		ScannedFrom: &from, ScannedTo: &to, ObservedFrom: &from, ObservedTo: &to,
		Gaps: []StageGap{{From: to, To: to, Reason: "activities: permanently rejected"}},
	}
	finishDispatchedJob(t, h, sess.SessionID, storage.OnboardingSyncStageRecentRaw, res)
	// Raw completed WITH real data: the analysis stage arms (T05), the
	// backfill chain follows behind it.
	completeAnalysisStage(t, h, sess.SessionID)

	if d := dispatchOf(t, h, sess.SessionID, storage.OnboardingSyncStageExtendedRaw); d == nil {
		t.Fatal("extended stage must be appended despite the recent gap record")
	}
	got, _ := h.store.GetOnboardingSyncSessionByID(ctx, sess.SessionID)
	if got.Terminal() {
		t.Fatalf("session = %s, want still running (chain continues)", got.State)
	}
}

// TestChunkContinuation_RequeuesNextChunk walks the in_progress chunk path:
// the chunk job terminal-succeeds with StageStatusInProgress, the coverage
// row stays running with the chunk's progress, the dispatch is requeued as
// chunk_seq+1 under a chunk-suffixed key, and the session is NOT finalized.
// The requeued row waits out the dispatch grace (让权), then dispatches.
func TestOnboardingSyncChunkContinuation_RequeuesNextChunk(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	uid := uuid.NewString()
	sess := createDispatched(t, h, uid)
	completeStage(t, h, sess.SessionID, storage.OnboardingSyncStageRecentRaw)
	completeAnalysisStage(t, h, sess.SessionID)

	// The extended stage's first chunk: walk progressed, budget ran out.
	scannedFrom, scannedTo := "2026-05-20", "2026-08-18"
	finishDispatchedJob(t, h, sess.SessionID, storage.OnboardingSyncStageExtendedRaw, StageResult{
		Stage: storage.OnboardingSyncStageExtendedRaw, Status: StageStatusInProgress,
		ScannedFrom: &scannedFrom, ScannedTo: &scannedTo,
	})

	d := dispatchOf(t, h, sess.SessionID, storage.OnboardingSyncStageExtendedRaw)
	// The chunk requeue may already have been dispatched again by a later
	// sweep pass (the harness's grace is only 50ms) — the invariant is the
	// chunk generation, not the transient row status.
	if d == nil || (d.Status != storage.OnboardingSyncDispatchPending && d.Status != storage.OnboardingSyncDispatchDispatched) {
		t.Fatalf("dispatch after in_progress = %+v, want requeued next chunk", d)
	}
	if d.ChunkSeq != 1 || !strings.HasSuffix(d.IdempotencyKey, ":c1") {
		t.Fatalf("chunk key = %q chunk_seq = %d, want :c1 suffix with chunk_seq 1", d.IdempotencyKey, d.ChunkSeq)
	}
	cov, _ := h.store.GetOnboardingSyncStageCoverage(ctx, sess.SessionID, storage.OnboardingSyncStageExtendedRaw)
	if cov.Status != storage.OnboardingSyncCoverageRunning {
		t.Fatalf("coverage = %s, want running", cov.Status)
	}
	if cov.ScannedFrom == nil || *cov.ScannedFrom != scannedFrom || cov.ScannedTo == nil || *cov.ScannedTo != scannedTo {
		t.Errorf("coverage scanned = %v..%v, want %s..%s", cov.ScannedFrom, cov.ScannedTo, scannedFrom, scannedTo)
	}
	got, _ := h.store.GetOnboardingSyncSessionByID(ctx, sess.SessionID)
	if got.Terminal() {
		t.Fatalf("session = %s, in_progress must never finalize", got.State)
	}

	// After the dispatch grace the pending chunk dispatches (exactly one job).
	time.Sleep(60 * time.Millisecond)
	h.sweepN(ctx, 6)
	d = dispatchOf(t, h, sess.SessionID, storage.OnboardingSyncStageExtendedRaw)
	if d.Status != storage.OnboardingSyncDispatchDispatched {
		t.Fatalf("dispatch after grace = %s, want dispatched", d.Status)
	}
	if n := countJobsForKey(t, h.store, uid, d.IdempotencyKey); n != 1 {
		t.Errorf("jobs for chunk key = %d, want 1", n)
	}

	// The final chunk completes the stage: the chain advances again.
	completeStage(t, h, sess.SessionID, storage.OnboardingSyncStageExtendedRaw)
	if dispatchOf(t, h, sess.SessionID, storage.OnboardingSyncStageHistoricalRaw) == nil {
		t.Fatal("historical stage must follow the completed extended stage")
	}
}

// TestChunkContinuation_RescuesCrashBetweenTerminalMarkAndRequeue simulates
// the crash window: the dispatch reached done and the coverage stays running
// (the requeue write was lost). The sweep's advance pass must re-arm the
// chunk purely from durable state.
func TestOnboardingSyncChunkContinuation_RescuesCrashBetweenTerminalMarkAndRequeue(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	uid := uuid.NewString()
	sess := createDispatched(t, h, uid)
	completeStage(t, h, sess.SessionID, storage.OnboardingSyncStageRecentRaw)
	completeAnalysisStage(t, h, sess.SessionID)

	scannedFrom, scannedTo := "2026-05-20", "2026-08-18"
	d := dispatchOf(t, h, sess.SessionID, storage.OnboardingSyncStageExtendedRaw)
	j, _ := h.store.JobByID(ctx, *d.JobID)
	b, _ := json.Marshal(StageResult{
		Stage: storage.OnboardingSyncStageExtendedRaw, Status: StageStatusInProgress,
		ScannedFrom: &scannedFrom, ScannedTo: &scannedTo,
	})
	j.Status = job.StatusDone
	j.ResultJSON = string(b)
	now := time.Now().UTC()
	j.CompletedAt = &now
	if err := h.store.Jobs().Update(ctx, j); err != nil {
		t.Fatalf("job done: %v", err)
	}
	// Crash: mark the dispatch done WITHOUT letting the sweep run its normal
	// order (this is the write that would have happened before the requeue).
	if err := h.store.MarkOnboardingSyncDispatchTerminal(ctx, d.ID, storage.OnboardingSyncDispatchDone); err != nil {
		t.Fatalf("terminal mark: %v", err)
	}
	// Coverage is still pending (applyStageResult never ran) — the advance
	// pass must still continue the chunk.

	h.sweepN(ctx, 6)
	d = dispatchOf(t, h, sess.SessionID, storage.OnboardingSyncStageExtendedRaw)
	if d == nil || d.ChunkSeq != 1 || !strings.HasSuffix(d.IdempotencyKey, ":c1") {
		t.Fatalf("dispatch after rescue = %+v, want requeued chunk 1", d)
	}
	if n := countJobsForKey(t, h.store, uid, d.IdempotencyKey); n != 1 {
		t.Errorf("jobs for the rescue chunk key = %d, want exactly 1", n)
	}
	got, _ := h.store.GetOnboardingSyncSessionByID(ctx, sess.SessionID)
	if got.Terminal() {
		t.Fatalf("session = %s, rescue must not finalize", got.State)
	}
}

// TestHistoricalFailure_DoesNotRetractRecent pins AC6: a terminal historical
// stage failure fails the session (retryable) but leaves the recent stage's
// coverage and readiness intact — 近期数据不撤回，教练可用。
func TestOnboardingSyncHistoricalFailure_DoesNotRetractRecent(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	uid := uuid.NewString()
	sess := createDispatched(t, h, uid)
	completeStage(t, h, sess.SessionID, storage.OnboardingSyncStageRecentRaw)
	completeAnalysisStage(t, h, sess.SessionID)
	completeStage(t, h, sess.SessionID, storage.OnboardingSyncStageExtendedRaw)

	d := dispatchOf(t, h, sess.SessionID, storage.OnboardingSyncStageHistoricalRaw)
	j, _ := h.store.JobByID(ctx, *d.JobID)
	j.Status = job.StatusFailed
	j.ErrorMessage = "provider 5xx"
	failedAt := time.Now().UTC()
	j.CompletedAt = &failedAt
	if err := h.store.Jobs().Update(ctx, j); err != nil {
		t.Fatalf("job failed: %v", err)
	}
	h.sweepN(ctx, 6)

	got, _ := h.store.GetOnboardingSyncSessionByID(ctx, sess.SessionID)
	if got.State != storage.OnboardingSyncStateFailed {
		t.Fatalf("session = %s, want failed", got.State)
	}
	recentCov, _ := h.store.GetOnboardingSyncStageCoverage(ctx, sess.SessionID, storage.OnboardingSyncStageRecentRaw)
	if recentCov.Status != storage.OnboardingSyncCoverageCompleted {
		t.Fatalf("recent coverage = %s, want completed (not retracted)", recentCov.Status)
	}
	view, err := h.svc.View(ctx, uid)
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	if view.Readiness.RecentData != ReadinessReady {
		t.Errorf("recent_data = %s, want ready after historical failure", view.Readiness.RecentData)
	}
	if view.Readiness.HistoricalData == ReadinessReady || view.Readiness.HistoricalData == ReadinessReadyWithGaps {
		t.Errorf("historical_data = %s, want not ready", view.Readiness.HistoricalData)
	}
}

// TestUnfinishedRecentActivityWindow covers the AC3 seam: the recent
// activities window is exposed while the session is unfinished and hidden for
// terminal sessions, foreign providers, or users without a session.
func TestOnboardingSyncUnfinishedRecentActivityWindow(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	uid := uuid.NewString()
	if _, ok := h.svc.UnfinishedRecentActivityWindow(ctx, uid, "coros"); ok {
		t.Fatal("no session: ok must be false")
	}
	sess := createDispatched(t, h, uid)
	if _, ok := h.svc.UnfinishedRecentActivityWindow(ctx, uid, "garmin"); ok {
		t.Fatal("provider mismatch: ok must be false")
	}
	win, ok := h.svc.UnfinishedRecentActivityWindow(ctx, uid, "coros")
	if !ok {
		t.Fatal("unfinished session: ok must be true")
	}
	anchor, _ := time.Parse("2006-01-02", sess.AnchorDay)
	if win.To != sess.AnchorDay || win.From != anchor.AddDate(0, 0, -89).Format("2006-01-02") {
		t.Errorf("window = %s..%s", win.From, win.To)
	}

	// Terminal session: the cursor is trustworthy again.
	completeStage(t, h, sess.SessionID, storage.OnboardingSyncStageRecentRaw)
	completeAnalysisStage(t, h, sess.SessionID)
	completeStage(t, h, sess.SessionID, storage.OnboardingSyncStageExtendedRaw)
	completeStage(t, h, sess.SessionID, storage.OnboardingSyncStageHistoricalRaw)
	completeStage(t, h, sess.SessionID, storage.OnboardingSyncStageAuxiliary)
	if _, ok := h.svc.UnfinishedRecentActivityWindow(ctx, uid, "coros"); ok {
		t.Fatal("terminal session: ok must be false")
	}
}
