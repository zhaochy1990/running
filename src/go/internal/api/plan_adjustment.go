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

	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// Deviation-adjustment consent flow (#858 PR-C): the nightly scan (PR-C 下半)
// and the rolling worker record a pending plan_adjustment row; the
// mini-program popup asks the reason (choose), shows the pre-generated
// adjusted weeks (payload), then accept applies those weekly docs through the
// same per-week channel the internal rolling batch-apply uses, or dismiss
// closes the event for good. Internal endpoints carry the worker↔nightly
// channel; the user endpoints are self-scoped by JWT.

// PlanAdjustmentStore is the storage surface the adjustment routes need.
type PlanAdjustmentStore interface {
	UpsertPendingAdjustment(ctx context.Context, userID, masterPlanID, eventWeekStart, reason, question, payload string) (*storage.PlanAdjustment, error)
	GetPendingAdjustment(ctx context.Context, userID string) (*storage.PlanAdjustment, error)
	GetAdjustmentByID(ctx context.Context, userID, id string) (*storage.PlanAdjustment, error)
	ChooseAdjustmentReason(ctx context.Context, userID, id, reason string) (*storage.PlanAdjustment, error)
	CompleteAdjustmentPayload(ctx context.Context, userID, id, reason, payload string) (*storage.PlanAdjustment, error)
	SetAdjustmentStatus(ctx context.Context, userID, id, status string) error
	ApplyStructuredWeeklyPlan(ctx context.Context, userID, weekStart, content string, replacement *storage.WeeklyPlanReplacement, opts ...storage.WeeklyPlanApplyOptions) (*storage.WeeklyPlan, *storage.WeeklyPlan, error)
	GetActiveWeeklyPlan(ctx context.Context, userID, weekStart string) (*storage.WeeklyPlan, error)
}

type planAdjustmentRoutes struct {
	store PlanAdjustmentStore
	log   *zap.Logger
	// now is the accept-time clock. Merging "past arrangements" at write time is
	// deliberate (#952): a proposal generated yesterday may be accepted today,
	// and the days in between are past by then.
	now func() time.Time
}

func newPlanAdjustmentRoutes(store PlanAdjustmentStore, log *zap.Logger) *planAdjustmentRoutes {
	return &planAdjustmentRoutes{store: store, log: log, now: time.Now}
}

// today is the Shanghai civil day the accept was written on.
func (p *planAdjustmentRoutes) today() string {
	return timefmt.ShanghaiDay(p.now()).Format("2006-01-02")
}

func (p *planAdjustmentRoutes) registerInternal(rg *gin.RouterGroup) {
	if p.store == nil {
		return
	}
	rg.POST("/api/internal/users/:user_id/plan-adjustments", p.upsertPending)
	rg.GET("/api/internal/users/:user_id/plan-adjustment/pending", p.pendingInternal)
	rg.POST("/api/internal/users/:user_id/plan-adjustments/:id/payload", p.completePayload)
}

func (p *planAdjustmentRoutes) registerUser(rg *gin.RouterGroup) {
	if p.store == nil {
		return
	}
	rg.GET("/api/users/:user_id/plan-adjustment/pending", p.pending)
	rg.POST("/api/users/:user_id/plan-adjustments/:id/choose", p.choose)
	rg.POST("/api/users/:user_id/plan-adjustments/:id/accept", p.accept)
	rg.POST("/api/users/:user_id/plan-adjustments/:id/dismiss", p.dismiss)
}

// ── internal channel (worker / nightly scan) ────────────────────────────────

type upsertAdjustmentRequest struct {
	MasterPlanID   string `json:"master_plan_id" binding:"required"`
	EventWeekStart string `json:"event_week_start" binding:"required"`
	Reason         string `json:"reason" binding:"required"`
	Question       string `json:"question" binding:"required"`
	Payload        string `json:"payload" binding:"required"`
}

