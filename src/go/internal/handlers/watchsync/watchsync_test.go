package watchsync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	gomysql "github.com/go-sql-driver/mysql"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
)

// fakeProvider implements the minimal Provider the handler needs.
type fakeProvider struct {
	loggedIn   bool
	loginErr   error
	syncErr    error
	result     provider.SyncResult
	gotUser    string
	gotOpts    provider.SyncOptions
	emit       []provider.SyncProgress // progress events to replay through opts.Progress
	syncCalled bool
}

func (f *fakeProvider) IsLoggedIn(user string) (bool, error) {
	return f.loggedIn, f.loginErr
}

func (f *fakeProvider) Info() provider.ProviderInfo {
	return provider.ProviderInfo{Name: "coros"}
}

func (f *fakeProvider) SyncUser(_ context.Context, user string, opts provider.SyncOptions) (provider.SyncResult, error) {
	f.syncCalled = true
	f.gotUser = user
	f.gotOpts = opts
	for _, e := range f.emit {
		if opts.Progress != nil {
			opts.Progress(e)
		}
	}
	return f.result, f.syncErr
}

// fakeMarker captures last-sync bookkeeping written by the handler.
type fakeMarker struct{ set map[string]string }

func (m *fakeMarker) SetMeta(_ context.Context, _, key, value string) error {
	if m.set == nil {
		m.set = map[string]string{}
	}
	m.set[key] = value
	return nil
}

// testJobs is an arbitrary non-default concurrency the tests thread through
// New to assert it lands on the run's SyncOptions.
const testJobs = 7

func run(t *testing.T, f *fakeProvider, input string) (string, error, []string, []int) {
	t.Helper()
	h := New(func(_ context.Context, _ string) (Provider, error) { return f, nil }, &fakeMarker{}, testJobs)
	var stages []string
	var pcts []int
	hb := func(stage string, pct int) error {
		stages = append(stages, stage)
		pcts = append(pcts, pct)
		return nil
	}
	res, err := h(context.Background(), &job.Job{UserID: "u-123", InputJSON: input}, hb)
	return res, err, stages, pcts
}

func TestHandler_DefaultsToFullAll(t *testing.T) {
	f := &fakeProvider{loggedIn: true, result: provider.SyncResult{Activities: 3, Health: 2}}
	res, err, _, _ := run(t, f, "") // empty payload -> default full + all
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if f.gotUser != "u-123" {
		t.Errorf("user = %q, want u-123", f.gotUser)
	}
	if f.gotOpts.Mode != provider.SyncFull {
		t.Errorf("mode = %v, want full (default)", f.gotOpts.Mode)
	}
	if f.gotOpts.Content != provider.ContentAll {
		t.Errorf("content = %v, want all (default)", f.gotOpts.Content)
	}
	if f.gotOpts.Jobs != testJobs {
		t.Errorf("jobs = %d, want %d (threaded from New)", f.gotOpts.Jobs, testJobs)
	}
	if res != `{"activities":3,"health":2,"mode":"full"}` {
		t.Errorf("result = %s", res)
	}
}

func TestHandler_ParsesPayload(t *testing.T) {
	f := &fakeProvider{loggedIn: true}
	_, err, _, _ := run(t, f, `{"mode":"incremental","content":"health","limit":50}`)
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if f.gotOpts.Mode != provider.SyncIncremental {
		t.Errorf("mode = %v, want incremental", f.gotOpts.Mode)
	}
	if f.gotOpts.Content != provider.ContentHealth {
		t.Errorf("content = %v, want health", f.gotOpts.Content)
	}
	if f.gotOpts.Limit != 50 {
		t.Errorf("limit = %d, want 50", f.gotOpts.Limit)
	}
}

func TestHandler_ReturnsHealthDatesForDownstreamCompute(t *testing.T) {
	f := &fakeProvider{
		loggedIn: true,
		result: provider.SyncResult{
			Health:      2,
			HealthDates: []string{"2026-08-10", "2026-08-11"},
		},
	}
	res, err, _, _ := run(t, f, `{"mode":"incremental"}`)
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	var body struct {
		HealthDates []string `json:"health_dates"`
	}
	if err := json.Unmarshal([]byte(res), &body); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if len(body.HealthDates) != 2 || body.HealthDates[0] != "2026-08-10" || body.HealthDates[1] != "2026-08-11" {
		t.Fatalf("health_dates = %v, want synced Shanghai days", body.HealthDates)
	}
}

