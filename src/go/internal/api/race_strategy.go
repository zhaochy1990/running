// race_strategy.go is the race-strategy surface (#396): the coach's structured
// race execution strategy (target time, pace table, fueling, tips) for one
// race, persisted per (user, race) with only the latest version kept.
//
//	POST /api/users/:user_id/race-strategies   (internal token: the TS coach API)
//	GET  /api/users/me/race-strategies/:race_id (report page / detail card)
//	PUT  /api/users/me/race-strategies/:race_id (runner edits in the report page)
//
// The POST and PUT share the upsert: the coach writing a new draft and the
// runner saving an edit are both "replace the latest version".
package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/racetypes"
	"github.com/zhaochy1990/stride/internal/storage"
)

// ─────────────────────────────────────────────────────────────────────────────
// Dependency. A narrow port so the api package stays free of GORM. Satisfied
// by *storage.Store.
// ─────────────────────────────────────────────────────────────────────────────

// RaceStrategyStore is the persistence the strategy endpoints need.
type RaceStrategyStore interface {
	// The bool reports whether the upsert created the row (the handler answers
	// 201 vs 200 on it).
	UpsertRaceStrategy(ctx context.Context, userID string, raceEventID uint64, itemType, content string) (*storage.RaceStrategy, bool, error)
	GetRaceStrategy(ctx context.Context, userID string, raceEventID uint64) (*storage.RaceStrategy, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// Registrar
// ─────────────────────────────────────────────────────────────────────────────

type raceStrategyRoutes struct {
	store RaceStrategyStore
	log   *zap.Logger
}

func newRaceStrategyRoutes(store RaceStrategyStore, log *zap.Logger) *raceStrategyRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &raceStrategyRoutes{store: store, log: log}
}

func (r *raceStrategyRoutes) register(rg *gin.RouterGroup) {
	if r.store == nil {
		return
	}
	rg.POST("/api/users/:user_id/race-strategies", r.insert)
	rg.GET("/api/users/me/race-strategies/:race_id", r.get)
	rg.PUT("/api/users/me/race-strategies/:race_id", r.put)
}

// ─────────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────────

// raceStrategyDTO is the wire shape: tracking fields plus the strategy content
// as a JSON object (the canonical schema lives in coach_contract; the client
// mirrors it, the server treats it as validated-at-the-edge data).
type raceStrategyDTO struct {
	RaceID    uint64         `json:"race_id"`
	ItemType  string         `json:"item_type"`
	Content   map[string]any `json:"content"`
	CreatedAt string         `json:"created_at"`
	UpdatedAt string         `json:"updated_at"`
}

type raceStrategyUpsertResponse struct {
	RaceID    uint64 `json:"race_id"`
	ItemType  string `json:"item_type"`
	UpdatedAt string `json:"updated_at"`
}

// raceStrategyInsertRequest is the internal POST body: the strategy is scoped
// by the race_event_id the coach turn targeted.
type raceStrategyInsertRequest struct {
	RaceEventID uint64         `json:"race_event_id" binding:"required"`
	ItemType    string         `json:"item_type" binding:"required"`
	Content     map[string]any `json:"content" binding:"required"`
}

// raceStrategyPutRequest is the user PUT body: the race comes from the path.
type raceStrategyPutRequest struct {
	ItemType string         `json:"item_type" binding:"required"`
	Content  map[string]any `json:"content" binding:"required"`
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

// insert persists (overwrites) the coach-generated strategy for one race.
// Internal token only — the TS coach API is the writer; it never accepts end
// users. Content must be a JSON object; the full RaceStrategy schema was
// validated on the TS side before the call.
//
//	@Summary		Save a coach race strategy
//	@Description	Internal-only. Upserts (overwrites) the user's latest race strategy for one published race; only the latest version is kept.
//	@Tags			race-strategies
//	@Accept			json
//	@Produce		json
//	@Param			user_id	path	string						true	"Target user UUID"
//	@Param			body	body	raceStrategyInsertRequest	true	"Race id, item type and strategy content JSON"
//	@Success		201		{object}	raceStrategyUpsertResponse
//	@Success		200		{object}	raceStrategyUpsertResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		422		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Router			/api/users/{user_id}/race-strategies [post]
func (r *raceStrategyRoutes) insert(c *gin.Context) {
	if callerFrom(c).Tier != TierInternal {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}
	uid := c.Param("user_id")
	if _, err := uuid.Parse(uid); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_user"})
		return
	}
	var req raceStrategyInsertRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		if isBodyTooLarge(err) {
			c.JSON(http.StatusRequestEntityTooLarge, errorResponse{Error: "race_strategy_too_large"})
			return
		}
		r.log.Warn("insert race strategy bind failed", zapErr(err), zap.String("user_id", uid))
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_content"})
		return
	}
	if !racetypes.IsValid(req.ItemType) {
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_item_type"})
		return
	}
	encoded, err := json.Marshal(req.Content)
	if err != nil {
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_content"})
		return
	}
	strategy, created, err := r.store.UpsertRaceStrategy(c.Request.Context(), uid, req.RaceEventID, req.ItemType, string(encoded))
	if err != nil {
		writeRaceEngagementError(c, r.log, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	c.JSON(status, raceStrategyUpsertResponse{
		RaceID:    strategy.RaceEventID,
		ItemType:  strategy.ItemType,
		UpdatedAt: strategy.UpdatedAt.UTC().Format(time.RFC3339),
	})
}

// get returns the caller's latest strategy for one race (the detail card's
// summary state and the report page's full content). 404 when none exists.
//
//	@Summary		Get my race strategy
//	@Description	Returns the current user's latest race strategy for one race.
//	@Tags			race-strategies
//	@Produce		json
//	@Param			race_id	path	int	true	"Race id"
//	@Success		200		{object}	raceStrategyDTO
//	@Failure		401		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/race-strategies/{race_id} [get]
func (r *raceStrategyRoutes) get(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	raceID, ok := parseUintParam(c, "race_id")
	if !ok {
		return
	}
	strategy, err := r.store.GetRaceStrategy(c.Request.Context(), uid, raceID)
	if errors.Is(err, storage.ErrRaceStrategyNotFound) {
		c.JSON(http.StatusNotFound, errorResponse{Error: "race_strategy_not_found"})
		return
	}
	if err != nil {
		r.log.Error("get race strategy failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusOK, newRaceStrategyDTO(strategy))
}

// put saves the runner's edits from the report page (pace table / fueling
// rows). Same overwrite semantics as the coach insert: the edit becomes the
// latest version.
//
//	@Summary		Update my race strategy
//	@Description	Upserts (overwrites) the current user's race strategy edits for one published race.
//	@Tags			race-strategies
//	@Accept			json
//	@Produce		json
//	@Param			race_id	path	int						true	"Race id"
//	@Param			body	body	raceStrategyPutRequest	true	"Item type and strategy content JSON"
//	@Success		201		{object}	raceStrategyUpsertResponse
//	@Success		200		{object}	raceStrategyUpsertResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		422		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/race-strategies/{race_id} [put]
func (r *raceStrategyRoutes) put(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	raceID, ok := parseUintParam(c, "race_id")
	if !ok {
		return
	}
	var req raceStrategyPutRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		if isBodyTooLarge(err) {
			c.JSON(http.StatusRequestEntityTooLarge, errorResponse{Error: "race_strategy_too_large"})
			return
		}
		r.log.Warn("put race strategy bind failed", zapErr(err))
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_content"})
		return
	}
	if !racetypes.IsValid(req.ItemType) {
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_item_type"})
		return
	}
	encoded, err := json.Marshal(req.Content)
	if err != nil {
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_content"})
		return
	}
	strategy, created, err := r.store.UpsertRaceStrategy(c.Request.Context(), uid, raceID, req.ItemType, string(encoded))
	if err != nil {
		writeRaceEngagementError(c, r.log, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	c.JSON(status, raceStrategyUpsertResponse{
		RaceID:    strategy.RaceEventID,
		ItemType:  strategy.ItemType,
		UpdatedAt: strategy.UpdatedAt.UTC().Format(time.RFC3339),
	})
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

func newRaceStrategyDTO(row *storage.RaceStrategy) raceStrategyDTO {
	var content map[string]any
	if err := json.Unmarshal([]byte(row.Content), &content); err != nil {
		// The writer validates object shape; a corrupt row must not 500 the
		// read — the client renders an empty strategy instead.
		content = map[string]any{}
	}
	return raceStrategyDTO{
		RaceID:    row.RaceEventID,
		ItemType:  row.ItemType,
		Content:   content,
		CreatedAt: row.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt: row.UpdatedAt.UTC().Format(time.RFC3339),
	}
}