// upsertPending creates or refreshes the user's pending adjustment proposal.
// Same-event terminal rows reject with 409 (event closed); any other pending
// row is superseded first (one pending per user).
//
//	@Summary		Upsert pending adjustment proposal (internal)
//	@Description	Internal-only (#858). Creates or refreshes the athlete's pending plan_adjustment: same-event pending rows refresh payload; accepted/dismissed events reject with 409; other pending rows are superseded.
//	@Tags			plan-adjustment
//	@Accept			json
//	@Produce		json
//	@Param			user_id	path	string					true	"Target user UUID"
//	@Param			body	body	upsertAdjustmentRequest	true	"Proposal event key, reason, popup question and payload JSON"
//	@Success		201		{object}	adjustmentResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		409		{object}	errorResponse
//	@Failure		413		{object}	errorResponse
//	@Failure		422		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Router		/api/internal/users/{user_id}/plan-adjustments [post]
func (p *planAdjustmentRoutes) upsertPending(c *gin.Context) {
	if callerFrom(c).Tier != TierInternal {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}
	userID := c.Param("user_id")
	if _, err := uuid.Parse(userID); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_user"})
		return
	}
	var body upsertAdjustmentRequest
	if err := c.ShouldBindJSON(&body); err != nil {
		if isBodyTooLarge(err) {
			c.JSON(http.StatusRequestEntityTooLarge, errorResponse{Error: "adjustment_too_large"})
			return
		}
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request body"})
		return
	}
	if _, err := uuid.Parse(body.MasterPlanID); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_master_plan"})
		return
	}
	if !isAdjustmentReason(body.Reason) || !isMondayDate(body.EventWeekStart) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_event"})
		return
	}
	if !json.Valid([]byte(body.Payload)) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_payload"})
		return
	}
	row, err := p.store.UpsertPendingAdjustment(
		c.Request.Context(), userID, body.MasterPlanID, body.EventWeekStart, body.Reason, body.Question, body.Payload,
	)
	if errors.Is(err, storage.ErrAdjustmentEventClosed) {
		c.JSON(http.StatusConflict, errorResponse{Error: "adjustment_event_closed"})
		return
	}
	if err != nil {
		p.log.Error("upsert pending adjustment failed", zapErr(err), zap.String("user_id", userID))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusCreated, adjustmentResponse{Adjustment: adjustmentOf(row)})
}

// completePayload refills a pending row after the generate_adjustment job
// finished regenerating for the user's chosen reason.
//
//	@Summary		Refill adjustment payload (internal, regeneration channel)
//	@Description	Internal-only (#858). The generate_adjustment worker posts the regenerated proposal payload for the pending row; the row's reason must match the regeneration request.
//	@Tags			plan-adjustment
//	@Accept			json
//	@Produce		json
//	@Param			user_id	path	string						true	"Target user UUID"
//	@Param			id		path	string						true	"Adjustment UUID"
//	@Param			body	body	completePayloadRequest		true	"Reason plus payload JSON"
//	@Success		200		{object}	adjustmentResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		409		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Router		/api/internal/users/{user_id}/plan-adjustments/{id}/payload [post]
func (p *planAdjustmentRoutes) completePayload(c *gin.Context) {
	if callerFrom(c).Tier != TierInternal {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}
	userID := c.Param("user_id")
	if _, err := uuid.Parse(userID); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_user"})
		return
	}
	var body completePayloadRequest
	if err := c.ShouldBindJSON(&body); err != nil {
		if isBodyTooLarge(err) {
			c.JSON(http.StatusRequestEntityTooLarge, errorResponse{Error: "adjustment_too_large"})
			return
		}
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request body"})
		return
	}
	if !isAdjustmentReason(body.Reason) || !json.Valid([]byte(body.Payload)) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_payload"})
		return
	}
	row, err := p.store.CompleteAdjustmentPayload(c.Request.Context(), userID, c.Param("id"), body.Reason, body.Payload)
	if errors.Is(err, storage.ErrAdjustmentNotFound) {
		c.JSON(http.StatusNotFound, errorResponse{Error: "adjustment_not_found"})
		return
	}
	if errors.Is(err, storage.ErrAdjustmentState) {
		c.JSON(http.StatusConflict, errorResponse{Error: "adjustment_state_conflict"})
		return
	}
	if err != nil {
		p.log.Error("complete adjustment payload failed", zapErr(err), zap.String("user_id", userID))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusOK, adjustmentResponse{Adjustment: adjustmentOf(row)})
}

