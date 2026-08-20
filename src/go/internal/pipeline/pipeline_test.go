package pipeline

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/job"
)

// --- fakes ---------------------------------------------------------------

type fakeEnqueuer struct {
	mu    sync.Mutex
	specs []job.EnqueueSpec
}

func (e *fakeEnqueuer) Enqueue(_ context.Context, spec job.EnqueueSpec) (string, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.specs = append(e.specs, spec)
	if spec.ID != "" {
		return spec.ID, nil
	}
	return jobIDFor(len(e.specs)), nil
}

func (e *fakeEnqueuer) count() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	return len(e.specs)
}

type partialEnqueuer struct {
	fakeEnqueuer
	failAt         int
	err            error
	emptyOnFailure bool
}

func (e *partialEnqueuer) Enqueue(ctx context.Context, spec job.EnqueueSpec) (string, error) {
	id, _ := e.fakeEnqueuer.Enqueue(ctx, spec)
	if len(e.specs) == e.failAt {
		if e.emptyOnFailure {
			return "", e.err
		}
		return id, e.err
	}
	return id, nil
}

func jobIDFor(n int) string {
	return "job-" + string(rune('0'+n))
}

type fakePStore struct {
	mu   sync.Mutex
	rows map[string]*job.PipelineRun
}

func newFakePStore() *fakePStore { return &fakePStore{rows: map[string]*job.PipelineRun{}} }

func (s *fakePStore) Create(_ context.Context, r *job.PipelineRun) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rows[r.RunID] = copyRun(r)
	return nil
}
func (s *fakePStore) Get(_ context.Context, id string) (*job.PipelineRun, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rows[id]
	if !ok {
		return nil, &job.ErrNotFound{Key: id}
	}
	return copyRun(r), nil
}
func (s *fakePStore) Update(_ context.Context, r *job.PipelineRun) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rows[r.RunID] = copyRun(r)
	return nil
}
func (s *fakePStore) Mutate(_ context.Context, id string, fn func(*job.PipelineRun) (bool, error)) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rows[id]
	if !ok {
		return false, &job.ErrNotFound{Key: id}
	}
	candidate := copyRun(r)
	changed, err := fn(candidate)
	if err != nil || !changed {
		return changed, err
	}
	s.rows[id] = candidate
	return true, nil
}
func (s *fakePStore) snap(id string) *job.PipelineRun {
	s.mu.Lock()
	defer s.mu.Unlock()
	return copyRun(s.rows[id])
}
func copyRun(r *job.PipelineRun) *job.PipelineRun {
	if r == nil {
		return nil
	}
	cp := *r
	cp.Steps = append([]job.PipelineStep(nil), r.Steps...)
	return &cp
}

func onboardingRegistry() *Registry {
	r := NewRegistry()
	r.MustRegister(Def{Name: "onboarding", Steps: []StepDef{
		{Name: "full_sync", JobType: "onboarding_full_sync"},
		{Name: "calibration", JobType: "onboarding_calibration"},
		{Name: "backfill", JobType: "onboarding_backfill"},
	}})
	return r
}

func fixedNow() func() time.Time {
	t := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	return func() time.Time { return t }
}

func newOrch(ps job.PipelineStore, enq job.Enqueuer) *Orchestrator {
	return New(ps, enq, onboardingRegistry(),
		WithClock(fixedNow()),
		WithRunIDFunc(func() string { return "run-1" }),
	)
}

// --- tests ---------------------------------------------------------------

