package onboardingsync

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/handlers/historicalcalibration"
	"github.com/zhaochy1990/stride/internal/handlers/historicalmetrics"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/tsstore"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

func historicalSession(t *testing.T, h *harness) *storage.OnboardingSyncSession {
	t.Helper()
	ctx := context.Background()
	user := uuid.NewString()
	anchor := time.Now().UTC().Add(-96 * time.Hour)
	day := timefmt.ShanghaiDayStr(anchor)
	claim, err := h.store.ClaimOrCreateOnboardingSyncSession(ctx, storage.OnboardingSyncClaimSpec{
		UserID: user, Provider: "coros", AnchorDay: day, AnchorAtUTC: anchor,
		StageNames: []string{storage.OnboardingSyncStageHistoricalRaw, storage.OnboardingSyncStageAuxiliary},
		WorkItems: map[string][]storage.OnboardingSyncWorkItemSpec{
			storage.OnboardingSyncStageHistoricalRaw: {{Kind: "activities", RangeFrom: "2021-01-01", RangeTo: day}},
			storage.OnboardingSyncStageAuxiliary:     {{Kind: "race_detection", RangeFrom: "2021-01-01", RangeTo: day}},
		},
		IdempotencyKey: func(stage, sessionID string, _ int64) string { return sessionID + ":" + stage },
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = h.store.DeleteUserData(ctx, user) })
	if err := h.svc.DispatchSession(ctx, claim.Session.SessionID); err != nil {
		t.Fatal(err)
	}
	return claim.Session
}

