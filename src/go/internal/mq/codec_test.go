package mq

import (
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/job"
)

func TestMessageCodec_RoundTrip(t *testing.T) {
	in := job.Message{JobID: "j1", UserID: "u1"}
	b, err := encodeMessage(in)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	out, err := decodeMessage(b)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out != in {
		t.Fatalf("round-trip mismatch: %+v != %+v", out, in)
	}
}

func TestDecodeMessage_RejectsMissingJobID(t *testing.T) {
	if _, err := decodeMessage([]byte(`{"partition_key":"u1"}`)); err == nil {
		t.Fatal("want error when job_id missing")
	}
	if _, err := decodeMessage([]byte(`not json`)); err == nil {
		t.Fatal("want error for invalid json")
	}
}

func TestExpirationMillis(t *testing.T) {
	cases := []struct {
		d    time.Duration
		want string
	}{
		{5 * time.Second, "5000"},
		{1500 * time.Millisecond, "1500"},
		{0, "0"},
		{-3 * time.Second, "0"},
	}
	for _, c := range cases {
		if got := expirationMillis(c.d); got != c.want {
			t.Fatalf("expirationMillis(%v) = %q, want %q", c.d, got, c.want)
		}
	}
}
