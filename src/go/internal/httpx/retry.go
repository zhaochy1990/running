// Package httpx adds request-level retry for the watch-provider HTTP clients.
// A transient failure on a single request (a dropped connection mid-body =
// "unexpected EOF", a reset, a timeout, or a 5xx/429) is retried in place with
// exponential backoff, so a long sync keeps going instead of failing the whole
// job and re-scanning from the top.
package httpx

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"syscall"
	"time"

	retry "github.com/avast/retry-go/v4"
)

// Defaults for the request retry policy.
const (
	DefaultAttempts  uint          = 3
	DefaultBaseDelay time.Duration = 300 * time.Millisecond
)

// StatusError wraps a non-2xx HTTP response as an error. It is retryable for
// 429 (Too Many Requests) and 5xx (server errors); 4xx are terminal.
type StatusError struct {
	Code int
	Body string
}

func (e *StatusError) Error() string {
	b := e.Body
	if len(b) > 200 {
		b = b[:200]
	}
	return fmt.Sprintf("http %d: %s", e.Code, b)
}

// Retryable reports whether this status should be retried.
func (e *StatusError) Retryable() bool {
	return RetryableStatus(e.Code)
}

// RetryableStatus reports whether an HTTP status code is transient (429 or 5xx).
func RetryableStatus(code int) bool {
	return code == http.StatusTooManyRequests || code >= 500
}

// Retryable classifies an error as a transient HTTP/transport failure worth
// retrying: connection errors/timeouts, a mid-body EOF/reset, and any error
// exposing Retryable() bool == true (e.g. StatusError for 5xx/429). A cancelled
// context or an overall deadline is NOT retried, and neither is anything else
// (4xx, decode errors, etc.).
func Retryable(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	// Explicit opt-in via a Retryable() method (StatusError, provider APIErrors).
	var r interface{ Retryable() bool }
	if errors.As(err, &r) {
		return r.Retryable()
	}
	// Mid-body read failures (the "unexpected EOF" that bit long COROS syncs).
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	// Connection-level failures.
	if errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.ECONNABORTED) || errors.Is(err, syscall.EPIPE) {
		return true
	}
	// Anything the net stack reports (dial errors, timeouts, url.Error, ...).
	var ne net.Error
	if errors.As(err, &ne) {
		return true
	}
	return false
}

// Do runs fn, retrying up to DefaultAttempts total on Retryable errors with
// exponential backoff (DefaultBaseDelay, doubling), honoring ctx. It returns the
// last error if all attempts fail.
func Do(ctx context.Context, fn func() error) error {
	return DoN(ctx, DefaultAttempts, DefaultBaseDelay, fn)
}

// DoN is Do with an explicit attempt count and base delay (for tests / tuning).
func DoN(ctx context.Context, attempts uint, baseDelay time.Duration, fn func() error) error {
	return retry.Do(
		fn,
		retry.Context(ctx),
		retry.Attempts(attempts),
		retry.Delay(baseDelay),
		retry.DelayType(retry.BackOffDelay),
		retry.RetryIf(Retryable),
		retry.LastErrorOnly(true),
	)
}