func TestHandler_ReturnsScheduleMetadata(t *testing.T) {
	f := &fakeProvider{
		loggedIn: true,
		result: provider.SyncResult{
			ScheduleSessions:        2,
			ScheduleSkippedStrength: 1,
			ScheduleSkippedStride:   1,
			ScheduleSkippedInvalid:  1,
		},
	}
	res, err, _, _ := run(t, f, "")
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	var body struct {
		ScheduleSessions        int `json:"schedule_sessions"`
		ScheduleSkippedStrength int `json:"schedule_skipped_strength"`
		ScheduleSkippedStride   int `json:"schedule_skipped_stride"`
		ScheduleSkippedInvalid  int `json:"schedule_skipped_invalid"`
	}
	if err := json.Unmarshal([]byte(res), &body); err != nil {
		t.Fatalf("decode result: %v", err)
	}
	if body.ScheduleSessions != 2 || body.ScheduleSkippedStrength != 1 ||
		body.ScheduleSkippedStride != 1 || body.ScheduleSkippedInvalid != 1 {
		t.Fatalf("schedule metadata = %+v", body)
	}
}

func TestHandler_NotLoggedIn_Permanent(t *testing.T) {
	f := &fakeProvider{loggedIn: false}
	_, err, _, _ := run(t, f, "")
	pe, ok := job.AsPermanent(err)
	if !ok {
		t.Fatalf("want PermanentError, got %v", err)
	}
	if pe.Code != "not_logged_in" {
		t.Errorf("code = %q, want not_logged_in", pe.Code)
	}
	if f.syncCalled {
		t.Error("SyncUser must not run when not logged in")
	}
}

func TestHandler_AuthError_Permanent(t *testing.T) {
	f := &fakeProvider{loggedIn: true, syncErr: provider.ErrAuthRequired}
	_, err, _, _ := run(t, f, "")
	pe, ok := job.AsPermanent(err)
	if !ok {
		t.Fatalf("want PermanentError, got %v", err)
	}
	if pe.Code != "auth_failed" {
		t.Errorf("code = %q, want auth_failed", pe.Code)
	}
}

func TestHandler_TransientError_Retryable(t *testing.T) {
	f := &fakeProvider{loggedIn: true, syncErr: errors.New("connection reset")}
	_, err, _, _ := run(t, f, "")
	if err == nil {
		t.Fatal("want error")
	}
	if _, ok := job.AsPermanent(err); ok {
		t.Errorf("transient error must NOT be permanent: %v", err)
	}
}

func TestHandler_InvalidProviderRequest_Permanent(t *testing.T) {
	f := &fakeProvider{loggedIn: true, syncErr: provider.ErrInvalidRequest}
	_, err, _, _ := run(t, f, "")
	pe, ok := job.AsPermanent(err)
	if !ok {
		t.Fatalf("want PermanentError, got %v", err)
	}
	if pe.Code != "provider_invalid_request" {
		t.Errorf("code = %q, want provider_invalid_request", pe.Code)
	}
}

// TestHandler_DeterministicWriteError_Permanent covers the fail-fast path: a
// deterministic MySQL write failure (here a 1062 unique-index violation, as
// wrapped by the storage layer) must poison immediately rather than exhaust the
// retry budget, since it recurs identically on every attempt.
func TestHandler_DeterministicWriteError_Permanent(t *testing.T) {
	dup := fmt.Errorf("storage: insert children: %w", &gomysql.MySQLError{Number: 1062, Message: "Duplicate entry"})
	f := &fakeProvider{loggedIn: true, syncErr: dup}
	_, err, _, _ := run(t, f, "")
	pe, ok := job.AsPermanent(err)
	if !ok {
		t.Fatalf("want PermanentError, got %v", err)
	}
	if pe.Code != "storage_constraint" {
		t.Errorf("code = %q, want storage_constraint", pe.Code)
	}
}

