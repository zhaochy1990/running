package api

import (
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/zhaochy1990/stride/internal/job"
)

// startPipeline godoc
//
//	@Summary		Start a pipeline run
//	@Description	Starts a named pipeline (a linear sequence of jobs). The pipeline name is supplied in the request body. Internal callers may start any cataloged pipeline for any user; user callers may only start user-initiable pipelines for themselves. Supply an Idempotency-Key header to make retries safe.
//	@Tags			pipelines
//	@Accept			json
//	@Produce		json
//	@Param			Idempotency-Key	header		string					false	"Deduplicates creation; a repeat key returns the existing run (200)"
//	@Param			body			body		startPipelineRequest	true	"Pipeline name (required) and optional subject user/input"
//	@Success		202				{object}	startPipelineResponse	"Started"
//	@Success		200				{object}	startPipelineResponse	"Existing run returned for a repeated Idempotency-Key"
//	@Failure		400				{object}	errorResponse
//	@Failure		401				{object}	errorResponse
//	@Failure		403				{object}	errorResponse
//	@Failure		500				{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/pipelines [post]
func (s *Service) startPipeline(c *gin.Context) {
	caller := callerFrom(c)

	var body startPipelineRequest
	// Tolerate an empty body (EOF) so the missing-name check below owns that
	// error, but reject a malformed one.
	if err := c.ShouldBindJSON(&body); err != nil && !errors.Is(err, io.EOF) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request body"})
		return
	}

	name := body.Name
	if name == "" {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "pipeline name required"})
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

	runID, err := s.pipelines.StartPipeline(c.Request.Context(), name, userID, createdBy, idem, string(body.Input))
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
//	@Description	Reads one asynchronous pipeline run. Web onboarding polls the /api alias with the run_id returned by POST /api/{user}/sync; a done run remains separate from explicit onboarding finalization.
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
//	@Router			/api/pipelines/{run_id} [get]
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
	uid := c.Param("user_id")
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

// adminOrInternal reports whether the caller is an administrator (separate
// admin JWT audience + role=admin) or a trusted server-to-server caller
// (X-Internal-Token) — the two classes the admin pipeline-status surface admits.
func adminOrInternal(c *gin.Context) bool {
	tier := callerFrom(c).Tier
	return tier == TierAdmin || tier == TierInternal
}

// listAdminPipelineRuns godoc
//
//	@Summary		List pipeline runs (admin)
//	@Description	Lists pipeline runs across all users, newest first. Admin JWT or internal token only; user callers are denied. Filters by status / user_id / pipeline_name, paginated with limit+offset; total is the count matching the filters (before pagination).
//	@Tags			pipelines
//	@Produce		json
//	@Param			status			query		string	false	"Filter by run status (queued|running|done|failed)"
//	@Param			user_id			query		string	false	"Filter by subject user id"
//	@Param			pipeline_name	query		string	false	"Filter by pipeline name"
//	@Param			limit			query		int		false	"Page size (default 50, max 200)"
//	@Param			offset			query		int		false	"Page offset"
//	@Success		200				{object}	pipelineRunsAdminResponse
//	@Failure		401				{object}	errorResponse
//	@Failure		403				{object}	errorResponse
//	@Failure		500				{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/admin/pipeline-runs [get]
func (s *Service) listAdminPipelineRuns(c *gin.Context) {
	if !adminOrInternal(c) {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}

	limit, _ := strconv.Atoi(c.Query("limit"))
	offset, _ := strconv.Atoi(c.Query("offset"))
	runs, total, err := s.runsAdminList.ListAllPipelineRuns(c.Request.Context(), job.PipelineListOptions{
		UserID:       c.Query("user_id"),
		PipelineName: c.Query("pipeline_name"),
		Status:       c.Query("status"),
		Limit:        limit,
		Offset:       offset,
	})
	if err != nil {
		s.log.Error("list admin pipeline runs failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	resp := pipelineRunsAdminResponse{
		Runs:   make([]runStateResponse, len(runs)),
		Total:  total,
		Limit:  limit,
		Offset: offset,
	}
	for i, r := range runs {
		resp.Runs[i] = toRunStateResponse(r)
	}
	c.JSON(http.StatusOK, resp)
}

// getAdminPipelineRun godoc
//
//	@Summary		Get a pipeline run (admin)
//	@Description	Reads one pipeline run regardless of owner. Admin JWT or internal token only; user callers are denied. A missing run returns 404.
//	@Tags			pipelines
//	@Produce		json
//	@Param			run_id	path		string	true	"Run id"
//	@Success		200		{object}	runStateResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/admin/pipeline-runs/{run_id} [get]
func (s *Service) getAdminPipelineRun(c *gin.Context) {
	if !adminOrInternal(c) {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}

	runID := c.Param("run_id")
	run, err := s.runs.Get(c.Request.Context(), runID)
	if job.IsNotFound(err) {
		c.JSON(http.StatusNotFound, errorResponse{Error: "not found"})
		return
	}
	if err != nil {
		s.log.Error("get admin pipeline run failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusOK, toRunStateResponse(run))
}
