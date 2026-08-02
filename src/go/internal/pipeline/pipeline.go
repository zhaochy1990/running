// Package pipeline advances linear, named pipelines of jobs. The Orchestrator
// implements job.Lifecycle: the dispatcher calls it when a job reaches a
// terminal state, and it enqueues the next step or finalizes the run. All
// callbacks are idempotent so at-least-once delivery is safe.
package pipeline

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/logging"
)

// StepDef is one step of a pipeline definition.
type StepDef struct {
	Name    string
	JobType string
}

// Def is a named linear pipeline.
type Def struct {
	Name  string
	Steps []StepDef
}

// Registry holds pipeline definitions, keyed by name.
type Registry struct {
	defs map[string]Def
}

// NewRegistry returns an empty Registry.
func NewRegistry() *Registry { return &Registry{defs: map[string]Def{}} }

// MustRegister adds a definition, panicking on a duplicate or empty name.
func (r *Registry) MustRegister(d Def) {
	if d.Name == "" {
		panic("pipeline: empty name")
	}
	if len(d.Steps) == 0 {
		panic("pipeline: definition has no steps")
	}
	if _, ok := r.defs[d.Name]; ok {
		panic("pipeline: duplicate definition " + d.Name)
	}
	r.defs[d.Name] = d
}

// Get looks up a definition.
func (r *Registry) Get(name string) (Def, bool) {
	d, ok := r.defs[name]
	return d, ok
}

// Orchestrator drives pipeline runs.
type Orchestrator struct {
	store  job.PipelineStore
	enq    job.Enqueuer
	reg    *Registry
	now    func() time.Time
	newRun func() string
	log    *zap.Logger
}

// Option configures an Orchestrator.
type Option func(*Orchestrator)

// WithClock overrides the time source (tests).
func WithClock(now func() time.Time) Option { return func(o *Orchestrator) { o.now = now } }

// WithRunIDFunc overrides run-ID generation (tests).
func WithRunIDFunc(f func() string) Option { return func(o *Orchestrator) { o.newRun = f } }

// WithLogger sets the structured logger.
func WithLogger(l *zap.Logger) Option { return func(o *Orchestrator) { o.log = l } }

// New wires an Orchestrator. Defaults: UTC clock, UUIDv4 run ids.
func New(store job.PipelineStore, enq job.Enqueuer, reg *Registry, opts ...Option) *Orchestrator {
	o := &Orchestrator{
		store:  store,
		enq:    enq,
		reg:    reg,
		now:    func() time.Time { return time.Now().UTC() },
		newRun: func() string { return uuid.NewString() },
		log:    logging.Default(),
	}
	for _, opt := range opts {
		opt(o)
	}
	return o
}

