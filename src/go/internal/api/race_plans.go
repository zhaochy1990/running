// race_plans.go is the user-facing race-plan surface: a sibling registrar
// sharing the auth path
//
//	GET    /api/users/me/race-plans            (「我的赛事」 list, race info joined)
//	PUT    /api/users/me/race-plans/:race_id   (the 报名 selector upsert)
//	DELETE /api/users/me/race-plans/:race_id   (未报名/取消追踪)
//
// One plan per (user, race) — UNIQUE(user, event) — because the plan tracks the
// runner's attendance at the race, and the 报名项目 is carried on that single row.
package api

import (
	"context"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/racetypes"
	"github.com/zhaochy1990/stride/internal/storage"
)

// ─────────────────────────────────────────────────────────────────────────────
// Dependency. A narrow port so the api package stays free of GORM. Satisfied
// by *storage.Store.
// ─────────────────────────────────────────────────────────────────────────────

// RacePlanStore is the persistence the plan endpoints need.
type RacePlanStore interface {
	UpsertRacePlan(ctx context.Context, up storage.RacePlanUpsert) (*storage.RacePlan, error)
	DeleteRacePlan(ctx context.Context, userID string, raceEventID uint64) error
	ListRacePlans(ctx context.Context, userID string) ([]storage.RacePlanWithRace, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// Registrar
// ─────────────────────────────────────────────────────────────────────────────

type racePlanRoutes struct {
	store RacePlanStore
	log   *zap.Logger
}

func newRacePlanRoutes(store RacePlanStore, log *zap.Logger) *racePlanRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &racePlanRoutes{store: store, log: log}
}

func (p *racePlanRoutes) register(rg *gin.RouterGroup) {
	if p.store == nil {
		return
	}
	rg.GET("/api/users/me/race-plans", p.list)
	rg.PUT("/api/users/me/race-plans/:race_id", p.upsert)
	rg.DELETE("/api/users/me/race-plans/:race_id", p.delete)
}

// ─────────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────────

// racePlanDTO is one plan as「我的赛事」renders it: the tracking fields plus the
// compact race projection (name/date/place/labels) the plan card's header shows.
// offboarded mirrors the storage-layer layering: true on a registered/won/
// confirmed plan whose race is unpublished or deleted (灰卡、记录保留), while lost
// plans never reach the response — they are silently filtered in the store.
type racePlanDTO struct {
	RaceID     uint64           `json:"race_id"`
	ItemType   string           `json:"item_type"`
	State      string           `json:"state"`
	Hotel      bool             `json:"hotel"`
	Transit    bool             `json:"transit"`
	Race       *racePlanRaceDTO `json:"race"`
	Offboarded bool             `json:"offboarded"`
	CreatedAt  string           `json:"created_at"`
	UpdatedAt  string           `json:"updated_at"`
}

// racePlanRaceDTO is the plan-card projection of the race. It is nil-safe
// alongside Offboarded: a plan whose race row is gone keeps name_cn/name/date
// out of the payload and the client renders the pure placeholder.
type racePlanRaceDTO struct {
	ID       uint64  `json:"id"`
	Name     string  `json:"name"`
	NameCN   *string `json:"name_cn"`
	RaceDate string  `json:"race_date"`
	Province *string `json:"province"`
	City     *string `json:"city"`
	Label    *string `json:"label"`
	WALabel  *string `json:"wa_label"`
}

type racePlansResponse struct {
	Plans []racePlanDTO `json:"plans"`
}

// racePlanUpsertResponse is the 报名 selector's answer: the persisted tracking
// fields only. It deliberately carries no race projection and no offboarded
// flag — those are list-read semantics computed against the race's CURRENT
// published state (see racePlanDTO), while this row was just written against a
// race the store already verified as published.
type racePlanUpsertResponse struct {
	RaceID    uint64 `json:"race_id"`
	ItemType  string `json:"item_type"`
	State     string `json:"state"`
	Hotel     bool   `json:"hotel"`
	Transit   bool   `json:"transit"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

// racePlanUpsertRequest is the body of the 报名 selector submission: 项目+状态
// arrive together and are both required. hotel/transit are tri-state — absent
// keeps the stored value (the selector must not wipe the plan card's checked
// 行程 boxes), explicit false/true sets it.
type racePlanUpsertRequest struct {
	ItemType string `json:"item_type" binding:"required"`
	State    string `json:"state" binding:"required"`
	Hotel    *bool  `json:"hotel"`
	Transit  *bool  `json:"transit"`
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

// upsert creates or updates the caller's plan for one race. item_type must be
// a racetypes token and state one of the four signup states; the race must be
// published (404 otherwise).
//
//	@Summary		Create or update a race plan
//	@Description	Upserts the current user's plan (报名项目 + 状态) for one published race. Absent hotel/transit keep their stored values.
//	@Tags			race-plans
//	@Accept			json
//	@Produce		json
//	@Param			race_id	path	int						true	"Race id"
//	@Param			body	body	racePlanUpsertRequest	true	"Plan fields"
//	@Success		200		{object}	racePlanUpsertResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		422		{object}	validationErrorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/race-plans/{race_id} [put]
func (p *racePlanRoutes) upsert(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	raceID, ok := parseRaceIDParam(c)
	if !ok {
		return
	}
	var req racePlanUpsertRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: bindingDetail(err)})
		return
	}
	if !racetypes.IsValid(req.ItemType) {
		c.JSON(http.StatusUnprocessableEntity, racePlanValidationDetail("item_type", "item_type must be a race-type token (Marathon / HalfMarathon / {n}Km / Other / Unknown)"))
		return
	}
	if !storage.IsRacePlanState(req.State) {
		c.JSON(http.StatusUnprocessableEntity, racePlanValidationDetail("state", "state must be one of registered / won / lost / confirmed"))
		return
	}
	plan, err := p.store.UpsertRacePlan(c.Request.Context(), storage.RacePlanUpsert{
		UserID: uid, RaceEventID: raceID,
		ItemType: req.ItemType, State: req.State,
		Hotel: req.Hotel, Transit: req.Transit,
	})
	if err != nil {
		writeRaceEngagementError(c, p.log, err)
		return
	}
	c.JSON(http.StatusOK, racePlanUpsertResponse{
		RaceID:    plan.RaceEventID,
		ItemType:  plan.ItemType,
		State:     plan.State,
		Hotel:     plan.Hotel,
		Transit:   plan.Transit,
		CreatedAt: plan.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt: plan.UpdatedAt.UTC().Format(time.RFC3339),
	})
}

// delete removes the caller's plan for one race (the selector's 未报名/取消追踪
// choice). 404 when no plan exists for the race.
//
//	@Summary		Delete a race plan
//	@Description	Deletes the current user's plan for one race.
//	@Tags			race-plans
//	@Param			race_id	path	int	true	"Race id"
//	@Success		204
//	@Failure		400	{object}	errorResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/race-plans/{race_id} [delete]
func (p *racePlanRoutes) delete(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	raceID, ok := parseRaceIDParam(c)
	if !ok {
		return
	}
	if err := p.store.DeleteRacePlan(c.Request.Context(), uid, raceID); err != nil {
		writeRaceEngagementError(c, p.log, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// list returns the caller's plans joined with race info, soonest race first.
// The offboarding layering is applied in the store (lost plans on unpublished
// races are dropped; the rest carry offboarded=true).
//
//	@Summary		List my race plans
//	@Description	Returns the current user's race plans with a compact race projection, ordered by race date ascending. Plans whose race is unpublished or deleted carry offboarded=true (已下架 placeholder); lost plans on such races are omitted.
//	@Tags			race-plans
//	@Produce		json
//	@Success		200	{object}	racePlansResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/race-plans [get]
func (p *racePlanRoutes) list(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	rows, err := p.store.ListRacePlans(c.Request.Context(), uid)
	if err != nil {
		p.log.Error("race plans: read failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	plans := make([]racePlanDTO, 0, len(rows))
	for i := range rows {
		plans = append(plans, newRacePlanDTO(rows[i]))
	}
	c.JSON(http.StatusOK, racePlansResponse{Plans: plans})
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

func newRacePlanDTO(row storage.RacePlanWithRace) racePlanDTO {
	dto := racePlanDTO{
		RaceID:     row.Plan.RaceEventID,
		ItemType:   row.Plan.ItemType,
		State:      row.Plan.State,
		Hotel:      row.Plan.Hotel,
		Transit:    row.Plan.Transit,
		Offboarded: row.Offboarded(),
		CreatedAt:  row.Plan.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:  row.Plan.UpdatedAt.UTC().Format(time.RFC3339),
	}
	if row.Race != nil {
		dto.Race = &racePlanRaceDTO{
			ID:       row.Race.ID,
			Name:     row.Race.Name,
			NameCN:   row.Race.NameCN,
			RaceDate: row.Race.RaceDate,
			Province: row.Race.Province,
			City:     row.Race.City,
			Label:    row.Race.Label,
			WALabel:  row.Race.WALabel,
		}
	}
	return dto
}

// racePlanValidationDetail renders one field-scoped 422 entry, the same shape
// binding errors produce (ADR 0013) so the client's per-field UX works for the
// vocabulary checks too.
func racePlanValidationDetail(field, msg string) validationErrorResponse {
	return validationErrorResponse{Detail: []validationDetailItem{
		{Loc: []string{"body", field}, Msg: msg},
	}}
}
