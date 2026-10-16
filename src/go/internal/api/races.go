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
	"strings"
	"unicode/utf8"

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

// RaceStore is the surface the races endpoints need: the read join plus the
// two athlete-owned writes (manual naming, calendar-match rejection).
type RaceStore interface {
	UserRaces(ctx context.Context, userID string) ([]storage.UserRaceRow, error)
	SetRaceDisplayName(ctx context.Context, userID, labelID string, displayName *string) (bool, error)
	ClearRaceCalendarLink(ctx context.Context, userID, labelID string) (bool, error)
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
	rg.PATCH("/api/:user/races/:labelId", r.rename)
	rg.DELETE("/api/:user/races/:labelId/calendar-match", r.clearCalendarMatch)
}

// ─────────────────────────────────────────────────────────────────────────────
// DTO
// ─────────────────────────────────────────────────────────────────────────────

// raceItemDTO is one confirmed race. distance_band reuses the detector's
// distance-band vocabulary ("marathon" / "half_marathon") so clients can
// localize 全马/半马 without re-deriving thresholds; "other" covers a race row
// whose activity distance has since drifted outside the admitted bands.
//
// race_name/display_name/label/wa_label are the calendar identity chain
// (devops#544): race_name is the official event name (name_cn preferred), nil
// unless the race is linked to a calendar item; display_name is the athlete's
// manual name; label/wa_label are the event grade tiers. name stays the
// activity name for old clients.
type raceItemDTO struct {
	LabelID      string   `json:"label_id"`
	Name         *string  `json:"name"`
	RaceName     *string  `json:"race_name"`
	DisplayName  *string  `json:"display_name"`
	Label        *string  `json:"label"`
	WALabel      *string  `json:"wa_label"`
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

// renameRaceBody is the PATCH /api/{user}/races/{labelId} request body: the
// athlete's own display name for the race. A blank value (after trim) clears
// the stored name — the mirror of updateFeelNote, minus its non-blank rule.
type renameRaceBody struct {
	DisplayName *string `json:"display_name" binding:"required"`
}

// rename writes the athlete's manual name for one confirmed race. Trimmed to
// one line: an all-blank value clears (NULL), longer than 50 runes is 400.
// Responds 204 with no body — callers know what they sent; the stored name is
// observable via the list endpoint's display_name field.
//
//	@Summary		Set a race's athlete-chosen display name
//	@Description	Writes the athlete's own name for one confirmed race ("我的成绩" manual naming). An all-blank value clears the stored name; more than 50 characters is rejected. Only the display_name column is touched — official calendar identity, evidence and PB data are never modified. A user caller may only rename their own races; an internal caller may rename any user's.
//	@Tags			races
//	@Accept			json
//	@Param			user		path		string			true	"User id (JWT sub)"
//	@Param			labelId		path		string			true	"Activity label id of the race"
//	@Param			body		body		renameRaceBody	true	"Display name (blank to clear)"
//	@Success		204			{string}	string			"No Content"
//	@Failure		400			{object}	errorResponse
//	@Failure		401			{object}	errorResponse
//	@Failure		403			{object}	errorResponse
//	@Failure		404			{object}	errorResponse
//	@Failure		500			{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/races/{labelId} [patch]
func (r *raceRoutes) rename(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	var body renameRaceBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "display_name is required"})
		return
	}
	name := strings.TrimSpace(*body.DisplayName)
	if utf8.RuneCountInString(name) > 50 {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "display_name must be at most 50 characters"})
		return
	}
	var stored *string
	if name != "" {
		stored = &name
	}
	found, err := r.store.SetRaceDisplayName(c.Request.Context(), user, c.Param("labelId"), stored)
	if err != nil {
		r.log.Error("set race display name failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if !found {
		c.JSON(http.StatusNotFound, errorResponse{Error: "Not found"})
		return
	}
	c.Status(http.StatusNoContent)
}

// clearCalendarMatch rejects one race's calendar match ("这不是这场比赛"):
// the link is severed and evidence becomes user_cleared so the rematch paths
// skip the row. An already-unlinked race is a 204 no-op.
//
//	@Summary		Reject a race's calendar match
//	@Description	Severs the race_calendar_item link of one confirmed race and records evidence user_cleared, so the rematch path never re-chains it. The race row itself (and its activity) stays confirmed. Clearing an already-unlinked race is a no-op; a missing race row is 404. A user caller may only clear their own races; an internal caller may clear any user's.
//	@Tags			races
//	@Param			user		path		string	true	"User id (JWT sub)"
//	@Param			labelId		path		string	true	"Activity label id of the race"
//	@Success		204			{string}	string	"No Content"
//	@Failure		401			{object}	errorResponse
//	@Failure		403			{object}	errorResponse
//	@Failure		404			{object}	errorResponse
//	@Failure		500			{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/races/{labelId}/calendar-match [delete]
func (r *raceRoutes) clearCalendarMatch(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	found, err := r.store.ClearRaceCalendarLink(c.Request.Context(), user, c.Param("labelId"))
	if err != nil {
		r.log.Error("clear race calendar match failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if !found {
		c.JSON(http.StatusNotFound, errorResponse{Error: "Not found"})
		return
	}
	c.Status(http.StatusNoContent)
}

func toRaceItemDTO(row *storage.UserRaceRow) raceItemDTO {
	return raceItemDTO{
		LabelID:      row.LabelID,
		Name:         row.Name,
		RaceName:     row.RaceName,
		DisplayName:  row.DisplayName,
		Label:        row.Label,
		WALabel:      row.WALabel,
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