// TestHandler_TransientWriteError_Retryable guards the other side: a transient
// MySQL fault (deadlock 1213) must stay retryable, not be swept into the
// fail-fast path.
func TestHandler_TransientWriteError_Retryable(t *testing.T) {
	deadlock := fmt.Errorf("storage: upsert activity: %w", &gomysql.MySQLError{Number: 1213, Message: "Deadlock found"})
	f := &fakeProvider{loggedIn: true, syncErr: deadlock}
	_, err, _, _ := run(t, f, "")
	if err == nil {
		t.Fatal("want error")
	}
	if _, ok := job.AsPermanent(err); ok {
		t.Errorf("transient deadlock must NOT be permanent: %v", err)
	}
}

func TestHandler_BadPayload_Permanent(t *testing.T) {
	f := &fakeProvider{loggedIn: true}
	_, err, _, _ := run(t, f, `{"mode":"sideways"}`)
	pe, ok := job.AsPermanent(err)
	if !ok {
		t.Fatalf("want PermanentError for bad payload, got %v", err)
	}
	if pe.Code != "bad_payload" {
		t.Errorf("code = %q, want bad_payload", pe.Code)
	}
	if f.syncCalled {
		t.Error("SyncUser must not run on bad payload")
	}
}

func TestHandler_ResolveError_Retryable(t *testing.T) {
	h := New(func(context.Context, string) (Provider, error) {
		return nil, errors.New("db down while resolving provider")
	}, &fakeMarker{}, testJobs)
	_, err := h(context.Background(), &job.Job{UserID: "u-123"}, func(string, int) error { return nil })
	if err == nil {
		t.Fatal("want error")
	}
	if _, ok := job.AsPermanent(err); ok {
		t.Errorf("resolver fault must be retryable, got permanent: %v", err)
	}
}

func TestHandler_BridgesProgressToHeartbeat(t *testing.T) {
	f := &fakeProvider{
		loggedIn: true,
		emit: []provider.SyncProgress{
			{"phase": "activities", "current": 5, "total": 10, "percent": 45},
			{"phase": "health", "current": 1, "total": 1, "percent": 95},
		},
	}
	_, err, stages, pcts := run(t, f, "")
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if len(stages) != 2 || stages[0] != "activities" || stages[1] != "health" {
		t.Fatalf("stages = %v", stages)
	}
	if len(pcts) != 2 || pcts[0] != 45 || pcts[1] != 95 {
		t.Fatalf("percents = %v", pcts)
	}
}

func TestHandler_StampsLastSyncTimeOnSuccess(t *testing.T) {
	f := &fakeProvider{loggedIn: true, result: provider.SyncResult{Activities: 1}}
	m := &fakeMarker{}
	h := New(func(context.Context, string) (Provider, error) { return f, nil }, m, testJobs)
	if _, err := h(context.Background(), &job.Job{UserID: "u-123"}, func(string, int) error { return nil }); err != nil {
		t.Fatalf("handler: %v", err)
	}
	if _, ok := m.set[storage.MetaKeyLastSyncTime]; !ok {
		t.Errorf("last_sync_time not stamped on success: %v", m.set)
	}
}

func TestHandler_NoStampOnFailedSync(t *testing.T) {
	f := &fakeProvider{loggedIn: true, syncErr: errors.New("connection reset")}
	m := &fakeMarker{}
	h := New(func(context.Context, string) (Provider, error) { return f, nil }, m, testJobs)
	if _, err := h(context.Background(), &job.Job{UserID: "u-123"}, func(string, int) error { return nil }); err == nil {
		t.Fatal("want error")
	}
	if len(m.set) != 0 {
		t.Errorf("must not stamp last_sync_time on a failed sync: %v", m.set)
	}
}

// --- write-isolation session wiring (devops#1005) ---------------------------

// fakeSessions is a SessionManager recording the session lifecycle and
// handing the sync a callback so the test can inspect what rode in ctx.
type fakeSessions struct {
	beginErr  error
	renewErr  error
	released  bool
	session   *storage.PublishSession
	sawInSync *storage.PublishSession
}

