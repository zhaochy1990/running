package api

import (
	"errors"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/zhaochy1990/stride/internal/job"
)

// startPipeline godoc
//
//	@Summary		Start a pipeline run
//	@Description	Starts a named pipeline (a linear sequence of jobs). Internal callers may start any cataloged pipeline for any user; user callers may only start user-initiable pipelines for themselves. Supply an Idempotency-Key header to make retries safe.
//	@Tags			pipelines
//	@Accept			json
//	@Produce		json
//	@Param			name			path		string					true	"Pipeline name"
//	@Param			Idempotency-Key	header		string					false	"Deduplicates creation; a repeat key returns the existing run (200)"
//	@Param			body			body		startPipelineRequest	false	"Optional subject user/input"
//	@Success		202				{object}	startPipelineResponse	"Started"
//	@Success		200				{object}	startPipelineResponse	"Existing run returned for a repeated Idempotency-Key"
//	@Failure		400				{object}	errorResponse
//	@Failure		401				{object}	errorResponse
//	@Failure		403				{object}	errorResponse
//	@Failure		500				{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/pipelines/{name} [post]
func (s *Service) startPipeline(c *gin.Context) {
	caller := callerFrom(c)
	name := c.Param("name")

	var body startPipelineRequest
	// Body is optional; tolerate an empty body (EOF) but reject a malformed one.
	if err := c.ShouldBindJSON(&body); err != nil && !errors.Is(err, io.EOF) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request body"})
		return
	}

	userInitiable, known := s.pipelineUserInitiable[name]
	if !known {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "unknown pipeline"})
		return
	}
	if caller.Tier == TierUser && !userInitiable {
		c.JSON(http.StatusForbidden, errorResponse{Error: "pipeline is not user-initiable"})
		return
	}

	userID := resolveUserID(caller, body.UserID)
	createdBy := resolveCreatedBy(caller)
	idem := c.GetHeader("Idempotency-Key")

	if idem != "" {
		if existing, err := s.runsIdem.PipelineRunByIdempotencyKey(c.Request.Context(), userID, idem); err == nil {
			c.JSON(http.StatusOK, startPipelineResponse{RunID: existing.RunID, PipelineName: name, Deduplicated: true})
			return
		} else if !job.IsNotFound(err) {
			s.log.Error("idempotency lookup failed", zapErr(err))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
	}

	runID, err := s.pipelines.StartPipeline(c.Request.Context(), name, userID, createdBy, idem)
	if errors.Is(err, job.ErrConflict) {
		existing, lookupErr := s.runsIdem.PipelineRunByIdempotencyKey(c.Request.Context(), userID, idem)
		if lookupErr != nil {
			s.log.Error("conflict resolve failed", zapErr(lookupErr))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
		c.JSON(http.StatusOK, startPipelineResponse{RunID: existing.RunID, PipelineName: name, Deduplicated: true})
		return
	}
	if err != nil {
		s.log.Error("start pipeline failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "start pipeline failed"})
		return
	}
	c.JSON(http.StatusAccepted, startPipelineResponse{RunID: runID, PipelineName: name})
}

// getPipelineRun godoc
//
//	@Summary		Get a pipeline run's status
//	@Tags			pipelines
//	@Produce		json
//	@Param			run_id	path		string	true	"Run id"
//	@Success		200		{object}	runStateResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/pipelines/{run_id} [get]
func (s *Service) getPipelineRun(c *gin.Context) {
	caller := callerFrom(c)
	runID := c.Param("run_id")

	run, err := s.runs.Get(c.Request.Context(), runID)
	if job.IsNotFound(err) {
		c.JSON(http.StatusNotFound, errorResponse{Error: "not found"})
		return
	}
	if err != nil {
		s.log.Error("get run failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	// A user may read only their own run; hide others' existence as 404.
	if caller.Tier == TierUser && run.UserID != caller.UserID {
		c.JSON(http.StatusNotFound, errorResponse{Error: "not found"})
		return
	}
	c.JSON(http.StatusOK, toRunStateResponse(run))
}

// listUserPipelines godoc
//
//	@Summary		List a user's pipeline runs
//	@Description	Lists the pipeline runs for a user (the subject whose data they operate on), most recent first. A user caller may only list their own runs (uid must equal their JWT sub); an internal caller may list any uid.
//	@Tags			pipelines
//	@Produce		json
//	@Param			uid	path		string	true	"User id (the subject; JWT sub)"
//	@Success		200	{object}	userPipelinesResponse
//	@Failure		400	{object}	errorResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		403	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/users/{uid}/pipelines [get]
func (s *Service) listUserPipelines(c *gin.Context) {
	caller := callerFrom(c)
	uid := c.Param("uid")
	if uid == "" {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "user id required"})
		return
	}
	if caller.Tier == TierUser && uid != caller.UserID {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}

	runs, err := s.runsList.PipelineRunsByUser(c.Request.Context(), uid)
	if err != nil {
		s.log.Error("list user pipelines failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	pipelines := make([]runStateResponse, len(runs))
	for i, r := range runs {
		pipelines[i] = toRunStateResponse(r)
	}
	c.JSON(http.StatusOK, userPipelinesResponse{Pipelines: pipelines})
}
