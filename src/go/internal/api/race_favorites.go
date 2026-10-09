// race_favorites.go is the user-facing race-favorite surface: a sibling
// registrar sharing the auth path
//
//	GET  /api/users/me/race-favorites              (favorited race ids, published only)
//	POST /api/users/me/race-favorites/:race_id/toggle  (the list-page star tap)
//
// The list exists to feed the race-center list page's 收藏 view filter, so it
// returns the id set only — rendering is the race-calendar read surface's job.
package api

import (
	"context"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
)

// ─────────────────────────────────────────────────────────────────────────────
// Dependency. A narrow port so the api package stays free of GORM. Satisfied
// by *storage.Store.
// ─────────────────────────────────────────────────────────────────────────────

// RaceFavoriteStore is the persistence the favorite endpoints need.
type RaceFavoriteStore interface {
	ToggleRaceFavorite(ctx context.Context, userID string, raceEventID uint64) (bool, error)
	ListRaceFavoriteIDs(ctx context.Context, userID string) ([]uint64, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// Registrar
// ─────────────────────────────────────────────────────────────────────────────

type raceFavoriteRoutes struct {
	store RaceFavoriteStore
	log   *zap.Logger
}

func newRaceFavoriteRoutes(store RaceFavoriteStore, log *zap.Logger) *raceFavoriteRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &raceFavoriteRoutes{store: store, log: log}
}

func (f *raceFavoriteRoutes) register(rg *gin.RouterGroup) {
	if f.store == nil {
		return
	}
	rg.GET("/api/users/me/race-favorites", f.list)
	rg.POST("/api/users/me/race-favorites/:race_id/toggle", f.toggle)
}

// ─────────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────────

type raceFavoriteToggleResponse struct {
	RaceID    uint64 `json:"race_id"`
	Favorited bool   `json:"favorited"`
}

type raceFavoritesResponse struct {
	RaceIDs []uint64 `json:"race_ids"`
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

// toggle flips the caller's favorite mark on one race (the star tap in the race
// list). The race must be published; an unpublished or missing id answers 404.
//
//	@Summary		Toggle a race favorite
//	@Description	Toggles the current user's favorite mark on one published race and returns the resulting state.
//	@Tags			race-favorites
//	@Produce		json
//	@Param			race_id	path	int	true	"Race id"
//	@Success		200		{object}	raceFavoriteToggleResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/race-favorites/{race_id}/toggle [post]
func (f *raceFavoriteRoutes) toggle(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	raceID, ok := parseUintParam(c, "race_id")
	if !ok {
		return
	}
	favorited, err := f.store.ToggleRaceFavorite(c.Request.Context(), uid, raceID)
	if err != nil {
		writeRaceEngagementError(c, f.log, err)
		return
	}
	c.JSON(http.StatusOK, raceFavoriteToggleResponse{RaceID: raceID, Favorited: favorited})
}

// list returns the ids of the caller's favorited published races, newest
// favorite first. Unpublished (下架) races drop out silently.
//
//	@Summary		List favorited race ids
//	@Description	Returns the ids of the current user's favorited races that are still published, newest favorite first.
//	@Tags			race-favorites
//	@Produce		json
//	@Success		200		{object}	raceFavoritesResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/race-favorites [get]
func (f *raceFavoriteRoutes) list(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	ids, err := f.store.ListRaceFavoriteIDs(c.Request.Context(), uid)
	if err != nil {
		f.log.Error("race favorites: read failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusOK, raceFavoritesResponse{RaceIDs: ids})
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers (favorites + plans)
// ─────────────────────────────────────────────────────────────────────────────

// writeRaceEngagementError maps the engagement stores' sentinels onto HTTP
// status codes. All surfaces answer a missing/unpublished race and a foreign
// or missing row with the same 404 shape.
func writeRaceEngagementError(c *gin.Context, log *zap.Logger, err error) {
	switch {
	case errors.Is(err, storage.ErrRaceCalendarNotFound):
		c.JSON(http.StatusNotFound, errorResponse{Error: "race_not_found"})
	case errors.Is(err, storage.ErrRacePlanNotFound):
		c.JSON(http.StatusNotFound, errorResponse{Error: "race_plan_not_found"})
	case errors.Is(err, storage.ErrUserCustomRaceNotFound):
		c.JSON(http.StatusNotFound, errorResponse{Error: "custom_race_not_found"})
	default:
		if log != nil {
			log.Error("race engagement write failed", zap.Error(err))
		}
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
	}
}