// pendingInternal is the worker-facing variant of pending: same row, internal
// tier (the regenerate job locates its target row this way).
//
//	@Summary		Get the pending adjustment (internal)
//	@Description	Internal-only (#858). Returns the athlete's pending adjustment row for the worker's regeneration channel; 404 when none.
//	@Tags			plan-adjustment
//	@Produce		json
//	@Param			user_id	path	string	true	"Target user UUID"
//	@Success		200		{object}	adjustmentResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Security		InternalToken
//	@Router		/api/internal/users/{user_id}/plan-adjustment/pending [get]
func (p *planAdjustmentRoutes) pendingInternal(c *gin.Context) {
	if callerFrom(c).Tier != TierInternal {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}
	userID := c.Param("user_id")
	if _, err := uuid.Parse(userID); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_user"})
		return
	}
	row, err := p.store.GetPendingAdjustment(c.Request.Context(), userID)
	if err != nil {
		p.log.Error("load pending adjustment (internal) failed", zapErr(err), zap.String("user_id", userID))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if row == nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "当前没有待确认的训练调整"})
		return
	}
	c.JSON(http.StatusOK, adjustmentResponse{Adjustment: adjustmentOf(row)})
}

type completePayloadRequest struct {
	Reason  string `json:"reason" binding:"required"`
	Payload string `json:"payload" binding:"required"`
}

// ── user (mini-program popup) channel ───────────────────────────────────────

