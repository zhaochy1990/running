package storage

import (
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/job"
)

func TestJobModel_RoundTrip(t *testing.T) {
	now := time.Date(2026, 3, 4, 5, 6, 7, 890000000, time.UTC)
	done := now.Add(time.Minute)
	in := &job.Job{
		ID: "j1", PartitionKey: "u1", Type: "greet", Status: job.StatusDone,
		Attempts: 2, Stage: "phase-2", ProgressPct: 100,
		InputJSON: `{"a":1}`, ResultJSON: `{"ok":true}`,
		ErrorCode: "", ErrorMessage: "", PipelineRunID: "run-9",
		CreatedAt: now, UpdatedAt: now, CompletedAt: &done,
	}
	out := toJobModel(in).toDomain()
	if *out != *in {
		t.Fatalf("round-trip mismatch:\n in=%+v\nout=%+v", in, out)
	}
}

func TestPipelineModel_RoundTrip(t *testing.T) {
	now := time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)
	in := &job.PipelineRun{
		RunID: "run-1", PartitionKey: "u1", UserID: "trigger-1", Name: "onboarding",
		Status: job.StatusRunning, CurrentStep: 1,
		Steps: []job.PipelineStep{
			{Name: "full_sync", JobType: "onboarding_full_sync", Status: job.StatusDone, JobID: "j1"},
			{Name: "calibration", JobType: "onboarding_calibration", Status: job.StatusQueued, JobID: "j2"},
		},
		CreatedAt: now, UpdatedAt: now,
	}
	m, err := toPipelineModel(in)
	if err != nil {
		t.Fatalf("to model: %v", err)
	}
	out, err := m.toDomain()
	if err != nil {
		t.Fatalf("to domain: %v", err)
	}
	if out.RunID != in.RunID || out.Status != in.Status || out.CurrentStep != in.CurrentStep {
		t.Fatalf("scalar mismatch: %+v", out)
	}
	if out.UserID != in.UserID {
		t.Fatalf("user id = %q, want %q", out.UserID, in.UserID)
	}
	if len(out.Steps) != 2 || out.Steps[0] != in.Steps[0] || out.Steps[1] != in.Steps[1] {
		t.Fatalf("steps mismatch: %+v", out.Steps)
	}
}

func TestPipelineModel_EmptyStepsJSON(t *testing.T) {
	m := &pipelineRunModel{RunID: "r", PartitionKey: "u", Name: "x", Status: "queued"}
	out, err := m.toDomain()
	if err != nil {
		t.Fatalf("to domain: %v", err)
	}
	if len(out.Steps) != 0 {
		t.Fatalf("want no steps, got %d", len(out.Steps))
	}
}
