package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
)

type WeeklyPlanStore interface {
	ListActiveWeeklyPlans(ctx context.Context, userID string) ([]storage.WeeklyPlan, error)
	GetActiveWeeklyPlan(ctx context.Context, userID, weekStart string) (*storage.WeeklyPlan, error)
}

type weeklyPlanRoutes struct {
	store WeeklyPlanStore
	log   *zap.Logger
}

func newWeeklyPlanRoutes(store WeeklyPlanStore, log *zap.Logger) *weeklyPlanRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &weeklyPlanRoutes{store: store, log: log}
}

func (w *weeklyPlanRoutes) register(rg *gin.RouterGroup) {
	if w.store == nil {
		return
	}
	rg.GET("/api/:user/plan/weeks", w.list)
	rg.GET("/api/:user/plan/weeks/:weekName", w.detail)
}

type weeklyPlanMetadataResponse struct {
	PlanID         string  `json:"plan_id"`
	WeekName       string  `json:"week_name"`
	DateFrom       string  `json:"date_from"`
	DateTo         string  `json:"date_to"`
	MasterPlanID   *string `json:"master_plan_id"`
	Status         string  `json:"status"`
	ContentVersion int8    `json:"content_version"`
	Revision       int64   `json:"revision"`
	CreatedAt      string  `json:"created_at"`
	UpdatedAt      string  `json:"updated_at"`
}

type weeklyPlanDetailResponse struct {
	weeklyPlanMetadataResponse
	Content any `json:"content"`
}

var weekNamePattern = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2})$`)

func weekIdentity(weekName string) (weekStart string, weekEnd time.Time, ok bool) {
	match := weekNamePattern.FindStringSubmatch(weekName)
	if match == nil {
		return "", time.Time{}, false
	}
	start, err := time.Parse("2006-01-02", match[1])
	if err != nil || start.Weekday() != time.Monday {
		return "", time.Time{}, false
	}
	end := start.AddDate(0, 0, 6)
	if end.Format("01-02") != match[2] {
		return "", time.Time{}, false
	}
	return match[1], end, true
}

func weeklyPlanMetadata(plan storage.WeeklyPlan) (weeklyPlanMetadataResponse, error) {
	start, err := time.Parse("2006-01-02", plan.WeekStart)
	if err != nil || start.Weekday() != time.Monday {
		return weeklyPlanMetadataResponse{}, fmt.Errorf("invalid stored week_start %q", plan.WeekStart)
	}
	end := start.AddDate(0, 0, 6)
	return weeklyPlanMetadataResponse{
		PlanID: plan.PlanID, WeekName: start.Format("2006-01-02") + "_" + end.Format("01-02"),
		DateFrom: plan.WeekStart, DateTo: end.Format("2006-01-02"),
		MasterPlanID: plan.MasterPlanID, Status: plan.Status,
		ContentVersion: plan.ContentVersion, Revision: plan.Revision,
		CreatedAt: plan.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt: plan.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}, nil
}

// list returns metadata for every active weekly plan, newest first.
//
//	@Summary		List a user's active weekly plans
//	@Tags			weekly-plan
//	@Produce		json
//	@Param			user	path	string	true	"User id (JWT sub)"
//	@Success		200	{object}	map[string]interface{}
//	@Failure		401	{object}	errorResponse
//	@Failure		403	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/plan/weeks [get]
func (w *weeklyPlanRoutes) list(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	plans, err := w.store.ListActiveWeeklyPlans(c.Request.Context(), user)
	if err != nil {
		w.log.Error("list weekly plans failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	sort.Slice(plans, func(i, j int) bool { return plans[i].WeekStart > plans[j].WeekStart })
	weeks := make([]weeklyPlanMetadataResponse, 0, len(plans))
	for _, plan := range plans {
		item, err := weeklyPlanMetadata(plan)
		if err != nil {
			w.log.Error("weekly plan has invalid identity", zapErr(err), zap.String("plan_id", plan.PlanID))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
		weeks = append(weeks, item)
	}
	c.JSON(http.StatusOK, gin.H{"weeks": weeks})
}

// detail returns the active weekly plan in its stored representation.
//
//	@Summary		Get a user's active weekly plan
//	@Tags			weekly-plan
//	@Produce		json
//	@Param			user		path	string	true	"User id (JWT sub)"
//	@Param			weekName	path	string	true	"Shanghai week name (YYYY-MM-DD_MM-DD)"
//	@Success		200	{object}	weeklyPlanDetailResponse
//	@Failure		400	{object}	errorResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		403	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/plan/weeks/{weekName} [get]
func (w *weeklyPlanRoutes) detail(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	weekStart, _, ok := weekIdentity(c.Param("weekName"))
	if !ok {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_week_name"})
		return
	}
	plan, err := w.store.GetActiveWeeklyPlan(c.Request.Context(), user, weekStart)
	if err != nil {
		w.log.Error("get weekly plan failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if plan == nil {
		c.JSON(http.StatusNotFound, errorResponse{Error: "weekly_plan_not_found"})
		return
	}
	metadata, err := weeklyPlanMetadata(*plan)
	if err != nil {
		w.log.Error("weekly plan has invalid identity", zapErr(err), zap.String("plan_id", plan.PlanID))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	var content any = plan.Content
	if plan.ContentVersion == storage.WeeklyPlanContentStructured {
		var document map[string]any
		if err := json.Unmarshal([]byte(plan.Content), &document); err != nil {
			w.log.Error("weekly plan content is invalid JSON", zapErr(err), zap.String("plan_id", plan.PlanID))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
		if document == nil {
			w.log.Error("weekly plan content is not a JSON object", zap.String("plan_id", plan.PlanID))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
		if _, ok := document["sessions"].([]any); !ok {
			w.log.Error("weekly plan content has no sessions array", zap.String("plan_id", plan.PlanID))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
		if _, ok := document["nutrition"].([]any); !ok {
			w.log.Error("weekly plan content has no nutrition array", zap.String("plan_id", plan.PlanID))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
		content = document
	}
	c.JSON(http.StatusOK, weeklyPlanDetailResponse{weeklyPlanMetadataResponse: metadata, Content: content})
}
