// custom_races.go is the「我的比赛」custom-race surface (#474): races the user
// adds by hand, outside race_calendar —
//
//	POST   /api/users/me/custom-races   (create)
//	PUT    /api/users/me/custom-races/:id   (full update)
//	DELETE /api/users/me/custom-races/:id   (physical delete)
//	GET    /api/users/me/my-races           (aggregate: official plans + custom)
//
// Every row is strictly user-private: a foreign or missing id is the same 404,
// and the aggregate endpoint is the only read path (no GET /custom-races list —
// edit prefill reuses the aggregate's full fields; no pagination, a runner has
// at most a few dozen of these).
package api

import (
	"context"
	"net/http"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/racetypes"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// ─────────────────────────────────────────────────────────────────────────────
// Dependency. A narrow port so the api package stays free of GORM. Satisfied
// by *storage.Store.
// ─────────────────────────────────────────────────────────────────────────────

// UserCustomRaceStore is the persistence the custom-race endpoints need.
type UserCustomRaceStore interface {
	CreateUserCustomRace(ctx context.Context, row *storage.UserCustomRace) error
	UpdateUserCustomRace(ctx context.Context, userID string, upd *storage.UserCustomRace) (*storage.UserCustomRace, error)
	DeleteUserCustomRace(ctx context.Context, userID string, id uint64) error
	ListUserCustomRaces(ctx context.Context, userID string) ([]storage.UserCustomRace, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// Registrar
// ─────────────────────────────────────────────────────────────────────────────

type customRaceRoutes struct {
	store UserCustomRaceStore
	plans RacePlanStore // for the my-races aggregate only
	log   *zap.Logger
}

func newCustomRaceRoutes(store UserCustomRaceStore, plans RacePlanStore, log *zap.Logger) *customRaceRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &customRaceRoutes{store: store, plans: plans, log: log}
}

func (p *customRaceRoutes) register(rg *gin.RouterGroup) {
	if p.store == nil {
		return
	}
	rg.POST("/api/users/me/custom-races", p.create)
	rg.PUT("/api/users/me/custom-races/:id", p.update)
	rg.DELETE("/api/users/me/custom-races/:id", p.delete)
	rg.GET("/api/users/me/my-races", p.myRaces)
}

// ─────────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────────

// customRaceRequest is the create/full-update body: required are name, a
// valid YYYY-MM-DD race_date (no bounds — past dates are backfill, far-future
// allowed, #457 修正决议) and an item_type from the seven-chip whitelist;
// everything else is optional. State defaults to want.
//
// hotel/transit are deliberately absent: the columns exist per the #457 DDL
// (「状态/行程存自有表」) but the v1 contract's field list does not expose them
// (no travel toggles on custom cards yet) — reads carry them, writes never
// change them from the default.
type customRaceRequest struct {
	Name       string   `json:"name" binding:"required,max=128"`
	RaceDate   string   `json:"race_date" binding:"required"`
	ItemType   string   `json:"item_type" binding:"required"`
	DistanceKm *float64 `json:"distance_km"`
	AscentM    *uint32  `json:"ascent_m"`
	City       string   `json:"city" binding:"max=64"`
	Website    string   `json:"website" binding:"max=512"`
	Note       string   `json:"note" binding:"max=512"`
	State      string   `json:"state" binding:"max=16"`
}

// customRaceDTO is one custom race as「我的比赛」renders it: every stored field
// plus the derived done flag (race day has passed in Shanghai time — finished
// races are never stored, only derived at read).
type customRaceDTO struct {
	ID         uint64   `json:"id"`
	Name       string   `json:"name"`
	RaceDate   string   `json:"race_date"`
	ItemType   string   `json:"item_type"`
	DistanceKm *float64 `json:"distance_km"`
	AscentM    *uint32  `json:"ascent_m"`
	City       string   `json:"city"`
	Website    string   `json:"website"`
	Note       string   `json:"note"`
	State      string   `json:"state"`
	Hotel      bool     `json:"hotel"`
	Transit    bool     `json:"transit"`
	Done       bool     `json:"done"`
	CreatedAt  string   `json:"created_at"`
	UpdatedAt  string   `json:"updated_at"`
}

// myRaceItem is one card of the aggregated「我的比赛」list: an official race-plan
// card (the exact race-plans DTO, reused verbatim by the client's toPlanCard)
// or a custom card.
type myRaceItem struct {
	Source string         `json:"source"` // "official" | "custom"
	Plan   *racePlanDTO   `json:"plan,omitempty"`
	Race   *customRaceDTO `json:"race,omitempty"`

	// sort inputs, not part of the payload.
	sortDate string // race date, raceSortDate's "9999-99-99" when unknown
	done     bool
}

type myRacesResponse struct {
	Items []myRaceItem `json:"items"`
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

// create adds one custom race for the caller. Answers 201 with the stored row.
//
//	@Summary		Create a custom race
//	@Description	Adds a race outside race_calendar for the current user (「我的比赛」手动添加). race_date is any valid YYYY-MM-DD; item_type must be one of the seven form chips.
//	@Tags			custom-races
//	@Accept			json
//	@Produce		json
//	@Param			body	body	customRaceRequest	true	"Race fields"
//	@Success		201		{object}	customRaceDTO
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		422		{object}	validationErrorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/custom-races [post]
func (p *customRaceRoutes) create(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	var req customRaceRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: bindingDetail(err)})
		return
	}
	if verr := validateCustomRace(&req); verr != nil {
		c.JSON(http.StatusUnprocessableEntity, *verr)
		return
	}
	row := storage.UserCustomRace{
		UserID: uid, Name: req.Name, RaceDate: req.RaceDate, ItemType: req.ItemType,
		DistanceKm: req.DistanceKm, AscentM: req.AscentM,
		City: req.City, Website: req.Website, Note: req.Note,
		State: customRaceStateOrWant(req.State),
	}
	if err := p.store.CreateUserCustomRace(c.Request.Context(), &row); err != nil {
		writeRaceEngagementError(c, p.log, err)
		return
	}
	c.JSON(http.StatusCreated, newCustomRaceDTO(row))
}

