// race_strategy.go is the race-strategy surface (#396): the coach's structured
// race execution strategy (target time, pace table, fueling, tips), persisted
// per (user, race, target time) — one version per goal, the athlete's own
// decision.
//
//	POST   /api/users/:user_id/race-strategies   (internal token: the TS coach API)
//	GET    /api/users/me/race-strategies/:race_id (report page / detail card)
//	PUT    /api/users/me/race-strategies/:race_id (runner edits in the report page)
//	DELETE /api/users/me/race-strategies/:race_id (remove one target's version)
//
// The three writers share the version key: target_finish_time extracted from
// the content JSON — regenerating or editing a goal overwrites that goal's
// version and leaves other goals untouched.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
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
	// 201 vs 200 on it). TargetTime is the version key.
	UpsertRaceStrategy(ctx context.Context, userID string, raceEventID uint64, targetTime, itemType, content string) (*storage.RaceStrategy, bool, error)
	GetRaceStrategies(ctx context.Context, userID string, raceEventID uint64) ([]storage.RaceStrategy, error)
	DeleteRaceStrategy(ctx context.Context, userID string, raceEventID uint64, targetTime string) error
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
	rg.DELETE("/api/users/me/race-strategies/:race_id", r.delete)
}

// ─────────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────────

// raceStrategyVersionDTO is one goal version on the wire: the version key plus
// the strategy content as a JSON object (the canonical schema lives in
// coach_contract; the client mirrors it, the server treats it as
// validated-at-the-edge data).
type raceStrategyVersionDTO struct {
	TargetFinishTime string         `json:"target_finish_time"`
	ItemType         string         `json:"item_type"`
	Content          map[string]any `json:"content"`
	UpdatedAt        string         `json:"updated_at"`
}

// raceStrategyListDTO is the GET response: every version the runner saved for
// this race, ordered fastest goal first. Empty list means "not generated yet".
type raceStrategyListDTO struct {
	RaceID     uint64                   `json:"race_id"`
	Strategies []raceStrategyVersionDTO `json:"strategies"`
}

type raceStrategyUpsertResponse struct {
	RaceID           uint64 `json:"race_id"`
	ItemType         string `json:"item_type"`
	TargetFinishTime string `json:"target_finish_time"`
	UpdatedAt        string `json:"updated_at"`
}

// raceStrategyInsertRequest is the internal POST body: the strategy is scoped
// by the race_event_id the coach turn targeted.
type raceStrategyInsertRequest struct {
	RaceEventID uint64         `json:"race_event_id" binding:"required"`
	ItemType    string         `json:"item_type" binding:"required"`
	Content     map[string]any `json:"content" binding:"required"`
}

// raceStrategyPutRequest is the user PUT body: the race comes from the path,
// the version key from content.target_finish_time.
type raceStrategyPutRequest struct {
	ItemType string         `json:"item_type" binding:"required"`
	Content  map[string]any `json:"content" binding:"required"`
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

// insert persists (overwrites) the coach-generated strategy for one goal of
// one race. Internal token only — the TS coach API is the writer; it never
// accepts end users. Content must be a JSON object; the full RaceStrategy
// schema was validated on the TS side before the call.
//
//	@Summary		Save a coach race strategy
//	@Description	Internal-only. Upserts (overwrites) one goal version of the user's race strategy for a published race; the goal (target_finish_time in content) is the version key, other goals are untouched.
//	@Tags			race-strategies
//	@Accept			json
//	@Produce		json
//	@Param			user_id	path	string						true	"Target user UUID"
//	@Param			body	body	raceStrategyInsertRequest	true	"Race id, item type and strategy content JSON (target_finish_time inside content is the version key)"
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
	r.upsert(c, uid, req.RaceEventID, req.ItemType, req.Content)
}

