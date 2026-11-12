package api

import (
	"errors"
	"net/http"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/storage"
)

// Internal rolling materialization channel (#858 PR-A): the TS plan-job worker
// applies the weekly docs a master/rolling kernel produced in one batch and
// lists the weeks already materialized for a master plan. Same X-Internal-Token
// tier as the internal job surface (ADR 0033); the admin JWT tier and the user
// tier cannot enter.

type batchApplyWeeklyPlansRequest struct {
	MasterPlanID string           `json:"master_plan_id" binding:"required"`
	Weeks        []map[string]any `json:"weeks" binding:"required"`
}

type batchApplyWeeklyPlanResult struct {
	WeekStart string `json:"week_start"`
	PlanID    string `json:"plan_id"`
	Revision  int64  `json:"revision"`
	Replaced  bool   `json:"replaced"`
}

type batchApplyWeeklyPlansResponse struct {
	Results []batchApplyWeeklyPlanResult `json:"results"`
}

type internalWeekRowResponse struct {
	WeekStart    string  `json:"week_start"`
	MasterPlanID *string `json:"master_plan_id"`
	Revision     int64   `json:"revision"`
}

type listInternalWeeksResponse struct {
	Weeks []internalWeekRowResponse `json:"weeks"`
}

// registerInternal mounts the rolling weekly channel on the default-deny
// authenticated group (internal tier only; the handlers re-check the tier).
func (w *weeklyPlanRoutes) registerInternal(rg *gin.RouterGroup) {
	if w.store == nil {
		return
	}
	rg.POST("/api/internal/users/:user_id/plan/weeks/batch-apply", w.batchApply)
	rg.GET("/api/internal/users/:user_id/plan/weeks", w.listInternalWeeks)
}

// batchApply validates and applies a batch of weekly docs for one master plan.
// A week with an existing active row under the same master plan is replaced
// with revision+1; a row under a different master plan is a 409 (changing
// plans goes through the master-plan apply/update path). Any failure rejects
// the whole batch with a 4xx so a redelivery stays safe.
//
//	@Summary		Batch-apply weekly docs (internal, rolling channel)
//	@Description	Internal-only (#858). Applies a batch of validated weekly-plan docs linked to one master plan. Same-plan weeks replace with revision+1; weeks owned by a different master plan are rejected with 409. Any invalid week rejects the whole batch.
//	@Tags			weekly-plan
//	@Accept			json
//	@Produce		json
//	@Param			user_id	path		string							true	"Target user UUID"
//	@Param			body	body		batchApplyWeeklyPlansRequest	true	"Master plan id plus the weekly docs to apply"
//	@Success		201		{object}	batchApplyWeeklyPlansResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		409		{object}	errorResponse
//	@Failure		413		{object}	errorResponse
//	@Failure		422		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Router			/api/internal/users/{user_id}/plan/weeks/batch-apply [post]
func (w *weeklyPlanRoutes) batchApply(c *gin.Context) {
	if callerFrom(c).Tier != TierInternal {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}
	userID := c.Param("user_id")
	if _, err := uuid.Parse(userID); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_user"})
		return
	}

	var body batchApplyWeeklyPlansRequest
	if err := c.ShouldBindJSON(&body); err != nil {
		if isBodyTooLarge(err) {
			c.JSON(http.StatusRequestEntityTooLarge, errorResponse{Error: "weekly_plan_too_large"})
			return
		}
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid request body"})
		return
	}
	masterPlanID, err := uuid.Parse(body.MasterPlanID)
	if err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_master_plan"})
		return
	}
	if len(body.Weeks) == 0 {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "empty_weeks"})
		return
	}

	ctx := c.Request.Context()
	// Phase 1 validates every week and pre-resolves the replacement
	// expectation, so content errors and cross-plan conflicts are rejected
	// before anything is written.
	type preparedWeek struct {
		weekStart   string
		content     string
		replacement *storage.WeeklyPlanReplacement
	}
	seen := make(map[string]bool, len(body.Weeks))
	prepared := make([]preparedWeek, 0, len(body.Weeks))
	for index, document := range body.Weeks {
		weekName, _ := document["week_name"].(string)
		weekStart, _, ok := weekIdentity(weekName)
		if !ok {
			c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_content"})
			return
		}
		if seen[weekStart] {
			c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "duplicate_week"})
			return
		}
		seen[weekStart] = true
		content, err := validateAppliedWeeklyPlan(document, weekName)
		if err != nil {
			w.log.Warn("batch apply week content invalid", zapErr(err), zap.String("user_id", userID), zap.Int("week_index", index))
			c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_content"})
			return
		}
		active, err := w.store.GetActiveWeeklyPlan(ctx, userID, weekStart)
		if err != nil {
			w.log.Error("batch apply read active week failed", zapErr(err), zap.String("user_id", userID))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
		var replacement *storage.WeeklyPlanReplacement
		if active != nil {
			if active.MasterPlanID == nil || *active.MasterPlanID != masterPlanID.String() {
				// A weekly row belongs to another master plan: replacing it is a
				// plan change, which is the master apply/update path's decision.
				c.JSON(http.StatusConflict, errorResponse{Error: "weekly_plan_master_plan_conflict"})
				return
			}
			replacement = &storage.WeeklyPlanReplacement{PlanID: active.PlanID, Revision: active.Revision}
		}
		prepared = append(prepared, preparedWeek{weekStart: weekStart, content: string(content), replacement: replacement})
	}

	// Phase 2 applies each week. Weeks are independent rows; a storage-level
	// race mid-batch can still leave a prefix applied, which is safe to retry:
	// re-delivering the same batch replaces with revision+1 (no duplicates).
	results := make([]batchApplyWeeklyPlanResult, 0, len(prepared))
	for _, week := range prepared {
		link := masterPlanID.String()
		created, replaced, err := w.store.ApplyStructuredWeeklyPlan(
			ctx, userID, week.weekStart, week.content, week.replacement,
			storage.WeeklyPlanApplyOptions{MasterPlanID: &link, ContinueRevision: true},
		)
		if errors.Is(err, storage.ErrWeeklyPlanExists) || errors.Is(err, storage.ErrWeeklyPlanConflict) {
			c.JSON(http.StatusConflict, errorResponse{Error: "weekly_plan_changed"})
			return
		}
		if err != nil {
			w.log.Error("batch apply week failed", zapErr(err), zap.String("user_id", userID), zap.String("week_start", week.weekStart))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
		results = append(results, batchApplyWeeklyPlanResult{
			WeekStart: created.WeekStart, PlanID: created.PlanID,
			Revision: created.Revision, Replaced: replaced != nil,
		})
	}
	c.JSON(http.StatusCreated, batchApplyWeeklyPlansResponse{Results: results})
}

