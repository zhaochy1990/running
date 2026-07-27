package job

import (
	"testing"
	"time"
)

func TestDecideFailure_RetryWithExponentialBackoff(t *testing.T) {
	base := 1 * time.Second
	max := 60 * time.Second
	limit := 5

	cases := []struct {
		attempts  int
		wantDelay time.Duration
	}{
		{attempts: 1, wantDelay: 1 * time.Second}, // base * 2^0
		{attempts: 2, wantDelay: 2 * time.Second}, // base * 2^1
		{attempts: 3, wantDelay: 4 * time.Second}, // base * 2^2
		{attempts: 4, wantDelay: 8 * time.Second}, // base * 2^3
	}
	for _, c := range cases {
		got := DecideFailure(c.attempts, limit, base, max)
		if got.Outcome != OutcomeRetry {
			t.Fatalf("attempts=%d: want retry, got %v", c.attempts, got.Outcome)
		}
		if got.Delay != c.wantDelay {
			t.Fatalf("attempts=%d: want delay %v, got %v", c.attempts, c.wantDelay, got.Delay)
		}
	}
}

func TestDecideFailure_BackoffCappedAtMax(t *testing.T) {
	got := DecideFailure(10, 100, 1*time.Second, 30*time.Second)
	if got.Outcome != OutcomeRetry {
		t.Fatalf("want retry, got %v", got.Outcome)
	}
	if got.Delay != 30*time.Second {
		t.Fatalf("want capped delay 30s, got %v", got.Delay)
	}
}

func TestDecideFailure_PoisonAtLimit(t *testing.T) {
	// The attempt that just failed is the 5th; limit is 5 -> poison.
	got := DecideFailure(5, 5, 1*time.Second, 60*time.Second)
	if got.Outcome != OutcomePoison {
		t.Fatalf("want poison at limit, got %v", got.Outcome)
	}
}

func TestDecideFailure_PoisonBeyondLimit(t *testing.T) {
	got := DecideFailure(7, 5, 1*time.Second, 60*time.Second)
	if got.Outcome != OutcomePoison {
		t.Fatalf("want poison beyond limit, got %v", got.Outcome)
	}
}