// get returns every goal version the caller saved for one race (the detail
// card's summary state and the report page's version switcher). Empty list
// when none exists.
//
//	@Summary		List my race strategies
//	@Description	Returns all of the current user's race-strategy versions for one race, one per goal (target_finish_time), fastest goal first.
//	@Tags			race-strategies
//	@Produce		json
//	@Param			race_id	path	int	true	"Race id"
//	@Success		200		{object}	raceStrategyListDTO
//	@Failure		401		{object}	errorResponse
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
	rows, err := r.store.GetRaceStrategies(c.Request.Context(), uid, raceID)
	if err != nil {
		r.log.Error("list race strategies failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	versions := make([]raceStrategyVersionDTO, 0, len(rows))
	for i := range rows {
		versions = append(versions, newRaceStrategyVersionDTO(&rows[i]))
	}
	c.JSON(http.StatusOK, raceStrategyListDTO{RaceID: raceID, Strategies: versions})
}

// put saves the runner's edits from the report page (pace table / fueling
// rows) into the goal version the content belongs to (content.target_finish_time
// is the key); other goals are untouched.
//
//	@Summary		Update my race strategy
//	@Description	Upserts one goal version of the current user's race strategy for a published race; content.target_finish_time is the version key.
//	@Tags			race-strategies
//	@Accept			json
//	@Produce		json
//	@Param			race_id	path	int						true	"Race id"
//	@Param			body	body	raceStrategyPutRequest	true	"Item type and strategy content JSON (target_finish_time inside content is the version key)"
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
	r.upsert(c, uid, raceID, req.ItemType, req.Content)
}

// delete removes one goal's version; the race's other versions are untouched.
//
//	@Summary		Delete my race strategy version
//	@Description	Deletes one goal version of the current user's race strategy, keyed by the target query parameter (H:MM:SS).
//	@Tags			race-strategies
//	@Produce		json
//	@Param			race_id	path	int	true	"Race id"
//	@Param			target	query	string	true	"Target finish time (H:MM:SS) of the version to delete"
//	@Success		204
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		422		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/race-strategies/{race_id} [delete]
func (r *raceStrategyRoutes) delete(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	raceID, ok := parseUintParam(c, "race_id")
	if !ok {
		return
	}
	target := c.Query("target")
	if !raceStrategyTargetRe.MatchString(target) {
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_target_time"})
		return
	}
	err := r.store.DeleteRaceStrategy(c.Request.Context(), uid, raceID, target)
	if errors.Is(err, storage.ErrRaceStrategyNotFound) {
		c.JSON(http.StatusNotFound, errorResponse{Error: "race_strategy_not_found"})
		return
	}
	if err != nil {
		writeRaceEngagementError(c, r.log, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// raceStrategyTargetRe pins the version key to the contract's target shape
// (coach_contract: ^\d{1,2}:\d{2}:\d{2}$).
var raceStrategyTargetRe = regexp.MustCompile(`^\d{1,2}:\d{2}:\d{2}$`)

// upsert is the shared tail of insert and put: validate the vocabulary, pull
// the version key out of the content, write through the store, answer 201 on
// create / 200 on overwrite.
func (r *raceStrategyRoutes) upsert(c *gin.Context, uid string, raceEventID uint64, itemType string, content map[string]any) {
	if !racetypes.IsValid(itemType) {
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_item_type"})
		return
	}
	target, _ := content["target_finish_time"].(string)
	if !raceStrategyTargetRe.MatchString(target) {
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_target_time"})
		return
	}
	encoded, err := json.Marshal(content)
	if err != nil {
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_content"})
		return
	}
	strategy, created, err := r.store.UpsertRaceStrategy(c.Request.Context(), uid, raceEventID, target, itemType, string(encoded))
	if err != nil {
		writeRaceEngagementError(c, r.log, err)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	c.JSON(status, raceStrategyUpsertResponse{
		RaceID:           strategy.RaceEventID,
		ItemType:         strategy.ItemType,
		TargetFinishTime: strategy.TargetFinishTime,
		UpdatedAt:        strategy.UpdatedAt.UTC().Format(time.RFC3339),
	})
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

func newRaceStrategyVersionDTO(row *storage.RaceStrategy) raceStrategyVersionDTO {
	var content map[string]any
	if err := json.Unmarshal([]byte(row.Content), &content); err != nil {
		// The writer validates object shape; a corrupt row must not 500 the
		// read — the client renders an empty strategy instead.
		content = map[string]any{}
	}
	return raceStrategyVersionDTO{
		TargetFinishTime: row.TargetFinishTime,
		ItemType:         row.ItemType,
		Content:          content,
		UpdatedAt:        row.UpdatedAt.UTC().Format(time.RFC3339),
	}
}
