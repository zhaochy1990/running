package onboardingcompute

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/zhaochy1990/stride/internal/job"
)

const testUser = "f10bc353-01ab-4db1-af9f-d9305ea9a532"

func TestHandlerStagesAndResult(t *testing.T) {
	h := New()
	var stages []string
	hb := func(stage string, _ int) error { stages = append(stages, stage); return nil }

	res, err := h(context.Background(), &job.Job{PartitionKey: testUser}, hb)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	var out result
	if e := json.Unmarshal([]byte(res), &out); e != nil {
		t.Fatalf("result is not JSON: %v (%q)", e, res)
	}
	if out.User != testUser {
		t.Fatalf("result user = %q, want %q", out.User, testUser)
	}

	want := []string{"calibration", "training_load", "ability"}
	if len(stages) != len(want) {
		t.Fatalf("stages = %v, want %v", stages, want)
	}
	for i := range want {
		if stages[i] != want[i] {
			t.Fatalf("stage %d = %q, want %q", i, stages[i], want[i])
		}
	}
}

func TestHandlerRejectsNonUUIDPartition(t *testing.T) {
	h := New()
	_, err := h(context.Background(), &job.Job{PartitionKey: "not-a-uuid"},
		func(string, int) error { return nil })

	pe, ok := job.AsPermanent(err)
	if !ok {
		t.Fatalf("want a permanent error, got %v", err)
	}
	if pe.Code != "bad_partition" {
		t.Fatalf("error code = %q, want bad_partition", pe.Code)
	}
}