func (f *fakeSessions) BeginWatchSyncSession(_ context.Context, userID, providerName, holder string, _ time.Duration) (*storage.PublishSession, error) {
	if f.beginErr != nil {
		return nil, f.beginErr
	}
	f.session = &storage.PublishSession{UserID: userID, Provider: providerName,
		Holder: holder, BindingRevision: 3, LeaseToken: 7}
	return f.session, nil
}

func (f *fakeSessions) RenewWatchExecLease(context.Context, string, string, int64, time.Duration) error {
	return f.renewErr
}

func (f *fakeSessions) ReleaseWatchExecLease(_ context.Context, _, _ string, _ int64) error {
	f.released = true
	return nil
}

type ctxInspectProvider struct {
	fakeProvider
	onSync func(ctx context.Context)
}

func (p *ctxInspectProvider) SyncUser(ctx context.Context, user string, opts provider.SyncOptions) (provider.SyncResult, error) {
	if p.onSync != nil {
		p.onSync(ctx)
	}
	return p.fakeProvider.SyncUser(ctx, user, opts)
}

func TestHandler_Isolated_ThreadsSessionThroughSync(t *testing.T) {
	sessions := &fakeSessions{}
	f := &ctxInspectProvider{fakeProvider: fakeProvider{loggedIn: true, result: provider.SyncResult{Activities: 1}}}
	f.onSync = func(ctx context.Context) {
		sessions.sawInSync = storage.PublishSessionFromContext(ctx)
	}
	h := NewIsolated(func(_ context.Context, _ string) (Provider, error) { return f, nil },
		&fakeMarker{}, testJobs, sessions, 90*time.Millisecond)
	if _, err := h(context.Background(), &job.Job{ID: "job-9", UserID: "u-iso"}, func(string, int) error { return nil }); err != nil {
		t.Fatalf("handler: %v", err)
	}
	if sessions.sawInSync != sessions.session {
		t.Fatalf("sync saw session %v, want the begun session %v", sessions.sawInSync, sessions.session)
	}
	if sessions.sawInSync == nil || sessions.sawInSync.Provider != "coros" || sessions.sawInSync.Holder != "job-9" {
		t.Fatalf("session = %+v, want provider coros, holder job-9", sessions.sawInSync)
	}
	if !sessions.released {
		t.Fatal("lease not released after sync")
	}
}