func finishHistoricalInput(t *testing.T, h *harness, sess *storage.OnboardingSyncSession, stage string) {
	t.Helper()
	ctx := context.Background()
	cov, err := h.store.GetOnboardingSyncStageCoverage(ctx, sess.SessionID, stage)
	if err != nil || cov == nil {
		t.Fatalf("coverage %s: %v", stage, err)
	}
	cov.Status = storage.OnboardingSyncCoverageCompletedWithGaps
	if err := h.store.UpdateOnboardingSyncStageCoverage(ctx, cov); err != nil {
		t.Fatal(err)
	}
	dispatches, err := h.store.ListOnboardingSyncDispatches(ctx, sess.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	for _, dispatch := range dispatches {
		if dispatch.Stage == stage {
			if err := h.store.MarkOnboardingSyncDispatchTerminal(ctx, dispatch.ID, storage.OnboardingSyncDispatchDone); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestOnboardingSyncHistoricalAnalysisPendingAfterInputsCompleteWithAutomationOff(t *testing.T) {
	h := newHarness(t)
	sess := historicalSession(t, h)
	ctx := context.Background()
	for _, stage := range []string{storage.OnboardingSyncStageHistoricalRaw, storage.OnboardingSyncStageAuxiliary} {
		finishHistoricalInput(t, h, sess, stage)
	}
	h.svc.Sweep(ctx)
	assertHistoricalJob(t, h, sess, historicalcalibration.JobType, false)
	v, err := h.svc.View(ctx, sess.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if v.Readiness.HistoricalAnalysis != ReadinessPending {
		t.Fatalf("historical analysis = %s, want pending", v.Readiness.HistoricalAnalysis)
	}
}

func TestOnboardingSyncHistoricalSweepRecoversInterruptedMultiYearHistory(t *testing.T) {
	h := newHarnessWithHorizon(t, time.Nanosecond)
	h.svc.historicalAuto = true
	blob, err := tsstore.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h.store.SetTSBlobStore(blob)
	ctx := context.Background()
	sess := historicalSession(t, h)
	user := sess.UserID
	today := timefmt.ShanghaiToday()
	previousDay := today.AddDate(0, 0, -1).Format("2006-01-02")
	from := today.AddDate(0, 0, -80).Format("2006-01-02")
	domains := `{"calibration":{"status":"unavailable","reason":"vendor_evidence_missing"},"load":{"status":"unavailable","reason":"historical_calibration_missing"},"zones":{"status":"unavailable","reason":"historical_calibration_missing"}}`
	if err := h.store.UpsertOnboardingRecentAnalysis(ctx, &storage.OnboardingRecentAnalysis{
		SessionID: sess.SessionID, UserID: user, AnchorDay: sess.AnchorDay, AsOfDay: previousDay,
		Status: storage.OnboardingAnalysisStatusUnavailable, DomainsJSON: &domains, CoverageFrom: &from, CoverageTo: &previousDay,
		ComputedAt: time.Now().UTC().Add(-96 * time.Hour),
	}); err != nil {
		t.Fatal(err)
	}
	for i, offset := range []int{-1000, -480, -180, -80, -25, -5, -1} {
		seedHistoryActivity(t, h, user, fmt.Sprintf("history-%d", i), today.AddDate(0, 0, offset))
	}
	finishHistoricalInput(t, h, sess, storage.OnboardingSyncStageHistoricalRaw)
	h.svc.Sweep(ctx)
	assertHistoricalJob(t, h, sess, historicalcalibration.JobType, false)

	finishHistoricalInput(t, h, sess, storage.OnboardingSyncStageAuxiliary)
	var wg sync.WaitGroup
	for range 4 {
		wg.Add(1)
		go func() { defer wg.Done(); h.svc.Sweep(ctx) }()
	}
	wg.Wait()
	first := assertHistoricalJob(t, h, sess, historicalcalibration.JobType, true)
	jobs, _, err := h.store.ListAllJobs(ctx, job.PipelineListOptions{UserID: user, PipelineName: historicalcalibration.JobType})
	if err != nil || len(jobs) != 1 {
		t.Fatalf("concurrent sweeps: %d calibration jobs, err=%v", len(jobs), err)
	}
	assertHistoricalJob(t, h, sess, historicalmetrics.JobType, false)

	cal := historicalcalibration.New(historicalcalibration.Config{Store: h.store, Enq: h.svc.enq, Enabled: true, ChunkDays: 180})
	metrics := historicalmetrics.New(historicalmetrics.Config{Store: h.store, Enq: h.svc.enq, Enabled: true})
	finishHistoricalJob(t, h, first, cal)
	firstRun, err := h.store.ActiveHistoricalRecomputeRunByUser(ctx, user)
	if err != nil || firstRun == nil {
		t.Fatalf("first calibration run: %v", err)
	}
	seedHistoryActivity(t, h, user, "sync-while-calibrating", today)
	finishHistoricalJob(t, h, assertHistoricalJob(t, h, sess, historicalcalibration.JobType, true), cal)
	old, err := h.store.GetHistoricalRecomputeRun(ctx, firstRun.RunID)
	if err != nil || old.State != storage.HistoricalRecomputeStateSuperseded || old.BundleFingerprint != nil {
		t.Fatalf("interrupted calibration published a bundle: %+v, %v", old, err)
	}
	h.svc.Sweep(ctx)
	assertHistoricalJob(t, h, sess, historicalmetrics.JobType, false)
	drainHistoricalJobs(t, h, sess, historicalcalibration.JobType, cal)

	h.svc.Sweep(ctx)
	firstMetrics := assertHistoricalJob(t, h, sess, historicalmetrics.JobType, true)
	finishHistoricalJob(t, h, firstMetrics, metrics)
	seedHistoryActivity(t, h, user, "sync-while-deriving", today)
	finishHistoricalJob(t, h, assertHistoricalJob(t, h, sess, historicalmetrics.JobType, true), metrics)
	runs, err := h.store.ReadOnboardingHistoricalRuns(ctx, sess)
	if err != nil || runs.Metrics == nil || runs.Metrics.State != storage.HistoricalMetricsStateSuperseded || runs.Metrics.PublishedAt != nil {
		t.Fatalf("interrupted metrics published rows: %+v, %v", runs.Metrics, err)
	}
	if load, err := h.store.ActivityTrainingLoad(ctx, user, "sync-while-calibrating"); load != nil || err != nil {
		t.Fatalf("staged load visible prematurely: %+v, %v", load, err)
	}

	h.svc.Sweep(ctx)
	drainHistoricalJobs(t, h, sess, historicalcalibration.JobType, cal)
	h.svc.Sweep(ctx)
	drainHistoricalJobs(t, h, sess, historicalmetrics.JobType, metrics)
	h.svc.Sweep(ctx)
	assertHistoricalJob(t, h, sess, historicalcalibration.JobType, false)
	assertHistoricalJob(t, h, sess, historicalmetrics.JobType, false)
	view, err := h.svc.View(ctx, user)
	if err != nil || (view.Readiness.HistoricalAnalysis != ReadinessReady && view.Readiness.HistoricalAnalysis != ReadinessReadyWithGaps) {
		t.Fatalf("historical results not visible: %+v, %v", view, err)
	}
	if view.RecentAnalysis == nil || view.RecentAnalysis.AsOfDay != previousDay ||
		view.RecentAnalysis.Domains["load"].Status != "ready" || view.RecentAnalysis.Domains["zones"].Status != "ready" ||
		view.RecentAnalysis.Domains["calibration"].Reason != "vendor_evidence_missing" {
		t.Fatalf("older snapshot failed to show published data or preserve unrelated gaps: %+v", view.RecentAnalysis)
	}
	row, err := h.store.GetOnboardingRecentAnalysis(ctx, sess.SessionID)
	if err != nil || row.DomainsJSON == nil || *row.DomainsJSON != domains {
		t.Fatalf("read projection changed the recorded evidence snapshot: %+v, %v", row, err)
	}
	for _, label := range []string{"sync-while-calibrating", "sync-while-deriving"} {
		if load, err := h.store.ActivityTrainingLoad(ctx, user, label); err != nil || load == nil {
			t.Fatalf("new activity %s missing load: %+v, %v", label, load, err)
		}
	}
}

func TestOnboardingSyncHistoricalSweepStopsAfterInterruptionLimit(t *testing.T) {
	h := newHarness(t)
	h.svc.historicalAuto = true
	ctx := context.Background()
	sess := historicalSession(t, h)
	finishHistoricalInput(t, h, sess, storage.OnboardingSyncStageHistoricalRaw)
	finishHistoricalInput(t, h, sess, storage.OnboardingSyncStageAuxiliary)
	for i := range historicalInterruptionLimit {
		runID := uuid.NewString()
		_, err := h.store.ClaimOrCreateHistoricalRecomputeRun(ctx, storage.HistoricalRecomputeClaimSpec{
			RunID: runID, UserID: sess.UserID, Provider: sess.Provider, BindingRevision: sess.BindingRevision,
			AnalysisAsOfDay: sess.AnchorDay, TargetFromDay: sess.AnchorDay, TargetToDay: sess.AnchorDay,
			InputFingerprint: fmt.Sprintf("test-%d", i), CreatedBy: storage.OnboardingHistoricalActor,
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := h.store.SupersedeHistoricalRecomputeRun(ctx, runID, "data_revision_changed"); err != nil {
			t.Fatal(err)
		}
	}
	h.svc.Sweep(ctx)
	h.svc.Sweep(ctx)
	assertHistoricalJob(t, h, sess, historicalcalibration.JobType, false)
	view, err := h.svc.View(ctx, sess.UserID)
	if err != nil || view.HistoricalAnalysisReason == nil || *view.HistoricalAnalysisReason != storage.OnboardingHistoricalRetryLimit ||
		view.Readiness.HistoricalAnalysis != ReadinessPending || view.HistoricalAnalysisPoll {
		t.Fatalf("interruption limit not surfaced: %+v, err=%v", view, err)
	}
}

func seedHistoryActivity(t *testing.T, h *harness, user, label string, day time.Time) {
	t.Helper()
	distance, seconds, maxHR, avgHR := 8000.0, 2400.0, 185, 156
	points := make([]storage.TimeseriesPoint, 81)
	for i := range points {
		ts, meters, speed, hr := int64(3000*i), float64(i)*100, distance/seconds, avgHR+i%17
		points[i] = storage.TimeseriesPoint{Timestamp: &ts, Distance: &meters, Speed: &speed, HeartRate: &hr}
	}
	err := h.store.UpsertActivity(context.Background(), &storage.Activity{
		UserID: user, LabelID: label, SportType: 100, Date: day.Add(time.Hour),
		DistanceM: &distance, DurationS: &seconds, MaxHR: &maxHR, AvgHR: &avgHR,
		Provider: "coros", SyncedAt: time.Now().UTC(),
	}, nil, points, nil)
	if err != nil {
		t.Fatal(err)
	}
}

func assertHistoricalJob(t *testing.T, h *harness, sess *storage.OnboardingSyncSession, kind string, want bool) *job.Job {
	t.Helper()
	j, err := h.store.LatestOnboardingHistoricalJob(context.Background(), sess.UserID, kind, sess.CreatedAt, true)
	if err != nil || (j != nil) != want {
		t.Fatalf("active %s: %+v, want exists=%t, err=%v", kind, j, want, err)
	}
	return j
}

func finishHistoricalJob(t *testing.T, h *harness, j *job.Job, handler job.Handler) {
	t.Helper()
	ctx := context.Background()
	running, claimed, err := h.store.Jobs().Claim(ctx, j.ID, time.Now())
	if err != nil || !claimed {
		t.Fatalf("claim %s: %v", j.ID, err)
	}
	result, err := handler(ctx, running, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("execute %s %s: %v", j.Type, j.InputJSON, err)
	}
	_, err = h.store.TransitionJob(ctx, j.ID, job.JobTransition{To: job.StatusDone, ResultJSON: &result})
	if err != nil {
		t.Fatal(err)
	}
}

func drainHistoricalJobs(t *testing.T, h *harness, sess *storage.OnboardingSyncSession, kind string, handler job.Handler) {
	t.Helper()
	j := assertHistoricalJob(t, h, sess, kind, true)
	for i := 0; i < 100; i++ {
		finishHistoricalJob(t, h, j, handler)
		next, err := h.store.LatestOnboardingHistoricalJob(context.Background(), sess.UserID, kind, sess.CreatedAt, true)
		if err != nil {
			t.Fatal(err)
		}
		if next == nil {
			return
		}
		j = next
	}
	t.Fatal("historical jobs exceeded test drain budget")
}
