package api

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/apifmt"
	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
)

type WeeklyPlanStore interface {
	ListActiveWeeklyPlans(ctx context.Context, userID string) ([]storage.WeeklyPlan, error)
	ListWeekSummaries(ctx context.Context, userID, masterPlanID string) ([]storage.WeekSummary, error)
	ListWeekActivities(ctx context.Context, userID, dateFrom, dateTo string) ([]storage.Activity, error)
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
	rg.GET("/api/:user/weeks", w.listSummaries)
	rg.GET("/api/:user/weeks/:weekName", w.weekDetail)
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

type weekSummaryResponse struct {
	Folder             string  `json:"folder"`
	DateFrom           string  `json:"date_from"`
	DateTo             string  `json:"date_to"`
	HasPlan            bool    `json:"has_plan"`
	HasFeedback        bool    `json:"has_feedback"`
	HasBodyComposition bool    `json:"has_body_composition"`
	PlanSource         string  `json:"plan_source"`
	PlanTitle          string  `json:"plan_title"`
	ActivityCount      int     `json:"activity_count"`
	TotalKM            float64 `json:"total_km"`
	TotalDurationS     float64 `json:"total_duration_s"`
	TotalDurationFmt   string  `json:"total_duration_fmt"`
}

type weekActivityResponse struct {
	activityDetailDTO
	RouteThumb json.RawMessage `json:"route_thumb" swaggertype:"object"`
}

type structuredWeekResponse struct {
	StructuredStatus string `json:"structured_status"`
	Sessions         any    `json:"sessions"`
	Nutrition        any    `json:"nutrition"`
	CoachNotes       any    `json:"coach_notes"`
}

type weekDetailResponse struct {
	WeekName         string                  `json:"week_name"`
	DateFrom         string                  `json:"date_from"`
	DateTo           string                  `json:"date_to"`
	Plan             *string                 `json:"plan,omitempty"`
	Activities       []weekActivityResponse  `json:"activities"`
	TotalKM          float64                 `json:"total_km"`
	TotalDurationS   float64                 `json:"total_duration_s"`
	TotalDurationFmt string                  `json:"total_duration_fmt"`
	ActivityCount    int                     `json:"activity_count"`
	Structured       *structuredWeekResponse `json:"structured,omitempty"`
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

// listSummaries exposes canonical MySQL weekly plans in the legacy list shape.
// File-backed feedback/body-composition flags are false because those stores
// are not part of stride-api.
func (w *weeklyPlanRoutes) listSummaries(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	masterPlanID, hasMasterPlan := c.GetQuery("master_plan")
	masterPlanID = strings.TrimSpace(masterPlanID)
	if hasMasterPlan && masterPlanID == "" {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_master_plan"})
		return
	}
	if masterPlanID != "" {
		if _, err := uuid.Parse(masterPlanID); err != nil {
			c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_master_plan"})
			return
		}
	}
	rows, err := w.store.ListWeekSummaries(c.Request.Context(), user, masterPlanID)
	if err != nil {
		w.log.Error("list week summaries failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	weeks := make([]weekSummaryResponse, 0, len(rows))
	for _, row := range rows {
		start, err := time.Parse("2006-01-02", row.WeekStart)
		if err != nil || start.Weekday() != time.Monday {
			w.log.Error("weekly plan has invalid identity", zap.String("plan_id", row.PlanID), zap.String("week_start", row.WeekStart))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
		end := start.AddDate(0, 0, 6)
		folder := start.Format("2006-01-02") + "_" + end.Format("01-02")
		planTitle := folder
		if row.ContentVersion == storage.WeeklyPlanContentMarkdown {
			firstLine, _, _ := strings.Cut(row.Content, "\n")
			if title := strings.TrimSpace(strings.TrimLeft(strings.TrimSpace(firstLine), "# ")); title != "" {
				planTitle = title
			}
		}
		weeks = append(weeks, weekSummaryResponse{
			Folder: folder, DateFrom: row.WeekStart, DateTo: end.Format("2006-01-02"),
			HasPlan: true, HasFeedback: false, HasBodyComposition: false,
			PlanSource: "weekly_plan_store", PlanTitle: planTitle,
			ActivityCount: row.ActivityCount, TotalKM: row.TotalKM,
			TotalDurationS: row.TotalDurationS, TotalDurationFmt: apifmt.DurationFmt(&row.TotalDurationS),
		})
	}
	c.JSON(http.StatusOK, gin.H{"weeks": weeks})
}

// weekDetail returns the migrated active weekly plan plus activities from the
// canonical MySQL stores.
//
//	@Summary		Get a user's week detail
//	@Tags			weekly-plan
//	@Produce		json
//	@Param			user		path	string	true	"User id (JWT sub)"
//	@Param			weekName	path	string	true	"Shanghai week name (YYYY-MM-DD_MM-DD)"
//	@Success		200	{object}	weekDetailResponse
//	@Failure		400	{object}	errorResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		403	{object}	errorResponse
//	@Failure		404	{object}	errorResponse
//	@Failure		500	{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/weeks/{weekName} [get]
func (w *weeklyPlanRoutes) weekDetail(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	weekName := c.Param("weekName")
	weekStart, weekEnd, ok := weekIdentity(weekName)
	if !ok {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_week_name"})
		return
	}
	plan, err := w.store.GetActiveWeeklyPlan(c.Request.Context(), user, weekStart)
	if err != nil {
		w.log.Error("get week detail plan failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if plan == nil {
		c.JSON(http.StatusNotFound, errorResponse{Error: "weekly_plan_not_found"})
		return
	}
	dateTo := weekEnd.Format("2006-01-02")
	rows, err := w.store.ListWeekActivities(c.Request.Context(), user, weekStart, dateTo)
	if err != nil {
		w.log.Error("get week detail activities failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}

	response := weekDetailResponse{
		WeekName: weekName, DateFrom: weekStart, DateTo: dateTo,
		Activities: make([]weekActivityResponse, 0, len(rows)),
	}
	for i := range rows {
		activity := toActivityDetail(&rows[i])
		response.Activities = append(response.Activities, weekActivityResponse{
			activityDetailDTO: activity,
			RouteThumb:        routeThumbRaw(rows[i].RouteThumbJSON),
		})
		response.TotalKM += activity.DistanceKm
		if rows[i].DurationS != nil {
			response.TotalDurationS += *rows[i].DurationS
		}
	}
	response.TotalKM = math.Round(response.TotalKM*10) / 10
	response.TotalDurationFmt = apifmt.DurationFmt(&response.TotalDurationS)
	response.ActivityCount = len(response.Activities)

	if plan.ContentVersion == storage.WeeklyPlanContentMarkdown {
		response.Plan = &plan.Content
	} else {
		var document map[string]any
		if err := json.Unmarshal([]byte(plan.Content), &document); err != nil {
			w.log.Error("weekly plan content is invalid JSON", zapErr(err), zap.String("plan_id", plan.PlanID))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
		sessions, sessionsOK := document["sessions"].([]any)
		nutrition, nutritionOK := document["nutrition"].([]any)
		if !sessionsOK || !nutritionOK {
			w.log.Error("weekly plan content is missing structured arrays", zap.String("plan_id", plan.PlanID))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
		coachNotes := document["coach_notes"]
		if coachNotes == nil {
			coachNotes = document["notes_md"]
		}
		response.Structured = &structuredWeekResponse{
			StructuredStatus: "canonical", Sessions: sessions, Nutrition: nutrition, CoachNotes: coachNotes,
		}
	}
	c.JSON(http.StatusOK, response)
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
