// Package pipeline advances linear, named pipelines of jobs. The Orchestrator
// implements job.Lifecycle: the dispatcher calls it when a job reaches a
// terminal state, and it enqueues the next step or finalizes the run. All
// callbacks are idempotent so at-least-once delivery is safe.
package pipeline

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/logging"
)

// StepDef is one step of a pipeline definition.
type StepDef struct {
	Name              string
	JobType           string
	ContinueOnFailure bool
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

// CompletionListener receives a pipeline only after its final step has been
// durably marked done. Implementations must guard their own side effects against
// duplicate delivery.
type CompletionListener interface {
	OnPipelineCompleted(ctx context.Context, run *job.PipelineRun) error
}

// Orchestrator drives pipeline runs.
type Orchestrator struct {
	store      job.PipelineStore
	enq        job.Enqueuer
	reg        *Registry
	completion CompletionListener
	now        func() time.Time
	newRun     func() string
	newJob     func() string
	log        *zap.Logger
}

// Option configures an Orchestrator.
type Option func(*Orchestrator)

// WithClock overrides the time source (tests).
func WithClock(now func() time.Time) Option { return func(o *Orchestrator) { o.now = now } }

// WithRunIDFunc overrides run-ID generation (tests).
func WithRunIDFunc(f func() string) Option { return func(o *Orchestrator) { o.newRun = f } }

// WithLogger sets the structured logger.
func WithLogger(l *zap.Logger) Option { return func(o *Orchestrator) { o.log = l } }

// WithCompletionListener observes durable pipeline completion.
func WithCompletionListener(l CompletionListener) Option {
	return func(o *Orchestrator) { o.completion = l }
}

// New wires an Orchestrator. Defaults: UTC clock, UUIDv4 run ids.
func New(store job.PipelineStore, enq job.Enqueuer, reg *Registry, opts ...Option) *Orchestrator {
	o := &Orchestrator{
		store:  store,
		enq:    enq,
		reg:    reg,
		now:    func() time.Time { return time.Now().UTC() },
		newRun: func() string { return uuid.NewString() },
		newJob: func() string { return uuid.NewString() },
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
// an internal caller) and is provenance only. inputJSON is the run-level input
// threaded into every step's job InputJSON (see mergeStepInput); pass "" for a
// pipeline that takes none.
func (o *Orchestrator) StartPipeline(ctx context.Context, name, userID, createdBy, idempotencyKey, inputJSON string) (string, error) {
	return o.startPipeline(ctx, o.newRun(), name, userID, createdBy, idempotencyKey, inputJSON)
}

// StartPipelineWithID creates a run with a caller-provided ID. It is used by the
// onboarding entrypoint to atomically claim the user-onboarding association before
// enqueueing work, preventing concurrent browser requests from creating two runs.
func (o *Orchestrator) StartPipelineWithID(ctx context.Context, runID, name, userID, createdBy, idempotencyKey, inputJSON string) (string, error) {
	return o.startPipeline(ctx, runID, name, userID, createdBy, idempotencyKey, inputJSON)
}

func (o *Orchestrator) startPipeline(ctx context.Context, runID, name, userID, createdBy, idempotencyKey, inputJSON string) (string, error) {
	def, ok := o.reg.Get(name)
	if !ok {
		return "", fmt.Errorf("pipeline: unknown definition %q", name)
	}
	now := o.now()
	steps := make([]job.PipelineStep, len(def.Steps))
	for i, s := range def.Steps {
		steps[i] = job.PipelineStep{
			Name:              s.Name,
			JobType:           s.JobType,
			Status:            job.StatusQueued,
			ContinueOnFailure: s.ContinueOnFailure,
		}
	}
	// Persist the first job ID before publishing its pointer. A worker can never
	// observe a first-step job that the run does not yet link to.
	steps[0].JobID = o.newJob()
	run := &job.PipelineRun{
		RunID:          runID,
		UserID:         userID,
		CreatedBy:      createdBy,
		Name:           name,
		InputJSON:      inputJSON,
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
	_, err := o.enq.Enqueue(ctx, job.EnqueueSpec{
		ID:            run.Steps[0].JobID,
		Type:          def.Steps[0].JobType,
		UserID:        userID,
		PipelineRunID: run.RunID,
		// First step has no upstream result; it receives just the run input.
		InputJSON: mergeStepInput(run.InputJSON, ""),
	})
	if err != nil {
		// The run reserved this ID before the enqueue attempt. Do not rely on an
		// enqueuer returning it alongside a publication error: the durable step
		// job may already be terminal even when the broker boundary returns "".
		failed := &job.Job{ID: run.Steps[0].JobID, PipelineRunID: run.RunID, ErrorMessage: "work publication failed"}
		if failErr := o.OnJobFailed(ctx, failed); failErr != nil {
			return run.RunID, failErr
		}
		return run.RunID, err
	}
	o.log.Info("pipeline started", zap.String("name", name), zap.String("run_id", run.RunID), zap.String("user_id", userID))
	return run.RunID, nil
}

// OnJobStarted marks the owning run's step as running when a worker claims j and
// begins executing it. Without this hook a step stays queued until it completes,
// so GET /pipelines/{run_id} would report the run as running while its active
// step still showed queued. Idempotent: it only advances a step from queued to
// running, so duplicate deliveries and retries are no-ops and it never clobbers
// a step that has already reached a terminal state.
func (o *Orchestrator) OnJobStarted(ctx context.Context, j *job.Job) error {
	if j.PipelineRunID == "" {
		return nil
	}
	run, err := o.store.Get(ctx, j.PipelineRunID)
	if err != nil {
		if job.IsNotFound(err) {
			o.log.Warn("pipeline run missing for started job", zap.String("run_id", j.PipelineRunID), zap.String("job_id", j.ID))
			return nil
		}
		return err
	}
	i := stepIndexByJobID(run, j.ID)
	if i < 0 {
		o.log.Warn("started job not found in run steps", zap.String("run_id", run.RunID), zap.String("job_id", j.ID))
		return nil
	}
	if run.Steps[i].Status != job.StatusQueued {
		return nil // already running or terminal: nothing to do
	}
	// Only the step status changes here. CurrentStep is already set to the active
	// index by StartPipeline / OnJobCompleted before the job can be claimed, so we
	// deliberately leave it untouched — that keeps a stale duplicate "started"
	// delivery from rewinding it. Mutate supplies cross-process serialization.
	changed, err := o.store.Mutate(ctx, j.PipelineRunID, func(run *job.PipelineRun) (bool, error) {
		i := stepIndexByJobID(run, j.ID)
		if i < 0 || run.Steps[i].Status != job.StatusQueued {
			return false, nil
		}
		run.Steps[i].Status = job.StatusRunning
		run.UpdatedAt = o.now()
		return true, nil
	})
	if err != nil {
		if job.IsNotFound(err) {
			return nil
		}
		return err
	}
	if changed {
		o.log.Info("pipeline step running", zap.String("run_id", j.PipelineRunID), zap.String("job_id", j.ID))
	}
	return nil
}

const completionClaimTTL = 5 * time.Minute

// OnJobCompleted advances the run that owns j, or finalizes it if j was the last
// step. Every state transition is locked and persisted by PipelineStore.Mutate,
// so duplicate deliveries across worker processes cannot reserve two next jobs.
func (o *Orchestrator) OnJobCompleted(ctx context.Context, j *job.Job) error {
	if j.PipelineRunID == "" {
		return nil
	}

	var nextSpec *job.EnqueueSpec
	var completionRun *job.PipelineRun
	var completionClaim string
	now := o.now()
	_, err := o.store.Mutate(ctx, j.PipelineRunID, func(run *job.PipelineRun) (bool, error) {
		i := stepIndexByJobID(run, j.ID)
		if i < 0 {
			o.log.Warn("completed job not found in run steps", zap.String("run_id", run.RunID), zap.String("job_id", j.ID))
			return false, nil
		}
		// A failure wins over a late completion; a terminal run cannot be reopened.
		if run.Status == job.StatusFailed {
			return false, nil
		}
		if i == len(run.Steps)-1 {
			changed := false
			if run.Status != job.StatusDone {
				run.Steps[i].Status = job.StatusDone
				run.Status = job.StatusDone
				run.CurrentStep = i
				run.CompletedAt = &now
				run.UpdatedAt = now
				changed = true
			}
			if o.completion == nil || run.CompletionApplied {
				return changed, nil
			}
			if run.CompletionClaimID != "" && run.CompletionClaimedAt != nil && now.Sub(*run.CompletionClaimedAt) < completionClaimTTL {
				return changed, nil
			}
			completionClaim = o.newJob()
			run.CompletionClaimID = completionClaim
			run.CompletionClaimedAt = &now
			run.UpdatedAt = now
			completionRun = cloneRun(run)
			return true, nil
		}

		next := i + 1
		if run.Steps[i].Status == job.StatusDone || run.Steps[next].JobID != "" {
			return false, nil
		}
		// Reserve and durably link the next ID before its broker pointer exists.
		run.Steps[i].Status = job.StatusDone
		run.Steps[next].JobID = o.newJob()
		run.CurrentStep = next
		run.UpdatedAt = now
		nextSpec = &job.EnqueueSpec{
			ID:            run.Steps[next].JobID,
			Type:          run.Steps[next].JobType,
			UserID:        run.UserID,
			PipelineRunID: run.RunID,
			InputJSON:     mergeStepInput(run.InputJSON, j.ResultJSON),
		}
		return true, nil
	})
	if err != nil {
		if job.IsNotFound(err) {
			o.log.Warn("pipeline run missing for completed job", zap.String("run_id", j.PipelineRunID), zap.String("job_id", j.ID))
			return nil
		}
		return err
	}

	if nextSpec != nil {
		_, err := o.enq.Enqueue(ctx, *nextSpec)
		if err != nil {
			// nextSpec.ID was durably reserved and linked while advancing the
			// pipeline, so it remains authoritative on every enqueue failure.
			failed := &job.Job{ID: nextSpec.ID, PipelineRunID: j.PipelineRunID, ErrorMessage: "work publication failed"}
			if failErr := o.OnJobFailed(ctx, failed); failErr != nil {
				return failErr
			}
			return err
		}
		o.log.Info("pipeline advanced", zap.String("run_id", j.PipelineRunID), zap.String("step", nextSpec.Type))
	}
	if completionRun == nil {
		return nil
	}
	if err := o.completion.OnPipelineCompleted(ctx, completionRun); err != nil {
		_, clearErr := o.store.Mutate(ctx, j.PipelineRunID, func(run *job.PipelineRun) (bool, error) {
			if run.CompletionApplied || run.CompletionClaimID != completionClaim {
				return false, nil
			}
			run.CompletionClaimID = ""
			run.CompletionClaimedAt = nil
			run.UpdatedAt = o.now()
			return true, nil
		})
		if clearErr != nil {
			return clearErr
		}
		o.log.Error("pipeline completion listener failed", zap.String("run_id", j.PipelineRunID), zap.Error(err))
		return err
	}
	_, err = o.store.Mutate(ctx, j.PipelineRunID, func(run *job.PipelineRun) (bool, error) {
		if run.CompletionApplied || run.CompletionClaimID != completionClaim {
			return false, nil
		}
		run.CompletionApplied = true
		run.CompletionClaimID = ""
		run.CompletionClaimedAt = nil
		run.UpdatedAt = o.now()
		return true, nil
	})
	return err
}

// OnJobFailed marks the owning run failed. Idempotent.
func (o *Orchestrator) OnJobFailed(ctx context.Context, j *job.Job) error {
	if j.PipelineRunID == "" {
		return nil
	}
	now := o.now()
	var nextSpec *job.EnqueueSpec
	changed, err := o.store.Mutate(ctx, j.PipelineRunID, func(run *job.PipelineRun) (bool, error) {
		if run.Status.Terminal() {
			return false, nil
		}
		i := stepIndexByJobID(run, j.ID)
		if i < 0 {
			return false, nil
		}
		run.Steps[i].Status = job.StatusFailed
		if run.Steps[i].ContinueOnFailure && i < len(run.Steps)-1 {
			next := i + 1
			if run.Steps[next].JobID != "" {
				return false, nil
			}
			run.Steps[next].JobID = o.newJob()
			run.CurrentStep = next
			run.UpdatedAt = now
			nextSpec = &job.EnqueueSpec{
				ID:            run.Steps[next].JobID,
				Type:          run.Steps[next].JobType,
				UserID:        run.UserID,
				PipelineRunID: run.RunID,
				InputJSON:     mergeStepInput(run.InputJSON, j.InputJSON),
			}
			return true, nil
		}
		run.Status = job.StatusFailed
		run.ErrorMessage = j.ErrorMessage
		run.CompletedAt = &now
		run.UpdatedAt = now
		return true, nil
	})
	if err != nil {
		if job.IsNotFound(err) {
			return nil
		}
		return err
	}
	if changed {
		if nextSpec == nil {
			o.log.Error("pipeline failed", zap.String("run_id", j.PipelineRunID), zap.String("job_id", j.ID), zap.String("err", j.ErrorMessage))
		}
	}
	if nextSpec != nil {
		if _, err := o.enq.Enqueue(ctx, *nextSpec); err != nil {
			failed := &job.Job{ID: nextSpec.ID, PipelineRunID: j.PipelineRunID, ErrorMessage: "work publication failed"}
			if failErr := o.OnJobFailed(ctx, failed); failErr != nil {
				return failErr
			}
			return err
		}
		o.log.Warn("optional pipeline step failed; continuing",
			zap.String("run_id", j.PipelineRunID),
			zap.String("job_id", j.ID),
			zap.String("next_step", nextSpec.Type),
			zap.String("err", j.ErrorMessage),
		)
	}
	return nil
}

func cloneRun(run *job.PipelineRun) *job.PipelineRun {
	cp := *run
	cp.Steps = append([]job.PipelineStep(nil), run.Steps...)
	return &cp
}

func stepIndexByJobID(run *job.PipelineRun, jobID string) int {
	for i := range run.Steps {
		if run.Steps[i].JobID == jobID {
			return i
		}
	}
	return -1
}

// mergeStepInput builds a step's job InputJSON by shallow-merging the run-level
// input over the previous step's ResultJSON. The previous result supplies what a
// downstream step consumes (e.g. label_ids from watch_sync); the run input
// (e.g. {"mode":"incremental"}) wins on any key conflict so it stays
// authoritative. Non-object or empty inputs are tolerated; the result is "" when
// there is nothing to pass.
func mergeStepInput(runInput, prevResult string) string {
	merged := map[string]any{}
	if strings.TrimSpace(prevResult) != "" {
		var prev map[string]any
		if json.Unmarshal([]byte(prevResult), &prev) == nil {
			for k, v := range prev {
				merged[k] = v
			}
		}
	}
	if strings.TrimSpace(runInput) != "" {
		var run map[string]any
		if json.Unmarshal([]byte(runInput), &run) == nil {
			for k, v := range run {
				merged[k] = v // run input wins on conflict
			}
		}
	}
	if len(merged) == 0 {
		return ""
	}
	b, err := json.Marshal(merged)
	if err != nil {
		return ""
	}
	return string(b)
}
