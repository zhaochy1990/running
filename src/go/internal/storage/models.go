// Package storage is the only place that talks to MySQL. It maps the job domain
// (internal/job) onto GORM models and implements job.Store / job.PipelineStore.
//
// Timestamps are DATETIME(6) holding UTC; the DSN is forced to loc=UTC &
// parseTime=true (see Open) and GORM's automatic timestamp management is
// disabled so the domain remains the single source of time truth (ADR 0003).
package storage

import (
	"encoding/json"
	"time"

	"github.com/zhaochy1990/stride/internal/job"
)

// jobModel is the GORM row for a job. autoCreateTime/autoUpdateTime are disabled
// so GORM never overwrites the timestamps the domain sets.
type jobModel struct {
	ID           string `gorm:"column:id;type:char(36);primaryKey"`
	PartitionKey string `gorm:"column:partition_key;type:varchar(191);index:idx_jobs_partition;uniqueIndex:uq_jobs_partition_idem,priority:1;not null"`
	Type         string `gorm:"column:job_type;type:varchar(191);index;not null"`
	Status       string `gorm:"column:status;type:varchar(32);index;not null"`
	Attempts     int    `gorm:"column:attempts;not null;default:0"`
	Stage        string `gorm:"column:stage;type:varchar(191)"`
	ProgressPct  int    `gorm:"column:progress_pct;not null;default:0"`
	InputJSON    string `gorm:"column:input_json;type:longtext"`
	ResultJSON   string `gorm:"column:result_json;type:longtext"`
	ErrorCode    string `gorm:"column:error_code;type:varchar(191)"`
	ErrorMessage string `gorm:"column:error_message;type:text"`
	// IdempotencyKey is NULL for keyless jobs (pipeline steps, retries). MySQL &
	// SQLite treat NULLs as distinct, so many keyless rows coexist while a set
	// key is unique within its partition (uq_jobs_partition_idem).
	IdempotencyKey *string    `gorm:"column:idempotency_key;type:varchar(191);uniqueIndex:uq_jobs_partition_idem,priority:2"`
	PipelineRunID  string     `gorm:"column:pipeline_run_id;type:char(36);index"`
	CreatedAt      time.Time  `gorm:"column:created_at;type:datetime(6);autoCreateTime:false"`
	UpdatedAt      time.Time  `gorm:"column:updated_at;type:datetime(6);autoUpdateTime:false"`
	CompletedAt    *time.Time `gorm:"column:completed_at;type:datetime(6)"`
}

func (jobModel) TableName() string { return "jobs" }

// nullIfEmpty maps "" -> NULL so keyless idempotency columns don't collide.
func nullIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// derefString maps a NULL idempotency column back to "".
func derefString(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func toJobModel(j *job.Job) *jobModel {
	return &jobModel{
		ID:             j.ID,
		PartitionKey:   j.PartitionKey,
		Type:           j.Type,
		Status:         string(j.Status),
		Attempts:       j.Attempts,
		Stage:          j.Stage,
		ProgressPct:    j.ProgressPct,
		InputJSON:      j.InputJSON,
		ResultJSON:     j.ResultJSON,
		ErrorCode:      j.ErrorCode,
		ErrorMessage:   j.ErrorMessage,
		IdempotencyKey: nullIfEmpty(j.IdempotencyKey),
		PipelineRunID:  j.PipelineRunID,
		CreatedAt:      j.CreatedAt,
		UpdatedAt:      j.UpdatedAt,
		CompletedAt:    j.CompletedAt,
	}
}

func (m *jobModel) toDomain() *job.Job {
	return &job.Job{
		ID:             m.ID,
		PartitionKey:   m.PartitionKey,
		Type:           m.Type,
		Status:         job.Status(m.Status),
		Attempts:       m.Attempts,
		Stage:          m.Stage,
		ProgressPct:    m.ProgressPct,
		InputJSON:      m.InputJSON,
		ResultJSON:     m.ResultJSON,
		ErrorCode:      m.ErrorCode,
		ErrorMessage:   m.ErrorMessage,
		IdempotencyKey: derefString(m.IdempotencyKey),
		PipelineRunID:  m.PipelineRunID,
		CreatedAt:      m.CreatedAt,
		UpdatedAt:      m.UpdatedAt,
		CompletedAt:    m.CompletedAt,
	}
}

// pipelineRunModel is the GORM row for a pipeline run. Steps are stored as a JSON
// blob (denormalized), matching the reference design.
type pipelineRunModel struct {
	RunID          string     `gorm:"column:run_id;type:char(36);primaryKey"`
	PartitionKey   string     `gorm:"column:partition_key;type:varchar(191);index:idx_runs_partition;uniqueIndex:uq_runs_partition_idem,priority:1;not null"`
	Name           string     `gorm:"column:name;type:varchar(191);not null"`
	Status         string     `gorm:"column:status;type:varchar(32);index;not null"`
	CurrentStep    int        `gorm:"column:current_step;not null;default:0"`
	StepsJSON      string     `gorm:"column:steps_json;type:longtext"`
	ErrorMessage   string     `gorm:"column:error_message;type:text"`
	IdempotencyKey *string    `gorm:"column:idempotency_key;type:varchar(191);uniqueIndex:uq_runs_partition_idem,priority:2"`
	CreatedAt      time.Time  `gorm:"column:created_at;type:datetime(6);autoCreateTime:false"`
	UpdatedAt      time.Time  `gorm:"column:updated_at;type:datetime(6);autoUpdateTime:false"`
	CompletedAt    *time.Time `gorm:"column:completed_at;type:datetime(6)"`
}

func (pipelineRunModel) TableName() string { return "pipeline_runs" }

func toPipelineModel(r *job.PipelineRun) (*pipelineRunModel, error) {
	steps, err := json.Marshal(r.Steps)
	if err != nil {
		return nil, err
	}
	return &pipelineRunModel{
		RunID:          r.RunID,
		PartitionKey:   r.PartitionKey,
		Name:           r.Name,
		Status:         string(r.Status),
		CurrentStep:    r.CurrentStep,
		StepsJSON:      string(steps),
		ErrorMessage:   r.ErrorMessage,
		IdempotencyKey: nullIfEmpty(r.IdempotencyKey),
		CreatedAt:      r.CreatedAt,
		UpdatedAt:      r.UpdatedAt,
		CompletedAt:    r.CompletedAt,
	}, nil
}

func (m *pipelineRunModel) toDomain() (*job.PipelineRun, error) {
	var steps []job.PipelineStep
	if m.StepsJSON != "" {
		if err := json.Unmarshal([]byte(m.StepsJSON), &steps); err != nil {
			return nil, err
		}
	}
	return &job.PipelineRun{
		RunID:          m.RunID,
		PartitionKey:   m.PartitionKey,
		Name:           m.Name,
		Status:         job.Status(m.Status),
		CurrentStep:    m.CurrentStep,
		Steps:          steps,
		ErrorMessage:   m.ErrorMessage,
		IdempotencyKey: derefString(m.IdempotencyKey),
		CreatedAt:      m.CreatedAt,
		UpdatedAt:      m.UpdatedAt,
		CompletedAt:    m.CompletedAt,
	}, nil
}
