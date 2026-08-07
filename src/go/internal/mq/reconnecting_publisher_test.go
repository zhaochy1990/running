package mq

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/job"
)

type fakePublisherSession struct {
	mu        sync.Mutex
	healthy   bool
	published int
	started   chan struct{}
	release   chan struct{}
	closed    chan struct{}
	startOnce sync.Once
	closeOnce sync.Once
}

func (s *fakePublisherSession) Healthy() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.healthy
}

func (s *fakePublisherSession) Close() error {
	s.mu.Lock()
	s.healthy = false
	s.mu.Unlock()
	s.closeOnce.Do(func() {
		if s.closed != nil {
			close(s.closed)
		}
	})
	return nil
}

func (s *fakePublisherSession) PublishWork(context.Context, job.Message) error {
	s.mu.Lock()
	healthy := s.healthy
	s.mu.Unlock()
	if !healthy {
		return errors.New("connection closed")
	}
	if s.started != nil {
		s.startOnce.Do(func() { close(s.started) })
		<-s.release
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.published++
	return nil
}

func (s *fakePublisherSession) disconnect() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.healthy = false
}

func (s *fakePublisherSession) PublishRetry(context.Context, job.Message, time.Duration) error {
	return nil
}

func TestReconnectingPublisherDoesNotCloseSessionDuringPublish(t *testing.T) {
	first := &fakePublisherSession{
		healthy: true,
		started: make(chan struct{}),
		release: make(chan struct{}),
		closed:  make(chan struct{}),
	}
	second := &fakePublisherSession{healthy: true}
	sessions := []publisherSession{first, second}
	var mu sync.Mutex
	dial := func() (publisherSession, error) {
		mu.Lock()
		defer mu.Unlock()
		s := sessions[0]
		sessions = sessions[1:]
		return s, nil
	}

	pub, err := newReconnectingPublisher(dial, time.Millisecond, 5*time.Millisecond)
	if err != nil {
		t.Fatalf("new publisher: %v", err)
	}
	defer pub.Close()

	published := make(chan error, 1)
	go func() { published <- pub.PublishWork(context.Background(), job.Message{}) }()
	<-first.started
	first.disconnect()
	time.Sleep(10 * time.Millisecond)
	select {
	case <-first.closed:
		t.Fatal("initial session closed while publish was in flight")
	default:
	}
	close(first.release)
	if err := <-published; err != nil {
		t.Fatalf("in-flight publish: %v", err)
	}

	deadline := time.Now().Add(time.Second)
	for !pub.Healthy() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	select {
	case <-first.closed:
	case <-time.After(time.Second):
		t.Fatal("initial session was not closed after publish completed")
	}
}

func (s *fakePublisherSession) PublishPoison(context.Context, job.Message) error {
	return nil
}

func (s *fakePublisherSession) publishCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.published
}

func TestReconnectingPublisherReconnectsAfterConnectionCloses(t *testing.T) {
	first := &fakePublisherSession{healthy: true}
	second := &fakePublisherSession{healthy: true}
	sessions := []publisherSession{first, second}
	var mu sync.Mutex
	dial := func() (publisherSession, error) {
		mu.Lock()
		defer mu.Unlock()
		if len(sessions) == 0 {
			return nil, errors.New("unexpected dial")
		}
		s := sessions[0]
		sessions = sessions[1:]
		return s, nil
	}

	pub, err := newReconnectingPublisher(dial, time.Millisecond, 5*time.Millisecond)
	if err != nil {
		t.Fatalf("new publisher: %v", err)
	}
	defer pub.Close()

	if err := first.Close(); err != nil {
		t.Fatalf("close initial session: %v", err)
	}

	deadline := time.Now().Add(time.Second)
	for !pub.Healthy() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if !pub.Healthy() {
		t.Fatal("publisher did not become healthy after reconnect")
	}
	if err := pub.PublishWork(context.Background(), job.Message{}); err != nil {
		t.Fatalf("publish after reconnect: %v", err)
	}
	if got := second.publishCount(); got != 1 {
		t.Fatalf("replacement session publishes = %d, want 1", got)
	}
}