type adjustmentDTO struct {
	ID             string    `json:"id"`
	MasterPlanID   string    `json:"master_plan_id"`
	EventWeekStart string    `json:"event_week_start"`
	Reason         string    `json:"reason"`
	Status         string    `json:"status"`
	Payload        *string   `json:"payload"`
	Question       string    `json:"question"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type adjustmentResponse struct {
	Adjustment adjustmentDTO `json:"adjustment"`
}

type chooseAdjustmentRequest struct {
	Reason string `json:"reason" binding:"required"`
}

func adjustmentOf(row *storage.PlanAdjustment) adjustmentDTO {
	return adjustmentDTO{
		ID: row.ID, MasterPlanID: row.MasterPlanID, EventWeekStart: row.EventWeekStart,
		Reason: row.Reason, Status: row.Status, Payload: row.Payload,
		Question: row.Question, UpdatedAt: row.UpdatedAt,
	}
}

// pending returns the user's popup-visible proposal (404 when none).
//
//	@Summary		Get the pending adjustment proposal
//	@Description	#858: the mini-program popup payload — the pending proposal with its pre-generated adjusted weeks. Payload is null while a reason change is being regenerated.
//	@Tags			plan-adjustment
//	@Produce		json
//	@Param			user_id	path	string	true	"User UUID (JWT sub; self only)"
//	@Success		200		{object}	adjustmentResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Security		BearerAuth
//	@Router		/api/users/{user_id}/plan-adjustment/pending [get]
func (p *planAdjustmentRoutes) pending(c *gin.Context) {
	userID := c.Param("user_id")
	if !p.selfOnly(c, userID) {
		return
	}
	row, err := p.store.GetPendingAdjustment(c.Request.Context(), userID)
	if err != nil {
		p.log.Error("load pending adjustment failed", zapErr(err), zap.String("user_id", userID))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if row == nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "当前没有待确认的训练调整"})
		return
	}
	c.JSON(http.StatusOK, adjustmentResponse{Adjustment: adjustmentOf(row)})
}

// choose answers the reason question. Same reason → 200 with the stored
// payload (instant proposal). A different reason → payload cleared, 202: the
// mini-program enqueues the generate_adjustment job (coach_api) and polls
// pending until the payload refills.
//
//	@Summary		Answer the adjustment reason question
//	@Description	#858: same reason returns the pre-generated payload instantly (200); a changed reason clears the payload and returns 202 — the mp then enqueues the regeneration job and polls.
//	@Tags			plan-adjustment
//	@Accept			json
//	@Produce		json
//	@Param			user_id	path	string					true	"User UUID (JWT sub; self only)"
//	@Param			id		path	string					true	"Adjustment UUID"
//	@Param			body	body	chooseAdjustmentRequest	true	"Chosen reason"
//	@Success		200		{object}	adjustmentResponse
//	@Success		202		{object}	adjustmentResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		409		{object}	errorResponse
//	@Security		BearerAuth
//	@Router		/api/users/{user_id}/plan-adjustments/{id}/choose [post]
func (p *planAdjustmentRoutes) choose(c *gin.Context) {
	userID := c.Param("user_id")
	if !p.selfOnly(c, userID) {
		return
	}
	var body chooseAdjustmentRequest
	if err := c.ShouldBindJSON(&body); err != nil || !isAdjustmentReason(body.Reason) {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_reason"})
		return
	}
	row, err := p.store.ChooseAdjustmentReason(c.Request.Context(), userID, c.Param("id"), body.Reason)
	if errors.Is(err, storage.ErrAdjustmentNotFound) {
		c.JSON(http.StatusNotFound, errorResponse{Error: "adjustment_not_found"})
		return
	}
	if errors.Is(err, storage.ErrAdjustmentState) {
		c.JSON(http.StatusConflict, errorResponse{Error: "adjustment_state_conflict"})
		return
	}
	if err != nil {
		p.log.Error("choose adjustment reason failed", zapErr(err), zap.String("user_id", userID))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	// 受伤不走提案引擎：清 payload 由伤病模式接管（PR-D 端点），202 语义同换因。
	if row.Payload == nil {
		c.JSON(http.StatusAccepted, adjustmentResponse{Adjustment: adjustmentOf(row)})
		return
	}
	c.JSON(http.StatusOK, adjustmentResponse{Adjustment: adjustmentOf(row)})
}

// accept applies the payload's weekly docs (per-week channel: same-plan
// replace with revision+1, cross-plan 409) and only then marks the row
// accepted. Dismissal-after-accept is impossible (terminal state).
//
//	@Summary		Accept the adjustment and apply the adjusted weeks
//	@Description	#858: applies the payload weekly docs through the rolling per-week channel, then marks the adjustment accepted. Requires a payload (a reason change must finish regenerating first).
//	@Tags			plan-adjustment
//	@Produce		json
//	@Param			user_id	path	string	true	"User UUID (JWT sub; self only)"
//	@Param			id		path	string	true	"Adjustment UUID"
//	@Success		200		{object}	acceptAdjustmentResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		409		{object}	errorResponse
//	@Failure		422		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router		/api/users/{user_id}/plan-adjustments/{id}/accept [post]
func (p *planAdjustmentRoutes) accept(c *gin.Context) {
	userID := c.Param("user_id")
	if !p.selfOnly(c, userID) {
		return
	}
	ctx := c.Request.Context()
	row, err := p.store.GetAdjustmentByID(ctx, userID, c.Param("id"))
	if errors.Is(err, storage.ErrAdjustmentNotFound) {
		c.JSON(http.StatusNotFound, errorResponse{Error: "adjustment_not_found"})
		return
	}
	if err != nil {
		p.log.Error("load adjustment for accept failed", zapErr(err), zap.String("user_id", userID))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if row.Status != storage.PlanAdjustmentStatusPending {
		c.JSON(http.StatusConflict, errorResponse{Error: "adjustment_state_conflict"})
		return
	}
	if row.Payload == nil {
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "adjustment_payload_regenerating"})
		return
	}
	var proposal struct {
		WeeklyDocs []map[string]any `json:"weekly_docs"`
	}
	if err := json.Unmarshal([]byte(*row.Payload), &proposal); err != nil || len(proposal.WeeklyDocs) == 0 {
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_payload"})
		return
	}
	type appliedWeek = acceptAdjustmentWeek
	applied := make([]appliedWeek, 0, len(proposal.WeeklyDocs))
	today := p.today()
	for _, document := range proposal.WeeklyDocs {
		weekName, _ := document["week_name"].(string)
		weekStart, _, ok := weekIdentity(weekName)
		if !ok {
			c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_content"})
			return
		}
		var replacement *storage.WeeklyPlanReplacement
		active, err := p.store.GetActiveWeeklyPlan(ctx, userID, weekStart)
		if err != nil {
			p.log.Error("adjustment accept read active week failed", zapErr(err), zap.String("user_id", userID))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
		toApply := document
		if active != nil {
			if active.MasterPlanID == nil || *active.MasterPlanID != row.MasterPlanID {
				c.JSON(http.StatusConflict, errorResponse{Error: "weekly_plan_master_plan_conflict"})
				return
			}
			replacement = &storage.WeeklyPlanReplacement{PlanID: active.PlanID, Revision: active.Revision}
			// #952：以实际写入日（不是提案生成日）保护过去安排——生成后隔天
			// 才同意时，这期间已成为过去的安排仍取现存课表。
			var activeDocument map[string]any
			if err := json.Unmarshal([]byte(active.Content), &activeDocument); err != nil {
				p.log.Warn("adjustment accept active week unreadable — keeping it", zapErr(err), zap.String("user_id", userID), zap.String("week_start", weekStart))
				continue
			}
			merged, keep := mergeAdjustedWeeklyPlan(document, activeDocument, today)
			if !keep {
				p.log.Info("adjustment accept keeps current week (no safe future replacement)", zap.String("user_id", userID), zap.String("week_start", weekStart))
				continue
			}
			toApply = merged
		}
		content, err := validateAppliedWeeklyPlan(toApply, weekName)
		if err != nil {
			if active != nil {
				// 合并后的周不合法：保留原课表，绝不写入未冻结的新文档。
				p.log.Warn("adjustment accept merged week invalid — keeping active week", zapErr(err), zap.String("user_id", userID), zap.String("week_start", weekStart))
				continue
			}
			p.log.Warn("adjustment accept week content invalid", zapErr(err), zap.String("user_id", userID), zap.String("week_start", weekStart))
			c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_content"})
			return
		}
		link := row.MasterPlanID
		created, replaced, err := p.store.ApplyStructuredWeeklyPlan(
			ctx, userID, weekStart, string(content), replacement,
			storage.WeeklyPlanApplyOptions{MasterPlanID: &link, ContinueRevision: true},
		)
		if errors.Is(err, storage.ErrWeeklyPlanExists) || errors.Is(err, storage.ErrWeeklyPlanConflict) {
			c.JSON(http.StatusConflict, errorResponse{Error: "weekly_plan_changed"})
			return
		}
		if err != nil {
			p.log.Error("adjustment accept apply week failed", zapErr(err), zap.String("user_id", userID), zap.String("week_start", weekStart))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
		applied = append(applied, appliedWeek{WeekStart: created.WeekStart, Revision: created.Revision, Replaced: replaced != nil})
	}
	if err := p.store.SetAdjustmentStatus(ctx, userID, row.ID, storage.PlanAdjustmentStatusAccepted); err != nil {
		p.log.Error("adjustment accept status transition failed", zapErr(err), zap.String("user_id", userID))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusOK, acceptAdjustmentResponse{Applied: applied})
}

type acceptAdjustmentWeek struct {
	WeekStart string `json:"week_start"`
	Revision  int64  `json:"revision"`
	Replaced  bool   `json:"replaced"`
}

type acceptAdjustmentResponse struct {
	Applied []acceptAdjustmentWeek `json:"applied"`
}

// dismiss closes the event: this (user, event week) is never asked again —
// the reality is silently absorbed by the next batch-boundary rolling.
//
//	@Summary		Dismiss the adjustment (keep the current plan)
//	@Description	#858: closes the event — the same deviation week is never re-proposed; adaptation defers to the next rolling boundary.
//	@Tags			plan-adjustment
//	@Produce		json
//	@Param			user_id	path	string	true	"User UUID (JWT sub; self only)"
//	@Param			id		path	string	true	"Adjustment UUID"
//	@Success		204
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		404		{object}	errorResponse
//	@Failure		409		{object}	errorResponse
//	@Security		BearerAuth
//	@Router		/api/users/{user_id}/plan-adjustments/{id}/dismiss [post]
func (p *planAdjustmentRoutes) dismiss(c *gin.Context) {
	userID := c.Param("user_id")
	if !p.selfOnly(c, userID) {
		return
	}
	err := p.store.SetAdjustmentStatus(c.Request.Context(), userID, c.Param("id"), storage.PlanAdjustmentStatusDismissed)
	if errors.Is(err, storage.ErrAdjustmentNotFound) {
		c.JSON(http.StatusNotFound, errorResponse{Error: "adjustment_not_found"})
		return
	}
	if errors.Is(err, storage.ErrAdjustmentState) {
		c.JSON(http.StatusConflict, errorResponse{Error: "adjustment_state_conflict"})
		return
	}
	if err != nil {
		p.log.Error("dismiss adjustment failed", zapErr(err), zap.String("user_id", userID))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.Status(http.StatusNoContent)
}

// selfOnly enforces the user tier's self-scope (admins/internal never enter
// these routes: the popup is the athlete's decision alone).
func (p *planAdjustmentRoutes) selfOnly(c *gin.Context, userID string) bool {
	caller := callerFrom(c)
	if caller.Tier != TierUser {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return false
	}
	if _, err := uuid.Parse(userID); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_user"})
		return false
	}
	if caller.UserID != userID {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return false
	}
	return true
}

var adjustmentReasons = map[string]bool{
	"pace_unmet": true, "volume_unmet": true, "no_time": true,
	"injured": true, "ran_other": true, "over_delivered": true,
}

func isAdjustmentReason(reason string) bool { return adjustmentReasons[reason] }

func isMondayDate(day string) bool {
	parsed, ok := parseExactDate(day)
	return ok && parsed.Weekday() == time.Monday
}
