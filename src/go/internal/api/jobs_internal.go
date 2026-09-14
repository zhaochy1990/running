package api

import (
	"errors"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/job"
)

// Internal-only plan-job surface (ADR 0033): a create-without-publish endpoint
// the Coach API uses to persist a plan job row before publishing the pointer to
// its own queue, a transition endpoint the TS worker reports every state change
// through, a stale-running reconcile, and the unified admin async list. Only the
// server-to-server internal tier may call the mutating endpoints; admin JWT and
// internal both read the unified list.

type createInternalJobRequest struct {
	JobID          string `json:"job_id" binding:"required"`
	UserID         string `json:"user_id"`
	JobType        string `json:"job_type" binding:"required"`
	InputJSON      string `json:"input_json"`
	IdempotencyKey string `json:"idempotency_key"`
}

type createInternalJobResponse struct {
	JobID string `json:"job_id"`
	// Created is false when the idempotency key resolved to an existing job.
	Created bool `json:"created"`
}

// createInternalJob persists a queued job row without publishing. The caller
// (Coach API) owns the broker pointer for the plan-job queue, so it publishes
// after this returns created=true. Idempotent on (user_id, idempotency_key).
//
//	@Summary		Create a job row (internal, no publish)
//	@Description	Internal-only. Persists a queued job row and returns it without publishing a broker pointer — the caller publishes. Idempotent on (user_id, idempotency_key); a repeat key returns the existing job with created=false.
//	@Tags			jobs
//	@Accept			json
//	@Produce		json
//	@Param			body	body		createInternalJobRequest	true	"Job row to persist"
//	@Success		201		{object}	createInternalJobResponse	"Created"
//	@Success		200		{object}	createInternalJobResponse	"Existing job for a repeated idempotency key"
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Router			/api/internal/jobs [post]
func (s *Service) createInternalJob(c *gin.Context) {
	if callerFrom(c).Tier != TierInternal {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}

	var body createInternalJobRequest
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request body"})
		return
	}
	if _, err := uuid.Parse(body.JobID); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid job_id"})
		return
	}

	ctx := c.Request.Context()
	if body.IdempotencyKey != "" {
		if existing, err := s.jobsIdem.JobByIdempotencyKey(ctx, body.UserID, body.IdempotencyKey); err == nil {
			c.JSON(http.StatusOK, createInternalJobResponse{JobID: existing.ID, Created: false})
			return
		} else if !job.IsNotFound(err) {
			s.log.Error("internal job idempotency lookup failed", zapErr(err))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
	}

	now := time.Now().UTC().Truncate(time.Millisecond)
	j := &job.Job{
		ID:             body.JobID,
		UserID:         body.UserID,
		Type:           body.JobType,
		Status:         job.StatusQueued,
		InputJSON:      body.InputJSON,
		IdempotencyKey: body.IdempotencyKey,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	if err := s.jobsCreate.Create(ctx, j); err != nil {
		if errors.Is(err, job.ErrConflict) {
			existing, lookupErr := s.jobsIdem.JobByIdempotencyKey(ctx, body.UserID, body.IdempotencyKey)
			if lookupErr != nil {
				s.log.Error("internal job conflict resolve failed", zapErr(lookupErr))
				c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
				return
			}
			c.JSON(http.StatusOK, createInternalJobResponse{JobID: existing.ID, Created: false})
			return
		}
		s.log.Error("internal job create failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusCreated, createInternalJobResponse{JobID: j.ID, Created: true})
}

// getInternalJob reads the full job row for the worker (input_json included,
// unlike the user-facing GET /jobs/{id}).
//
//	@Summary		Get a job row (internal)
//	@Description	Internal-only. Returns the full job row including input_json, for the plan-job worker (ADR 0033).
//	@Tags			jobs
//	@Produce		json
//	@Param			job_id	path	string	true	"Job id"
//	@Success		200	{object}	jobStateResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		403	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		InternalToken
//	@Router			/api/internal/jobs/{job_id} [get]
func (s *Service) getInternalJob(c *gin.Context) {
	if callerFrom(c).Tier != TierInternal {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}
	j, err := s.jobs.Get(c.Request.Context(), c.Param("job_id"))
	if job.IsNotFound(err) {
		c.JSON(http.StatusNotFound, errorResponse{Error: "not found"})
		return
	}
	if err != nil {
		s.log.Error("get internal job failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusOK, toJobStateResponse(j))
}

type jobTransitionRequest struct {
	From          *string    `json:"from,omitempty"`
	To            string     `json:"to" binding:"required"`
	Attempts      *int       `json:"attempts,omitempty"`
	AttemptsDelta *int       `json:"attempts_delta,omitempty"`
	AttemptsLT    *int       `json:"attempts_lt,omitempty"`
	Stage         *string    `json:"stage,omitempty"`
	ProgressPct   *int       `json:"progress_pct,omitempty"`
	ErrorCode     *string    `json:"error_code,omitempty"`
	ErrorMessage  *string    `json:"error_message,omitempty"`
	ClearError    bool       `json:"clear_error,omitempty"`
	ResultJSON    *string    `json:"result_json,omitempty"`
	HeartbeatAt   *time.Time `json:"heartbeat_at,omitempty"`
	CompletedAt   *time.Time `json:"completed_at,omitempty"`
}

// transitionJob applies a compare-and-set state change to a job row (ADR 0033).
// The worker sends each stage/progress/terminal change here; From guards the
// write so a duplicate or racing pointer cannot clobber a newer state.
//
//	@Summary		Transition a job (internal)
//	@Description	Internal-only. Applies a compare-and-set state change: From is the expected current status (nil = unconditional), AttemptsLT an extra guard on the current attempts, To the new one, plus optional attempts/delta progress/error/heartbeat fields. 409 when a guard fails.
//	@Tags			jobs
//	@Accept			json
//	@Produce		json
//	@Param			job_id	path	string					true	"Job id"
//	@Param			body	body	jobTransitionRequest	true	"State transition"
//	@Success		200		{object}	jobStateResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		409		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Router			/api/internal/jobs/{job_id}/transition [post]
func (s *Service) transitionJob(c *gin.Context) {
	if callerFrom(c).Tier != TierInternal {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}
	var body jobTransitionRequest
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request body"})
		return
	}

	tr := job.JobTransition{To: job.Status(body.To)}
	if body.From != nil {
		from := job.Status(*body.From)
		tr.From = &from
	}
	tr.Attempts = body.Attempts
	tr.AttemptsDelta = body.AttemptsDelta
	tr.AttemptsLT = body.AttemptsLT
	tr.Stage = body.Stage
	tr.ProgressPct = body.ProgressPct
	tr.ErrorCode = body.ErrorCode
	tr.ErrorMessage = body.ErrorMessage
	tr.ClearError = body.ClearError
	tr.ResultJSON = body.ResultJSON
	tr.HeartbeatAt = body.HeartbeatAt
	tr.CompletedAt = body.CompletedAt

	updated, err := s.jobsTransition.TransitionJob(c.Request.Context(), c.Param("job_id"), tr)
	if job.IsNotFound(err) {
		c.JSON(http.StatusNotFound, errorResponse{Error: "not found"})
		return
	}
	if errors.Is(err, job.ErrStateChanged) {
		c.JSON(http.StatusConflict, errorResponse{Error: "job_state_changed"})
		return
	}
	if err != nil {
		s.log.Error("job transition failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusOK, toJobStateResponse(updated))
}

type staleRunningRequest struct {
	OlderThan *time.Time `json:"older_than" binding:"required"`
	ErrorCode string     `json:"error_code" binding:"required"`
}

// failStaleRunningJobs fails every running job whose heartbeat is older than
// older_than (the plan-job worker's stale-running reconcile backstop).
//
//	@Summary		Fail stale running jobs (internal)
//	@Description	Internal-only. Fails every running job whose heartbeat is older than older_than, tagged with error_code. Returns how many were failed.
//	@Tags			jobs
//	@Accept			json
//	@Produce		json
//	@Param			body	body	staleRunningRequest	true	"Reconcile window and error code"
//	@Success		200		{object}	map[string]interface{}
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Router			/api/internal/jobs/stale-running [post]
func (s *Service) failStaleRunningJobs(c *gin.Context) {
	if callerFrom(c).Tier != TierInternal {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}
	var body staleRunningRequest
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request body"})
		return
	}
	count, err := s.jobsStale.FailStaleRunningJobs(
		c.Request.Context(), *body.OlderThan, time.Now().UTC().Truncate(time.Millisecond), body.ErrorCode,
	)
	if err != nil {
		s.log.Error("fail stale running jobs failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"failed": count})
}

// asyncRunResponse is one entry in the unified admin async view: a pipeline run
// or a standalone job (plan job). Kind discriminates the shapes.
type asyncRunResponse struct {
	RunID        string                 `json:"run_id"`
	Kind         string                 `json:"kind"`
	Name         string                 `json:"name"`
	UserID       string                 `json:"user_id,omitempty"`
	CreatedBy    string                 `json:"created_by,omitempty"`
	Status       string                 `json:"status"`
	CurrentStep  int                    `json:"current_step,omitempty"`
	Steps        []pipelineStepResponse `json:"steps,omitempty"`
	Stage        string                 `json:"stage,omitempty"`
	ProgressPct  int                    `json:"progress_pct,omitempty"`
	Attempts     int                    `json:"attempts,omitempty"`
	ErrorMessage string                 `json:"error_message,omitempty"`
	CreatedAt    time.Time              `json:"created_at"`
	UpdatedAt    time.Time              `json:"updated_at"`
	CompletedAt  *time.Time             `json:"completed_at,omitempty"`
}

type asyncRunsAdminResponse struct {
	Runs   []asyncRunResponse `json:"runs"`
	Total  int64              `json:"total"`
	Limit  int                `json:"limit"`
	Offset int                `json:"offset"`
}

// listAdminAsyncRuns is the unified admin view of every async run — pipeline
// runs and standalone plan jobs together, newest first (ADR 0033).
//
//	@Summary		List async runs (admin)
//	@Description	Lists pipeline runs and standalone jobs together, newest first. Admin JWT or internal token only. Filters by status / user_id / name, paginated with limit+offset; total is the count matching the filters (before pagination).
//	@Tags			jobs
//	@Produce		json
//	@Param			status	query	string	false	"Filter by status (queued|running|done|failed)"
//	@Param			user_id	query	string	false	"Filter by subject user id"
//	@Param			name	query	string	false	"Filter by pipeline name or job type"
//	@Param			limit	query	int		false	"Page size (default 50, max 200)"
//	@Param			offset	query	int		false	"Page offset"
//	@Success		200		{object}	asyncRunsAdminResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/admin/async-runs [get]
func (s *Service) listAdminAsyncRuns(c *gin.Context) {
	if !adminOrInternal(c) {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}

	// Fetch both halves with the same filters, merge newest-first, then page the
	// merged set. The plan-job population is tiny, so an in-memory merge is fine.
	// ponytail: unbounded fetch per kind, capped at maxAsyncRunsPage each; if
	// standalone jobs ever grow past that, move the merge into SQL.
	limit := asyncPageLimit(c.Query("limit"))
	offset := asyncPageOffset(c.Query("offset"))

	opts := job.PipelineListOptions{
		UserID:       c.Query("user_id"),
		PipelineName: c.Query("name"),
		Status:       c.Query("status"),
		Limit:        maxAsyncRunsPage,
	}
	runs, runTotal, err := s.runsAdminList.ListAllPipelineRuns(c.Request.Context(), opts)
	if err != nil {
		s.log.Error("list admin async runs (pipelines) failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	jobs, jobTotal, err := s.jobsAdminList.ListAllJobs(c.Request.Context(), opts)
	if err != nil {
		s.log.Error("list admin async runs (jobs) failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}

	entries := make([]asyncRunResponse, 0, len(runs)+len(jobs))
	for _, r := range runs {
		steps := make([]pipelineStepResponse, len(r.Steps))
		for i, st := range r.Steps {
			steps[i] = pipelineStepResponse{
				Name:              st.Name,
				JobType:           st.JobType,
				Status:            string(st.Status),
				JobID:             st.JobID,
				ContinueOnFailure: st.ContinueOnFailure,
			}
		}
		entries = append(entries, asyncRunResponse{
			RunID: r.RunID, Kind: "pipeline", Name: r.Name, UserID: r.UserID, CreatedBy: r.CreatedBy,
			Status: string(r.Status), CurrentStep: r.CurrentStep, Steps: steps, ErrorMessage: r.ErrorMessage,
			CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt, CompletedAt: r.CompletedAt,
		})
	}
	for _, j := range jobs {
		entries = append(entries, asyncRunResponse{
			RunID: j.ID, Kind: "job", Name: j.Type, UserID: j.UserID, CreatedBy: j.CreatedBy,
			Status: string(j.Status), Stage: j.Stage, ProgressPct: j.ProgressPct, Attempts: j.Attempts,
			ErrorMessage: j.ErrorMessage, CreatedAt: j.CreatedAt, UpdatedAt: j.UpdatedAt, CompletedAt: j.CompletedAt,
		})
	}
	sort.Slice(entries, func(i, jj int) bool { return entries[i].CreatedAt.After(entries[jj].CreatedAt) })

	total := int64(runTotal + jobTotal)
	start := offset
	if start > len(entries) {
		start = len(entries)
	}
	end := start + limit
	if end > len(entries) {
		end = len(entries)
	}
	c.JSON(http.StatusOK, asyncRunsAdminResponse{
		Runs:   entries[start:end],
		Total:  total,
		Limit:  limit,
		Offset: offset,
	})
}

// maxAsyncRunsPage caps the merged admin list page (mirrors the storage cap for
// pipeline runs).
const maxAsyncRunsPage = 200

func asyncPageLimit(raw string) int {
	limit, err := strconv.Atoi(raw)
	if err != nil || limit <= 0 {
		return 50
	}
	if limit > maxAsyncRunsPage {
		return maxAsyncRunsPage
	}
	return limit
}

func asyncPageOffset(raw string) int {
	offset, err := strconv.Atoi(raw)
	if err != nil || offset < 0 {
		return 0
	}
	return offset
}
