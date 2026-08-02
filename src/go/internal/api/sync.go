package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/provider"
)

// syncUser godoc
//
//	@Summary		Trigger a watch-data sync (+ compute) for a user
//	@Description	Starts the data-sync pipeline for the user and returns immediately (202) with a run id; poll GET /pipelines/{run_id} for completion. The pipeline syncs watch data and then computes derived metrics (training load, PMC, personal bests). Mode picks the pipeline: "incremental" (default) syncs only new activities and computes only those; "full" re-syncs history, recomputes the athlete baseline, and does a full compute (new-user onboarding). This is the async Go replacement for the Python POST /api/{user}/sync. A user caller may only sync their own id (path {user} must equal their JWT sub); an internal caller may sync any user (path {user} must be a UUID).
//	@Tags			sync
//	@Accept			json
//	@Produce		json
//	@Param			user	path		string					true	"User id (JWT sub, or any user UUID for internal callers)"
//	@Param			body	body		syncRequest				false	"Optional sync options; omitted mode defaults to incremental"
//	@Success		202		{object}	startPipelineResponse	"Started"
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/sync [post]
func (s *Service) syncUser(c *gin.Context) {
	caller := callerFrom(c)
	pathUser := c.Param("user")

	// Resolve the subject (whose data to sync) per tier. User tier: only your own
	// id (mirrors getJob/getPipelineRun). Internal tier: any user, but it must be
	// a UUID (mirrors Python's /internal/sync UUID4 guard) so a stray path segment
	// can't create a garbage subject.
	var userID string
	switch caller.Tier {
	case TierUser:
		if pathUser != caller.UserID {
			c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
			return
		}
		userID = caller.UserID
	default: // TierInternal
		if _, err := uuid.Parse(pathUser); err != nil {
			c.JSON(http.StatusBadRequest, errorResponse{Error: "user must be a UUID"})
			return
		}
		userID = pathUser
	}

	// Optional body {mode, content, limit}. Tolerate an empty body (EOF) but
	// reject malformed JSON.
	var body syncRequest
	if err := c.ShouldBindJSON(&body); err != nil && !errors.Is(err, io.EOF) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request body"})
		return
	}
	in := provider.SyncOptionsInput{Mode: body.Mode, Content: body.Content, Limit: body.Limit}
	// This endpoint's purpose is ongoing catch-up, so an omitted mode means
	// incremental.
	if in.Mode == "" {
		in.Mode = string(provider.SyncIncremental)
	}
	if err := in.Validate(); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: err.Error()})
		return
	}

	// Mode picks the pipeline: full -> onboarding (sync -> calibration ->
	// compute), incremental -> data_sync (sync -> compute). The {mode,content,
	// limit} body becomes the run input, threaded into every step.
	var pipelineName string
	switch in.Mode {
	case string(provider.SyncFull):
		pipelineName = s.syncPipelineFull
	default: // incremental
		pipelineName = s.syncPipelineIncremental
	}
	inputJSON, err := json.Marshal(in)
	if err != nil {
		s.log.Error("marshal sync input failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}

	runID, err := s.pipelines.StartPipeline(c.Request.Context(), pipelineName, userID, resolveCreatedBy(caller), "", string(inputJSON))
	if err != nil {
		s.log.Error("start sync pipeline failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "start sync failed"})
		return
	}
	c.JSON(http.StatusAccepted, startPipelineResponse{RunID: runID, PipelineName: pipelineName})
}
