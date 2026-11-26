// onboardingrecent_test.go covers the onboarding_recent_sync executor
// (devops#1008, epic devops#1004 T04) against a REAL MySQL session store
// (STRIDE_WORKER_TEST_MYSQL_DSN): work-item outcomes and credential reuse,
// the fenced publish session, the error taxonomy's job-level mapping, and the
// end-to-end create→dispatch→execute→sweep→coverage path with the real
// onboardingsync service (AC5: recent readiness proven without any
// whole-year history).
package onboardingrecent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/onboardingsync"
	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/tsstore"
)

// openStore mirrors the storage suite's harness: real MySQL, full migrations,
// in-memory blob store for the fenced publish path.
func openStore(t *testing.T) *storage.Store {
	t.Helper()
	dsn := os.Getenv("STRIDE_WORKER_TEST_MYSQL_DSN")
	if dsn == "" {
		t.Skip("set STRIDE_WORKER_TEST_MYSQL_DSN to run executor integration tests")
	}
	st, err := storage.Open(dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	st.SetTSBlobStore(tsstore.NewMemStore())
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
	return st
}

// finishAnalysisStage walks the T05 analysis stage to completion: the sweep
// armed and dispatched it after recent_raw terminalized; this helper persists
// its job row as done (with the StageResult contract) and lets the sweep
// finalize the session — the analysis executor itself is devops#1009's suite.
func finishAnalysisStage(t *testing.T, st *storage.Store, svc *onboardingsync.Service, enq *fakeEnqueuer, sess *storage.OnboardingSyncSession) {
	t.Helper()
	ctx := context.Background()
	spec, jobID := enq.specs[len(enq.specs)-1], enq.ids[len(enq.ids)-1]
	from, to := sess.AnchorDay, sess.AnchorDay
	res, _ := json.Marshal(onboardingsync.StageResult{
		Stage: storage.OnboardingSyncStageRecentAnalysis, Status: "completed",
		ScannedFrom: &from, ScannedTo: &to, ObservedFrom: &from, ObservedTo: &to,
	})
	now := time.Now().UTC()
	aj := &job.Job{
		ID: jobID, UserID: sess.UserID, Type: "onboarding_recent_analysis",
		Status: job.StatusDone, InputJSON: spec.InputJSON, IdempotencyKey: spec.IdempotencyKey,
		ResultJSON: string(res), CreatedAt: now, UpdatedAt: now, CompletedAt: &now,
	}
	if err := st.Jobs().Create(ctx, aj); err != nil {
		t.Fatalf("analysis job create: %v", err)
	}
	svc.Sweep(ctx)
}

// fakeProvider drives the executor: it records which windows it was asked for
// and answers from a scripted per-channel behavior.
type fakeProvider struct {
	name         string
	loggedIn     bool
	calls        map[string]int
	actBehaviour chan behaviour // per-activities-call behaviour (nil = done)
	healthErr    error          // fails the health channel when set
	dashErr      error          // fails the dashboard channel when set

	sawPublishSession *storage.PublishSession
}

type behaviour struct {
	status  string // done | gap | fail
	failErr error
}

func newFakeProvider() *fakeProvider {
	return &fakeProvider{name: "coros", loggedIn: true, calls: map[string]int{}}
}

func (f *fakeProvider) Info() provider.ProviderInfo {
	return provider.ProviderInfo{Name: f.name}
}

func (f *fakeProvider) IsLoggedIn(string) (bool, error) { return f.loggedIn, nil }

func (f *fakeProvider) SyncRecentRange(ctx context.Context, user string, opts provider.RecentRangeOptions, _ provider.ProgressCallback) (provider.RecentRangeReport, error) {
	f.sawPublishSession = storage.PublishSessionFromContext(ctx)
	strPtr := func(s string) *string { return &s }
	rep := provider.RecentRangeReport{}
	var firstErr error
	if opts.Activities != nil {
		f.calls["activities"]++
		b := behaviour{status: provider.RangeChannelDone}
		if f.actBehaviour != nil {
			b = <-f.actBehaviour
		}
		if b.status == "fail" {
			if firstErr == nil {
				firstErr = b.failErr
			}
		} else {
			st := provider.RangeChannelDone
			var gaps []provider.RangeGap
			if b.status == provider.RangeChannelGap {
				st = provider.RangeChannelGap
				gaps = append(gaps, provider.RangeGap{From: opts.Activities.From, To: opts.Activities.From, Reason: "permanently unobtainable"})
			}
			from, to := opts.Activities.From, opts.Activities.To
			rep.Activities = &provider.RangeChannelReport{
				Status: st, ScannedFrom: from, ScannedTo: to,
				ObservedFrom: strPtr(from), ObservedTo: strPtr(to),
				Gaps: gaps, Count: 3,
				Credential: fmt.Sprintf("coros:v1:range:activities:%s..%s:obs=%s..%s:n=3", from, to, from, to),
			}
		}
	}
	if opts.Health != nil {
		f.calls["health"]++
		if f.healthErr != nil {
			if firstErr == nil {
				firstErr = f.healthErr
			}
		} else {
			from, to := opts.Health.From, opts.Health.To
			rep.Health = &provider.RangeChannelReport{
				Status: provider.RangeChannelDone, ScannedFrom: from, ScannedTo: to,
				ObservedFrom: strPtr(from), ObservedTo: strPtr(to), Count: 28,
				Credential: fmt.Sprintf("coros:v1:range:health:%s..%s:obs=%s..%s:n=28", from, to, from, to),
			}
		}
	}
	if opts.Dashboard != nil && firstErr == nil {
		f.calls["dashboard"]++
		if f.dashErr != nil {
			firstErr = f.dashErr
		} else {
			day := opts.Dashboard.To
			rep.Dashboard = &provider.RangeChannelReport{
				Status: provider.RangeChannelDone, ScannedFrom: day, ScannedTo: day,
				ObservedFrom: strPtr(day), ObservedTo: strPtr(day), Count: 1,
				Credential: fmt.Sprintf("coros:v1:range:dashboard:%s..%s:obs=%s..%s:n=1", day, day, day, day),
			}
		}
	}
	return rep, firstErr
}

// seedSession claims a real session with the T02 default recent work items.
func seedSession(t *testing.T, st *storage.Store, uid string) *storage.OnboardingSyncSession {
	t.Helper()
	anchor := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	spec := storage.OnboardingSyncClaimSpec{
		UserID: uid, Provider: "coros",
		AnchorDay: "2026-11-16", AnchorAtUTC: anchor,
		StageNames: []string{storage.OnboardingSyncStageRecentRaw},
		WorkItems: map[string][]storage.OnboardingSyncWorkItemSpec{
			storage.OnboardingSyncStageRecentRaw: {
				{Kind: "activities", RangeFrom: "2026-08-18", RangeTo: "2026-11-16"},
				{Kind: "health", RangeFrom: "2026-10-19", RangeTo: "2026-11-16"},
				{Kind: "dashboard", RangeFrom: "2026-11-16", RangeTo: "2026-11-16"},
			},
		},
		IdempotencyKey: func(stage, sessionID string, rev int64) string {
			return fmt.Sprintf("t1008:%s:%s:rev%d", sessionID, stage, rev)
		},
	}
	res, err := st.ClaimOrCreateOnboardingSyncSession(context.Background(), spec)
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	return res.Session
}

func stageJob(sess *storage.OnboardingSyncSession) *job.Job {
	return &job.Job{
		ID: "job-" + uuid.NewString()[:8], UserID: sess.UserID, Type: JobType,
		Status: job.StatusRunning, InputJSON: fmt.Sprintf(`{"session_id":%q,"stage":%q}`, sess.SessionID, storage.OnboardingSyncStageRecentRaw),
	}
}

func runHandler(t *testing.T, h job.Handler, j *job.Job) (string, error) {
	t.Helper()
	return h(context.Background(), j, func(string, int) error { return nil })
}

func handlerWith(t *testing.T, st *storage.Store, fp *fakeProvider) job.Handler {
	t.Helper()
	return New(Config{
		Resolve: func(context.Context, string) (Provider, error) { return fp, nil },
		Store:   st, Sessions: st, Jobs: 4,
	})
}

// The happy path executes every channel, records done items with credentials,
// threads the fenced publish session, and returns the StageResult contract.
func TestOnboardingRecent_ExecutesStageAndRecordsOutcomes(t *testing.T) {
	st := openStore(t)
	ctx := context.Background()
	uid := uuid.NewString()
	sess := seedSession(t, st, uid)
	fp := newFakeProvider()

	res, err := runHandler(t, handlerWith(t, st, fp), stageJob(sess))
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	var sr onboardingsync.StageResult
	if err := json.Unmarshal([]byte(res), &sr); err != nil {
		t.Fatalf("result parse: %v", err)
	}
	if sr.Stage != storage.OnboardingSyncStageRecentRaw || sr.Status != storage.OnboardingSyncCoverageCompleted {
		t.Errorf("stage result = %+v, want recent_raw completed", sr)
	}
	if sr.ScannedFrom == nil || *sr.ScannedFrom != "2026-08-18" || sr.ScannedTo == nil || *sr.ScannedTo != "2026-11-16" {
		t.Errorf("scanned = %v..%v, want 2026-08-18..2026-11-16", sr.ScannedFrom, sr.ScannedTo)
	}
	if sr.ObservedFrom == nil || *sr.ObservedFrom != "2026-08-18" || sr.ObservedTo == nil || *sr.ObservedTo != "2026-11-16" {
		t.Errorf("observed = %v..%v, want full window", sr.ObservedFrom, sr.ObservedTo)
	}
	items, _ := st.ListOnboardingSyncWorkItems(ctx, sess.SessionID, storage.OnboardingSyncStageRecentRaw)
	for _, it := range items {
		if it.Status != storage.OnboardingSyncItemDone {
			t.Errorf("item %s = %s, want done", it.Kind, it.Status)
		}
		if it.FetchCredential == nil || *it.FetchCredential == "" {
			t.Errorf("item %s has no complete-fetch credential", it.Kind)
		}
	}
	if fp.sawPublishSession == nil {
		t.Fatal("publish session not threaded into the sync context")
	}
	if fp.sawPublishSession.BindingRevision != sess.BindingRevision {
		t.Errorf("publish session revision = %d, want session's %d", fp.sawPublishSession.BindingRevision, sess.BindingRevision)
	}
	// The lease is released when the handler returns: a fenced write under the
	// same (now stale) session must be refused — the executor never leaves an
	// open writer behind (devops#1005 fence semantics).
	a := &storage.Activity{UserID: uid, LabelID: "FENCED", Date: time.Now().UTC(), Provider: "coros"}
	fenceCtx := storage.WithPublishSession(ctx, fp.sawPublishSession)
	err = st.UpsertActivity(fenceCtx, a, nil, nil, nil)
	if !storage.IsFenceViolation(err) {
		t.Errorf("post-release fenced write err = %v, want fence violation", err)
	}
}

// A transient failure mid-stage keeps the finished channel's credential; the
// job error is retryable; the retry re-runs ONLY the unfinished channel.
func TestOnboardingRecent_TransientFailureReusesDoneWork(t *testing.T) {
	st := openStore(t)
	ctx := context.Background()
	uid := uuid.NewString()
	sess := seedSession(t, st, uid)
	fp := newFakeProvider()
	fp.actBehaviour = make(chan behaviour, 4)
	fp.actBehaviour <- behaviour{status: provider.RangeChannelDone}
	h := handlerWith(t, st, fp)

	j := stageJob(sess)
	if _, err := runHandler(t, h, j); err != nil {
		t.Fatalf("first run: %v", err)
	}
	if fp.calls["activities"] != 1 {
		t.Fatalf("activities calls = %d, want 1", fp.calls["activities"])
	}
	// Second run with the activities item already done: only health/dashboard.
	fp.actBehaviour = nil // no further activities calls expected
	if _, err := runHandler(t, h, stageJob(sess)); err != nil {
		t.Fatalf("second run: %v", err)
	}
	if fp.calls["activities"] != 1 {
		t.Errorf("activities re-run on retry (calls=%d); done credentials must be reused", fp.calls["activities"])
	}
	if fp.calls["health"] != 1 || fp.calls["dashboard"] != 1 {
		t.Errorf("health/dashboard calls = %d/%d, want 1/1", fp.calls["health"], fp.calls["dashboard"])
	}
	items, _ := st.ListOnboardingSyncWorkItems(ctx, sess.SessionID, storage.OnboardingSyncStageRecentRaw)
	for _, it := range items {
		if it.Status != storage.OnboardingSyncItemDone {
			t.Errorf("item %s = %s, want done", it.Kind, it.Status)
		}
	}
}

// A mid-run transient failure (activities done, health network error) returns
// a retryable error, records the finished channel's credential, and the job
// auto-retry completes the stage without re-pulling activities.
func TestOnboardingRecent_MidRunTransientFailureMarksUnfinishedOnly(t *testing.T) {
	st := openStore(t)
	ctx := context.Background()
	uid := uuid.NewString()
	sess := seedSession(t, st, uid)
	fp := newFakeProvider()
	fp.actBehaviour = make(chan behaviour, 4)
	fp.actBehaviour <- behaviour{status: provider.RangeChannelDone}
	fp.healthErr = errors.New("coros: GET /analyse/query: connection reset")
	h := handlerWith(t, st, fp)

	if _, err := runHandler(t, h, stageJob(sess)); err == nil {
		t.Fatal("transient health failure must surface as a retryable error")
	} else if _, permanent := job.AsPermanent(err); permanent {
		t.Fatalf("transient failure classified permanent: %v", err)
	}
	items, _ := st.ListOnboardingSyncWorkItems(ctx, sess.SessionID, storage.OnboardingSyncStageRecentRaw)
	states := map[string]string{}
	for _, it := range items {
		states[it.Kind] = it.Status
	}
	if states["activities"] != storage.OnboardingSyncItemDone {
		t.Errorf("activities item = %s, want done (finished before the failure)", states["activities"])
	}
	if states["health"] != storage.OnboardingSyncItemFailed {
		t.Errorf("health item = %s, want failed (retryable)", states["health"])
	}
	if states["dashboard"] != storage.OnboardingSyncItemFailed {
		t.Errorf("dashboard item = %s, want failed (never reached)", states["dashboard"])
	}

	svc, err := onboardingsync.New(onboardingsync.Config{
		Store: st, Enqueuer: &fakeEnqueuer{}, Jobs: st, Runs: st,
		JobType: JobType, AnalysisJobType: "onboarding_recent_analysis", LegacyFullPipeline: "onboarding", Logger: zap.NewNop(),
	})
	if err != nil {
		t.Fatal(err)
	}
	viewBeforeRetry, err := svc.View(ctx, uid)
	if err != nil {
		t.Fatal(err)
	}
	var transient []onboardingsync.StageGap
	for _, stage := range viewBeforeRetry.Stages {
		if stage.Stage == storage.OnboardingSyncStageRecentRaw {
			transient = stage.Gaps
		}
	}
	if len(transient) != 1 || transient[0].Kind != provider.RangeGapTransient || transient[0].Channel != kindHealth {
		t.Fatalf("gaps before auto-retry = %+v, want the failed health range only", transient)
	}

	// The job-level auto-retry re-runs the handler: failed items re-armed, the
	// stage completes, and activities is NOT re-requested.
	ok := newFakeProvider()
	h3 := New(Config{
		Resolve: func(context.Context, string) (Provider, error) { return ok, nil },
		Store:   st, Sessions: st,
	})
	res, err := runHandler(t, h3, stageJob(sess))
	if err != nil {
		t.Fatalf("retry run: %v", err)
	}
	if ok.calls["activities"] != 0 {
		t.Errorf("activities re-run on auto-retry (calls=%d); done credentials must be reused", ok.calls["activities"])
	}
	if ok.calls["health"] != 1 || ok.calls["dashboard"] != 1 {
		t.Errorf("health/dashboard calls = %d/%d, want 1/1", ok.calls["health"], ok.calls["dashboard"])
	}
	var sr onboardingsync.StageResult
	_ = json.Unmarshal([]byte(res), &sr)
	if sr.Status != storage.OnboardingSyncCoverageCompleted || len(sr.Gaps) != 0 {
		t.Errorf("result = %+v, want completed with the transient failure resolved", sr)
	}
}

// Auth failures are permanent job errors; gap reports land as completed_with_gaps.
func TestOnboardingRecent_AuthFailureIsPermanent(t *testing.T) {
	st := openStore(t)
	uid := uuid.NewString()
	sess := seedSession(t, st, uid)
	fp := newFakeProvider()
	fp.actBehaviour = make(chan behaviour, 4)
	fp.actBehaviour <- behaviour{status: "fail", failErr: provider.ErrAuthRequired}

	_, err := runHandler(t, handlerWith(t, st, fp), stageJob(sess))
	if err == nil {
		t.Fatal("want auth error")
	}
	pe, ok := job.AsPermanent(err)
	if !ok {
		t.Fatalf("auth failure must be permanent, got %v", err)
	}
	if pe.Code != "auth_failed" {
		t.Errorf("code = %q, want auth_failed", pe.Code)
	}
}

func TestOnboardingRecent_GapReportIsCompletedWithGaps(t *testing.T) {
	st := openStore(t)
	ctx := context.Background()
	uid := uuid.NewString()
	sess := seedSession(t, st, uid)
	fp := newFakeProvider()
	fp.actBehaviour = make(chan behaviour, 4)
	fp.actBehaviour <- behaviour{status: provider.RangeChannelGap}

	res, err := runHandler(t, handlerWith(t, st, fp), stageJob(sess))
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	var sr onboardingsync.StageResult
	_ = json.Unmarshal([]byte(res), &sr)
	if sr.Status != storage.OnboardingSyncCoverageCompletedWithGaps {
		t.Errorf("status = %s, want completed_with_gaps", sr.Status)
	}
	if len(sr.Gaps) == 0 {
		t.Fatal("gaps missing from the stage result")
	}
	items, _ := st.ListOnboardingSyncWorkItems(ctx, sess.SessionID, storage.OnboardingSyncStageRecentRaw)
	for _, it := range items {
		if it.Kind == "activities" && it.Status != storage.OnboardingSyncItemGap {
			t.Errorf("activities item = %s, want gap", it.Status)
		}
	}
}

// A provider without the recent-range contract (Garmin until T03) is a
// permanent failure the moment the resolver reports it — no poisoning retries.
func TestOnboardingRecent_ProviderNotCapableIsPermanent(t *testing.T) {
	st := openStore(t)
	uid := uuid.NewString()
	sess := seedSession(t, st, uid)
	h := New(Config{
		Resolve: func(context.Context, string) (Provider, error) { return nil, ErrProviderNotRangeCapable },
		Store:   st, Sessions: st,
	})
	_, err := runHandler(t, h, stageJob(sess))
	pe, ok := job.AsPermanent(err)
	if !ok || pe.Code != "provider_not_capable" {
		t.Fatalf("err = %v, want permanent provider_not_capable", err)
	}
}

// A superseded session (rebind) is refused permanently before any provider call.
func TestOnboardingRecent_SupersededSessionRefused(t *testing.T) {
	st := openStore(t)
	ctx := context.Background()
	uid := uuid.NewString()
	sess := seedSession(t, st, uid)
	if err := st.SetOnboardingSyncSessionState(ctx, sess.SessionID, storage.OnboardingSyncStateSuperseded, nil); err != nil {
		t.Fatalf("supersede: %v", err)
	}
	fp := newFakeProvider()
	_, err := runHandler(t, handlerWith(t, st, fp), stageJob(sess))
	if pe, ok := job.AsPermanent(err); !ok || pe.Code != "session_superseded" {
		t.Fatalf("err = %v, want permanent session_superseded", err)
	}
	if len(fp.calls) != 0 {
		t.Errorf("provider called on a superseded session: %+v", fp.calls)
	}
}

// The end-to-end seam (AC5): real claim → dispatch → execute → sweep →
// coverage/readiness, on real MySQL, with no history beyond the recent
// windows — recent readiness never depends on a whole-year pull.
func TestOnboardingRecent_EndToEndWithSweep(t *testing.T) {
	st := openStore(t)
	ctx := context.Background()
	uid := uuid.NewString()

	enq := &fakeEnqueuer{}
	svc, err := onboardingsync.New(onboardingsync.Config{
		Store: st, Enqueuer: enq, Jobs: st, Runs: st,
		JobType:            JobType,
		AnalysisJobType:    "onboarding_recent_analysis",
		LegacyFullPipeline: "onboarding",
		Logger:             zap.NewNop(),
	})
	if err != nil {
		t.Fatalf("service: %v", err)
	}
	sess, err := svc.CreateOrClaim(ctx, uid, "coros")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if len(enq.specs) != 1 {
		t.Fatalf("dispatches = %d, want 1 stage job", len(enq.specs))
	}
	// Persist the dispatched job row like the real enqueuer does (same id the
	// dispatch row recorded), run the executor, then let the dispatcher's
	// terminal write land.
	spec, jobID := enq.specs[0], enq.ids[0]
	now := time.Now().UTC()
	j := &job.Job{
		ID: jobID, UserID: uid, Type: JobType,
		Status: job.StatusRunning, InputJSON: spec.InputJSON, IdempotencyKey: spec.IdempotencyKey,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := st.Jobs().Create(ctx, j); err != nil {
		t.Fatalf("job create: %v", err)
	}
	fp := newFakeProvider()
	h := handlerWith(t, st, fp)
	result, err := h(ctx, j, func(string, int) error { return nil })
	if err != nil {
		t.Fatalf("executor: %v", err)
	}
	j.Status = job.StatusDone
	j.ResultJSON = result
	done := time.Now().UTC()
	j.CompletedAt = &done
	if err := st.Jobs().Update(ctx, j); err != nil {
		t.Fatalf("job done: %v", err)
	}

	svc.Sweep(ctx)
	finishAnalysisStage(t, st, svc, enq, sess)

	// devops#1010: the analysis completing chains the background backfill
	// stages, so the SESSION stays non-terminal while recent data and
	// analysis are both ready — the client never waits for the history. The
	// raw + analysis dispatches themselves are terminal.
	got, err := st.GetOnboardingSyncSessionByID(ctx, sess.SessionID)
	if err != nil || got.Terminal() {
		t.Fatalf("session state = %s err=%v, want non-terminal (chain continues)", got.State, err)
	}
	disp, _ := st.ListOnboardingSyncDispatches(ctx, sess.SessionID)
	for _, d := range disp {
		if d.Stage != storage.OnboardingSyncStageRecentRaw && d.Stage != storage.OnboardingSyncStageRecentAnalysis {
			continue
		}
		if d.Status != storage.OnboardingSyncDispatchDone {
			t.Fatalf("dispatch %s = %s, want done", d.Stage, d.Status)
		}
	}
	view, err := svc.View(ctx, uid)
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	if view.Readiness.RecentData != onboardingsync.ReadinessReady {
		t.Fatalf("recent_data readiness = %s, want ready (no history beyond the windows was ever pulled: %+v)",
			view.Readiness.RecentData, fp.calls)
	}
	if !view.ShellReady {
		t.Error("shell_ready must hold from the claim onward")
	}
}

// Regression (devops#1008 D2): after a mid-stage transient failure and an
// explicit session retry, the stage result and the persisted coverage must be
// computed over the WHOLE work-item set — the byte-level-reused done channels
// keep contributing their windows — instead of narrowing scanned/observed to
// the single re-run channel's window, so GET view's state=completed and
// readiness.recent_data agree.
func TestOnboardingRecent_PartialRetryKeepsFullStageCoverage(t *testing.T) {
	st := openStore(t)
	ctx := context.Background()
	uid := uuid.NewString()

	enq := &fakeEnqueuer{}
	svc, err := onboardingsync.New(onboardingsync.Config{
		Store: st, Enqueuer: enq, Jobs: st, Runs: st,
		JobType:            JobType,
		AnalysisJobType:    "onboarding_recent_analysis",
		LegacyFullPipeline: "onboarding",
		Logger:             zap.NewNop(),
	})
	if err != nil {
		t.Fatalf("service: %v", err)
	}
	sess, err := svc.CreateOrClaim(ctx, uid, "coros")
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	// First run: activities + health complete, dashboard dies transiently —
	// the stage job fails retryably.
	newJob := func(spec job.EnqueueSpec, id string, now time.Time) *job.Job {
		return &job.Job{
			ID: id, UserID: uid, Type: JobType,
			Status: job.StatusRunning, InputJSON: spec.InputJSON, IdempotencyKey: spec.IdempotencyKey,
			CreatedAt: now, UpdatedAt: now,
		}
	}
	now := time.Now().UTC()
	j1 := newJob(enq.specs[0], enq.ids[0], now)
	if err := st.Jobs().Create(ctx, j1); err != nil {
		t.Fatalf("job create: %v", err)
	}
	fp := newFakeProvider()
	fp.dashErr = errors.New("coros: GET /dashboard/query: connection reset")
	if _, err := runHandler(t, handlerWith(t, st, fp), j1); err == nil {
		t.Fatal("transient dashboard failure must surface as a retryable error")
	} else if _, permanent := job.AsPermanent(err); permanent {
		t.Fatalf("transient dashboard failure classified permanent: %v", err)
	}
	j1.Status = job.StatusFailed
	j1.ErrorMessage = "coros: GET /dashboard/query: connection reset"
	failAt := time.Now().UTC()
	j1.CompletedAt = &failAt
	if err := st.Jobs().Update(ctx, j1); err != nil {
		t.Fatalf("job failed: %v", err)
	}
	svc.Sweep(ctx)
	if got, _ := st.GetOnboardingSyncSessionByID(ctx, sess.SessionID); got.State != storage.OnboardingSyncStateFailed {
		t.Fatalf("session state after failed stage = %s, want failed", got.State)
	}

	// The user's POST {"retry":true}: terminally-failed stages re-dispatch.
	if _, err := svc.Retry(ctx, uid); err != nil {
		t.Fatalf("retry: %v", err)
	}
	if len(enq.specs) != 2 {
		t.Fatalf("dispatches after retry = %d, want 2", len(enq.specs))
	}

	// Retry run: ONLY the dashboard channel re-runs; activities/health reuse
	// their complete-fetch credentials byte-for-byte.
	fp2 := newFakeProvider()
	j2 := newJob(enq.specs[1], enq.ids[1], time.Now().UTC())
	if err := st.Jobs().Create(ctx, j2); err != nil {
		t.Fatalf("retry job create: %v", err)
	}
	res, err := runHandler(t, handlerWith(t, st, fp2), j2)
	if err != nil {
		t.Fatalf("retry run: %v", err)
	}
	if fp2.calls["activities"] != 0 || fp2.calls["health"] != 0 || fp2.calls["dashboard"] != 1 {
		t.Errorf("retry re-ran finished channels: %+v (done credentials must be reused)", fp2.calls)
	}

	// The retry job's stage result must merge the reused channels' windows —
	// not just the dashboard day the fresh report carries. The full stage
	// window is the target window the claim created the items for, derived
	// from the SESSION's anchor (CreateOrClaim anchors on today's Shanghai
	// day — hardcoding the date made the test flake across midnight).
	anchor, err := time.Parse("2006-01-02", sess.AnchorDay)
	if err != nil {
		t.Fatalf("anchor day: %v", err)
	}
	wantTo := sess.AnchorDay
	wantFrom := anchor.AddDate(0, 0, -89).Format("2006-01-02")
	var sr onboardingsync.StageResult
	if err := json.Unmarshal([]byte(res), &sr); err != nil {
		t.Fatalf("result parse: %v", err)
	}
	if sr.ScannedFrom == nil || *sr.ScannedFrom != wantFrom || sr.ScannedTo == nil || *sr.ScannedTo != wantTo {
		t.Errorf("result scanned = %v..%v, want the full stage window %s..%s", sr.ScannedFrom, sr.ScannedTo, wantFrom, wantTo)
	}
	if sr.ObservedFrom == nil || *sr.ObservedFrom != wantFrom || sr.ObservedTo == nil || *sr.ObservedTo != wantTo {
		t.Errorf("result observed = %v..%v, want the full stage window (reused channels keep contributing)", sr.ObservedFrom, sr.ObservedTo)
	}
	if sr.Status != storage.OnboardingSyncCoverageCompleted {
		t.Errorf("result status = %s, want completed", sr.Status)
	}

	// The sweep persists that merged contract; coverage and readiness must
	// agree with the session's completed state (the client stops polling on
	// exactly this pair).
	j2.Status = job.StatusDone
	j2.ResultJSON = res
	done := time.Now().UTC()
	j2.CompletedAt = &done
	if err := st.Jobs().Update(ctx, j2); err != nil {
		t.Fatalf("job done: %v", err)
	}
	svc.Sweep(ctx)
	finishAnalysisStage(t, st, svc, enq, sess)
	cov, err := st.GetOnboardingSyncStageCoverage(ctx, sess.SessionID, storage.OnboardingSyncStageRecentRaw)
	if err != nil || cov == nil {
		t.Fatalf("coverage read: %v %v", cov, err)
	}
	if cov.ScannedFrom == nil || *cov.ScannedFrom != wantFrom || cov.ScannedTo == nil || *cov.ScannedTo != wantTo ||
		cov.ObservedFrom == nil || *cov.ObservedFrom != wantFrom || cov.ObservedTo == nil || *cov.ObservedTo != wantTo {
		t.Errorf("coverage windows = scanned %v..%v observed %v..%v, want full stage window %s..%s",
			cov.ScannedFrom, cov.ScannedTo, cov.ObservedFrom, cov.ObservedTo, wantFrom, wantTo)
	}
	if cov.Status != storage.OnboardingSyncCoverageCompleted {
		t.Errorf("coverage status = %s, want completed", cov.Status)
	}
	if cov.LastError != nil {
		t.Errorf("coverage last_error = %q, want cleared by the successful retry", *cov.LastError)
	}
	if cov.GapsJSON != nil {
		t.Errorf("coverage gaps_json = %q, want none for a fully covered stage", *cov.GapsJSON)
	}
	view, err := svc.View(ctx, uid)
	if err != nil {
		t.Fatalf("view: %v", err)
	}
	// devops#1010: the session continues into the chained backfill stages;
	// the agreement this regression pins is recent coverage + readiness.
	if view.State == storage.OnboardingSyncStateFailed {
		t.Errorf("session state = %s, want not failed", view.State)
	}
	if view.Readiness.RecentData != onboardingsync.ReadinessReady {
		t.Fatalf("recent_data readiness = %s, want ready (coverage and readiness must agree after a partial retry)",
			view.Readiness.RecentData)
	}
}

// devops#1010 defect regression (pure aggregation seam): a terminal gap item
// whose credential carries a storage-derived observed window must contribute
// that window AND only its complement as gaps — never a whole-window
// "no data at provider" gap over days the store actually holds. Items with no
// observed window keep the honest whole-window gap.
func TestStageResultFromItems_GapItemsKeepObservedWindowAndComplementGaps(t *testing.T) {
	strPtr := func(s string) *string { return &s }
	cred := func(kind, from, to, obsFrom, obsTo string, n int) *string {
		s := fmt.Sprintf("coros:v1:range:%s:%s..%s:obs=%s..%s:n=%d", kind, from, to, obsFrom, obsTo, n)
		return &s
	}
	items := []*storage.OnboardingSyncWorkItem{
		{Kind: kindActivities, RangeFrom: "2026-05-22", RangeTo: "2026-08-19", Status: storage.OnboardingSyncItemGap,
			Error:           strPtr("no activities at provider in range"),
			FetchCredential: cred(kindActivities, "2026-05-22", "2026-08-19", "2026-06-10", "2026-08-16", 18)},
		{Kind: kindHealth, RangeFrom: "2026-08-20", RangeTo: "2026-10-20", Status: storage.OnboardingSyncItemGap,
			Error:           strPtr("provider returned no health rows for range"),
			FetchCredential: cred(kindHealth, "2026-08-20", "2026-10-20", "2026-08-26", "2026-10-01", 30)},
	}
	var res onboardingsync.StageResult
	if err := json.Unmarshal([]byte(stageResultFromItems(storage.OnboardingSyncStageExtendedRaw, items)), &res); err != nil {
		t.Fatalf("parse: %v", err)
	}
	if res.Status != storage.OnboardingSyncCoverageCompleted {
		t.Errorf("status = %s, want completed", res.Status)
	}
	if res.ScannedFrom == nil || *res.ScannedFrom != "2026-05-22" || res.ScannedTo == nil || *res.ScannedTo != "2026-10-20" {
		t.Errorf("scanned = %v..%v, want 2026-05-22..2026-10-20", res.ScannedFrom, res.ScannedTo)
	}
	if res.ObservedFrom == nil || *res.ObservedFrom != "2026-06-10" || res.ObservedTo == nil || *res.ObservedTo != "2026-10-01" {
		t.Errorf("observed = %v..%v, want the credential-derived union 2026-06-10..2026-10-01", res.ObservedFrom, res.ObservedTo)
	}
	wantGaps := []onboardingsync.StageGap{
		{From: "2026-05-22", To: "2026-06-09", Kind: provider.RangeGapEmpty, Channel: kindActivities, Reason: "no activities at provider in range"},
		{From: "2026-08-17", To: "2026-08-19", Kind: provider.RangeGapEmpty, Channel: kindActivities, Reason: "no activities at provider in range"},
		{From: "2026-08-20", To: "2026-08-25", Kind: provider.RangeGapEmpty, Channel: kindHealth, Reason: "provider returned no health rows for range"},
		{From: "2026-10-02", To: "2026-10-20", Kind: provider.RangeGapEmpty, Channel: kindHealth, Reason: "provider returned no health rows for range"},
	}
	if len(res.Gaps) != len(wantGaps) {
		t.Fatalf("gaps = %+v, want exactly the complements %+v", res.Gaps, wantGaps)
	}
	for i, g := range wantGaps {
		if res.Gaps[i] != g {
			t.Errorf("gap[%d] = %+v, want %+v", i, res.Gaps[i], g)
		}
	}

	// No observed window (nothing stored in the window) keeps the honest
	// whole-window gap — observed stays empty, never fabricated.
	empty := []*storage.OnboardingSyncWorkItem{
		{Kind: kindActivities, RangeFrom: "2026-05-22", RangeTo: "2026-08-19", Status: storage.OnboardingSyncItemGap,
			Error:           strPtr("no activities at provider in range"),
			FetchCredential: strPtr("coros:v1:range:activities:2026-05-22..2026-08-19:obs=-..-:n=0")},
	}
	res = onboardingsync.StageResult{}
	if err := json.Unmarshal([]byte(stageResultFromItems(storage.OnboardingSyncStageHistoricalRaw, empty)), &res); err != nil {
		t.Fatalf("parse empty: %v", err)
	}
	if res.ObservedFrom != nil || res.ObservedTo != nil {
		t.Errorf("observed = %v..%v, want none (nothing stored)", res.ObservedFrom, res.ObservedTo)
	}
	if len(res.Gaps) != 1 || res.Gaps[0].From != "2026-05-22" || res.Gaps[0].To != "2026-08-19" {
		t.Errorf("gaps = %+v, want the single whole-window gap", res.Gaps)
	}
}

// fakeEnqueuer captures dispatches without a broker.
type fakeEnqueuer struct {
	specs []job.EnqueueSpec
	ids   []string
}

func (f *fakeEnqueuer) Enqueue(_ context.Context, spec job.EnqueueSpec) (string, error) {
	f.specs = append(f.specs, spec)
	id := "job-" + uuid.NewString()[:8]
	f.ids = append(f.ids, id)
	return id, nil
}
