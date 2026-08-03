package job

import (
	"context"
	"errors"
	"time"
)

// Store is the durable job state. Implementations must be safe under concurrent
// workers (transitions are last-write-wins on a row keyed by the globally-unique
// job ID).
type Store interface {
	Create(ctx context.Context, j *Job) error
	Get(ctx context.Context, jobID string) (*Job, error)
	Update(ctx context.Context, j *Job) error
}

// PipelineStore is the durable pipeline-run state.
type PipelineStore interface {
	Create(ctx context.Context, r *PipelineRun) error
	Get(ctx context.Context, runID string) (*PipelineRun, error)
	Update(ctx context.Context, r *PipelineRun) error
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