func TestStartPipeline_CreatesRunAndEnqueuesFirstStep(t *testing.T) {
	ps := newFakePStore()
	enq := &fakeEnqueuer{}
	o := newOrch(ps, enq)

	runID, err := o.StartPipeline(context.Background(), "onboarding", "u1", "creator-9", "", "")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	if runID != "run-1" {
		t.Fatalf("runID = %q", runID)
	}
	run := ps.snap("run-1")
	if run == nil {
		t.Fatal("run not persisted")
	}
	if run.Status != job.StatusRunning {
		t.Fatalf("status = %s, want running", run.Status)
	}
	if run.UserID != "u1" {
		t.Fatalf("user id (subject) = %q, want u1", run.UserID)
	}
	if run.CreatedBy != "creator-9" {
		t.Fatalf("created_by (actor) = %q, want creator-9", run.CreatedBy)
	}
	if len(run.Steps) != 3 {
		t.Fatalf("steps = %d, want 3", len(run.Steps))
	}
	// Only the first step is enqueued, linked back to the run.
	if len(enq.specs) != 1 {
		t.Fatalf("enqueued %d, want 1", len(enq.specs))
	}
	if enq.specs[0].Type != "onboarding_full_sync" || enq.specs[0].PipelineRunID != "run-1" || enq.specs[0].UserID != "u1" {
		t.Fatalf("first enqueue wrong: %+v", enq.specs[0])
	}
	if run.Steps[0].JobID == "" {
		t.Fatal("step 0 job id not recorded")
	}
}

func TestStartPipeline_PublishFailureFailsReservedFirstStep(t *testing.T) {
	ps := newFakePStore()
	enq := &partialEnqueuer{failAt: 1, err: errors.New("broker unavailable"), emptyOnFailure: true}
	o := newOrch(ps, enq)

	runID, err := o.StartPipeline(context.Background(), "onboarding", "u1", "u1", "", "")
	if runID != "run-1" || err == nil {
		t.Fatalf("start = %q, %v; want publish failure", runID, err)
	}
	run := ps.snap(runID)
	if run == nil || run.Steps[0].JobID == "" || run.Steps[0].Status != job.StatusFailed || run.Status != job.StatusFailed {
		t.Fatalf("reserved first step and run must be failed: %+v", run)
	}
}

func TestStartPipeline_UnknownName(t *testing.T) {
	o := newOrch(newFakePStore(), &fakeEnqueuer{})
	if _, err := o.StartPipeline(context.Background(), "nope", "u1", "u1", "", ""); err == nil {
		t.Fatal("want error for unknown pipeline")
	}
}

func TestOnJobCompleted_AdvancesToNextStep(t *testing.T) {
	ps := newFakePStore()
	enq := &fakeEnqueuer{}
	o := newOrch(ps, enq)
	_, _ = o.StartPipeline(context.Background(), "onboarding", "u1", "u1", "", "")
	run := ps.snap("run-1")
	step0JobID := run.Steps[0].JobID

	// full_sync completes.
	err := o.OnJobCompleted(context.Background(), &job.Job{
		ID: step0JobID, UserID: "u1", PipelineRunID: "run-1",
	})
	if err != nil {
		t.Fatalf("OnJobCompleted: %v", err)
	}

	run = ps.snap("run-1")
	if run.Steps[0].Status != job.StatusDone {
		t.Fatalf("step0 = %s, want done", run.Steps[0].Status)
	}
	if run.CurrentStep != 1 {
		t.Fatalf("current step = %d, want 1", run.CurrentStep)
	}
	if len(enq.specs) != 2 || enq.specs[1].Type != "onboarding_calibration" {
		t.Fatalf("second step not enqueued: %+v", enq.specs)
	}
	if run.Status != job.StatusRunning {
		t.Fatalf("run status = %s, want running", run.Status)
	}
}

func TestOnJobCompleted_PublishFailureFailsReservedNextStep(t *testing.T) {
	ps := newFakePStore()
	enq := &partialEnqueuer{failAt: 2, err: errors.New("broker unavailable"), emptyOnFailure: true}
	o := newOrch(ps, enq)
	if _, err := o.StartPipeline(context.Background(), "onboarding", "u1", "u1", "", ""); err != nil {
		t.Fatalf("start: %v", err)
	}
	first := ps.snap("run-1").Steps[0].JobID
	if err := o.OnJobCompleted(context.Background(), &job.Job{ID: first, UserID: "u1", PipelineRunID: "run-1"}); err == nil {
		t.Fatal("complete must return publish failure")
	}
	run := ps.snap("run-1")
	if run.Steps[0].Status != job.StatusDone || run.CurrentStep != 1 || run.Steps[1].JobID == "" || run.Steps[1].Status != job.StatusFailed || run.Status != job.StatusFailed {
		t.Fatalf("reserved next step and run must be failed: %+v", run)
	}
	if err := o.OnJobCompleted(context.Background(), &job.Job{ID: first, UserID: "u1", PipelineRunID: "run-1"}); err != nil {
		t.Fatalf("duplicate completion: %v", err)
	}
	if len(enq.specs) != 2 {
		t.Fatalf("enqueues = %d, want no duplicate next job", len(enq.specs))
	}
}

