package job

import (
	"context"
	"time"
)

// Store is the durable job state. Implementations must be safe under concurrent
// workers (transitions are last-write-wins on a row keyed by PartitionKey+ID).
type Store interface {
	Create(ctx context.Context, j *Job) error
	Get(ctx context.Context, partitionKey, jobID string) (*Job, error)
	Update(ctx context.Context, j *Job) error
}

// PipelineStore is the durable pipeline-run state.
type PipelineStore interface {
	Create(ctx context.Context, r *PipelineRun) error
	Get(ctx context.Context, partitionKey, runID string) (*PipelineRun, error)
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

// Heartbeat lets a handler report progress mid-run; it persists stage/progress
// on the job row. RabbitMQ holds the unacked message for the consumer, so unlike
// the old Azure design there is no lease to renew.
type Heartbeat func(stage string, progressPct int) error

// Handler runs one job. The returned string is persisted as ResultJSON. Return a
// PermanentError (via NewPermanentError) to fail terminally without retry.
type Handler func(ctx context.Context, j *Job, hb Heartbeat) (result string, err error)

// Lifecycle is invoked after a job reaches a terminal state so a pipeline
// orchestrator can advance or fail the run. Implementations MUST be idempotent.
type Lifecycle interface {
	OnJobCompleted(ctx context.Context, j *Job) error
	OnJobFailed(ctx context.Context, j *Job) error
}

// NopLifecycle is a Lifecycle that does nothing (for standalone jobs).
type NopLifecycle struct{}

func (NopLifecycle) OnJobCompleted(context.Context, *Job) error { return nil }
func (NopLifecycle) OnJobFailed(context.Context, *Job) error    { return nil }
