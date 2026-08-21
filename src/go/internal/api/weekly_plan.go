package api

import (
	"context"
	"encoding/json"
	"errors"
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
	ApplyStructuredWeeklyPlan(ctx context.Context, userID, weekStart, content string, replacement *storage.WeeklyPlanReplacement) (*storage.WeeklyPlan, *storage.WeeklyPlan, error)
	GetWeeklyFeedback(ctx context.Context, userID, weekStart string) (*storage.WeeklyFeedback, error)
	PutWeeklyFeedback(ctx context.Context, userID, weekStart, content string) (storage.WeeklyFeedback, error)
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

// registerReads mounts the Weekly Plan read surface on the shared authenticated
// group. User callers remain tenant-scoped, while verified admin and internal
// callers may inspect any user's plan.
func (w *weeklyPlanRoutes) registerReads(rg *gin.RouterGroup) {
	if w.store == nil {
		return
	}
	rg.GET("/api/:user/plan/weeks", w.list)
	rg.GET("/api/:user/plan/weeks/:weekName", w.detail)
	rg.GET("/api/:user/weeks", w.listSummaries)
	rg.GET("/api/:user/weeks/:weekName", w.weekDetail)
}

// registerWrites keeps Weekly Plan mutations on the default-deny route group,
// so an admin-dashboard token cannot edit an athlete's feedback.
func (w *weeklyPlanRoutes) registerWrites(rg *gin.RouterGroup) {
	if w.store == nil {
		return
	}
	rg.PUT("/api/:user/weeks/:weekName/feedback", w.putFeedback)
}

// registerAdminWrites mounts the narrow administrator-only plan import path on
// the parent authenticated group. The handler still verifies TierAdmin so user
// and internal callers cannot use it.
func (w *weeklyPlanRoutes) registerAdminWrites(rg *gin.RouterGroup) {
	if w.store == nil {
		return
	}
	rg.POST("/api/:user/plan/weeks/:weekName", w.apply)
}

type applyWeeklyPlanRequest struct {
	Content                map[string]any `json:"content" binding:"required"`
	ReplaceExisting        bool           `json:"replace_existing"`
	ExpectedActivePlanID   *string        `json:"expected_active_plan_id"`
	ExpectedActiveRevision *int64         `json:"expected_active_revision"`
}

type applyWeeklyPlanResponse struct {
	Success        bool                     `json:"success"`
	Plan           weeklyPlanDetailResponse `json:"plan"`
	ReplacedPlanID *string                  `json:"replaced_plan_id"`
}

// apply imports a validated structured Weekly Plan for an existing athlete.
// A caller must explicitly identify the active plan it confirmed replacing;
// the store then archives that exact revision and inserts the new active row
// atomically.
//
//	@Summary		Apply a structured Weekly Plan as an administrator
//	@Description	Creates a new active plan. Replacing one requires replace_existing plus the confirmed active plan id and revision; the prior plan is archived atomically.
//	@Tags			weekly-plan
//	@Accept			json
//	@Produce		json
//	@Param			user		path		string				 true	"Target user UUID"
//	@Param			weekName	path		string				 true	"Shanghai week name (YYYY-MM-DD_MM-DD)"
//	@Param			body		body		applyWeeklyPlanRequest true	"Structured plan and replacement decision"
//	@Success		201			{object}	applyWeeklyPlanResponse
//	@Failure		400			{object}	errorResponse
//	@Failure		401			{object}	errorResponse
//	@Failure		403			{object}	errorResponse
//	@Failure		409			{object}	errorResponse
//	@Failure		413			{object}	errorResponse
//	@Failure		422			{object}	errorResponse
//	@Failure		500			{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/{user}/plan/weeks/{weekName} [post]
func (w *weeklyPlanRoutes) apply(c *gin.Context) {
	if callerFrom(c).Tier != TierAdmin {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}
	user := c.Param("user")
	if _, err := uuid.Parse(user); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_user"})
		return
	}
	weekName := c.Param("weekName")
	weekStart, _, ok := weekIdentity(weekName)
	if !ok {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_week_name"})
		return
	}

	var request applyWeeklyPlanRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			c.JSON(http.StatusRequestEntityTooLarge, errorResponse{Error: "weekly_plan_too_large"})
			return
		}
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_content"})
		return
	}
	exp, err := parseReplacementExpectation(request.ReplaceExisting, request.ExpectedActivePlanID, request.ExpectedActiveRevision)
	if err != nil {
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_replacement"})
		return
	}
	var replacement *storage.WeeklyPlanReplacement
	if exp != nil {
		replacement = &storage.WeeklyPlanReplacement{PlanID: exp.PlanID, Revision: exp.Revision}
	}
	content, err := validateAppliedWeeklyPlan(request.Content, weekName)
	if err != nil {
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_content"})
		return
	}

	created, replaced, err := w.store.ApplyStructuredWeeklyPlan(
		c.Request.Context(), user, weekStart, string(content), replacement,
	)
	if errors.Is(err, storage.ErrWeeklyPlanExists) {
		c.JSON(http.StatusConflict, errorResponse{Error: "weekly_plan_exists"})
		return
	}
	if errors.Is(err, storage.ErrWeeklyPlanConflict) {
		c.JSON(http.StatusConflict, errorResponse{Error: "weekly_plan_changed"})
		return
	}
	if err != nil {
		w.log.Error("apply weekly plan failed", zapErr(err), zap.String("user_id", user), zap.String("week_name", weekName))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	metadata, err := weeklyPlanMetadata(*created)
	if err != nil {
		w.log.Error("applied weekly plan has invalid identity", zapErr(err), zap.String("plan_id", created.PlanID))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	var document map[string]any
	if err := json.Unmarshal(content, &document); err != nil {
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	var replacedID *string
	if replaced != nil {
		replacedID = &replaced.PlanID
	}
	c.JSON(http.StatusCreated, applyWeeklyPlanResponse{
		Success:        true,
		Plan:           weeklyPlanDetailResponse{weeklyPlanMetadataResponse: metadata, Content: document},
		ReplacedPlanID: replacedID,
	})
}

// planReplacementExpectation is the active-row (plan id, revision) an
// administrator explicitly confirmed replacing.
type planReplacementExpectation struct {
	PlanID   string
	Revision int64
}

// parseReplacementExpectation validates the replace_existing +
// expected_active_plan_id/revision contract shared by the weekly and master plan
// import handlers. A nil result with nil error means "apply without
// replacement".
func parseReplacementExpectation(replaceExisting bool, expectedPlanID *string, expectedRevision *int64) (*planReplacementExpectation, error) {
	if !replaceExisting {
		if expectedPlanID != nil || expectedRevision != nil {
			return nil, errors.New("replacement expectation requires replace_existing")
		}
		return nil, nil
	}
	if expectedPlanID == nil || strings.TrimSpace(*expectedPlanID) == "" ||
		expectedRevision == nil || *expectedRevision < 1 {
		return nil, errors.New("replacement expectation is incomplete")
	}
	planID, err := uuid.Parse(*expectedPlanID)
	if err != nil {
		return nil, errors.New("replacement plan id is invalid")
	}
	return &planReplacementExpectation{
		PlanID: planID.String(), Revision: *expectedRevision,
	}, nil
}

type putWeeklyFeedbackRequest struct {
	Content *string `json:"content" binding:"required"`
}

type weeklyFeedbackResponse struct {
	Success     bool   `json:"success"`
	Week        string `json:"week"`
	Feedback    string `json:"feedback"`
	HasFeedback bool   `json:"has_feedback"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

// putFeedback saves the athlete's feedback for one Shanghai natural week.
//
//	@Summary		Save weekly feedback
//	@Tags			weekly-plan
//	@Accept			json
//	@Produce		json
//	@Param			user		path		string					true	"User id (JWT sub)"
//	@Param			weekName	path		string					true	"Shanghai week name (YYYY-MM-DD_MM-DD)"
//	@Param			body		body		putWeeklyFeedbackRequest	true	"Weekly feedback"
//	@Success		200			{object}	weeklyFeedbackResponse
//	@Failure		400			{object}	errorResponse
//	@Failure		401			{object}	errorResponse
//	@Failure		403			{object}	errorResponse
//	@Failure		413			{object}	errorResponse
//	@Failure		422			{object}	errorResponse
//	@Failure		500			{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/weeks/{weekName}/feedback [put]
func (w *weeklyPlanRoutes) putFeedback(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	weekName := c.Param("weekName")
	weekStart, _, ok := weekIdentity(weekName)
	if !ok {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_week_name"})
		return
	}
	var request putWeeklyFeedbackRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			c.JSON(http.StatusRequestEntityTooLarge, errorResponse{Error: "weekly_feedback_too_large"})
			return
		}
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_content"})
		return
	}
	if request.Content == nil {
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_content"})
		return
	}
	content := *request.Content
	if len([]byte(content)) > 256*1024 {
		c.JSON(http.StatusRequestEntityTooLarge, errorResponse{Error: "weekly_feedback_too_large"})
		return
	}
	if strings.TrimSpace(content) == "" {
		content = ""
	}
	row, err := w.store.PutWeeklyFeedback(c.Request.Context(), user, weekStart, content)
	if err != nil {
		w.log.Error("put weekly feedback failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusOK, weeklyFeedbackResponse{
		Success: true, Week: weekName, Feedback: row.ContentMD, HasFeedback: row.ContentMD != "",
		CreatedAt: row.CreatedAt.UTC().Format(time.RFC3339Nano), UpdatedAt: row.UpdatedAt.UTC().Format(time.RFC3339Nano),
	})
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
	WeekName          string                  `json:"week_name"`
	DateFrom          string                  `json:"date_from"`
	DateTo            string                  `json:"date_to"`
	Plan              *string                 `json:"plan" extensions:"x-nullable"`
	Activities        []weekActivityResponse  `json:"activities"`
	TotalKM           float64                 `json:"total_km"`
	TotalDurationS    float64                 `json:"total_duration_s"`
	TotalDurationFmt  string                  `json:"total_duration_fmt"`
	ActivityCount     int                     `json:"activity_count"`
	Structured        *structuredWeekResponse `json:"structured" extensions:"x-nullable"`
	Feedback          string                  `json:"feedback"`
	FeedbackCreatedAt *string                 `json:"feedback_created_at" format:"date-time" extensions:"x-nullable"`
	FeedbackUpdatedAt *string                 `json:"feedback_updated_at" format:"date-time" extensions:"x-nullable"`
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
	start, err := parseStoredWeekStart(plan.WeekStart)
	if err != nil || start.Weekday() != time.Monday {
		return weeklyPlanMetadataResponse{}, fmt.Errorf("invalid stored week_start %q", plan.WeekStart)
	}
	end := start.AddDate(0, 0, 6)
	dateFrom := start.Format("2006-01-02")
	return weeklyPlanMetadataResponse{
		PlanID: plan.PlanID, WeekName: dateFrom + "_" + end.Format("01-02"),
		DateFrom: dateFrom, DateTo: end.Format("2006-01-02"),
		MasterPlanID: plan.MasterPlanID, Status: plan.Status,
		ContentVersion: plan.ContentVersion, Revision: plan.Revision,
		CreatedAt: plan.CreatedAt.UTC().Format(time.RFC3339Nano),
		UpdatedAt: plan.UpdatedAt.UTC().Format(time.RFC3339Nano),
	}, nil
}

func parseStoredWeekStart(value string) (time.Time, error) {
	if date, err := time.Parse("2006-01-02", value); err == nil {
		return date, nil
	}
	date, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}, err
	}
	if date.Hour() != 0 || date.Minute() != 0 || date.Second() != 0 || date.Nanosecond() != 0 {
		return time.Time{}, fmt.Errorf("stored date is not midnight")
	}
	return date, nil
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
		hasPlan := row.PlanID != ""
		planSource := "none"
		if hasPlan {
			planSource = "weekly_plan_store"
		}
		weeks = append(weeks, weekSummaryResponse{
			Folder: folder, DateFrom: row.WeekStart, DateTo: end.Format("2006-01-02"),
			HasPlan: hasPlan, HasFeedback: row.HasFeedback, HasBodyComposition: false,
			PlanSource: planSource, PlanTitle: planTitle,
			ActivityCount: row.ActivityCount, TotalKM: row.TotalKM,
			TotalDurationS: row.TotalDurationS, TotalDurationFmt: apifmt.DurationFmt(&row.TotalDurationS),
		})
	}
	c.JSON(http.StatusOK, gin.H{"weeks": weeks})
}

// weekDetail aggregates an active plan, activities, and weekly feedback for one
// Shanghai natural week.
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
	dateTo := weekEnd.Format("2006-01-02")
	rows, err := w.store.ListWeekActivities(c.Request.Context(), user, weekStart, dateTo)
	if err != nil {
		w.log.Error("get week detail activities failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	feedback, err := w.store.GetWeeklyFeedback(c.Request.Context(), user, weekStart)
	if err != nil {
		w.log.Error("get week detail feedback failed", zapErr(err))
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
	if feedback != nil {
		response.Feedback = feedback.ContentMD
		createdAt := feedback.CreatedAt.UTC().Format(time.RFC3339Nano)
		updatedAt := feedback.UpdatedAt.UTC().Format(time.RFC3339Nano)
		response.FeedbackCreatedAt = &createdAt
		response.FeedbackUpdatedAt = &updatedAt
	}

	if plan == nil {
		if len(rows) == 0 && feedback == nil {
			c.JSON(http.StatusNotFound, errorResponse{Error: "week_not_found"})
			return
		}
		c.JSON(http.StatusOK, response)
		return
	}
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
