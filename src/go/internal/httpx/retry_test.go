package httpx

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"
)

func TestRetryable(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"ctx canceled", context.Canceled, false},
		{"ctx deadline", context.DeadlineExceeded, false},
		{"unexpected EOF", io.ErrUnexpectedEOF, true},
		{"EOF", io.EOF, true},
		{"wrapped EOF", errors.New("read: " + io.ErrUnexpectedEOF.Error()), false}, // string-wrapped, not a real chain
		{"status 500", &StatusError{Code: 500}, true},
		{"status 429", &StatusError{Code: 429}, true},
		{"status 404", &StatusError{Code: 404}, false},
		{"status 401", &StatusError{Code: 401}, false},
		{"plain error", errors.New("boom"), false},
	}
	for _, c := range cases {
		if got := Retryable(c.err); got != c.want {
			t.Errorf("%s: Retryable = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestDoN_RetriesTransientThenSucceeds(t *testing.T) {
	calls := 0
	err := DoN(context.Background(), 3, time.Millisecond, func() error {
		calls++
		if calls < 3 {
			return io.ErrUnexpectedEOF // transient
		}
		return nil
	})
	if err != nil {
		t.Fatalf("want success, got %v", err)
	}
	if calls != 3 {
		t.Errorf("calls = %d, want 3", calls)
	}
}

func TestDoN_StopsOnNonRetryable(t *testing.T) {
	calls := 0
	want := &StatusError{Code: 404}
	err := DoN(context.Background(), 5, time.Millisecond, func() error {
		calls++
		return want
	})
	if calls != 1 {
		t.Errorf("calls = %d, want 1 (no retry on 4xx)", calls)
	}
	var se *StatusError
	if !errors.As(err, &se) || se.Code != 404 {
		t.Errorf("err = %v, want the 404", err)
	}
}

func TestDoN_ExhaustsAttempts(t *testing.T) {
	calls := 0
	err := DoN(context.Background(), 3, time.Millisecond, func() error {
		calls++
		return &StatusError{Code: 503}
	})
	if calls != 3 {
		t.Errorf("calls = %d, want 3 (attempt ceiling)", calls)
	}
	if err == nil {
		t.Fatal("want error after exhausting retries")
	}
}

func TestDoN_HonorsContextCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	calls := 0
	err := DoN(ctx, 10, 20*time.Millisecond, func() error {
		calls++
		cancel() // cancel after the first attempt
		return io.ErrUnexpectedEOF
	})
	if err == nil {
		t.Fatal("want error on cancellation")
	}
	if calls > 2 {
		t.Errorf("calls = %d, want <=2 (should stop on ctx cancel)", calls)
	}
}

func TestStatusError_Retryable(t *testing.T) {
	for code, want := range map[int]bool{200: false, 404: false, 429: true, 500: true, 503: true} {
		if got := (&StatusError{Code: code}).Retryable(); got != want {
			t.Errorf("status %d Retryable = %v, want %v", code, got, want)
		}
	}
}
