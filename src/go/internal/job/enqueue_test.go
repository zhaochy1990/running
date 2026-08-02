package job

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestStoreEnqueuer_StoreFirstThenPublish(t *testing.T) {
	store := newFakeStore()
	pub := &fakePublisher{}
	ids := []string{"job-1"}
	i := 0
	e := NewStoreEnqueuer(store, pub,
		WithEnqueueClock(fixedNow()),
		WithIDFunc(func() string { id := ids[i]; i++; return id }),
	)

	id, err := e.Enqueue(context.Background(), EnqueueSpec{
		Type: "greet", UserID: "u1", InputJSON: `{"name":"a"}`,
	})
	if err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	if id != "job-1" {
		t.Fatalf("id = %q, want job-1", id)
	}

	// Row is written before publish, as queued.
	got := store.snapshot("job-1")
	if got == nil {
		t.Fatal("job row not created")
	}
	if got.Status != StatusQueued {
		t.Fatalf("status = %s, want queued", got.Status)
	}
	if got.Type != "greet" || got.InputJSON != `{"name":"a"}` {
		t.Fatalf("row not populated: %+v", got)
	}
	if got.CreatedAt.IsZero() {
		t.Fatal("created_at not set")
	}
	// Pointer published to the work queue.
	if len(pub.work) != 1 || pub.work[0].JobID != "job-1" || pub.work[0].UserID != "u1" {
		t.Fatalf("work publish wrong: %+v", pub.work)
	}
}

func TestStoreEnqueuer_CarriesPipelineLink(t *testing.T) {
	store := newFakeStore()
	pub := &fakePublisher{}
	e := NewStoreEnqueuer(store, pub,
		WithEnqueueClock(fixedNow()),
		WithIDFunc(func() string { return "job-x" }),
	)
	if _, err := e.Enqueue(context.Background(), EnqueueSpec{
		Type: "step1", UserID: "u1", PipelineRunID: "run-7",
	}); err != nil {
		t.Fatalf("enqueue: %v", err)
	}
	got := store.snapshot("job-x")
	if got.PipelineRunID != "run-7" {
		t.Fatalf("pipeline link = %q, want run-7", got.PipelineRunID)
	}
}

func TestStoreEnqueuer_PublishFailurePropagates(t *testing.T) {
	store := newFakeStore()
	pub := &failingPublisher{err: errors.New("broker down")}
	e := NewStoreEnqueuer(store, pub,
		WithEnqueueClock(fixedNow()),
		WithIDFunc(func() string { return "job-1" }),
	)
	_, err := e.Enqueue(context.Background(), EnqueueSpec{Type: "greet", UserID: "u1"})
	if err == nil {
		t.Fatal("want error when publish fails")
	}
	// Row still exists as queued (store-first); a reconcile can re-publish.
	if got := store.snapshot("job-1"); got == nil || got.Status != StatusQueued {
		t.Fatal("row should remain queued after publish failure")
	}
}

type failingPublisher struct{ err error }

func (p *failingPublisher) PublishWork(context.Context, Message) error { return p.err }
func (p *failingPublisher) PublishRetry(context.Context, Message, time.Duration) error {
	return p.err
}
func (p *failingPublisher) PublishPoison(context.Context, Message) error { return p.err }
