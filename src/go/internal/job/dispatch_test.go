package job

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// --- fakes ---------------------------------------------------------------

type fakeStore struct {
	mu   sync.Mutex
	rows map[string]*Job
}

func newFakeStore(seed ...*Job) *fakeStore {
	s := &fakeStore{rows: map[string]*Job{}}
	for _, j := range seed {
		cp := *j
		s.rows[j.ID] = &cp
	}
	return s
}

func (s *fakeStore) Create(_ context.Context, j *Job) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := *j
	s.rows[j.ID] = &cp
	return nil
}

func (s *fakeStore) Get(_ context.Context, id string) (*Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	j, ok := s.rows[id]
	if !ok {
		return nil, &ErrNotFound{Key: id}
	}
	cp := *j
	return &cp, nil
}

func (s *fakeStore) Update(_ context.Context, j *Job) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := *j
	s.rows[j.ID] = &cp
	return nil
}

func (s *fakeStore) snapshot(id string) *Job {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.rows[id]
}

type fakePublisher struct {
	work   []Message
	retry  []Message
	delays []time.Duration
	poison []Message
}

func (p *fakePublisher) PublishWork(_ context.Context, m Message) error {
	p.work = append(p.work, m)
	return nil
}
func (p *fakePublisher) PublishRetry(_ context.Context, m Message, d time.Duration) error {
	p.retry = append(p.retry, m)
	p.delays = append(p.delays, d)
	return nil
}
func (p *fakePublisher) PublishPoison(_ context.Context, m Message) error {
	p.poison = append(p.poison, m)
	return nil
}

type recordingLifecycle struct {
	completed []string
	failed    []string
}

func (l *recordingLifecycle) OnJobCompleted(_ context.Context, j *Job) error {
	l.completed = append(l.completed, j.ID)
	return nil
}
func (l *recordingLifecycle) OnJobFailed(_ context.Context, j *Job) error {
	l.failed = append(l.failed, j.ID)
	return nil
}

func testPolicy() RetryPolicy {
	return RetryPolicy{MaxAttempts: 3, BaseBackoff: time.Second, MaxBackoff: time.Minute}
}

func fixedNow() func() time.Time {
	t := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	return func() time.Time { return t }
}

// --- tests ---------------------------------------------------------------

func TestDispatch_Success(t *testing.T) {
	seed := &Job{ID: "j1", UserID: "u1", Type: "greet", Status: StatusQueued}
	store := newFakeStore(seed)
	reg := NewRegistry()
	reg.MustRegister("greet", func(_ context.Context, j *Job, hb Heartbeat) (string, error) {
		_ = hb("working", 50)
		return `{"ok":true}`, nil
	})
	pub := &fakePublisher{}
	life := &recordingLifecycle{}
	d := NewDispatcher(store, reg, pub, life, testPolicy(), WithClock(fixedNow()))

	if err := d.Dispatch(context.Background(), Message{JobID: "j1", UserID: "u1"}); err != nil {
		t.Fatalf("dispatch: %v", err)
	}

	got := store.snapshot("j1")
	if got.Status != StatusDone {
		t.Fatalf("status = %s, want done", got.Status)
	}
	if got.ResultJSON != `{"ok":true}` {
		t.Fatalf("result = %q", got.ResultJSON)
	}
	if got.ProgressPct != 100 {
		t.Fatalf("progress = %d, want 100", got.ProgressPct)
	}
	if got.Attempts != 1 {
		t.Fatalf("attempts = %d, want 1", got.Attempts)
	}
	if got.CompletedAt == nil {
		t.Fatal("completed_at not set")
	}
	if len(life.completed) != 1 || life.completed[0] != "j1" {
		t.Fatalf("OnJobCompleted not fired: %v", life.completed)
	}
	if len(pub.retry)+len(pub.poison) != 0 {
		t.Fatal("unexpected retry/poison publish on success")
	}
}

func TestDispatch_MissingHandler_TerminalFailed(t *testing.T) {
	seed := &Job{ID: "j1", UserID: "u1", Type: "unknown", Status: StatusQueued}
	store := newFakeStore(seed)
	pub := &fakePublisher{}
	life := &recordingLifecycle{}
	d := NewDispatcher(store, NewRegistry(), pub, life, testPolicy(), WithClock(fixedNow()))

	if err := d.Dispatch(context.Background(), Message{JobID: "j1", UserID: "u1"}); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	got := store.snapshot("j1")
	if got.Status != StatusFailed {
		t.Fatalf("status = %s, want failed", got.Status)
	}
	if got.ErrorCode != "no_handler" {
		t.Fatalf("error_code = %q, want no_handler", got.ErrorCode)
	}
	if len(pub.retry) != 0 || len(pub.poison) != 0 {
		t.Fatal("missing handler must not retry/poison")
	}
	if len(life.failed) != 1 {
		t.Fatalf("OnJobFailed not fired: %v", life.failed)
	}
}

