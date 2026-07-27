package job

import (
	"errors"
	"time"
)

// FailureOutcome is what to do with a job whose handler returned an error.
type FailureOutcome int

const (
	// OutcomeRetry re-enqueues the job onto the retry queue with backoff Delay.
	OutcomeRetry FailureOutcome = iota
	// OutcomePoison dead-letters the job and marks it terminally failed.
	OutcomePoison
)

func (o FailureOutcome) String() string {
	switch o {
	case OutcomeRetry:
		return "retry"
	case OutcomePoison:
		return "poison"
	default:
		return "unknown"
	}
}

// RetryDecision is the result of DecideFailure.
type RetryDecision struct {
	Outcome FailureOutcome
	Delay   time.Duration // backoff before redelivery; meaningful only for OutcomeRetry
}

// DecideFailure decides whether a failed job should be retried (with exponential
// backoff) or poisoned. attempts is the number of attempts made so far including
// the one that just failed; once it reaches maxAttempts the job is poisoned.
// Backoff = base * 2^(attempts-1), capped at maxDelay.
func DecideFailure(attempts, maxAttempts int, base, maxDelay time.Duration) RetryDecision {
	if attempts >= maxAttempts {
		return RetryDecision{Outcome: OutcomePoison}
	}
	delay := base
	for i := 1; i < attempts; i++ {
		delay *= 2
		if delay >= maxDelay {
			delay = maxDelay
			break
		}
	}
	if delay > maxDelay {
		delay = maxDelay
	}
	return RetryDecision{Outcome: OutcomeRetry, Delay: delay}
}

// PermanentError wraps an error that must not be retried: the job goes straight
// to terminal failed (e.g. bad input, unknown sub-resource). Handlers return it
// via NewPermanentError.
type PermanentError struct {
	Code string
	err  error
}

func (e *PermanentError) Error() string { return e.err.Error() }
func (e *PermanentError) Unwrap() error { return e.err }

// NewPermanentError marks err as non-retryable with a stable error code.
func NewPermanentError(code string, err error) error {
	return &PermanentError{Code: code, err: err}
}

// AsPermanent reports whether err (or anything it wraps) is a PermanentError.
func AsPermanent(err error) (*PermanentError, bool) {
	var pe *PermanentError
	if errors.As(err, &pe) {
		return pe, true
	}
	return nil, false
}