func TestOnJobStarted_MarksStepRunning(t *testing.T) {
	ps := newFakePStore()
	enq := &fakeEnqueuer{}
	o := newOrch(ps, enq)
	_, _ = o.StartPipeline(context.Background(), "onboarding", "u1", "u1", "", "")

	run := ps.snap("run-1")
	step0JobID := run.Steps[0].JobID
	// Precondition: the first step is seeded queued even though the run is running.
	if run.Steps[0].Status != job.StatusQueued {
		t.Fatalf("precondition step0 = %s, want queued", run.Steps[0].Status)
	}

	if err := o.OnJobStarted(context.Background(), &job.Job{
		ID: step0JobID, UserID: "u1", PipelineRunID: "run-1",
	}); err != nil {
		t.Fatalf("OnJobStarted: %v", err)
	}

	run = ps.snap("run-1")
	if run.Steps[0].Status != job.StatusRunning {
		t.Fatalf("step0 = %s, want running", run.Steps[0].Status)
	}
	// Marking a step running must not enqueue anything or change the run status.
	if len(enq.specs) != 1 {
		t.Fatalf("enqueues = %d, want 1 (no extra enqueue on start)", len(enq.specs))
	}
	if run.Status != job.StatusRunning {
		t.Fatalf("run status = %s, want running", run.Status)
	}
}

func TestOnJobStarted_MarksNonFirstStepRunning(t *testing.T) {
	ps := newFakePStore()
	enq := &fakeEnqueuer{}
	o := newOrch(ps, enq)
	_, _ = o.StartPipeline(context.Background(), "onboarding", "u1", "u1", "", "")

	// Complete step 0 so the run advances and enqueues step 1 (still queued).
	step0JobID := ps.snap("run-1").Steps[0].JobID
	if err := o.OnJobCompleted(context.Background(), &job.Job{ID: step0JobID, UserID: "u1", PipelineRunID: "run-1"}); err != nil {
		t.Fatalf("complete step0: %v", err)
	}
	run := ps.snap("run-1")
	if run.Steps[1].Status != job.StatusQueued || run.CurrentStep != 1 {
		t.Fatalf("precondition: step1=%s current=%d, want queued/1", run.Steps[1].Status, run.CurrentStep)
	}

	// A worker now claims step 1's job.
	step1JobID := run.Steps[1].JobID
	if err := o.OnJobStarted(context.Background(), &job.Job{ID: step1JobID, UserID: "u1", PipelineRunID: "run-1"}); err != nil {
		t.Fatalf("OnJobStarted step1: %v", err)
	}
	run = ps.snap("run-1")
	if run.Steps[1].Status != job.StatusRunning {
		t.Fatalf("step1 = %s, want running", run.Steps[1].Status)
	}
	// Earlier step stays done; the run stays on step 1.
	if run.Steps[0].Status != job.StatusDone {
		t.Fatalf("step0 = %s, want done", run.Steps[0].Status)
	}
	if run.CurrentStep != 1 {
		t.Fatalf("current step = %d, want 1", run.CurrentStep)
	}
}