// update replaces every editable field of the caller's race (全量更新; absent
// optionals are cleared). 404 when the id does not exist or is not the
// caller's.
//
//	@Summary		Update a custom race
//	@Description	Full update of the current user's custom race; absent optional fields are cleared.
//	@Tags			custom-races
//	@Accept			json
//	@Produce		json
//	@Param			id		path	int					true	"Custom race id"
//	@Param			body	body	customRaceRequest	true	"Race fields"
//	@Success		200		{object}	customRaceDTO
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		422		{object}	validationErrorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/custom-races/{id} [put]
func (p *customRaceRoutes) update(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	id, ok := parseUintParam(c, "id")
	if !ok {
		return
	}
	var req customRaceRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: bindingDetail(err)})
		return
	}
	if verr := validateCustomRace(&req); verr != nil {
		c.JSON(http.StatusUnprocessableEntity, *verr)
		return
	}
	row, err := p.store.UpdateUserCustomRace(c.Request.Context(), uid, &storage.UserCustomRace{
		ID: id, Name: req.Name, RaceDate: req.RaceDate, ItemType: req.ItemType,
		DistanceKm: req.DistanceKm, AscentM: req.AscentM,
		City: req.City, Website: req.Website, Note: req.Note,
		State: customRaceStateOrWant(req.State),
	})
	if err != nil {
		writeRaceEngagementError(c, p.log, err)
		return
	}
	c.JSON(http.StatusOK, newCustomRaceDTO(*row))
}

