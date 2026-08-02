package job

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// EnqueueSpec describes a job to enqueue.
type EnqueueSpec struct {
	Type string
	// UserID is the athlete whose data the job operates on (the subject); empty
	// for system jobs (stored as NULL).
	UserID string
	// CreatedBy is the actor that triggered creation; empty (NULL) for internal
	// or orchestrator-created jobs.
	CreatedBy     string
	InputJSON     string
	PipelineRunID string // optional: links the job to a pipeline run
	// IdempotencyKey, when non-empty, deduplicates creation: Store.Create returns
	// ErrConflict if a job with the same (UserID, IdempotencyKey) exists.
	IdempotencyKey string
}

// Enqueuer creates a durable job and publishes its pointer. It is the single
// entry point for putting work on the queue (used by API routes and by the
// pipeline orchestrator).
type Enqueuer interface {
	Enqueue(ctx context.Context, spec EnqueueSpec) (jobID string, err error)
}

// StoreEnqueuer is the store-first Enqueuer: it writes the job row as queued
// (source of truth) and then publishes the pointer to the work queue. If the
// publish fails, the row remains queued and the error is returned so the caller
// can react (a reconcile pass can re-publish orphaned queued rows).
type StoreEnqueuer struct {
	store Store
	pub   Publisher
	now   func() time.Time
	newID func() string
}

// EnqueueOption configures a StoreEnqueuer.
type EnqueueOption func(*StoreEnqueuer)

// WithEnqueueClock overrides the time source (tests).
func WithEnqueueClock(now func() time.Time) EnqueueOption {
	return func(e *StoreEnqueuer) { e.now = now }
}

// WithIDFunc overrides job-ID generation (tests).
func WithIDFunc(f func() string) EnqueueOption {
	return func(e *StoreEnqueuer) { e.newID = f }
}

// NewStoreEnqueuer wires a StoreEnqueuer. Defaults: UTC clock, UUIDv4 ids.
func NewStoreEnqueuer(store Store, pub Publisher, opts ...EnqueueOption) *StoreEnqueuer {
	e := &StoreEnqueuer{
		store: store,
		pub:   pub,
		now:   func() time.Time { return time.Now().UTC() },
		newID: func() string { return uuid.NewString() },
	}
	for _, o := range opts {
		o(e)
	}
	return e
}

// Enqueue implements Enqueuer.
func (e *StoreEnqueuer) Enqueue(ctx context.Context, spec EnqueueSpec) (string, error) {
	now := e.now()
	j := &Job{
		ID:             e.newID(),
		UserID:         spec.UserID,
		CreatedBy:      spec.CreatedBy,
		Type:           spec.Type,
		Status:         StatusQueued,
		InputJSON:      spec.InputJSON,
		IdempotencyKey: spec.IdempotencyKey,
		PipelineRunID:  spec.PipelineRunID,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := e.store.Create(ctx, j); err != nil {
		return "", err
	}
	if err := e.pub.PublishWork(ctx, Message{JobID: j.ID, UserID: j.UserID}); err != nil {
		return j.ID, err
	}
	return j.ID, nil
}
