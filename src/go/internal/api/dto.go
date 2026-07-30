package api

import (
	"encoding/json"
	"time"

	"github.com/zhaochy1990/stride/internal/job"
)

// createJobRequest is the POST /jobs body. partition_key is honored only for the
// internal tier; for the user tier it is ignored and derived from the JWT sub.
type createJobRequest struct {
	Type         string          `json:"type" binding:"required" example:"watch_sync"`
	PartitionKey string          `json:"partition_key,omitempty" example:"Global"`
	Input        json.RawMessage `json:"input,omitempty" swaggertype:"object"`
}

// enqueueJobResponse is returned by POST /jobs. Deduplicated is true when an
// Idempotency-Key matched an existing job (HTTP 200) rather than creating one.
type enqueueJobResponse struct {
	JobID        string `json:"job_id"`
	PartitionKey string `json:"partition_key"`
	Deduplicated bool   `json:"deduplicated,omitempty"`
}

// startPipelineRequest is the POST /pipelines/{name} body (all fields optional).
type startPipelineRequest struct {
	PartitionKey string          `json:"partition_key,omitempty"`
	Input        json.RawMessage `json:"input,omitempty" swaggertype:"object"`
}

// startPipelineResponse is returned by POST /pipelines/{name}.
type startPipelineResponse struct {
	RunID        string `json:"run_id"`
	PartitionKey string `json:"partition_key"`
	PipelineName string `json:"pipeline_name"`
	Deduplicated bool   `json:"deduplicated,omitempty"`
}

// jobStateResponse is the GET /jobs/{pk}/{id} body.
type jobStateResponse struct {
	JobID        string     `json:"job_id"`
	PartitionKey string     `json:"partition_key"`
	JobType      string     `json:"job_type"`
	Status       string     `json:"status"`
	ProgressPct  int        `json:"progress_pct"`
	Stage        string     `json:"stage,omitempty"`
	Attempts     int        `json:"attempts"`
	ResultJSON   string     `json:"result_json,omitempty"`
	ErrorCode    string     `json:"error_code,omitempty"`
	ErrorMessage string     `json:"error_message,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
	CompletedAt  *time.Time `json:"completed_at,omitempty"`
}

// pipelineStepResponse is one step in a run's aggregate state.
type pipelineStepResponse struct {
	Name    string `json:"name"`
	JobType string `json:"job_type"`
	Status  string `json:"status"`
	JobID   string `json:"job_id,omitempty"`
}

// runStateResponse is the GET /pipelines/{pk}/{run_id} body.
type runStateResponse struct {
	RunID        string                 `json:"run_id"`
	PartitionKey string                 `json:"partition_key"`
	UserID       string                 `json:"user_id"`
	PipelineName string                 `json:"pipeline_name"`
	Status       string                 `json:"status"`
	CurrentStep  int                    `json:"current_step"`
	Steps        []pipelineStepResponse `json:"steps"`
	ErrorMessage string                 `json:"error_message,omitempty"`
	CreatedAt    time.Time              `json:"created_at"`
	UpdatedAt    time.Time              `json:"updated_at"`
	CompletedAt  *time.Time             `json:"completed_at,omitempty"`
}

// userPipelinesResponse is the GET /api/users/{uid}/pipelines body: a user's
// pipeline runs, most recent first.
type userPipelinesResponse struct {
	Pipelines []runStateResponse `json:"pipelines"`
}

// errorResponse is the uniform error envelope.
type errorResponse struct {
	Error string `json:"error"`
}

// JobCatalogEntry describes one supported job type for GET /jobs. Exported so
// cmd/api can populate it from internal/catalog without the api package
// depending on the catalog.
type JobCatalogEntry struct {
	Type          string          `json:"type" example:"watch_sync"`
	Description   string          `json:"description"`
	UserInitiable bool            `json:"user_initiable"`
	InputSchema   json.RawMessage `json:"input_schema" swaggertype:"object"`
	ExampleInput  json.RawMessage `json:"example_input" swaggertype:"object"`
}

// jobCatalogResponse is the GET /jobs body.
type jobCatalogResponse struct {
	Jobs []JobCatalogEntry `json:"jobs"`
}

// PipelineStepInfo names one step of a pipeline (its ordered job type).
type PipelineStepInfo struct {
	Name    string `json:"name"`
	JobType string `json:"job_type"`
}

// PipelineCatalogEntry describes one supported pipeline for GET /pipelines.
type PipelineCatalogEntry struct {
	Name          string             `json:"name" example:"onboarding"`
	Description   string             `json:"description"`
	UserInitiable bool               `json:"user_initiable"`
	Steps         []PipelineStepInfo `json:"steps"`
	InputSchema   json.RawMessage    `json:"input_schema" swaggertype:"object"`
	ExampleInput  json.RawMessage    `json:"example_input" swaggertype:"object"`
}

// pipelineCatalogResponse is the GET /pipelines body.
type pipelineCatalogResponse struct {
	Pipelines []PipelineCatalogEntry `json:"pipelines"`
}

func toJobStateResponse(j *job.Job) jobStateResponse {
	return jobStateResponse{
		JobID:        j.ID,
		PartitionKey: j.PartitionKey,
		JobType:      j.Type,
		Status:       string(j.Status),
		ProgressPct:  j.ProgressPct,
		Stage:        j.Stage,
		Attempts:     j.Attempts,
		ResultJSON:   j.ResultJSON,
		ErrorCode:    j.ErrorCode,
		ErrorMessage: j.ErrorMessage,
		CreatedAt:    j.CreatedAt,
		UpdatedAt:    j.UpdatedAt,
		CompletedAt:  j.CompletedAt,
	}
}

func toRunStateResponse(r *job.PipelineRun) runStateResponse {
	steps := make([]pipelineStepResponse, len(r.Steps))
	for i, s := range r.Steps {
		steps[i] = pipelineStepResponse{
			Name:    s.Name,
			JobType: s.JobType,
			Status:  string(s.Status),
			JobID:   s.JobID,
		}
	}
	return runStateResponse{
		RunID:        r.RunID,
		PartitionKey: r.PartitionKey,
		UserID:       r.UserID,
		PipelineName: r.Name,
		Status:       string(r.Status),
		CurrentStep:  r.CurrentStep,
		Steps:        steps,
		ErrorMessage: r.ErrorMessage,
		CreatedAt:    r.CreatedAt,
		UpdatedAt:    r.UpdatedAt,
		CompletedAt:  r.CompletedAt,
	}
}