func TestDispatch_TransientFailure_RetriesWithBackoff(t *testing.T) {
	seed := &Job{ID: "j1", UserID: "u1", Type: "flaky", Status: StatusQueued}
	store := newFakeStore(seed)
	reg := NewRegistry()
	reg.MustRegister("flaky", func(_ context.Context, j *Job, hb Heartbeat) (string, error) {
		return "", errors.New("temporary glitch")
	})
	pub := &fakePublisher{}
	life := &recordingLifecycle{}
	d := NewDispatcher(store, reg, pub, life, testPolicy(), WithClock(fixedNow()))

	if err := d.Dispatch(context.Background(), Message{JobID: "j1", UserID: "u1"}); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	got := store.snapshot("j1")
	if got.Status != StatusQueued {
		t.Fatalf("status = %s, want queued (awaiting retry)", got.Status)
	}
	if got.ErrorMessage == "" {
		t.Fatal("error message not stamped for retry")
	}
	if len(pub.retry) != 1 {
		t.Fatalf("want 1 retry publish, got %d", len(pub.retry))
	}
	if pub.delays[0] != time.Second { // attempts=1 -> base
		t.Fatalf("backoff = %v, want 1s", pub.delays[0])
	}
	if len(life.failed) != 0 {
		t.Fatal("OnJobFailed must not fire while still retrying")
	}
}

func TestDispatch_ExhaustsToPoison(t *testing.T) {
	// Job already attempted twice; MaxAttempts=3, so this (3rd) failure poisons.
	seed := &Job{ID: "j1", UserID: "u1", Type: "flaky", Status: StatusQueued, Attempts: 2}
	store := newFakeStore(seed)
	reg := NewRegistry()
	reg.MustRegister("flaky", func(_ context.Context, j *Job, hb Heartbeat) (string, error) {
		return "", errors.New("still broken")
	})
	pub := &fakePublisher{}
	life := &recordingLifecycle{}
	d := NewDispatcher(store, reg, pub, life, testPolicy(), WithClock(fixedNow()))

	if err := d.Dispatch(context.Background(), Message{JobID: "j1", UserID: "u1"}); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	got := store.snapshot("j1")
	if got.Status != StatusFailed {
		t.Fatalf("status = %s, want failed", got.Status)
	}
	if got.ErrorCode != "poison" {
		t.Fatalf("error_code = %q, want poison", got.ErrorCode)
	}
	if len(pub.poison) != 1 {
		t.Fatalf("want 1 poison publish, got %d", len(pub.poison))
	}
	if len(life.failed) != 1 {
		t.Fatalf("OnJobFailed not fired on poison: %v", life.failed)
	}
}

func TestDispatch_PermanentError_NoRetry(t *testing.T) {
	seed := &Job{ID: "j1", UserID: "u1", Type: "bad", Status: StatusQueued}
	store := newFakeStore(seed)
	reg := NewRegistry()
	reg.MustRegister("bad", func(_ context.Context, j *Job, hb Heartbeat) (string, error) {
		return "", NewPermanentError("bad_input", errors.New("cannot parse payload"))
	})
	pub := &fakePublisher{}
	life := &recordingLifecycle{}
	d := NewDispatcher(store, reg, pub, life, testPolicy(), WithClock(fixedNow()))

	if err := d.Dispatch(context.Background(), Message{JobID: "j1", UserID: "u1"}); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	got := store.snapshot("j1")
	if got.Status != StatusFailed {
		t.Fatalf("status = %s, want failed", got.Status)
	}
	if got.ErrorCode != "bad_input" {
		t.Fatalf("error_code = %q, want bad_input", got.ErrorCode)
	}
	if len(pub.retry) != 0 || len(pub.poison) != 0 {
		t.Fatal("permanent error must not retry or poison")
	}
	if len(life.failed) != 1 {
		t.Fatal("OnJobFailed not fired on permanent error")
	}
}

func TestDispatch_OrphanMessage_Dropped(t *testing.T) {
	store := newFakeStore() // empty
	reg := NewRegistry()
	pub := &fakePublisher{}
	d := NewDispatcher(store, reg, pub, NopLifecycle{}, testPolicy(), WithClock(fixedNow()))

	if err := d.Dispatch(context.Background(), Message{JobID: "ghost", UserID: "u1"}); err != nil {
		t.Fatalf("orphan should be dropped, got err: %v", err)
	}
	if len(pub.work)+len(pub.retry)+len(pub.poison) != 0 {
		t.Fatal("orphan must not publish anything")
	}
}

func TestDispatch_AlreadyTerminal_Idempotent(t *testing.T) {
	seed := &Job{ID: "j1", UserID: "u1", Type: "greet", Status: StatusDone}
	store := newFakeStore(seed)
	reg := NewRegistry()
	called := false
	reg.MustRegister("greet", func(_ context.Context, j *Job, hb Heartbeat) (string, error) {
		called = true
		return "", nil
	})
	d := NewDispatcher(store, reg, &fakePublisher{}, NopLifecycle{}, testPolicy(), WithClock(fixedNow()))

	if err := d.Dispatch(context.Background(), Message{JobID: "j1", UserID: "u1"}); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if called {
		t.Fatal("handler must not run for an already-terminal job")
	}
}

func TestDispatch_Heartbeat_PersistsProgress(t *testing.T) {
	seed := &Job{ID: "j1", UserID: "u1", Type: "long", Status: StatusQueued}
	store := newFakeStore(seed)
	reg := NewRegistry()
	reg.MustRegister("long", func(_ context.Context, j *Job, hb Heartbeat) (string, error) {
		if err := hb("phase-2", 42); err != nil {
			return "", err
		}
		return "done", nil
	})
	d := NewDispatcher(store, reg, &fakePublisher{}, NopLifecycle{}, testPolicy(), WithClock(fixedNow()))

	if err := d.Dispatch(context.Background(), Message{JobID: "j1", UserID: "u1"}); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	// final status is done/100, but stage from the last heartbeat persists.
	got := store.snapshot("j1")
	if got.Stage != "phase-2" {
		t.Fatalf("stage = %q, want phase-2", got.Stage)
	}
}
