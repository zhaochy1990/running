package mq

import (
	"context"
	"fmt"
	"time"

	"go.uber.org/zap"
)

// Startup-dial retry policy. Sized for the broker's real failure window: a
// rabbitmq Recreate roll is 15-30s, so doubling from the publisher-reconnect
// delay (1s) to its 30s cap spans ~3 minutes across 10 attempts — comfortably
// past the window, still bounded (#493).
const (
	dialRetryAttempts = 10
	dialRetryDelay    = defaultReconnectDelay
	dialRetryMaxDelay = defaultMaxReconnectDelay
)

// dialDeps is the test seam: no fake broker exists in-repo, so tests inject
// the dial and the clock.
type dialDeps struct {
	dial  func(url string) (*Conn, error)
	sleep func(ctx context.Context, d time.Duration) error
}

// DialWithRetry dials until the broker answers, the attempt budget runs out,
// or ctx is cancelled. The workers' startup path must not exit on a broker
// blip: k8s crash-loop backoff (10s..300s) would stretch a 15-30s broker
// restart into minutes of worker downtime.
//
// amqp091's Dial does not take a ctx, so a cancellation landing mid-dial is
// only observed at the next loop edge — one dial timeout (30s) of latency at
// worst, well within k8s's termination grace.
func DialWithRetry(ctx context.Context, url string, log *zap.Logger) (*Conn, error) {
	return dialWithRetry(ctx, url, log, dialDeps{})
}

func dialWithRetry(ctx context.Context, url string, log *zap.Logger, deps dialDeps) (*Conn, error) {
	dial := deps.dial
	if dial == nil {
		dial = Dial
	}
	sleep := deps.sleep
	if sleep == nil {
		sleep = func(ctx context.Context, d time.Duration) error {
			t := time.NewTimer(d)
			defer t.Stop()
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-t.C:
				return nil
			}
		}
	}

	for attempt := 1; ; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		conn, err := dial(url)
		if err == nil {
			return conn, nil
		}
		if attempt >= dialRetryAttempts {
			return nil, fmt.Errorf("mq: dial retry: %d attempts, broker still unreachable: %w", dialRetryAttempts, err)
		}
		wait := dialRetryDelay * (1 << (attempt - 1))
		if wait > dialRetryMaxDelay {
			wait = dialRetryMaxDelay
		}
		log.Warn("mq: dial failed; retrying", zap.Int("attempt", attempt), zap.Duration("retry_in", wait), zap.Error(err))
		if err := sleep(ctx, wait); err != nil {
			return nil, fmt.Errorf("mq: dial retry aborted: %w", err)
		}
	}
}