func TestOnJobStarted_Idempotent(t *testing.T) {
	ps := newFakePStore()
	enq := &fakeEnqueuer{}
	o := newOrch(ps, enq)
	_, _ = o.StartPipeline(context.Background(), "onboarding", "u1", "u1", "", "")
	jid := ps.snap("run-1").Steps[0].JobID

	msg := &job.Job{ID: jid, UserID: "u1", PipelineRunID: "run-1"}
	if err := o.OnJobStarted(context.Background(), msg); err != nil {
		t.Fatalf("OnJobStarted #1: %v", err)
	}
	if err := o.OnJobStarted(context.Background(), msg); err != nil { // duplicate delivery
		t.Fatalf("OnJobStarted #2: %v", err)
	}
	if run := ps.snap("run-1"); run.Steps[0].Status != job.StatusRunning {
		t.Fatalf("step0 = %s, want running", run.Steps[0].Status)
	}
}

func TestOnJobStarted_DoesNotClobberTerminalStep(t *testing.T) {
	ps := newFakePStore()
	enq := &fakeEnqueuer{}
	o := newOrch(ps, enq)
	_, _ = o.StartPipeline(context.Background(), "onboarding", "u1", "u1", "", "")
	jid := ps.snap("run-1").Steps[0].JobID

	// Step 0 completes first, then a stale/duplicate "started" delivery arrives.
	if err := o.OnJobCompleted(context.Background(), &job.Job{ID: jid, UserID: "u1", PipelineRunID: "run-1"}); err != nil {
		t.Fatalf("complete: %v", err)
	}
	if err := o.OnJobStarted(context.Background(), &job.Job{ID: jid, UserID: "u1", PipelineRunID: "run-1"}); err != nil {
		t.Fatalf("late OnJobStarted: %v", err)
	}
	if run := ps.snap("run-1"); run.Steps[0].Status != job.StatusDone {
		t.Fatalf("step0 = %s, want done (late start must not revert it)", run.Steps[0].Status)
	}
}

type fakeCompletionListener struct {
	runs []*job.PipelineRun
	err  error
}

func (l *fakeCompletionListener) OnPipelineCompleted(_ context.Context, run *job.PipelineRun) error {
	l.runs = append(l.runs, run)
	return l.err
}

func TestOnJobCompleted_LastStepMarksRunDone(t *testing.T) {
	ps := newFakePStore()
	enq := &fakeEnqueuer{}
	o := newOrch(ps, enq)
	_, _ = o.StartPipeline(context.Background(), "onboarding", "u1", "u1", "", "")

	// Walk all three steps to completion.
	for step := 0; step < 3; step++ {
		run := ps.snap("run-1")
		jid := run.Steps[step].JobID
		if err := o.OnJobCompleted(context.Background(), &job.Job{
			ID: jid, UserID: "u1", PipelineRunID: "run-1",
		}); err != nil {
			t.Fatalf("complete step %d: %v", step, err)
		}
	}

	run := ps.snap("run-1")
	if run.Status != job.StatusDone {
		t.Fatalf("run status = %s, want done", run.Status)
	}
	if run.CompletedAt == nil {
		t.Fatal("run completed_at not set")
	}
	// 3 enqueues total (one per step), no extra.
	if len(enq.specs) != 3 {
		t.Fatalf("enqueues = %d, want 3", len(enq.specs))
	}
}

func TestOnJobCompleted_ConcurrentFinalCallbacksClaimListenerOnce(t *testing.T) {
	ps := newFakePStore()
	enq := &fakeEnqueuer{}
	listener := &fakeCompletionListener{}
	o := New(ps, enq, onboardingRegistry(), WithClock(fixedNow()), WithRunIDFunc(func() string { return "run-1" }), WithCompletionListener(listener))
	if _, err := o.StartPipeline(context.Background(), "onboarding", "u1", "u1", "", ""); err != nil {
		t.Fatalf("start: %v", err)
	}
	for step := 0; step < 2; step++ {
		run := ps.snap("run-1")
		if err := o.OnJobCompleted(context.Background(), &job.Job{ID: run.Steps[step].JobID, UserID: "u1", PipelineRunID: run.RunID}); err != nil {
			t.Fatalf("complete step %d: %v", step, err)
		}
	}
	last := ps.snap("run-1").Steps[2].JobID
	msg := &job.Job{ID: last, UserID: "u1", PipelineRunID: "run-1"}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- o.OnJobCompleted(context.Background(), msg)
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("final completion: %v", err)
		}
	}
	if len(listener.runs) != 1 || !ps.snap("run-1").CompletionApplied {
		t.Fatalf("listener calls=%d completion_applied=%v, want 1/true", len(listener.runs), ps.snap("run-1").CompletionApplied)
	}
}