func TestHandler_Isolated_LeaseContentionIsRetryable(t *testing.T) {
	sessions := &fakeSessions{beginErr: storage.ErrLeaseHeld}
	f := &fakeProvider{loggedIn: true}
	h := NewIsolated(func(_ context.Context, _ string) (Provider, error) { return f, nil },
		&fakeMarker{}, testJobs, sessions, time.Minute)
	_, err := h(context.Background(), &job.Job{ID: "job-10", UserID: "u-iso"}, func(string, int) error { return nil })
	if !errors.Is(err, storage.ErrLeaseHeld) {
		t.Fatalf("err = %v, want ErrLeaseHeld", err)
	}
	if _, ok := job.AsPermanent(err); ok {
		t.Fatal("lease contention must stay retryable — the winner finishes and the retry proceeds")
	}
	if f.syncCalled {
		t.Fatal("sync ran despite failing to begin the session")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Recent-window gap check (devops#1010 AC3)
// ─────────────────────────────────────────────────────────────────────────────

// gapCheckProvider extends fakeProvider with the chunked backfill contract so
// the handler's gap-check pass can run it.
type gapCheckProvider struct {
	fakeProvider
	backfillCalled int
	backfillWin    provider.DayWindow
	backfillErr    error
}

func (g *gapCheckProvider) SyncBackfillRange(_ context.Context, _ string, opts provider.BackfillRangeOptions, _ provider.ProgressCallback) (provider.BackfillRangeReport, error) {
	g.backfillCalled++
	if opts.Activities != nil {
		g.backfillWin = *opts.Activities
	}
	return provider.BackfillRangeReport{}, g.backfillErr
}

type fakeGapCheck struct {
	win     provider.DayWindow
	ok      bool
	called  bool
	gotProv string
}

func (f *fakeGapCheck) UnfinishedRecentActivityWindow(_ context.Context, _, providerName string) (provider.DayWindow, bool) {
	f.called = true
	f.gotProv = providerName
	return f.win, f.ok
}

// While an onboarding session is unfinished, an INCREMENTAL run first scans
// the session's recent activities window with the existence-skipping backfill
// chunk (一次有界查漏), then runs the normal incremental.
func TestHandler_IncrementalRunsRecentGapCheck(t *testing.T) {
	f := &gapCheckProvider{fakeProvider: fakeProvider{loggedIn: true, result: provider.SyncResult{Activities: 1}}}
	gc := &fakeGapCheck{ok: true, win: provider.DayWindow{From: "2026-08-18", To: "2026-11-16"}}
	h := NewIsolatedWithGapCheck(func(_ context.Context, _ string) (Provider, error) { return f, nil }, &fakeMarker{}, testJobs, nil, 0, gc)
	if _, err := h(context.Background(), &job.Job{UserID: "u-123", InputJSON: `{"mode":"incremental"}`}, func(string, int) error { return nil }); err != nil {
		t.Fatalf("handler: %v", err)
	}
	if !gc.called || gc.gotProv != "coros" {
		t.Fatalf("gap check called=%v provider=%q, want called for coros", gc.called, gc.gotProv)
	}
	if f.backfillCalled != 1 {
		t.Fatalf("backfill chunks = %d, want 1", f.backfillCalled)
	}
	if f.backfillWin != gc.win {
		t.Errorf("gap-check window = %+v, want the session's recent window", f.backfillWin)
	}
	if !f.syncCalled {
		t.Error("the normal incremental must still run")
	}
}

// A full sync (window scanned anyway) and a finished session (ok=false) skip
// the extra pass; a failed gap-check chunk is logged and does not fail the
// incremental (the session executor remains the reliable healer).
func TestHandler_GapCheckSkipsAndToleratesFailure(t *testing.T) {
	// Full mode: no gap check even with an unfinished session.
	f := &gapCheckProvider{fakeProvider: fakeProvider{loggedIn: true}}
	gc := &fakeGapCheck{ok: true}
	h := NewIsolatedWithGapCheck(func(_ context.Context, _ string) (Provider, error) { return f, nil }, &fakeMarker{}, testJobs, nil, 0, gc)
	if _, err := h(context.Background(), &job.Job{UserID: "u-123", InputJSON: `{"mode":"full"}`}, func(string, int) error { return nil }); err != nil {
		t.Fatalf("full handler: %v", err)
	}
	if f.backfillCalled != 0 {
		t.Error("full sync must not run the gap check")
	}

	// Finished session: the seam reports ok=false, nothing extra runs.
	f2 := &gapCheckProvider{fakeProvider: fakeProvider{loggedIn: true}}
	gc2 := &fakeGapCheck{ok: false}
	h2 := NewIsolatedWithGapCheck(func(_ context.Context, _ string) (Provider, error) { return f2, nil }, &fakeMarker{}, testJobs, nil, 0, gc2)
	if _, err := h2(context.Background(), &job.Job{UserID: "u-123", InputJSON: `{"mode":"incremental"}`}, func(string, int) error { return nil }); err != nil {
		t.Fatalf("incremental handler: %v", err)
	}
	if f2.backfillCalled != 0 {
		t.Error("finished session must not run the gap check")
	}

	// A failing gap-check chunk must not fail the whole incremental.
	f3 := &gapCheckProvider{fakeProvider: fakeProvider{loggedIn: true}}
	f3.backfillErr = errors.New("vendor 5xx")
	gc3 := &fakeGapCheck{ok: true}
	h3 := NewIsolatedWithGapCheck(func(_ context.Context, _ string) (Provider, error) { return f3, nil }, &fakeMarker{}, testJobs, nil, 0, gc3)
	if _, err := h3(context.Background(), &job.Job{UserID: "u-123", InputJSON: `{"mode":"incremental"}`}, func(string, int) error { return nil }); err != nil {
		t.Fatalf("incremental must tolerate a failed gap-check chunk: %v", err)
	}
	if !f3.syncCalled {
		t.Error("the incremental must still run after a gap-check failure")
	}
}
