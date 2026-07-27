// Package job defines the async-job worker domain: job/pipeline records, the
// handler registry, and the lifecycle logic (dispatch, retry/poison decisions,
// pipeline advancement). It depends on no datastore or broker — those live
// behind the ports declared in ports.go — and only on a logger for diagnostics,
// so the lifecycle logic is unit-testable with fakes.
package job

import "time"

// Status is the lifecycle state of a Job or PipelineRun.
type Status string

const (
	StatusQueued  Status = "queued"
	StatusRunning Status = "running"
	StatusDone    Status = "done"
	StatusFailed  Status = "failed"
)

// Terminal reports whether the status is a final state.
func (s Status) Terminal() bool { return s == StatusDone || s == StatusFailed }

// GlobalPartition is the partition key for cross-user, system-wide jobs.
const GlobalPartition = "Global"

// Job is the durable record of one unit of background work. It is the source of
// truth (persisted in MySQL); the broker only carries a pointer to it.
type Job struct {
	ID           string
	PartitionKey string
	Type         string
	Status       Status
	Attempts     int
	Stage        string
	ProgressPct  int
	InputJSON    string
	ResultJSON   string
	ErrorCode    string
	ErrorMessage string
	// PipelineRunID links this job back to the PipelineRun that spawned it, so
	// the orchestrator can advance the run on completion. Empty for standalone jobs.
	PipelineRunID string
	CreatedAt     time.Time
	UpdatedAt     time.Time
	CompletedAt   *time.Time
}

// PipelineStep is one node in a linear pipeline.
type PipelineStep struct {
	Name    string `json:"name"`
	JobType string `json:"job_type"`
	Status  Status `json:"status"`
	JobID   string `json:"job_id"`
}

// PipelineRun is one execution of a named pipeline for a partition.
type PipelineRun struct {
	RunID        string
	PartitionKey string
	Name         string
	Status       Status
	CurrentStep  int
	Steps        []PipelineStep
	ErrorMessage string
	CreatedAt    time.Time
	UpdatedAt    time.Time
	CompletedAt  *time.Time
}

// Message is the pointer published to the broker. Full state lives in the store,
// keyed by (PartitionKey, JobID).
type Message struct {
	JobID        string `json:"job_id"`
	PartitionKey string `json:"partition_key"`
}
