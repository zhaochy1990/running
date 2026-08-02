package api

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/zhaochy1990/stride/internal/job"
)

// createJob godoc
//
//	@Summary		Enqueue an async job
//	@Description	Creates a job and publishes it to the worker. Internal callers may target any user and any cataloged job type; user callers may only create user-initiable types and the subject user is derived from their token. Supply an Idempotency-Key header to make retries safe.
//	@Tags			jobs
//	@Accept			json
//	@Produce		json
//	@Param			Idempotency-Key	header		string				false	"Deduplicates creation; a repeat key returns the existing job (200)"
//	@Param			body			body		createJobRequest	true	"Job to enqueue"
//	@Success		202				{object}	enqueueJobResponse	"Enqueued"
//	@Success		200				{object}	enqueueJobResponse	"Existing job returned for a repeated Idempotency-Key"
//	@Failure		400				{object}	errorResponse
//	@Failure		401				{object}	errorResponse
//	@Failure		403				{object}	errorResponse
//	@Failure		500				{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/jobs [post]
func (s *Service) createJob(c *gin.Context) {
	caller := callerFrom(c)

	var body createJobRequest
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request body"})
		return
	}

	userInitiable, known := s.jobUserInitiable[body.Type]
	if !known {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "unknown job_type"})
		return
	}
	if caller.Tier == TierUser && !userInitiable {
		c.JSON(http.StatusForbidden, errorResponse{Error: "job_type is not user-initiable"})
		return
	}

	userID := resolveUserID(caller, body.UserID)
	createdBy := resolveCreatedBy(caller)
	idem := c.GetHeader("Idempotency-Key")

	// Idempotency fast path: a matching key returns the existing job (200).
	if idem != "" {
		if existing, err := s.jobsIdem.JobByIdempotencyKey(c.Request.Context(), userID, idem); err == nil {
			c.JSON(http.StatusOK, enqueueJobResponse{JobID: existing.ID, Deduplicated: true})
			return
		} else if !job.IsNotFound(err) {
			s.log.Error("idempotency lookup failed", zapErr(err))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
	}

	jobID, err := s.enq.Enqueue(c.Request.Context(), job.EnqueueSpec{
		Type:           body.Type,
		UserID:         userID,
		CreatedBy:      createdBy,
		InputJSON:      string(body.Input),
		IdempotencyKey: idem,
	})
	if errors.Is(err, job.ErrConflict) {
		// Lost an idempotency race: another request created it first.
		existing, lookupErr := s.jobsIdem.JobByIdempotencyKey(c.Request.Context(), userID, idem)
		if lookupErr != nil {
			s.log.Error("conflict resolve failed", zapErr(lookupErr))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
		c.JSON(http.StatusOK, enqueueJobResponse{JobID: existing.ID, Deduplicated: true})
		return
	}
	if err != nil {
		s.log.Error("enqueue failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "enqueue failed"})
		return
	}
	c.JSON(http.StatusAccepted, enqueueJobResponse{JobID: jobID})
}

// getJob godoc
//
//	@Summary		Get a job's status
//	@Tags			jobs
//	@Produce		json
//	@Param			job_id	path		string	true	"Job id"
//	@Success		200		{object}	jobStateResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/jobs/{job_id} [get]
func (s *Service) getJob(c *gin.Context) {
	caller := callerFrom(c)
	jobID := c.Param("job_id")

	j, err := s.jobs.Get(c.Request.Context(), jobID)
	if job.IsNotFound(err) {
		c.JSON(http.StatusNotFound, errorResponse{Error: "not found"})
		return
	}
	if err != nil {
		s.log.Error("get job failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	// A user may read only their own job; hide others' existence as 404.
	if caller.Tier == TierUser && j.UserID != caller.UserID {
		c.JSON(http.StatusNotFound, errorResponse{Error: "not found"})
		return
	}
	c.JSON(http.StatusOK, toJobStateResponse(j))
}
