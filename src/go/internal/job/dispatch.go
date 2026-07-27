package job

import (
	"context"
	"log/slog"
	"time"
)

// RetryPolicy governs bounded retry + backoff before poisoning.
type RetryPolicy struct {
	MaxAttempts int
	BaseBackoff time.Duration
	MaxBackoff  time.Duration
}

// Dispatcher processes one pointer Message end to end: load the job, run its
// handler, and drive the terminal/retry/poison transition. It owns no transport
// loop — a Consumer feeds it Messages and acks after Dispatch returns nil.
type Dispatcher struct {
	store     Store
	registry  *Registry
	publisher Publisher
	lifecycle Lifecycle
	policy    RetryPolicy
	now       func() time.Time
	log       *slog.Logger
}

// Option configures a Dispatcher.
type Option func(*Dispatcher)

// WithClock overrides the time source (tests).
func WithClock(now func() time.Time) Option { return func(d *Dispatcher) { d.now = now } }

// WithLogger sets the structured logger.
func WithLogger(l *slog.Logger) Option { return func(d *Dispatcher) { d.log = l } }

// NewDispatcher wires a Dispatcher. lifecycle may be NopLifecycle for standalone
// jobs; pass a pipeline orchestrator to advance/fail pipeline runs.
func NewDispatcher(store Store, reg *Registry, pub Publisher, lc Lifecycle, policy RetryPolicy, opts ...Option) *Dispatcher {
	d := &Dispatcher{
		store:     store,
		registry:  reg,
		publisher: pub,
		lifecycle: lc,
		policy:    policy,
		now:       func() time.Time { return time.Now().UTC() },
		log:       slog.Default(),
	}
	for _, o := range opts {
		o(d)
	}
	return d
}

// Dispatch handles one message. It returns nil when the message was handled and
// the caller should ack (this includes terminal failures and drops — they are
// "handled"). It returns a non-nil error only on an infrastructure fault the
// caller should treat as nack/requeue (e.g. the store is unreachable), so the
// broker will redeliver.
func (d *Dispatcher) Dispatch(ctx context.Context, m Message) error {
	j, err := d.store.Get(ctx, m.PartitionKey, m.JobID)
	if err != nil {
		if _, ok := err.(*ErrNotFound); ok {
			// Orphan pointer (state deleted / never written): drop it.
			d.log.Warn("dropping orphan job message", "job_id", m.JobID, "partition", m.PartitionKey)
			return nil
		}
		return err // infra fault -> nack/requeue
	}

	if j.Status.Terminal() {
		// Already processed (duplicate delivery): idempotent drop.
		d.log.Debug("job already terminal, dropping duplicate", "job_id", j.ID, "status", j.Status)
		return nil
	}

	handler, ok := d.registry.Handler(j.Type)
	if !ok {
		d.log.Error("no handler for job type", "job_id", j.ID, "type", j.Type)
		return d.finishFailed(ctx, j, "no_handler", "no handler registered for job type "+j.Type)
	}

	// Claim: mark running and count the attempt.
	j.Status = StatusRunning
	j.Attempts++
	j.ErrorCode = ""
	j.ErrorMessage = ""
	j.UpdatedAt = d.now()
	if err := d.store.Update(ctx, j); err != nil {
		return err // infra fault -> redeliver
	}

	hb := func(stage string, pct int) error {
		j.Stage = stage
		j.ProgressPct = pct
		j.UpdatedAt = d.now()
		return d.store.Update(ctx, j)
	}

	result, herr := handler(ctx, j, hb)
	if herr == nil {
		return d.finishDone(ctx, j, result)
	}
	return d.handleFailure(ctx, j, m, herr)
}

func (d *Dispatcher) finishDone(ctx context.Context, j *Job, result string) error {
	now := d.now()
	j.Status = StatusDone
	j.ProgressPct = 100
	j.ResultJSON = result
	j.ErrorCode = ""
	j.ErrorMessage = ""
	j.CompletedAt = &now
	j.UpdatedAt = now
	if err := d.store.Update(ctx, j); err != nil {
		return err
	}
	if err := d.lifecycle.OnJobCompleted(ctx, j); err != nil {
		d.log.Error("lifecycle OnJobCompleted failed", "job_id", j.ID, "err", err)
	}
	d.log.Info("job done", "job_id", j.ID, "type", j.Type, "attempts", j.Attempts)
	return nil
}

func (d *Dispatcher) handleFailure(ctx context.Context, j *Job, m Message, herr error) error {
	if pe, ok := AsPermanent(herr); ok {
		return d.finishFailed(ctx, j, pe.Code, pe.Error())
	}

	decision := DecideFailure(j.Attempts, d.policy.MaxAttempts, d.policy.BaseBackoff, d.policy.MaxBackoff)
	switch decision.Outcome {
	case OutcomeRetry:
		j.Status = StatusQueued
		j.ErrorCode = "retryable"
		j.ErrorMessage = herr.Error()
		j.UpdatedAt = d.now()
		if err := d.store.Update(ctx, j); err != nil {
			return err
		}
		if err := d.publisher.PublishRetry(ctx, m, decision.Delay); err != nil {
			return err // could not schedule retry -> redeliver
		}
		d.log.Warn("job failed, scheduled retry", "job_id", j.ID, "attempts", j.Attempts, "backoff", decision.Delay, "err", herr)
		return nil
	default: // OutcomePoison
		if err := d.finishFailed(ctx, j, "poison", herr.Error()); err != nil {
			return err
		}
		if err := d.publisher.PublishPoison(ctx, m); err != nil {
			return err
		}
		d.log.Error("job poisoned", "job_id", j.ID, "attempts", j.Attempts, "err", herr)
		return nil
	}
}

func (d *Dispatcher) finishFailed(ctx context.Context, j *Job, code, msg string) error {
	now := d.now()
	j.Status = StatusFailed
	j.ErrorCode = code
	j.ErrorMessage = msg
	j.CompletedAt = &now
	j.UpdatedAt = now
	if err := d.store.Update(ctx, j); err != nil {
		return err
	}
	if err := d.lifecycle.OnJobFailed(ctx, j); err != nil {
		d.log.Error("lifecycle OnJobFailed failed", "job_id", j.ID, "err", err)
	}
	return nil
}
