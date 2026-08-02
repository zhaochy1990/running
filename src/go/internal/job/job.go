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

// Job is the durable record of one unit of background work. It is the source of
// truth (persisted in MySQL); the broker only carries a pointer to it.
type Job struct {
	ID string
	// UserID is the athlete whose data this job operates on (the subject). It is
	// the JWT sub for user-scoped work; empty for system jobs (e.g. the deploy
	// smoke handler), stored as NULL. It is the sole identity a handler reads to
	// know whose data to act on, and the only value the user-tier auth check
	// compares against the caller's JWT sub.
	UserID string
	// CreatedBy is the identity that triggered this job's creation (the actor):
	// the JWT sub when a user created it directly, or empty (NULL) when an
	// internal (X-Internal-Token) caller or the orchestrator created it. Pure
	// provenance — never used for authorization.
	CreatedBy    string
	Type         string
	Status       Status
	Attempts     int
	Stage        string
	ProgressPct  int
	InputJSON    string
	ResultJSON   string
	ErrorCode    string
	ErrorMessage string
	// IdempotencyKey deduplicates client-driven creation: at most one job may
	// exist per (UserID, IdempotencyKey). Empty means "no key" (stored as
	// NULL so keyless jobs — pipeline steps, retries — never collide).
	IdempotencyKey string
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

// PipelineRun is one execution of a named pipeline for one athlete.
type PipelineRun struct {
	RunID string
	// UserID is the athlete whose data this run operates on (the subject): the
	// JWT sub for a user-scoped run, empty (NULL) for a system run. It is what
	// the user-tier auth check and the per-user listing compare against, and it
	// flows down to every step job's UserID.
	UserID string
	// CreatedBy is the identity that triggered this run (the actor): the JWT sub
	// when a user started it, or empty (NULL) when an internal (X-Internal-Token)
	// caller did. Provenance only — never used for authorization. Coincides with
	// UserID for user-started runs; empty when an internal caller starts a run
	// targeting an athlete's data.
	CreatedBy string
	Name      string
	// InputJSON is the run-level input supplied at StartPipeline. The orchestrator
	// threads it into every step's job InputJSON (merged with the previous step's
	// ResultJSON), so a pipeline can carry parameters (e.g. sync mode) to its
	// steps and pass one step's output to the next.
	InputJSON    string
	Status       Status
	CurrentStep  int
	Steps        []PipelineStep
	ErrorMessage string
	// IdempotencyKey deduplicates client-driven starts: at most one run may
	// exist per (UserID, IdempotencyKey). Empty means "no key" (NULL).
	IdempotencyKey string
	CreatedAt      time.Time
	UpdatedAt      time.Time
	CompletedAt    *time.Time
}

// Message is the pointer published to the broker. Full state lives in the store,
// keyed by the globally-unique JobID; UserID rides along only for log context.
type Message struct {
	JobID  string `json:"job_id"`
	UserID string `json:"user_id"`
}
