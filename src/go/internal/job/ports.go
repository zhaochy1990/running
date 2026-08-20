package job

import (
	"context"
	"errors"
	"time"
)

// Store is the durable job state.
type Store interface {
	Create(ctx context.Context, j *Job) error
	Get(ctx context.Context, jobID string) (*Job, error)
	Update(ctx context.Context, j *Job) error
	// Claim atomically transitions a queued job to running and returns false when
	// another delivery has already claimed or terminated it.
	Claim(ctx context.Context, jobID string, now time.Time) (*Job, bool, error)
}

// PipelineStore is the durable pipeline-run state.
type PipelineStore interface {
	Create(ctx context.Context, r *PipelineRun) error
	Get(ctx context.Context, runID string) (*PipelineRun, error)
	Update(ctx context.Context, r *PipelineRun) error
	// Mutate locks a run for the duration of fn and persists its resulting state.
	// The returned changed value reports whether fn made a durable mutation. It is
	// the cross-process serialization boundary for pipeline lifecycle transitions.
	Mutate(ctx context.Context, runID string, fn func(*PipelineRun) (changed bool, err error)) (changed bool, err error)
}

// Publisher publishes pointer messages onto the broker's three queues.
// PublishRetry carries a per-message backoff before the message returns to the
// work queue (RabbitMQ: TTL + dead-letter exchange).
type Publisher interface {
	PublishWork(ctx context.Context, m Message) error
	PublishRetry(ctx context.Context, m Message, delay time.Duration) error
	PublishPoison(ctx context.Context, m Message) error
}

// ErrNotFound is returned by Store.Get / PipelineStore.Get when the row is absent.
type ErrNotFound struct{ Key string }

func (e *ErrNotFound) Error() string { return "not found: " + e.Key }

// IsNotFound reports whether err is (or wraps) an ErrNotFound.
func IsNotFound(err error) bool {
	var nf *ErrNotFound
	return errors.As(err, &nf)
}

// ErrConflict is returned by Store.Create / PipelineStore.Create when the row
// violates the unique (user_id, idempotency_key) constraint — i.e. a job or run
// with the same idempotency key already exists for that user. Callers (the HTTP
// API) react by returning the existing record instead of a new one.
var ErrConflict = errors.New("conflict: duplicate idempotency key")

// PublishFailedError reports a publish failure after the job was durably marked
// terminal. The job must never be executed if the broker delivery was ambiguous.
type PublishFailedError struct {
	JobID string
	Err   error
}

func (e *PublishFailedError) Error() string {
	return "job publish failed: " + e.Err.Error()
}
func (e *PublishFailedError) Unwrap() error { return e.Err }

// PublishPendingError remains as a compatibility marker for callers which use
// an alternate enqueuer. StoreEnqueuer itself now fail-closes via
// PublishFailedError and never leaves a queued orphan for reconciliation.
type PublishPendingError struct {
	JobID string
	Err   error
}

func (e *PublishPendingError) Error() string {
	return "job stored but publish pending: " + e.Err.Error()
}
func (e *PublishPendingError) Unwrap() error { return e.Err }

func IsPublishPending(err error) bool {
	var pending *PublishPendingError
	return errors.As(err, &pending)
}

// Heartbeat lets a handler report progress mid-run; it persists stage/progress
// on the job row. RabbitMQ holds the unacked message for the consumer, so unlike
// the old Azure design there is no lease to renew.
type Heartbeat func(stage string, progressPct int) error

// Handler runs one job. The returned string is persisted as ResultJSON. Return a
// PermanentError (via NewPermanentError) to fail terminally without retry.
type Handler func(ctx context.Context, j *Job, hb Heartbeat) (result string, err error)

// Lifecycle is invoked as a job changes state so a pipeline orchestrator can
// reflect that job's progress on its run. OnJobStarted fires when a worker
// claims the job and begins running it; OnJobCompleted / OnJobFailed fire when
// it reaches a terminal state (to advance or fail the run). Implementations
// MUST be idempotent — at-least-once delivery and retries can fire any hook
// more than once for the same job.
type Lifecycle interface {
	OnJobStarted(ctx context.Context, j *Job) error
	OnJobCompleted(ctx context.Context, j *Job) error
	OnJobFailed(ctx context.Context, j *Job) error
}

// NopLifecycle is a Lifecycle that does nothing (for standalone jobs).
type NopLifecycle struct{}

func (NopLifecycle) OnJobStarted(context.Context, *Job) error   { return nil }
func (NopLifecycle) OnJobCompleted(context.Context, *Job) error { return nil }
func (NopLifecycle) OnJobFailed(context.Context, *Job) error    { return nil }
