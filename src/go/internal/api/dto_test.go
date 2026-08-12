package api

import (
	"testing"

	"github.com/zhaochy1990/stride/internal/job"
)

func TestRunStateExposesContinueOnFailure(t *testing.T) {
	response := toRunStateResponse(&job.PipelineRun{Steps: []job.PipelineStep{{
		Name: "race_detection", JobType: "race_detection", ContinueOnFailure: true,
	}}})
	if len(response.Steps) != 1 || !response.Steps[0].ContinueOnFailure {
		t.Fatalf("run response steps = %+v", response.Steps)
	}
}