func TestOnJobCompleted_FinalStepNotifiesListenerOnce(t *testing.T) {
	ps := newFakePStore()
	enq := &fakeEnqueuer{}
	listener := &fakeCompletionListener{}
	o := New(ps, enq, onboardingRegistry(),
		WithClock(fixedNow()),
		WithRunIDFunc(func() string { return "run-1" }),
		WithCompletionListener(listener),
	)
	if _, err := o.StartPipeline(context.Background(), "onboarding", "u1", "u1", "", ""); err != nil {
		t.Fatalf("start: %v", err)
	}
	for step := 0; step < 3; step++ {
		run := ps.snap("run-1")
		if err := o.OnJobCompleted(context.Background(), &job.Job{ID: run.Steps[step].JobID, UserID: "u1", PipelineRunID: run.RunID}); err != nil {
			t.Fatalf("complete step %d: %v", step, err)
		}
	}
	if len(listener.runs) != 1 || listener.runs[0].RunID != "run-1" || listener.runs[0].Status != job.StatusDone {
		t.Fatalf("listener runs = %+v, want one completed run", listener.runs)
	}
	last := ps.snap("run-1").Steps[2].JobID
	if err := o.OnJobCompleted(context.Background(), &job.Job{ID: last, UserID: "u1", PipelineRunID: "run-1"}); err != nil {
		t.Fatalf("duplicate completion: %v", err)
	}
	if len(listener.runs) != 1 {
		t.Fatalf("listener calls = %d, want one", len(listener.runs))
	}
}

func TestOnJobCompleted_RetriesCompletionListenerAfterFailure(t *testing.T) {
	ps := newFakePStore()
	enq := &fakeEnqueuer{}
	listener := &fakeCompletionListener{err: errors.New("onboarding store unavailable")}
	o := New(ps, enq, onboardingRegistry(), WithClock(fixedNow()), WithRunIDFunc(func() string { return "run-1" }), WithCompletionListener(listener))
	if _, err := o.StartPipeline(context.Background(), "onboarding", "u1", "u1", "", ""); err != nil {
		t.Fatalf("start: %v", err)
	}
	for step := 0; step < 2; step++ {
		run := ps.snap("run-1")
		if err := o.OnJobCompleted(context.Background(), &job.Job{ID: run.Steps[step].JobID, UserID: "u1", PipelineRunID: run.RunID}); err != nil {
			t.Fatalf("complete step %d: %v", step, err)
		}
	}
	last := ps.snap("run-1").Steps[2].JobID
	if err := o.OnJobCompleted(context.Background(), &job.Job{ID: last, UserID: "u1", PipelineRunID: "run-1"}); err == nil {
		t.Fatal("want listener failure")
	}
	if run := ps.snap("run-1"); run.Status != job.StatusDone || run.CompletionApplied {
		t.Fatalf("terminal run must remain pending listener application: %+v", run)
	}
	listener.err = nil
	if err := o.OnJobCompleted(context.Background(), &job.Job{ID: last, UserID: "u1", PipelineRunID: "run-1"}); err != nil {
		t.Fatalf("listener retry: %v", err)
	}
	if len(listener.runs) != 2 || !ps.snap("run-1").CompletionApplied {
		t.Fatalf("listener calls=%d completion_applied=%v, want 2/true", len(listener.runs), ps.snap("run-1").CompletionApplied)
	}
}

func TestOnJobCompleted_Idempotent(t *testing.T) {
	ps := newFakePStore()
	enq := &fakeEnqueuer{}
	o := newOrch(ps, enq)
	_, _ = o.StartPipeline(context.Background(), "onboarding", "u1", "u1", "", "")
	run := ps.snap("run-1")
	jid := run.Steps[0].JobID

	msg := &job.Job{ID: jid, UserID: "u1", PipelineRunID: "run-1"}
	_ = o.OnJobCompleted(context.Background(), msg)
	_ = o.OnJobCompleted(context.Background(), msg) // duplicate delivery

	// Step 1 must be enqueued exactly once despite the double fire.
	if enq.count() != 2 {
		t.Fatalf("enqueues = %d, want 2 (no double-enqueue)", enq.count())
	}
}

