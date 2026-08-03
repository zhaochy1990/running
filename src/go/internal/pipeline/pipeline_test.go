package pipeline

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/job"
)

// --- fakes ---------------------------------------------------------------

type fakeEnqueuer struct {
	specs []job.EnqueueSpec
}

func (e *fakeEnqueuer) Enqueue(_ context.Context, spec job.EnqueueSpec) (string, error) {
	e.specs = append(e.specs, spec)
	return jobIDFor(len(e.specs)), nil
}

func jobIDFor(n int) string {
	return "job-" + string(rune('0'+n))
}

type fakePStore struct {
	rows map[string]*job.PipelineRun
}

func newFakePStore() *fakePStore { return &fakePStore{rows: map[string]*job.PipelineRun{}} }

func (s *fakePStore) Create(_ context.Context, r *job.PipelineRun) error {
	cp := *r
	cp.Steps = append([]job.PipelineStep(nil), r.Steps...)
	s.rows[r.RunID] = &cp
	return nil
}
func (s *fakePStore) Get(_ context.Context, id string) (*job.PipelineRun, error) {
	r, ok := s.rows[id]
	if !ok {
		return nil, &job.ErrNotFound{Key: id}
	}
	cp := *r
	cp.Steps = append([]job.PipelineStep(nil), r.Steps...)
	return &cp, nil
}
func (s *fakePStore) Update(_ context.Context, r *job.PipelineRun) error {
	cp := *r
	cp.Steps = append([]job.PipelineStep(nil), r.Steps...)
	s.rows[r.RunID] = &cp
	return nil
}
func (s *fakePStore) snap(id string) *job.PipelineRun { return s.rows[id] }

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
	if len(enq.specs) != 2 {
		t.Fatalf("enqueues = %d, want 2 (no double-enqueue)", len(enq.specs))
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
	done := &job.Job{ID: enq.specs[0].PipelineRunID, UserID: "u1", PipelineRunID: "run-1", ResultJSON: `{"label_ids":["a","b"],"activities":2}`}
	done.ID = jobIDFor(1) // step 0's job id
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
