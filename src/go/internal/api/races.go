// races.go is the user-facing race-effort read surface: a sibling registrar
// sharing the auth path
//
//   - GET /api/{user}/races   (confirmed races, newest first)
//
// It reads the races table the race-detection pipeline fills post-sync. That
// table deliberately stores only the (user_id, label_id) reference — name,
// distance, duration and metrics stay canonical in activities — so the storage
// read joins back to activities and this handler only maps/formats rows.
package api

import (
	"context"
	"net/http"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/apifmt"
	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/racedetection"
	"github.com/zhaochy1990/stride/internal/storage"
)

// ─────────────────────────────────────────────────────────────────────────────
// Dependency. A narrow read port so the api package stays free of GORM.
// Satisfied by *storage.Store.
// ─────────────────────────────────────────────────────────────────────────────

// RaceStore is the read surface the races endpoint needs.
type RaceStore interface {
	UserRaces(ctx context.Context, userID string) ([]storage.UserRaceRow, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// Registrar
// ─────────────────────────────────────────────────────────────────────────────

type raceRoutes struct {
	store RaceStore
	log   *zap.Logger
}

func newRaceRoutes(store RaceStore, log *zap.Logger) *raceRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &raceRoutes{store: store, log: log}
}

func (r *raceRoutes) register(rg *gin.RouterGroup) {
	rg.GET("/api/:user/races", r.list)
}

// ─────────────────────────────────────────────────────────────────────────────
// DTO
// ─────────────────────────────────────────────────────────────────────────────

// raceItemDTO is one confirmed race. distance_band reuses the detector's
// distance-band vocabulary ("marathon" / "half_marathon") so clients can
// localize 全马/半马 without re-deriving thresholds; "other" covers a race row
// whose activity distance has since drifted outside the admitted bands.
type raceItemDTO struct {
	LabelID      string   `json:"label_id"`
	Name         *string  `json:"name"`
	SportName    *string  `json:"sport_name"`
	Date         string   `json:"date"`
	DistanceBand string   `json:"distance_band"`
	DistanceM    *float64 `json:"distance_m"`
	DistanceKm   float64  `json:"distance_km"`
	DurationS    *float64 `json:"duration_s"`
	DurationFmt  string   `json:"duration_fmt"`
	AvgPaceSKm   *float64 `json:"avg_pace_s_km"`
	PaceFmt      string   `json:"pace_fmt"`
	AvgHR        *int     `json:"avg_hr"`
	MaxHR        *int     `json:"max_hr"`
	AscentM      *float64 `json:"ascent_m"`
	ThumbURL     *string  `json:"thumb_url"`
}

type racesResponse struct {
	UserID string        `json:"user_id"`
	Races  []raceItemDTO `json:"races"`
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

// list returns the user's confirmed race efforts, newest first.
//
//	@Summary		List a user's confirmed races
//	@Description	Returns the half-marathon and marathon race efforts the race-detection pipeline confirmed from synced activities, newest first, with name/date/distance/duration/pace/HR joined from the canonical activity rows. A user caller may only read their own races; an internal caller may read any user.
//	@Tags			races
//	@Produce		json
//	@Param			user	path		string	true	"User id (JWT sub)"
//	@Success		200		{object}	racesResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/races [get]
func (r *raceRoutes) list(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}

	rows, err := r.store.UserRaces(c.Request.Context(), user)
	if err != nil {
		r.log.Error("races: read failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}

	races := make([]raceItemDTO, 0, len(rows))
	for i := range rows {
		races = append(races, toRaceItemDTO(&rows[i]))
	}
	c.JSON(http.StatusOK, racesResponse{UserID: user, Races: races})
}

func toRaceItemDTO(row *storage.UserRaceRow) raceItemDTO {
	return raceItemDTO{
		LabelID:      row.LabelID,
		Name:         row.Name,
		SportName:    row.SportName,
		Date:         apifmt.ShanghaiISO(row.Date),
		DistanceBand: raceDistanceBand(row.DistanceM),
		DistanceM:    row.DistanceM,
		DistanceKm:   apifmt.DistanceKm(row.DistanceM),
		DurationS:    row.DurationS,
		DurationFmt:  apifmt.DurationFmt(row.DurationS),
		AvgPaceSKm:   row.AvgPaceSKm,
		PaceFmt:      apifmt.PaceFmt(row.AvgPaceSKm),
		AvgHR:        row.AvgHR,
		MaxHR:        row.MaxHR,
		AscentM:      row.AscentM,
		ThumbURL:     row.ThumbURL,
	}
}

// raceDistanceBand classifies a distance into the detector's band vocabulary.
// The detector admits candidates by band at write time; classifying again at
// read time keeps the payload self-describing and tolerates a drifting
// activity distance without inventing a new value space.
func raceDistanceBand(meters *float64) string {
	if meters == nil {
		return "other"
	}
	switch {
	case *meters >= racedetection.HalfMarathonMinDistanceM && *meters <= racedetection.HalfMarathonMaxDistanceM:
		return string(racedetection.RaceTypeHalfMarathon)
	case *meters >= racedetection.MarathonMinDistanceM && *meters <= racedetection.MarathonMaxDistanceM:
		return string(racedetection.RaceTypeMarathon)
	default:
		return "other"
	}
}