func TestOnJobCompleted_ConcurrentCallbacksReserveOneNextStep(t *testing.T) {
	ps := newFakePStore()
	enq := &fakeEnqueuer{}
	o := newOrch(ps, enq)
	if _, err := o.StartPipeline(context.Background(), "onboarding", "u1", "u1", "", ""); err != nil {
		t.Fatalf("start: %v", err)
	}
	jid := ps.snap("run-1").Steps[0].JobID
	msg := &job.Job{ID: jid, UserID: "u1", PipelineRunID: "run-1"}

	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- o.OnJobCompleted(context.Background(), msg)
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent completion: %v", err)
		}
	}
	if enq.count() != 2 { // first job + precisely one second-step job
		t.Fatalf("enqueues = %d, want 2", enq.count())
	}
	run := ps.snap("run-1")
	if run.Steps[0].Status != job.StatusDone || run.Steps[1].JobID == "" || run.CurrentStep != 1 {
		t.Fatalf("run transition not durably reserved: %+v", run)
	}
}

func TestOnJobFailed_MarksRunFailed(t *testing.T) {
	ps := newFakePStore()
	enq := &fakeEnqueuer{}
	o := newOrch(ps, enq)
	_, _ = o.StartPipeline(context.Background(), "onboarding", "u1", "u1", "", "")
	run := ps.snap("run-1")
	jid := run.Steps[0].JobID

	err := o.OnJobFailed(context.Background(), &job.Job{
		ID: jid, UserID: "u1", PipelineRunID: "run-1", ErrorMessage: "sync exploded",
	})
	if err != nil {
		t.Fatalf("OnJobFailed: %v", err)
	}
	run = ps.snap("run-1")
	if run.Status != job.StatusFailed {
		t.Fatalf("run status = %s, want failed", run.Status)
	}
	if run.Steps[0].Status != job.StatusFailed {
		t.Fatalf("step0 = %s, want failed", run.Steps[0].Status)
	}
	if run.ErrorMessage != "sync exploded" {
		t.Fatalf("error = %q", run.ErrorMessage)
	}
	if len(enq.specs) != 1 {
		t.Fatal("failed run must not enqueue further steps")
	}
}

func TestOnJobFailed_OptionalStepContinuesWithOriginalInput(t *testing.T) {
	ps := newFakePStore()
	enq := &fakeEnqueuer{}
	reg := NewRegistry()
	reg.MustRegister(Def{Name: "sync", Steps: []StepDef{
		{Name: "watch", JobType: "watch"},
		{Name: "race", JobType: "race_detection", ContinueOnFailure: true},
		{Name: "compute", JobType: "compute"},
	}})
	o := New(ps, enq, reg, WithClock(fixedNow()), WithRunIDFunc(func() string { return "run-1" }))
	if _, err := o.StartPipeline(context.Background(), "sync", "u1", "u1", "", `{"mode":"incremental"}`); err != nil {
		t.Fatalf("start: %v", err)
	}
	watch := ps.snap("run-1").Steps[0].JobID
	if err := o.OnJobCompleted(context.Background(), &job.Job{
		ID: watch, PipelineRunID: "run-1", ResultJSON: `{"label_ids":["a1"]}`,
	}); err != nil {
		t.Fatalf("complete watch: %v", err)
	}
	raceInput := enq.specs[1].InputJSON
	raceID := ps.snap("run-1").Steps[1].JobID
	if err := o.OnJobFailed(context.Background(), &job.Job{
		ID: raceID, PipelineRunID: "run-1", InputJSON: raceInput, ErrorMessage: "one classification failed",
	}); err != nil {
		t.Fatalf("optional failure: %v", err)
	}
	run := ps.snap("run-1")
	if run.Status != job.StatusRunning || run.Steps[1].Status != job.StatusFailed || run.CurrentStep != 2 {
		t.Fatalf("run = %+v", run)
	}
	if got := enq.specs[2].InputJSON; got != raceInput {
		t.Fatalf("compute input = %s, want %s", got, raceInput)
	}
	if err := o.OnJobFailed(context.Background(), &job.Job{
		ID: raceID, PipelineRunID: "run-1", InputJSON: raceInput, ErrorMessage: "duplicate",
	}); err != nil {
		t.Fatalf("duplicate optional failure: %v", err)
	}
	if len(enq.specs) != 3 {
		t.Fatalf("duplicate optional failure enqueued %d specs, want 3", len(enq.specs))
	}
	computeID := ps.snap("run-1").Steps[2].JobID
	if err := o.OnJobCompleted(context.Background(), &job.Job{ID: computeID, PipelineRunID: "run-1"}); err != nil {
		t.Fatalf("complete compute: %v", err)
	}
	run = ps.snap("run-1")
	if run.Status != job.StatusDone || run.Steps[1].Status != job.StatusFailed {
		t.Fatalf("final run = %+v", run)
	}
}

