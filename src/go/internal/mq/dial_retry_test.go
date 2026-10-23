package mq

import (
	"context"
	"errors"
	"testing"
	"time"

	"go.uber.org/zap"
)

func TestDialWithRetrySucceedsAfterTransientFailures(t *testing.T) {
	dialErrs := []error{errors.New("refused"), errors.New("refused")}
	var dialed int
	dial := func(string) (*Conn, error) {
		dialed++
		if dialed <= len(dialErrs) {
			return nil, dialErrs[dialed-1]
		}
		return &Conn{}, nil
	}
	var waits []time.Duration
	sleep := func(_ context.Context, d time.Duration) error {
		waits = append(waits, d)
		return nil
	}

	conn, err := dialWithRetry(context.Background(), "amqp://x", zap.NewNop(), dialDeps{
		dial: dial, sleep: sleep,
	})
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if conn == nil {
		t.Fatal("expected a conn")
	}
	if got, want := dialed, 3; got != want {
		t.Fatalf("dialed %d times, want %d", got, want)
	}
	// delays double from dialRetryDelay: 1s then 2s
	if got, want := waits, []time.Duration{time.Second, 2 * time.Second}; len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("waits = %v, want %v", got, want)
	}
}

func TestDialWithRetryCapsDelayAndKeepsLastError(t *testing.T) {
	lastErr := errors.New("final refusal")
	dial := func(string) (*Conn, error) { return nil, lastErr }
	var waits []time.Duration
	sleep := func(_ context.Context, d time.Duration) error {
		waits = append(waits, d)
		return nil
	}

	_, err := dialWithRetry(context.Background(), "amqp://x", zap.NewNop(), dialDeps{
		dial: dial, sleep: sleep,
	})
	if err == nil {
		t.Fatal("expected exhaustion error")
	}
	if !errors.Is(err, lastErr) {
		t.Fatalf("exhaustion error must keep the last dial error, got %v", err)
	}
	// 10 attempts → 9 waits: 1s,2s,4s,8s,16s, then capped at 30s
	want := []time.Duration{
		time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second,
		30 * time.Second, 30 * time.Second, 30 * time.Second, 30 * time.Second,
	}
	if len(waits) != len(want) {
		t.Fatalf("waits = %v, want %v", waits, want)
	}
	for i := range want {
		if waits[i] != want[i] {
			t.Fatalf("waits = %v, want %v", waits, want)
		}
	}
}

func TestDialWithRetryAbortsWhenSleepCancelled(t *testing.T) {
	dial := func(string) (*Conn, error) { return nil, errors.New("refused") }
	// the real ctx stays live — cancellation surfaces from sleep, as when a
	// SIGTERM lands mid-wait
	sleep := func(context.Context, time.Duration) error { return context.Canceled }

	_, err := dialWithRetry(context.Background(), "amqp://x", zap.NewNop(), dialDeps{
		dial: dial, sleep: sleep,
	})
	if err == nil || errors.Unwrap(err) != context.Canceled {
		t.Fatalf("expected wrapped context.Canceled, got %v", err)
	}
}

func TestDialWithRetryAbortsBeforeFirstDialWhenCtxAlreadyCancelled(t *testing.T) {
	dial := func(string) (*Conn, error) {
		t.Fatal("dial must not run when ctx is already cancelled")
		return nil, nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	_, err := dialWithRetry(ctx, "amqp://x", zap.NewNop(), dialDeps{dial: dial})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
}