// delete physically removes the caller's race. 404 when nothing to delete.
//
//	@Summary		Delete a custom race
//	@Description	Deletes the current user's custom race.
//	@Tags			custom-races
//	@Param			id	path	int	true	"Custom race id"
//	@Success		204
//	@Failure		400	{object}	errorResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/custom-races/{id} [delete]
func (p *customRaceRoutes) delete(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	id, ok := parseUintParam(c, "id")
	if !ok {
		return
	}
	if err := p.store.DeleteUserCustomRace(c.Request.Context(), uid, id); err != nil {
		writeRaceEngagementError(c, p.log, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// myRaces aggregates the caller's official race-plan cards and custom cards
// into one list: not-finished first ascending by race date, finished sunk to
// the bottom (ascending within the group). No pagination.
//
//	@Summary		List my races (aggregate)
//	@Description	Unified「我的比赛」list: official race-plan cards (source=official, the race-plans DTO verbatim, incl. offboarded) plus custom cards (source=custom, full fields + derived done). Not-finished items sort by race_date ascending, finished items sink to the bottom (ascending within the group).
//	@Tags			my-races
//	@Produce		json
//	@Success		200	{object}	myRacesResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/my-races [get]
func (p *customRaceRoutes) myRaces(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	items := []myRaceItem{}
	if p.plans != nil {
		rows, err := p.plans.ListRacePlans(c.Request.Context(), uid)
		if err != nil {
			p.log.Error("my races: list plans failed", zapErr(err))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
		for i := range rows {
			plan := newRacePlanDTO(rows[i])
			date := "9999-99-99"
			if plan.Race != nil {
				date = plan.Race.RaceDate
			}
			items = append(items, myRaceItem{
				Source: "official", Plan: &plan,
				// An unknown date (offboarded placeholder, race row gone)
				// sinks like a finished race: no date to count down against.
				sortDate: date, done: date == "9999-99-99" || raceDatePassed(date),
			})
		}
	}
	customs, err := p.store.ListUserCustomRaces(c.Request.Context(), uid)
	if err != nil {
		p.log.Error("my races: list customs failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	for _, row := range customs {
		dto := newCustomRaceDTO(row)
		items = append(items, myRaceItem{Source: "custom", Race: &dto, sortDate: row.RaceDate, done: dto.Done})
	}
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].done != items[j].done {
			return !items[i].done // not-finished first, finished sunk
		}
		return items[i].sortDate < items[j].sortDate
	})
	c.JSON(http.StatusOK, myRacesResponse{Items: items})
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// validateCustomRace checks the vocabulary/format rules the binding tags
// cannot express, in field order; nil when the body is valid. item_type is the
// seven-chip whitelist (not the full racetypes.IsValid space), race_date any
// valid calendar date, and distance_km must fit the decimal(6,1) column.
func validateCustomRace(req *customRaceRequest) *validationErrorResponse {
	detail := func(field, msg string) *validationErrorResponse {
		return &validationErrorResponse{Detail: []validationDetailItem{
			{Loc: []string{"body", field}, Msg: msg},
		}}
	}
	if !racetypes.IsCustomItemType(req.ItemType) {
		return detail("item_type", "item_type must be one of Marathon / HalfMarathon / 10Km / 5Km / Trail / Ultra / Other")
	}
	if _, err := time.Parse("2006-01-02", req.RaceDate); err != nil {
		return detail("race_date", "race_date must be a valid YYYY-MM-DD date")
	}
	if req.DistanceKm != nil && (*req.DistanceKm <= 0 || *req.DistanceKm > 99999.9) {
		return detail("distance_km", "distance_km must be a positive number of km")
	}
	if req.State != "" && !storage.IsCustomRaceState(req.State) {
		return detail("state", "state must be one of want / registered")
	}
	return nil
}

// customRaceStateOrWant applies the body default: an absent state means want.
func customRaceStateOrWant(state string) string {
	if state == "" {
		return storage.CustomRaceStateWant
	}
	return state
}

// raceDatePassed reports whether the race day has passed: race_date < today
// in Asia/Shanghai (the backend twin of the client's shanghaiToday/daysUntil
// derivation). Same-day races are not done yet. Applies to both custom rows
// and official plan cards (my-races derive done for both).
func raceDatePassed(raceDate string) bool {
	rd, err := time.Parse("2006-01-02", raceDate)
	if err != nil {
		return false
	}
	return rd.Before(timefmt.ShanghaiToday())
}

func newCustomRaceDTO(row storage.UserCustomRace) customRaceDTO {
	return customRaceDTO{
		ID: row.ID, Name: row.Name, RaceDate: row.RaceDate, ItemType: row.ItemType,
		DistanceKm: row.DistanceKm, AscentM: row.AscentM,
		City: row.City, Website: row.Website, Note: row.Note,
		State: row.State, Hotel: row.Hotel, Transit: row.Transit,
		Done:      raceDatePassed(row.RaceDate),
		CreatedAt: row.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt: row.UpdatedAt.UTC().Format(time.RFC3339),
	}
}
