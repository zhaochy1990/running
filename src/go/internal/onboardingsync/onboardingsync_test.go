// onboardingsync_test.go is the devops#1006 AC7 recovery suite: real MySQL
// (STRIDE_WORKER_TEST_MYSQL_DSN) + the real job store + the real service and
// reconcile sweep. Crashes are injected at the three lifecycle boundaries —
// between the claim transaction and the enqueue, between the enqueue and the
// dispatched mark, and between the job's terminal state and the sweep's
// observation — and the sweep must recover every one without losing or
// duplicating work. The stage executor is T03/T04's deliverable; the suite
// stands one in only where a terminal job row is needed (writing the
// StageResult contract the real executors will return).
package onboardingsync

import (
	"context"
	"encoding/json"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// memPublisher is the broker stand-in: it records published pointers so the
// suite can assert exactly-one dispatch per generation. The durable job row —
// the piece crash recovery actually depends on — stays real (MySQL).
type memPublisher struct {
	mu   sync.Mutex
	sent []string
}

func (p *memPublisher) PublishWork(_ context.Context, m job.Message) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sent = append(p.sent, m.JobID)
	return nil
}
func (p *memPublisher) PublishRetry(_ context.Context, m job.Message, _ time.Duration) error {
	return p.PublishWork(context.Background(), m)
}
func (p *memPublisher) PublishPoison(_ context.Context, m job.Message) error { return nil }
func (p *memPublisher) count() int                                           { p.mu.Lock(); defer p.mu.Unlock(); return len(p.sent) }

type harness struct {
	store *storage.Store
	pub   *memPublisher
	svc   *Service
}

// sweepN runs the reconcile pass a bounded number of times. The sweep is a
// periodic ticker in production; rotation guarantees every row is observed
// within ceil(rows/limit) passes, so recovery tests exercise that contract
// instead of assuming a single pass (a shared test database can carry more
// residue rows than one window).
func (h *harness) sweepN(ctx context.Context, n int) {
	for i := 0; i < n; i++ {
		h.svc.Sweep(ctx)
	}
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	return newHarnessWithHorizon(t, 72*time.Hour)
}

