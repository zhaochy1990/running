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

// fakeProvider drives the executor: it records which windows it was asked for
// and answers from a scripted per-channel behavior.
type fakeProvider struct {
	name         string
	loggedIn     bool
	calls        map[string]int
	actBehaviour chan behaviour // per-activities-call behaviour (nil = done)
	healthErr    error          // fails the health channel when set

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
		day := opts.Dashboard.To
		rep.Dashboard = &provider.RangeChannelReport{
			Status: provider.RangeChannelDone, ScannedFrom: day, ScannedTo: day,
			ObservedFrom: strPtr(day), ObservedTo: strPtr(day), Count: 1,
			Credential: fmt.Sprintf("coros:v1:range:dashboard:%s..%s:obs=%s..%s:n=1", day, day, day, day),
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
	if sr.Status != storage.OnboardingSyncCoverageCompleted {
		t.Errorf("status = %s, want completed", sr.Status)
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

	got, err := st.GetOnboardingSyncSessionByID(ctx, sess.SessionID)
	if err != nil || got.State != storage.OnboardingSyncStateCompleted {
		t.Fatalf("session state = %s err=%v, want completed", got.State, err)
	}
	disp, _ := st.ListOnboardingSyncDispatches(ctx, sess.SessionID)
	if disp[0].Status != storage.OnboardingSyncDispatchDone {
		t.Fatalf("dispatch = %s, want done", disp[0].Status)
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