// listInternalWeeks returns the weeks materialized for one master plan
// (oldest first), so the rolling worker can compute lastGeneratedWeek.
//
//	@Summary		List materialized weeks (internal, rolling channel)
//	@Description	Internal-only (#858). Returns the active weekly rows linked to a master plan: week_start, master_plan_id and revision, oldest first.
//	@Tags			weekly-plan
//	@Produce		json
//	@Param			user_id			path	string	true	"Target user UUID"
//	@Param			master_plan_id	query	string	true	"Master plan UUID"
//	@Success		200	{object}	listInternalWeeksResponse
//	@Failure		400	{object}	errorResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		403	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		InternalToken
//	@Router			/api/internal/users/{user_id}/plan/weeks [get]
func (w *weeklyPlanRoutes) listInternalWeeks(c *gin.Context) {
	if callerFrom(c).Tier != TierInternal {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}
	userID := c.Param("user_id")
	if _, err := uuid.Parse(userID); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_user"})
		return
	}
	masterPlanID := c.Query("master_plan_id")
	if _, err := uuid.Parse(masterPlanID); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_master_plan"})
		return
	}

	plans, err := w.store.ListActiveWeeklyPlans(c.Request.Context(), userID)
	if err != nil {
		w.log.Error("internal list weekly weeks failed", zapErr(err), zap.String("user_id", userID))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	weeks := make([]internalWeekRowResponse, 0, len(plans))
	for _, plan := range plans {
		if plan.MasterPlanID == nil || *plan.MasterPlanID != masterPlanID {
			continue
		}
		start, err := parseStoredWeekStart(plan.WeekStart)
		if err != nil || start.Weekday() != time.Monday {
			w.log.Error("internal weekly row has invalid identity", zap.String("plan_id", plan.PlanID), zap.String("week_start", plan.WeekStart))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
		weeks = append(weeks, internalWeekRowResponse{
			WeekStart: start.Format("2006-01-02"), MasterPlanID: plan.MasterPlanID, Revision: plan.Revision,
		})
	}
	sort.Slice(weeks, func(i, j int) bool { return weeks[i].WeekStart < weeks[j].WeekStart })
	c.JSON(http.StatusOK, listInternalWeeksResponse{Weeks: weeks})
}