func TestLifecycle_StandaloneJobIsNoop(t *testing.T) {
	ps := newFakePStore()
	enq := &fakeEnqueuer{}
	o := newOrch(ps, enq)

	// No PipelineRunID -> not part of any pipeline.
	if err := o.OnJobStarted(context.Background(), &job.Job{ID: "x", UserID: "u1"}); err != nil {
		t.Fatalf("standalone started: %v", err)
	}
	if err := o.OnJobCompleted(context.Background(), &job.Job{ID: "x", UserID: "u1"}); err != nil {
		t.Fatalf("standalone completed: %v", err)
	}
	if err := o.OnJobFailed(context.Background(), &job.Job{ID: "x", UserID: "u1"}); err != nil {
		t.Fatalf("standalone failed: %v", err)
	}
	if len(enq.specs) != 0 || len(ps.rows) != 0 {
		t.Fatal("standalone job must not touch pipelines")
	}
}

// Orchestrator must satisfy job.Lifecycle.
var _ job.Lifecycle = (*Orchestrator)(nil)

// TestInputThreading verifies the run-level input reaches step 0, and that a
// completed step's ResultJSON is merged into the next step's InputJSON (so a
// downstream step consumes what the previous one produced).
func TestInputThreading(t *testing.T) {
	ps := newFakePStore()
	enq := &fakeEnqueuer{}
	o := newOrch(ps, enq)

	if _, err := o.StartPipeline(context.Background(), "onboarding", "u1", "u1", "", `{"mode":"incremental"}`); err != nil {
		t.Fatalf("start: %v", err)
	}
	// Step 0 receives just the run input.
	if got := enq.specs[0].InputJSON; got != `{"mode":"incremental"}` {
		t.Fatalf("step0 input = %q, want run input", got)
	}

	// Complete step 0 with a result carrying label_ids; step 1 must see both the
	// run's mode and the upstream label_ids.
	done := &job.Job{ID: enq.specs[0].ID, UserID: "u1", PipelineRunID: "run-1", ResultJSON: `{"label_ids":["a","b"],"activities":2}`}
	if err := o.OnJobCompleted(context.Background(), done); err != nil {
		t.Fatalf("advance: %v", err)
	}
	if len(enq.specs) != 2 {
		t.Fatalf("enqueued %d specs, want 2", len(enq.specs))
	}
	var merged map[string]any
	if err := json.Unmarshal([]byte(enq.specs[1].InputJSON), &merged); err != nil {
		t.Fatalf("step1 input not JSON object: %q", enq.specs[1].InputJSON)
	}
	if merged["mode"] != "incremental" {
		t.Fatalf("step1 input missing run mode: %v", merged)
	}
	if _, ok := merged["label_ids"]; !ok {
		t.Fatalf("step1 input missing upstream label_ids: %v", merged)
	}
}