// StartPipeline creates a run (store-first) and enqueues its first step. A
// non-empty idempotencyKey deduplicates starts: Create returns job.ErrConflict
// if a run with the same (userID, idempotencyKey) already exists. userID is the
// athlete whose data the run operates on (the subject) — it flows down to every
// step job and is what auth and per-user listing key on; empty means a system
// run (NULL). createdBy records who triggered the run (the JWT sub, or empty for
// an internal caller) and is provenance only.
func (o *Orchestrator) StartPipeline(ctx context.Context, name, userID, createdBy, idempotencyKey string) (string, error) {
	def, ok := o.reg.Get(name)
	if !ok {
		return "", fmt.Errorf("pipeline: unknown definition %q", name)
	}
	now := o.now()
	steps := make([]job.PipelineStep, len(def.Steps))
	for i, s := range def.Steps {
		steps[i] = job.PipelineStep{Name: s.Name, JobType: s.JobType, Status: job.StatusQueued}
	}
	run := &job.PipelineRun{
		RunID:          o.newRun(),
		UserID:         userID,
		CreatedBy:      createdBy,
		Name:           name,
		Status:         job.StatusRunning,
		CurrentStep:    0,
		Steps:          steps,
		IdempotencyKey: idempotencyKey,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := o.store.Create(ctx, run); err != nil {
		return "", err
	}
	jobID, err := o.enq.Enqueue(ctx, job.EnqueueSpec{
		Type:          def.Steps[0].JobType,
		UserID:        userID,
		PipelineRunID: run.RunID,
	})
	if err != nil {
		return run.RunID, err
	}
	run.Steps[0].JobID = jobID
	run.UpdatedAt = o.now()
	if err := o.store.Update(ctx, run); err != nil {
		return run.RunID, err
	}
	o.log.Info("pipeline started", zap.String("name", name), zap.String("run_id", run.RunID), zap.String("user_id", userID))
	return run.RunID, nil
}

// OnJobCompleted advances the run that owns j, or finalizes it if j was the last
// step. Safe to call more than once for the same job (idempotent).
func (o *Orchestrator) OnJobCompleted(ctx context.Context, j *job.Job) error {
	if j.PipelineRunID == "" {
		return nil
	}
	run, err := o.store.Get(ctx, j.PipelineRunID)
	if err != nil {
		if job.IsNotFound(err) {
			o.log.Warn("pipeline run missing for completed job", zap.String("run_id", j.PipelineRunID), zap.String("job_id", j.ID))
			return nil
		}
		return err
	}
	i := stepIndexByJobID(run, j.ID)
	if i < 0 {
		o.log.Warn("completed job not found in run steps", zap.String("run_id", run.RunID), zap.String("job_id", j.ID))
		return nil
	}
	if run.Steps[i].Status == job.StatusDone {
		return nil // duplicate delivery: already advanced
	}
	run.Steps[i].Status = job.StatusDone

	if i == len(run.Steps)-1 {
		now := o.now()
		run.Status = job.StatusDone
		run.CurrentStep = i
		run.CompletedAt = &now
		run.UpdatedAt = now
		if err := o.store.Update(ctx, run); err != nil {
			return err
		}
		o.log.Info("pipeline done", zap.String("name", run.Name), zap.String("run_id", run.RunID))
		return nil
	}

	next := i + 1
	jobID, err := o.enq.Enqueue(ctx, job.EnqueueSpec{
		Type:          run.Steps[next].JobType,
		UserID:        run.UserID,
		PipelineRunID: run.RunID,
	})
	if err != nil {
		// Persist the completed step so a retry of this callback resumes from
		// the next step rather than re-running the finished one.
		run.UpdatedAt = o.now()
		_ = o.store.Update(ctx, run)
		return err
	}
	run.Steps[next].JobID = jobID
	run.CurrentStep = next
	run.UpdatedAt = o.now()
	if err := o.store.Update(ctx, run); err != nil {
		return err
	}
	o.log.Info("pipeline advanced", zap.String("run_id", run.RunID), zap.String("step", run.Steps[next].Name))
	return nil
}

// OnJobFailed marks the owning run failed. Idempotent.
func (o *Orchestrator) OnJobFailed(ctx context.Context, j *job.Job) error {
	if j.PipelineRunID == "" {
		return nil
	}
	run, err := o.store.Get(ctx, j.PipelineRunID)
	if err != nil {
		if job.IsNotFound(err) {
			return nil
		}
		return err
	}
	if run.Status == job.StatusFailed {
		return nil
	}
	if i := stepIndexByJobID(run, j.ID); i >= 0 {
		run.Steps[i].Status = job.StatusFailed
	}
	now := o.now()
	run.Status = job.StatusFailed
	run.ErrorMessage = j.ErrorMessage
	run.CompletedAt = &now
	run.UpdatedAt = now
	if err := o.store.Update(ctx, run); err != nil {
		return err
	}
	o.log.Error("pipeline failed", zap.String("run_id", run.RunID), zap.String("job_id", j.ID), zap.String("err", j.ErrorMessage))
	return nil
}

func stepIndexByJobID(run *job.PipelineRun, jobID string) int {
	for i := range run.Steps {
		if run.Steps[i].JobID == jobID {
			return i
		}
	}
	return -1
}
