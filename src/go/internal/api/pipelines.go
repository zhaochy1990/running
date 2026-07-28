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
//	@Description	Starts a named pipeline (a linear sequence of jobs). Internal callers may start any cataloged pipeline in any partition; user callers may only start user-initiable pipelines in their own partition. Supply an Idempotency-Key header to make retries safe.
//	@Tags			pipelines
//	@Accept			json
//	@Produce		json
//	@Param			name			path		string					true	"Pipeline name"
//	@Param			Idempotency-Key	header		string					false	"Deduplicates creation; a repeat key returns the existing run (200)"
//	@Param			body			body		startPipelineRequest	false	"Optional partition/input"
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

	partition := resolvePartition(caller, body.PartitionKey)
	idem := c.GetHeader("Idempotency-Key")

	if idem != "" {
		if existing, err := s.runsIdem.PipelineRunByIdempotencyKey(c.Request.Context(), partition, idem); err == nil {
			c.JSON(http.StatusOK, startPipelineResponse{RunID: existing.RunID, PartitionKey: partition, PipelineName: name, Deduplicated: true})
			return
		} else if !job.IsNotFound(err) {
			s.log.Error("idempotency lookup failed", zapErr(err))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
	}

	runID, err := s.pipelines.StartPipeline(c.Request.Context(), name, partition, idem)
	if errors.Is(err, job.ErrConflict) {
		existing, lookupErr := s.runsIdem.PipelineRunByIdempotencyKey(c.Request.Context(), partition, idem)
		if lookupErr != nil {
			s.log.Error("conflict resolve failed", zapErr(lookupErr))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
		c.JSON(http.StatusOK, startPipelineResponse{RunID: existing.RunID, PartitionKey: partition, PipelineName: name, Deduplicated: true})
		return
	}
	if err != nil {
		s.log.Error("start pipeline failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "start pipeline failed"})
		return
	}
	c.JSON(http.StatusAccepted, startPipelineResponse{RunID: runID, PartitionKey: partition, PipelineName: name})
}

// getPipelineRun godoc
//
//	@Summary		Get a pipeline run's status
//	@Tags			pipelines
//	@Produce		json
//	@Param			partition_key	path		string	true	"Partition key (user id, or Global)"
//	@Param			run_id			path		string	true	"Run id"
//	@Success		200				{object}	runStateResponse
//	@Failure		401				{object}	errorResponse
//	@Failure		403				{object}	errorResponse
//	@Failure		404				{object}	errorResponse
//	@Failure		500				{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/pipelines/{partition_key}/{run_id} [get]
func (s *Service) getPipelineRun(c *gin.Context) {
	caller := callerFrom(c)
	partition := c.Param("partition_key")
	runID := c.Param("run_id")

	if caller.Tier == TierUser && partition != caller.UserID {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}

	run, err := s.runs.Get(c.Request.Context(), partition, runID)
	if job.IsNotFound(err) {
		c.JSON(http.StatusNotFound, errorResponse{Error: "not found"})
		return
	}
	if err != nil {
		s.log.Error("get run failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusOK, toRunStateResponse(run))
}