func newHarnessWithHorizon(t *testing.T, horizon time.Duration) *harness {
	t.Helper()
	dsn := testDSN(t)
	st, err := storage.Open(dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	st.SetTSBlobStore(nil) // no blob writes happen on this surface
	ctx := context.Background()
	if err := st.AutoMigrate(ctx); err != nil {
		t.Fatalf("automigrate: %v", err)
	}
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	if err := st.AutoMigrateOnboardingSync(ctx); err != nil {
		t.Fatalf("automigrate onboarding sync: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	pub := &memPublisher{}
	enq := job.NewStoreEnqueuer(st.Jobs(), pub)
	svc, err := New(Config{
		Store: st, Enqueuer: enq, Jobs: st, Runs: st,
		JobType:                "onboarding_recent_sync",
		AnalysisJobType:        "onboarding_recent_analysis",
		LegacyFullPipeline:     "onboarding",
		DispatchGrace:          50 * time.Millisecond,
		SweepLimit:             50,
		AnalysisRefreshHorizon: horizon,
		Logger:                 zap.NewNop(),
	})
	if err != nil {
		t.Fatalf("service: %v", err)
	}
	return &harness{store: st, pub: pub, svc: svc}
}

// testDSN mirrors storage.openTestStore: skip without the env, so plain
// `go test ./...` stays green and CI attaches the database selectively.
func testDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("set STRIDE_WORKER_TEST_MYSQL_DSN to run onboarding sync integration tests")
	}
	return dsn
}

func TestOnboardingSyncCreateOrClaim_DispatchesStageJob(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	uid := uuid.NewString()
	provider := "coros"
	if err := h.store.SaveCredential(ctx, &storage.ProviderCredential{
		UserID: uid, Provider: provider, UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("credential: %v", err)
	}

	sess, err := h.svc.CreateOrClaim(ctx, uid, provider)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if !sess.ShellReady {
		t.Error("shell_ready must be true: session + dispatch record persisted")
	}
	disp, err := h.store.ListOnboardingSyncDispatches(ctx, sess.SessionID)
	if err != nil || len(disp) != 1 || disp[0].Status != storage.OnboardingSyncDispatchDispatched {
		t.Fatalf("dispatch = %+v err=%v, want dispatched", disp, err)
	}
	j, err := h.store.JobByID(ctx, *disp[0].JobID)
	if err != nil {
		t.Fatalf("job row missing: %v", err)
	}
	if j.Type != "onboarding_recent_sync" || j.UserID != uid || j.IdempotencyKey != disp[0].IdempotencyKey {
		t.Errorf("job = %+v", j)
	}
	var in stageInput
	if err := json.Unmarshal([]byte(j.InputJSON), &in); err != nil || in.SessionID != sess.SessionID || in.Stage != storage.OnboardingSyncStageRecentRaw {
		t.Errorf("job input = %s (%v)", j.InputJSON, err)
	}
	// Server-controlled windows: 90d activities / 28d health anchored on the
	// Shanghai claim day.
	items, _ := h.store.ListOnboardingSyncWorkItems(ctx, sess.SessionID, "")
	act, hlth := findItem(items, "activities"), findItem(items, "health")
	anchor, _ := time.Parse("2006-01-02", sess.AnchorDay)
	if act.RangeFrom != anchor.AddDate(0, 0, -89).Format("2006-01-02") || act.RangeTo != sess.AnchorDay {
		t.Errorf("activities window = %s..%s, want %s..%s", act.RangeFrom, act.RangeTo, anchor.AddDate(0, 0, -89).Format("2006-01-02"), sess.AnchorDay)
	}
	if hlth.RangeFrom != anchor.AddDate(0, 0, -27).Format("2006-01-02") {
		t.Errorf("health window from = %s, want %s", hlth.RangeFrom, anchor.AddDate(0, 0, -27).Format("2006-01-02"))
	}

	// Repeat POST claims the same session and enqueues nothing new.
	before := h.pub.count()
	again, err := h.svc.CreateOrClaim(ctx, uid, provider)
	if err != nil {
		t.Fatalf("repeat create: %v", err)
	}
	if again.SessionID != sess.SessionID {
		t.Errorf("repeat create session = %s, want %s", again.SessionID, sess.SessionID)
	}
	if h.pub.count() != before {
		t.Error("repeat create must not enqueue new work")
	}
}

func findItem(items []*storage.OnboardingSyncWorkItem, kind string) *storage.OnboardingSyncWorkItem {
	for _, it := range items {
		if it.Kind == kind {
			return it
		}
	}
	return nil
}

// TestSweep_RecoversCreateDispatchBoundary crashes between the claim
// transaction and the enqueue: the dispatch row is pending, no job exists.
// The sweep must enqueue exactly one job and dedupe on every later pass.
func TestOnboardingSyncSweep_RecoversCreateDispatchBoundary(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	uid := uuid.NewString()
	// Claim at the storage layer only — the service call (which would also
	// dispatch) is the "crashed before dispatch" simulation.
	res, err := h.store.ClaimOrCreateOnboardingSyncSession(ctx, storage.OnboardingSyncClaimSpec{
		UserID: uid, Provider: "coros",
		AnchorDay: time.Now().UTC().Format("2006-01-02"), AnchorAtUTC: time.Now().UTC(),
		StageNames: []string{storage.OnboardingSyncStageRecentRaw},
		WorkItems: map[string][]storage.OnboardingSyncWorkItemSpec{
			storage.OnboardingSyncStageRecentRaw: {{Kind: "activities", RangeFrom: "2026-08-18", RangeTo: "2026-11-16"}},
		},
		IdempotencyKey: func(stage, sid string, rev int64) string { return "onbsync:" + sid },
	})
	if err != nil {
		t.Fatalf("claim: %v", err)
	}

	time.Sleep(60 * time.Millisecond) // cross the sweep's dispatch grace
	h.sweepN(ctx, 5)
	disp, _ := h.store.ListOnboardingSyncDispatches(ctx, res.Session.SessionID)
	if len(disp) != 1 || disp[0].Status != storage.OnboardingSyncDispatchDispatched {
		t.Fatalf("dispatch after sweep = %+v, want dispatched", disp)
	}
	jobID := *disp[0].JobID

	// A second sweep must NOT create a second job or publish again.
	time.Sleep(60 * time.Millisecond)
	h.sweepN(ctx, 5)
	disp2, _ := h.store.ListOnboardingSyncDispatches(ctx, res.Session.SessionID)
	if len(disp2) != 1 || *disp2[0].JobID != jobID {
		t.Fatalf("second sweep duplicated work: %+v", disp2)
	}
	if n := countJobsForKey(t, h.store, uid, disp2[0].IdempotencyKey); n != 1 {
		t.Errorf("jobs for key = %d, want exactly 1", n)
	}
}

// TestSweep_AdoptsEnqueuedJob crashes between the enqueue and the dispatched
// mark: the job exists, the row still says pending. The sweep adopts the
// existing job instead of double-enqueueing.
func TestOnboardingSyncSweep_AdoptsEnqueuedJob(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	uid := uuid.NewString()
	res, err := h.store.ClaimOrCreateOnboardingSyncSession(ctx, storage.OnboardingSyncClaimSpec{
		UserID: uid, Provider: "coros",
		AnchorDay: "2026-11-16", AnchorAtUTC: time.Now().UTC(),
		StageNames: []string{storage.OnboardingSyncStageRecentRaw},
		WorkItems: map[string][]storage.OnboardingSyncWorkItemSpec{
			storage.OnboardingSyncStageRecentRaw: {{Kind: "health", RangeFrom: "2026-10-19", RangeTo: "2026-11-16"}},
		},
		IdempotencyKey: func(stage, sid string, rev int64) string { return "onbsync:" + sid },
	})
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	// The crashed process did enqueue...
	input, _ := json.Marshal(stageInput{SessionID: res.Session.SessionID, Stage: storage.OnboardingSyncStageRecentRaw})
	enq := job.NewStoreEnqueuer(h.store.Jobs(), h.pub)
	jobID, err := enq.Enqueue(ctx, job.EnqueueSpec{
		Type: "onboarding_recent_sync", UserID: uid,
		InputJSON: string(input), IdempotencyKey: "onbsync:" + res.Session.SessionID,
	})
	if err != nil {
		t.Fatalf("crash-sim enqueue: %v", err)
	}
	// ...but died before marking the row dispatched.

	time.Sleep(60 * time.Millisecond)
	h.sweepN(ctx, 5)
	disp, _ := h.store.ListOnboardingSyncDispatches(ctx, res.Session.SessionID)
	if len(disp) != 1 || disp[0].Status != storage.OnboardingSyncDispatchDispatched || *disp[0].JobID != jobID {
		t.Fatalf("dispatch after adopt = %+v, want dispatched job %s", disp, jobID)
	}
	if n := countJobsForKey(t, h.store, uid, disp[0].IdempotencyKey); n != 1 {
		t.Errorf("jobs for key = %d, want exactly 1 (adopted, not duplicated)", n)
	}
}

// TestSweep_RecordsCompletionWithCoverage walks the completion boundary: the
// executor job terminal-succeeds with the StageResult contract; the sweep
// records the dispatch done, persists observed coverage, finalizes the
// session completed, and the view reports recent_data ready.
func TestOnboardingSyncSweep_RecordsCompletionWithCoverage(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	uid := uuid.NewString()
	sess := createDispatched(t, h, uid)

	disp, _ := h.store.ListOnboardingSyncDispatches(ctx, sess.SessionID)
	j, _ := h.store.JobByID(ctx, *disp[0].JobID)
	// The executor's terminal report (T03/T04 will return this shape).
	from, to := sess.AnchorDay, sess.AnchorDay
	result := StageResult{
		Stage: storage.OnboardingSyncStageRecentRaw, Status: "completed",
		ScannedFrom: &from, ScannedTo: &to, ObservedFrom: &from, ObservedTo: &to,
	}
	// Observed must cover the 90-day target: report the whole window.
	anchor, _ := time.Parse("2006-01-02", sess.AnchorDay)
	obsFrom := anchor.AddDate(0, 0, -89).Format("2006-01-02")
	result.ObservedFrom = &obsFrom
	b, _ := json.Marshal(result)
	j.Status = job.StatusDone
	j.ResultJSON = string(b)
	now := time.Now().UTC()
	j.CompletedAt = &now
	if err := h.store.Jobs().Update(ctx, j); err != nil {
		t.Fatalf("job update: %v", err)
	}

	h.sweepN(ctx, 5)
	disp2, _ := h.store.ListOnboardingSyncDispatches(ctx, sess.SessionID)
	rawTerminal := false
	for _, d := range disp2 {
		if d.Stage == storage.OnboardingSyncStageRecentRaw && d.Status == storage.OnboardingSyncDispatchDone {
			rawTerminal = true
		}
	}
	if !rawTerminal {
		t.Fatalf("dispatches = %+v, want recent_raw done", disp2)
	}
	// T05 (devops#1009): raw completion arms the analysis stage — the session
	// is NOT terminal until the analysis dispatch also terminalizes.
	analysis, err := h.store.GetOnboardingSyncStageCoverage(ctx, sess.SessionID, storage.OnboardingSyncStageRecentAnalysis)
	if err != nil || analysis == nil {
		t.Fatalf("analysis coverage = %+v err=%v, want armed by the sweep", analysis, err)
	}
	var analysisJobID string
	for _, d := range disp2 {
		if d.Stage == storage.OnboardingSyncStageRecentAnalysis {
			if d.Status != storage.OnboardingSyncDispatchDispatched || d.JobID == nil {
				t.Fatalf("analysis dispatch = %+v, want dispatched", d)
			}
			analysisJobID = *d.JobID
		}
	}
	// The analysis executor terminal-succeeds: its StageResult plus the
	// published result row (the handler package owns that write in production).
	aj, _ := h.store.JobByID(ctx, analysisJobID)
	aFrom, aTo := obsFrom, to
	aResult := StageResult{
		Stage: storage.OnboardingSyncStageRecentAnalysis, Status: "completed",
		ScannedFrom: &aFrom, ScannedTo: &aTo, ObservedFrom: &aFrom, ObservedTo: &aTo,
	}
	ab, _ := json.Marshal(aResult)
	aj.Status = job.StatusDone
	aj.ResultJSON = string(ab)
	aj.CompletedAt = &now
	if err := h.store.Jobs().Update(ctx, aj); err != nil {
		t.Fatalf("analysis job update: %v", err)
	}
	domains := `{"calibration":{"status":"ready"},"load":{"status":"ready"},"zones":{"status":"ready"},"ability":{"status":"ready"}}`
	// The row's fingerprint must equal the CURRENT inputs' fingerprint, or
	// the refresh sweep would immediately requeue the analysis (devops#1009).
	fromDay := timefmt.ShanghaiToday().AddDate(0, 0, -AnalysisDigestLookbackDays).Format("2006-01-02")
	digest, err := h.store.OnboardingAnalysisDigest(ctx, uid, fromDay, to)
	if err != nil {
		t.Fatalf("digest: %v", err)
	}
	policy, err := h.store.CalibrationPolicy(ctx)
	if err != nil {
		t.Fatalf("policy: %v", err)
	}
	fp := storage.AnalysisFingerprint(sess.AnchorDay, to, sess.BindingRevision, policy, digest)
	if err := h.store.UpsertOnboardingRecentAnalysis(ctx, &storage.OnboardingRecentAnalysis{
		SessionID: sess.SessionID, UserID: uid, AsOfDay: to, AnchorDay: sess.AnchorDay,
		InputFingerprint: fp, Status: storage.OnboardingAnalysisStatusReady,
		DomainsJSON: &domains, ComputedAt: now,
	}); err != nil {
		t.Fatalf("analysis row: %v", err)
	}

	h.sweepN(ctx, 5)
	got, err := h.store.GetOnboardingSyncSessionByID(ctx, sess.SessionID)
	if err != nil || got.State != storage.OnboardingSyncStateCompleted {
		t.Fatalf("session state = %s err=%v, want completed", got.State, err)
	}
	view, err := h.svc.View(ctx, uid)
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	if view.Readiness.RecentData != ReadinessReady {
		t.Errorf("recent_data = %s, want ready (observed covers target)", view.Readiness.RecentData)
	}
	if view.Readiness.RecentAnalysis != ReadinessReady {
		t.Errorf("recent_analysis = %s, want ready", view.Readiness.RecentAnalysis)
	}
	if view.RecentAnalysis == nil || view.RecentAnalysis.AsOfDay != to || view.RecentAnalysis.Refreshing {
		t.Errorf("recent_analysis detail = %+v, want as-of %s not refreshing", view.RecentAnalysis, to)
	}
	if view.Readiness.ShellReady != true {
		t.Error("shell_ready lost")
	}
	// Repeat POST on a completed session re-pulls nothing.
	if _, err := h.svc.CreateOrClaim(ctx, uid, "coros"); err != nil {
		t.Fatalf("re-enter completed: %v", err)
	}
	if n := h.pub.countFor(uid); n != 2 {
		t.Errorf("jobs enqueued after re-enter = %d, want 2 (raw + analysis)", n)
	}
}

// TestSweep_FailedThenRetry walks a terminal stage failure and the explicit
// retry: the session fails, the retry bumps the generation, re-enqueues a NEW
// job under a new key, and re-arms failed work items while done items keep
// their credentials.
func TestOnboardingSyncSweep_FailedThenRetry(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	uid := uuid.NewString()
	sess := createDispatched(t, h, uid)

	// One work item fetched fine (credential kept), one failed.
	items, _ := h.store.ListOnboardingSyncWorkItems(ctx, sess.SessionID, "")
	h.store.MarkOnboardingSyncWorkItem(ctx, items[0].ID, storage.OnboardingSyncItemDone, "cred-1", nil)
	msg := "429 rate limited"
	h.store.MarkOnboardingSyncWorkItem(ctx, items[1].ID, storage.OnboardingSyncItemFailed, "", &msg)

	disp, _ := h.store.ListOnboardingSyncDispatches(ctx, sess.SessionID)
	j, _ := h.store.JobByID(ctx, *disp[0].JobID)
	j.Status = job.StatusFailed
	j.ErrorMessage = msg
	now := time.Now().UTC()
	j.CompletedAt = &now
	if err := h.store.Jobs().Update(ctx, j); err != nil {
		t.Fatalf("job fail: %v", err)
	}
	h.sweepN(ctx, 5)
	got, _ := h.store.GetOnboardingSyncSessionByID(ctx, sess.SessionID)
	if got.State != storage.OnboardingSyncStateFailed {
		t.Fatalf("session state = %s, want failed", got.State)
	}
	view, _ := h.svc.View(ctx, uid)
	if view.Readiness.RecentData != ReadinessFailed {
		t.Errorf("recent_data = %s, want failed", view.Readiness.RecentData)
	}

	// Explicit retry: new generation, new job, failed item re-armed, done
	// item untouched.
	sess2, err := h.svc.Retry(ctx, uid)
	if err != nil {
		t.Fatalf("retry: %v", err)
	}
	if sess2.RetryCount != 1 {
		t.Errorf("retry count = %d, want 1", sess2.RetryCount)
	}
	disp2, _ := h.store.ListOnboardingSyncDispatches(ctx, sess.SessionID)
	if disp2[0].Status != storage.OnboardingSyncDispatchDispatched || disp2[0].IdempotencyKey == disp[0].IdempotencyKey {
		t.Fatalf("retry dispatch = %+v, want dispatched under a NEW key", disp2[0])
	}
	items2, _ := h.store.ListOnboardingSyncWorkItems(ctx, sess.SessionID, "")
	byID := map[int64]*storage.OnboardingSyncWorkItem{}
	for _, it := range items2 {
		byID[it.ID] = it
	}
	if byID[items[0].ID].Status != storage.OnboardingSyncItemDone || byID[items[0].ID].FetchCredential == nil {
		t.Error("done item must keep its credential across retry")
	}
	if byID[items[1].ID].Status != storage.OnboardingSyncItemPending {
		t.Errorf("failed item after retry = %s, want pending", byID[items[1].ID].Status)
	}
}

// TestLegacyRunAdoption verifies AC6: an old full onboarding run already in
// flight is adopted (waited on), no stage job starts beside it; once the run
// terminalizes, the sweep dispatches the session's own recent stage.
func TestOnboardingSyncLegacyRunAdoption(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	uid := uuid.NewString()
	// The legacy run: an `onboarding` pipeline run, queued.
	legacy := &job.PipelineRun{RunID: uuid.NewString(), UserID: uid, Name: "onboarding",
		Status: job.StatusRunning, CurrentStep: 0,
		Steps:     []job.PipelineStep{{Name: "sync", JobType: "watch_sync", Status: job.StatusRunning}},
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}
	if err := h.store.Pipelines().Create(ctx, legacy); err != nil {
		t.Fatalf("legacy run: %v", err)
	}

	sess, err := h.svc.CreateOrClaim(ctx, uid, "coros")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if sess.State != storage.OnboardingSyncStateWaitingLegacy || sess.LegacyRunID == nil || *sess.LegacyRunID != legacy.RunID {
		t.Fatalf("session = %s legacy=%v, want waiting_legacy on %s", sess.State, sess.LegacyRunID, legacy.RunID)
	}
	if n := h.pub.countFor(uid); n != 0 {
		t.Fatalf("stage jobs enqueued beside a running legacy full run = %d, want 0", n)
	}

	// Sweeps while the legacy run runs keep waiting.
	time.Sleep(60 * time.Millisecond)
	h.sweepN(ctx, 5)
	if n := h.pub.countFor(uid); n != 0 {
		t.Fatalf("sweep dispatched beside a running legacy run = %d, want 0", n)
	}

	// The legacy run finishes → the sweep dispatches the recent stage once.
	legacy.Status = job.StatusDone
	now := time.Now().UTC()
	legacy.CompletedAt = &now
	if err := h.store.Pipelines().Update(ctx, legacy); err != nil {
		t.Fatalf("legacy finish: %v", err)
	}
	h.sweepN(ctx, 5)
	if n := h.pub.countFor(uid); n != 1 {
		t.Fatalf("jobs after legacy completion = %d, want 1", n)
	}
	got, _ := h.store.GetOnboardingSyncSessionByID(ctx, sess.SessionID)
	if got.State != storage.OnboardingSyncStateRunning {
		t.Fatalf("session state after legacy = %s, want running", got.State)
	}
}

// TestRebindIsolatesSession drives the rebind through the credential surface:
// unbind + rebind bumps the binding revision, the next POST creates a fresh
// session, and the old one is superseded (isolated).
func TestOnboardingSyncRebindIsolatesSession(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	uid := uuid.NewString()
	old, err := h.svc.CreateOrClaim(ctx, uid, "coros")
	if err != nil {
		t.Fatalf("old session: %v", err)
	}
	if err := h.store.DeleteCredential(ctx, uid, "coros"); err != nil {
		t.Fatalf("unbind: %v", err)
	}
	acct := "g-42"
	if err := h.store.SaveCredential(ctx, &storage.ProviderCredential{
		UserID: uid, Provider: "garmin", ProviderUserID: &acct, UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("rebind: %v", err)
	}
	fresh, err := h.svc.CreateOrClaim(ctx, uid, "garmin")
	if err != nil {
		t.Fatalf("fresh session: %v", err)
	}
	if fresh.SessionID == old.SessionID {
		t.Fatal("rebind must create a fresh session")
	}
	if fresh.BindingRevision <= old.BindingRevision {
		t.Errorf("fresh revision = %d, want > %d", fresh.BindingRevision, old.BindingRevision)
	}
	oldRow, _ := h.store.GetOnboardingSyncSessionByID(ctx, old.SessionID)
	if oldRow.State != storage.OnboardingSyncStateSuperseded {
		t.Fatalf("old session = %s, want superseded", oldRow.State)
	}
	view, err := h.svc.View(ctx, uid)
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	if view.SessionID != fresh.SessionID {
		t.Errorf("view session = %s, want the fresh %s", view.SessionID, fresh.SessionID)
	}
}

// TestConcurrentCreateOrClaim drives the full service from two "clients" at
// once: both resolve to one session, one dispatch.
func TestOnboardingSyncConcurrentCreateOrClaim(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	uid := uuid.NewString()
	if err := h.store.SaveCredential(ctx, &storage.ProviderCredential{
		UserID: uid, Provider: "coros", UpdatedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("credential: %v", err)
	}
	var wg sync.WaitGroup
	ids := make(chan string, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sess, err := h.svc.CreateOrClaim(ctx, uid, "coros")
			if err != nil {
				t.Errorf("concurrent create: %v", err)
				return
			}
			ids <- sess.SessionID
		}()
	}
	wg.Wait()
	close(ids)
	var got []string
	for id := range ids {
		got = append(got, id)
	}
	if len(got) == 2 && got[0] != got[1] {
		t.Fatalf("concurrent creates diverged: %s vs %s", got[0], got[1])
	}
	if n := h.pub.countFor(uid); n != 1 {
		t.Errorf("jobs enqueued = %d, want exactly 1", n)
	}
}

// TestView_NotReadyWithoutObservation pins 不假报近期数据ready: a completed
// dispatch whose executor reported NO observed window never reads ready.
func TestOnboardingSyncView_NotReadyWithoutObservation(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	uid := uuid.NewString()
	sess := createDispatched(t, h, uid)
	disp, _ := h.store.ListOnboardingSyncDispatches(ctx, sess.SessionID)
	j, _ := h.store.JobByID(ctx, *disp[0].JobID)
	j.Status = job.StatusDone
	j.ResultJSON = `{}` // done but nothing observed/reported
	now := time.Now().UTC()
	j.CompletedAt = &now
	if err := h.store.Jobs().Update(ctx, j); err != nil {
		t.Fatalf("job done: %v", err)
	}
	h.sweepN(ctx, 5)
	view, err := h.svc.View(ctx, uid)
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	if view.Readiness.RecentData == ReadinessReady || view.Readiness.RecentData == ReadinessReadyWithGaps {
		t.Fatalf("recent_data = %s with no observation, want not ready", view.Readiness.RecentData)
	}
	// The raw completion armed the analysis stage (its dispatch is pending),
	// while historical / auxiliary stay not_started until their tickets.
	if view.Readiness.RecentAnalysis != ReadinessRunning {
		t.Errorf("recent_analysis = %s, want running (armed and dispatched, not yet landed)", view.Readiness.RecentAnalysis)
	}
	if view.Readiness.HistoricalData != ReadinessNotStarted ||
		view.Readiness.HistoricalAnalysis != ReadinessNotStarted ||
		view.Readiness.Auxiliary != ReadinessNotStarted {
		t.Errorf("later-stage readiness = %+v, want all not_started", view.Readiness)
	}
}

// createDispatched creates a session through the service (dispatch included).
func createDispatched(t *testing.T, h *harness, uid string) *storage.OnboardingSyncSession {
	t.Helper()
	sess, err := h.svc.CreateOrClaim(context.Background(), uid, "coros")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	return sess
}

func countJobsForKey(t *testing.T, st *storage.Store, uid, key string) int {
	t.Helper()
	if _, err := st.JobByIdempotencyKey(context.Background(), uid, key); err != nil {
		if job.IsNotFound(err) {
			return 0
		}
		t.Fatalf("job lookup: %v", err)
	}
	return 1
}

func (p *memPublisher) countFor(string) int { return p.count() }
