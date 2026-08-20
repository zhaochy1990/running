package job

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
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

func (s *fakeStore) Claim(_ context.Context, id string, now time.Time) (*Job, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	j, ok := s.rows[id]
	if !ok {
		return nil, false, &ErrNotFound{Key: id}
	}
	if j.Status != StatusQueued {
		return nil, false, nil
	}
	j.Status = StatusRunning
	j.Attempts++
	j.ErrorCode = ""
	j.ErrorMessage = ""
	j.UpdatedAt = now
	cp := *j
	return &cp, true, nil
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
	started   []string
	completed []string
	failed    []string
}

func (l *recordingLifecycle) OnJobStarted(_ context.Context, j *Job) error {
	l.started = append(l.started, j.ID)
	return nil
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
	if len(life.started) != 1 || life.started[0] != "j1" {
		t.Fatalf("OnJobStarted not fired: %v", life.started)
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
	if len(life.started) != 1 || life.started[0] != "j1" {
		t.Fatalf("OnJobStarted must fire once the job is claimed, before its handler runs: %v", life.started)
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

func TestDispatch_DuplicateDeliveryClaimsOnlyOnce(t *testing.T) {
	seed := &Job{ID: "j1", UserID: "u1", Type: "block", Status: StatusQueued}
	store := newFakeStore(seed)
	reg := NewRegistry()
	started := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	reg.MustRegister("block", func(context.Context, *Job, Heartbeat) (string, error) {
		calls.Add(1)
		close(started)
		<-release
		return "", nil
	})
	d := NewDispatcher(store, reg, &fakePublisher{}, NopLifecycle{}, testPolicy(), WithClock(fixedNow()))
	errCh := make(chan error, 2)
	go func() { errCh <- d.Dispatch(context.Background(), Message{JobID: "j1"}) }()
	<-started
	go func() { errCh <- d.Dispatch(context.Background(), Message{JobID: "j1"}) }()
	close(release)
	if err := <-errCh; err != nil {
		t.Fatalf("first dispatch: %v", err)
	}
	if err := <-errCh; err != nil {
		t.Fatalf("duplicate dispatch: %v", err)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("handler calls = %d, want 1", got)
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

type failingStartedLifecycle struct {
	started int
}

func (l *failingStartedLifecycle) OnJobStarted(context.Context, *Job) error {
	l.started++
	return errors.New("pipeline status unavailable")
}
func (l *failingStartedLifecycle) OnJobCompleted(context.Context, *Job) error { return nil }
func (l *failingStartedLifecycle) OnJobFailed(context.Context, *Job) error    { return nil }

func TestDispatch_StartedLifecycleFailureStillRunsHandler(t *testing.T) {
	seed := &Job{ID: "j1", UserID: "u1", Type: "greet", Status: StatusQueued}
	store := newFakeStore(seed)
	reg := NewRegistry()
	var calls atomic.Int32
	reg.MustRegister("greet", func(context.Context, *Job, Heartbeat) (string, error) {
		calls.Add(1)
		return `{"ok":true}`, nil
	})
	life := &failingStartedLifecycle{}
	d := NewDispatcher(store, reg, &fakePublisher{}, life, testPolicy(), WithClock(fixedNow()))

	if err := d.Dispatch(context.Background(), Message{JobID: "j1", UserID: "u1"}); err != nil {
		t.Fatalf("dispatch: %v", err)
	}
	if got := calls.Load(); got != 1 {
		t.Fatalf("handler calls = %d, want 1", got)
	}
	if life.started != 1 {
		t.Fatalf("OnJobStarted calls = %d, want 1", life.started)
	}
	if got := store.snapshot("j1"); got.Status != StatusDone {
		t.Fatalf("status = %s, want done", got.Status)
	}
}

type failOnceLifecycle struct {
	completed int
}

func (l *failOnceLifecycle) OnJobStarted(context.Context, *Job) error { return nil }
func (l *failOnceLifecycle) OnJobFailed(context.Context, *Job) error  { return nil }
func (l *failOnceLifecycle) OnJobCompleted(context.Context, *Job) error {
	l.completed++
	if l.completed == 1 {
		return errors.New("completion listener unavailable")
	}
	return nil
}

func TestDispatch_TerminalCompletionLifecycleRetries(t *testing.T) {
	seed := &Job{ID: "j1", UserID: "u1", Type: "greet", Status: StatusQueued}
	store := newFakeStore(seed)
	reg := NewRegistry()
	reg.MustRegister("greet", func(context.Context, *Job, Heartbeat) (string, error) { return "", nil })
	life := &failOnceLifecycle{}
	d := NewDispatcher(store, reg, &fakePublisher{}, life, testPolicy(), WithClock(fixedNow()))

	if err := d.Dispatch(context.Background(), Message{JobID: "j1", UserID: "u1"}); err == nil {
		t.Fatal("first delivery must request lifecycle retry")
	}
	if got := store.snapshot("j1"); got.Status != StatusDone {
		t.Fatalf("job status = %s, want durable done", got.Status)
	}
	if err := d.Dispatch(context.Background(), Message{JobID: "j1", UserID: "u1"}); err != nil {
		t.Fatalf("terminal replay: %v", err)
	}
	if life.completed != 2 {
		t.Fatalf("completion calls = %d, want 2", life.completed)
	}
}

type failOnceFailedLifecycle struct{ calls int }

func (l *failOnceFailedLifecycle) OnJobStarted(context.Context, *Job) error   { return nil }
func (l *failOnceFailedLifecycle) OnJobCompleted(context.Context, *Job) error { return nil }
func (l *failOnceFailedLifecycle) OnJobFailed(context.Context, *Job) error {
	l.calls++
	if l.calls == 1 {
		return errors.New("pipeline unavailable")
	}
	return nil
}

func TestDispatch_TerminalFailureLifecycleRetries(t *testing.T) {
	seed := &Job{ID: "j1", UserID: "u1", Type: "bad", Status: StatusQueued}
	store := newFakeStore(seed)
	reg := NewRegistry()
	reg.MustRegister("bad", func(context.Context, *Job, Heartbeat) (string, error) {
		return "", NewPermanentError("bad_input", errors.New("bad"))
	})
	life := &failOnceFailedLifecycle{}
	d := NewDispatcher(store, reg, &fakePublisher{}, life, testPolicy(), WithClock(fixedNow()))
	if err := d.Dispatch(context.Background(), Message{JobID: "j1"}); err == nil {
		t.Fatal("terminal lifecycle failure must request redelivery")
	}
	if got := store.snapshot("j1"); got.Status != StatusFailed {
		t.Fatalf("status = %s, want failed", got.Status)
	}
	if err := d.Dispatch(context.Background(), Message{JobID: "j1"}); err != nil {
		t.Fatalf("terminal replay: %v", err)
	}
	if life.calls != 2 {
		t.Fatalf("failed lifecycle calls = %d, want 2", life.calls)
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
