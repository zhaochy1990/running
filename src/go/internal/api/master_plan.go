package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies (ADR 0024). The master-plan read surface is a sibling registrar
// with its own store port, mounted on the shared authed group.
// ─────────────────────────────────────────────────────────────────────────────

// MasterPlanStore is the MySQL persistence needed by the unified current-plan
// reader. GetCurrentMasterPlan returns either content representation and never
// falls back to Python, Azure, files, or SQLite.
type MasterPlanStore interface {
	GetCurrentMasterPlan(ctx context.Context, userID string) (*storage.MasterPlan, error)
	RunningWeekSummaries(ctx context.Context, userID string, windows []storage.WeekWindow) (map[int]storage.RunningWeekSummary, error)
	TrainingDoseWeekSummaries(ctx context.Context, userID string, windows []storage.WeekWindow) (map[int]storage.TrainingDoseWeekSummary, error)
	ApplyStructuredMasterPlan(ctx context.Context, userID, goalID, content string, replacement *storage.MasterPlanReplacement) (*storage.MasterPlan, *storage.MasterPlan, error)
}

type masterPlanRoutes struct {
	store MasterPlanStore
	log   *zap.Logger
}

func newMasterPlanRoutes(store MasterPlanStore, log *zap.Logger) *masterPlanRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &masterPlanRoutes{store: store, log: log}
}

// register mounts the current season-plan read endpoints on the already-
// authenticated group. /me remains as a compatibility alias for Web clients.
func (m *masterPlanRoutes) register(rg *gin.RouterGroup) {
	if m.store == nil {
		return
	}
	rg.GET("/api/users/me/master-plan/current", m.getCurrent)
	rg.GET("/api/users/:user_id/master-plan/current", m.getCurrentForUser)
}

// registerAdminWrites mounts the narrow administrator-only master plan
// import path on the parent authenticated group. The handler still verifies
// TierAdmin so user and internal callers cannot use it.
func (m *masterPlanRoutes) registerAdminWrites(rg *gin.RouterGroup) {
	if m.store == nil {
		return
	}
	rg.POST("/api/users/:user_id/master-plans", m.apply)
}

type applyMasterPlanRequest struct {
	Content                map[string]any `json:"content" binding:"required"`
	ReplaceExisting        bool           `json:"replace_existing"`
	ExpectedActivePlanID   *string        `json:"expected_active_plan_id"`
	ExpectedActiveRevision *int64         `json:"expected_active_revision"`
}

type applyMasterPlanResponse struct {
	Success        bool                      `json:"success"`
	Plan           currentSeasonPlanEnvelope `json:"plan"`
	ReplacedPlanID *string                   `json:"replaced_plan_id"`
}

// apply imports a validated structured Master Plan for an existing athlete.
// A caller must explicitly identify the active plan it confirmed replacing;
// the store then archives that exact revision and inserts the new active row
// atomically.
//
//	@Summary		Apply a structured Master Plan as an administrator
//	@Description	Creates a new active master plan. Replacing one requires replace_existing plus the confirmed active plan id and revision; the prior plan is archived atomically.
//	@Tags			master-plan
//	@Accept			json
//	@Produce		json
//	@Param			user_id	path		string					 true	"Target user UUID"
//	@Param			body		body		applyMasterPlanRequest true	"Structured plan and replacement decision"
//	@Success		201			{object}	applyMasterPlanResponse
//	@Failure		400			{object}	errorResponse
//	@Failure		401			{object}	errorResponse
//	@Failure		403			{object}	errorResponse
//	@Failure		409			{object}	errorResponse
//	@Failure		413			{object}	errorResponse
//	@Failure		422			{object}	errorResponse
//	@Failure		500			{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/{user_id}/master-plans [post]
func (m *masterPlanRoutes) apply(c *gin.Context) {
	if callerFrom(c).Tier != TierAdmin {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}
	uid := c.Param("user_id")
	if _, err := uuid.Parse(uid); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "invalid_user"})
		return
	}

	var request applyMasterPlanRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			c.JSON(http.StatusRequestEntityTooLarge, errorResponse{Error: "master_plan_too_large"})
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
	var replacement *storage.MasterPlanReplacement
	if exp != nil {
		replacement = &storage.MasterPlanReplacement{PlanID: exp.PlanID, Revision: exp.Revision}
	}
	content, goalID, err := validateAppliedMasterPlan(request.Content)
	if err != nil {
		c.JSON(http.StatusUnprocessableEntity, errorResponse{Error: "invalid_content"})
		return
	}

	created, replaced, err := m.store.ApplyStructuredMasterPlan(c.Request.Context(), uid, goalID, string(content), replacement)
	if errors.Is(err, storage.ErrMasterPlanExists) {
		c.JSON(http.StatusConflict, errorResponse{Error: "master_plan_exists"})
		return
	}
	if errors.Is(err, storage.ErrMasterPlanConflict) {
		c.JSON(http.StatusConflict, errorResponse{Error: "master_plan_changed"})
		return
	}
	if err != nil {
		m.log.Error("apply master plan failed", zapErr(err), zap.String("user_id", uid))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	envelope, _, _, err := buildCurrentEnvelope(created, timefmt.ShanghaiToday(), m.log)
	if err != nil {
		m.log.Error("applied master plan is invalid", zapErr(err), zap.String("plan_id", created.PlanID))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	var replacedID *string
	if replaced != nil {
		replacedID = &replaced.PlanID
	}
	c.JSON(http.StatusCreated, applyMasterPlanResponse{
		Success:        true,
		Plan:           envelope,
		ReplacedPlanID: replacedID,
	})
}

func validateAppliedMasterPlan(content map[string]any) ([]byte, string, error) {
	goal, ok := content["goal"].(map[string]any)
	if !ok {
		return nil, "", errors.New("goal is required")
	}
	goalID, ok := goal["goal_id"].(string)
	if !ok || strings.TrimSpace(goalID) == "" {
		return nil, "", errors.New("goal.goal_id is required")
	}
	if _, err := uuid.Parse(goalID); err != nil {
		return nil, "", errors.New("goal.goal_id must be a UUID")
	}

	jsonBytes, err := json.Marshal(content)
	if err != nil {
		return nil, "", fmt.Errorf("failed to marshal content: %w", err)
	}
	if len(jsonBytes) > 10*1024*1024 {
		return nil, "", errors.New("content exceeds 10MB limit")
	}
	return jsonBytes, goalID, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/users/me/master-plan/current
// ─────────────────────────────────────────────────────────────────────────────

// getCurrent returns the user's active season plan as a content-versioned
// envelope. Only canonical absence is a 404; every storage or validation failure
// is surfaced as 500.
//
//	@Summary		Get the current user's active season training plan
//	@Tags			master-plan
//	@Produce		json
//	@Success		200	{object}	currentSeasonPlanEnvelope
//	@Failure		401	{object}	errorResponse
//	@Failure		404	{object}	map[string]string
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/master-plan/current [get]
func (m *masterPlanRoutes) getCurrent(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	m.getCurrentForUserID(c, uid)
}

// getCurrentForUser returns one user's current plan. User JWTs may read only
// their own subject; verified admin JWTs and the internal token may read any
// user. The target must be a UUID before the storage adapter is called.
//
//	@Summary		Get a user's active season training plan
//	@Tags			master-plan
//	@Produce		json
//	@Param			user_id	path		string	true	"User id (JWT sub)"
//	@Success		200			{object}	currentSeasonPlanEnvelope
//	@Failure		400			{object}	errorResponse
//	@Failure		401			{object}	errorResponse
//	@Failure		403			{object}	errorResponse
//	@Failure		404			{object}	map[string]string
//	@Failure		500			{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/users/{user_id}/master-plan/current [get]
func (m *masterPlanRoutes) getCurrentForUser(c *gin.Context) {
	uid := c.Param("user_id")
	if _, err := uuid.Parse(uid); err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "user must be a UUID"})
		return
	}
	caller := callerFrom(c)
	if caller.Tier == TierUser && uid != caller.UserID {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return
	}
	m.getCurrentForUserID(c, uid)
}

func (m *masterPlanRoutes) getCurrentForUserID(c *gin.Context, uid string) {
	row, err := m.store.GetCurrentMasterPlan(c.Request.Context(), uid)
	if err != nil {
		m.log.Error("get current master plan failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if row == nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "当前没有激活的赛季训练计划"})
		return
	}

	envelope, windows, weekFinished, err := buildCurrentEnvelope(row, timefmt.ShanghaiToday(), m.log)
	if err != nil {
		m.log.Error("current master plan is invalid", zapErr(err), zap.String("plan_id", row.PlanID))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if len(windows) > 0 {
		run, rerr := m.store.RunningWeekSummaries(c.Request.Context(), uid, windows)
		dose, derr := m.store.TrainingDoseWeekSummaries(c.Request.Context(), uid, windows)
		if rerr != nil || derr != nil {
			m.log.Error("master plan weekly actuals failed", zapErr(cmpErr(rerr, derr)))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
		if doc, ok := envelope.Plan.(map[string]any); ok {
			if weeks, ok := doc["weeks"].([]map[string]any); ok {
				overlayActuals(weeks, run, dose, weekFinished)
			}
		}
	}
	c.JSON(http.StatusOK, envelope)
}

func cmpErr(a, b error) error {
	if a != nil {
		return a
	}
	return b
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified envelope and structured response builder
// ─────────────────────────────────────────────────────────────────────────────

type currentSeasonPlanEnvelope struct {
	ContentVersion int8      `json:"content_version" enums:"1,2"`
	Status         string    `json:"status" enums:"active"`
	PlanID         string    `json:"plan_id"`
	GoalID         string    `json:"goal_id"`
	Revision       *int64    `json:"revision" extensions:"x-nullable"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
	Plan           any       `json:"plan"`
}

func buildCurrentEnvelope(row *storage.MasterPlan, today time.Time, log *zap.Logger) (currentSeasonPlanEnvelope, []storage.WeekWindow, map[int]bool, error) {
	if row == nil || strings.TrimSpace(row.Content) == "" {
		return currentSeasonPlanEnvelope{}, nil, nil, fmt.Errorf("current plan content is empty")
	}
	if _, err := uuid.Parse(row.PlanID); err != nil {
		return currentSeasonPlanEnvelope{}, nil, nil, fmt.Errorf("current plan_id is invalid")
	}
	if _, err := uuid.Parse(row.GoalID); err != nil {
		return currentSeasonPlanEnvelope{}, nil, nil, fmt.Errorf("current goal_id is invalid")
	}
	if row.Status != storage.MasterPlanStatusActive || row.CreatedAt.IsZero() || row.UpdatedAt.IsZero() {
		return currentSeasonPlanEnvelope{}, nil, nil, fmt.Errorf("current plan metadata is invalid")
	}
	envelope := currentSeasonPlanEnvelope{
		ContentVersion: row.ContentVersion,
		Status:         row.Status,
		PlanID:         row.PlanID,
		GoalID:         row.GoalID,
		Revision:       row.Revision,
		CreatedAt:      row.CreatedAt,
		UpdatedAt:      row.UpdatedAt,
	}
	if row.ContentVersion == storage.MasterPlanContentMarkdown {
		envelope.Plan = row.Content
		return envelope, nil, nil, nil
	}
	if row.ContentVersion != storage.MasterPlanContentStructured {
		return currentSeasonPlanEnvelope{}, nil, nil, fmt.Errorf("unsupported content_version %d", row.ContentVersion)
	}
	if row.Revision == nil || *row.Revision < 1 {
		return currentSeasonPlanEnvelope{}, nil, nil, fmt.Errorf("structured plan revision must be positive")
	}
	doc, windows, weekFinished, err := buildCurrentResponse(row, today)
	if err != nil {
		return currentSeasonPlanEnvelope{}, nil, nil, err
	}
	goal, ok := doc["goal"].(map[string]any)
	if !ok || asString(goal["goal_id"]) == "" {
		return currentSeasonPlanEnvelope{}, nil, nil, fmt.Errorf("structured plan goal is required")
	}
	if embeddedGoal := asString(goal["goal_id"]); embeddedGoal != row.GoalID {
		log.Warn("master plan embedded goal_id drift", zap.String("plan_id", row.PlanID))
		goal["goal_id"] = row.GoalID
	}
	for _, key := range []string{"plan_id", "user_id", "status", "version", "revision", "created_at", "updated_at"} {
		delete(doc, key)
	}
	envelope.Plan = doc
	return envelope, windows, weekFinished, nil
}

type mpPhase struct {
	ID          string `json:"id"`
	StartDate   string `json:"start_date"`
	EndDate     string `json:"end_date"`
	IsCompleted bool   `json:"is_completed"`
}

type mpMilestone struct {
	ID              string  `json:"id"`
	Date            string  `json:"date"`
	Target          string  `json:"target"`
	CompletedActual *string `json:"completed_actual"`
}

// mpContent captures the subset of the stored MasterPlan JSON needed to compute
// the derived position fields and the expanded week rows.
type mpContent struct {
	StartDate  string        `json:"start_date"`
	EndDate    string        `json:"end_date"`
	TotalWeeks int           `json:"total_weeks"`
	Phases     []mpPhase     `json:"phases"`
	Milestones []mpMilestone `json:"milestones"`
}

// buildCurrentResponse reshapes the stored MasterPlan JSON into the #6 response:
// the plan body passes through verbatim, `weekly_key_sessions` is dropped, `weeks`
// is replaced with the expanded rows (with no-data actuals), and three
// date-derived fields are added. It also returns the per-week activity windows to
// aggregate actuals over, and which of those weeks are already finished (so a
// still-open current week is never reported as a "complete" dose).
func buildCurrentResponse(plan *storage.MasterPlan, today time.Time) (map[string]any, []storage.WeekWindow, map[int]bool, error) {
	var doc map[string]any
	if err := json.Unmarshal([]byte(plan.Content), &doc); err != nil {
		return nil, nil, nil, err
	}
	var parsed mpContent
	if err := json.Unmarshal([]byte(plan.Content), &parsed); err != nil {
		return nil, nil, nil, err
	}
	if err := validateStructuredPlanDoc(doc, parsed); err != nil {
		return nil, nil, nil, err
	}

	rawWeeks := toMapSlice(doc["weeks"])
	if len(rawWeeks) == 0 {
		rawWeeks = toMapSlice(doc["weekly_key_sessions"])
	}

	weeks, windows, weekFinished := buildWeekRows(parsed, rawWeeks, today)
	doc["current_phase_id"] = currentPhaseID(parsed.Phases, today)
	doc["current_week_number"] = currentWeekNumber(parsed, rawWeeks, today)
	doc["next_milestone"] = nextMilestone(parsed.Milestones, today)
	doc["weeks"] = weeks
	delete(doc, "weekly_key_sessions")
	return doc, windows, weekFinished, nil
}

func validateStructuredPlanDoc(doc map[string]any, parsed mpContent) error {
	goal, ok := doc["goal"].(map[string]any)
	if !ok || strings.TrimSpace(asString(goal["goal_id"])) == "" || goal["target_time"] == nil {
		return fmt.Errorf("structured plan goal is invalid")
	}
	if parsed.StartDate == "" || parsed.EndDate == "" || parsed.TotalWeeks < 1 {
		return fmt.Errorf("structured plan dates and total_weeks are required")
	}
	start, ok := parseExactDate(parsed.StartDate)
	if !ok {
		return fmt.Errorf("structured plan start_date is invalid")
	}
	end, ok := parseExactDate(parsed.EndDate)
	if !ok || end.Before(start) {
		return fmt.Errorf("structured plan end_date is invalid")
	}

	phases, ok := doc["phases"].([]any)
	if !ok {
		return fmt.Errorf("structured plan phases are required")
	}
	for _, raw := range phases {
		phase, ok := raw.(map[string]any)
		if !ok || !validPhase(phase) {
			return fmt.Errorf("structured plan phase is invalid")
		}
	}
	milestones, ok := doc["milestones"].([]any)
	if !ok {
		return fmt.Errorf("structured plan milestones are required")
	}
	for _, raw := range milestones {
		milestone, ok := raw.(map[string]any)
		if !ok || !validMilestone(milestone) {
			return fmt.Errorf("structured plan milestone is invalid")
		}
	}
	weeksValue, hasWeeks := doc["weeks"]
	if !hasWeeks {
		weeksValue = doc["weekly_key_sessions"]
	}
	weeks, ok := weeksValue.([]any)
	if !ok {
		return fmt.Errorf("structured plan weeks are required")
	}
	for _, raw := range weeks {
		week, ok := raw.(map[string]any)
		if !ok || !validWeek(week) {
			return fmt.Errorf("structured plan week is invalid")
		}
	}
	principles, ok := doc["training_principles"].([]any)
	if !ok || !allStrings(principles) || strings.TrimSpace(asString(doc["generated_by"])) == "" {
		return fmt.Errorf("structured plan principles or generator are invalid")
	}
	return nil
}

func validPhase(phase map[string]any) bool {
	start, okStart := parseExactDate(asString(phase["start_date"]))
	end, okEnd := parseExactDate(asString(phase["end_date"]))
	return strings.TrimSpace(asString(phase["id"])) != "" && strings.TrimSpace(asString(phase["name"])) != "" &&
		okStart && okEnd && !end.Before(start) && isNumber(phase["weekly_distance_km_low"]) &&
		isNumber(phase["weekly_distance_km_high"]) && isStringArray(phase["key_session_types"]) && isStringArray(phase["milestone_ids"])
}

func validMilestone(milestone map[string]any) bool {
	_, okDate := parseExactDate(asString(milestone["date"]))
	return strings.TrimSpace(asString(milestone["id"])) != "" && strings.TrimSpace(asString(milestone["type"])) != "" &&
		strings.TrimSpace(asString(milestone["phase_id"])) != "" && milestone["target"] != nil && okDate
}

func validWeek(week map[string]any) bool {
	_, okDate := parseExactDate(asString(week["week_start"]))
	keySessions, ok := week["key_sessions"].([]any)
	if !ok || !allMaps(keySessions) {
		return false
	}
	return asInt(week["week_index"]) > 0 && okDate && strings.TrimSpace(asString(week["phase_id"])) != "" &&
		isNullableNumber(week["target_weekly_km_low"]) && isNullableNumber(week["target_weekly_km_high"])
}

func parseExactDate(value string) (time.Time, bool) {
	if len(value) != len("2006-01-02") {
		return time.Time{}, false
	}
	return parseDate(value)
}

func allStrings(values []any) bool {
	for _, value := range values {
		if _, ok := value.(string); !ok {
			return false
		}
	}
	return true
}

func allMaps(values []any) bool {
	for _, value := range values {
		if _, ok := value.(map[string]any); !ok {
			return false
		}
	}
	return true
}

func isStringArray(value any) bool {
	values, ok := value.([]any)
	return ok && allStrings(values)
}

func isNumber(value any) bool {
	_, ok := asFloat(value)
	return ok
}

func isNullableNumber(value any) bool {
	return value == nil || isNumber(value)
}

// currentPhaseID returns the id of the phase whose [start,end] contains today,
// or nil. Mirrors the Python "first phase containing today" rule.
func currentPhaseID(phases []mpPhase, today time.Time) any {
	for _, p := range phases {
		s, ok1 := parseDate(p.StartDate)
		e, ok2 := parseDate(p.EndDate)
		if ok1 && ok2 && !today.Before(s) && !today.After(e) {
			return p.ID
		}
	}
	return nil
}

// currentWeekNumber returns the 1-based week index containing today (by explicit
// week_start windows first, then by plan-start arithmetic), or nil outside range.
func currentWeekNumber(c mpContent, rawWeeks []map[string]any, today time.Time) any {
	for _, w := range rawWeeks {
		ws, ok := parseDate(asString(w["week_start"]))
		if !ok {
			continue
		}
		if !today.Before(ws) && !today.After(ws.AddDate(0, 0, 6)) {
			return asInt(w["week_index"])
		}
	}
	ps, ok1 := parseDate(c.StartDate)
	pe, ok2 := parseDate(c.EndDate)
	if !ok1 || !ok2 || today.Before(ps) || today.After(pe) {
		return nil
	}
	return int(today.Sub(ps).Hours()/24)/7 + 1
}

// nextMilestone returns the earliest not-yet-completed milestone with a
// days_until countdown, or nil.
func nextMilestone(ms []mpMilestone, today time.Time) any {
	incomplete := make([]mpMilestone, 0, len(ms))
	for _, m := range ms {
		if m.CompletedActual == nil {
			incomplete = append(incomplete, m)
		}
	}
	if len(incomplete) == 0 {
		return nil
	}
	sort.SliceStable(incomplete, func(i, j int) bool { return incomplete[i].Date < incomplete[j].Date })
	m := incomplete[0]
	md, ok := parseDate(m.Date)
	if !ok {
		return nil
	}
	return map[string]any{
		"id":         m.ID,
		"date":       m.Date,
		"target":     m.Target,
		"days_until": int(md.Sub(today).Hours() / 24),
	}
}

// buildWeekRows expands the plan's weeks (explicit weeks + synthetic started
// lead-in weeks) and augments each with planned/derived fields plus no-data
// actual_* placeholders. It also returns the activity windows to aggregate over
// (one per started week, end clamped to today) and which weeks are already
// finished. The caller overlays the fetched actuals via overlayActuals.
func buildWeekRows(c mpContent, rawWeeks []map[string]any, today time.Time) ([]map[string]any, []storage.WeekWindow, map[int]bool) {
	explicit := map[int]map[string]any{}
	maxIdx := 0
	for _, w := range rawWeeks {
		wi := asInt(w["week_index"])
		if wi > 0 {
			explicit[wi] = w
			if wi > maxIdx {
				maxIdx = wi
			}
		}
	}

	totalWeeks := c.TotalWeeks
	if maxIdx > totalWeeks {
		totalWeeks = maxIdx
	}
	planStart, okStart := parseDate(c.StartDate)

	var rows []map[string]any
	if !okStart || totalWeeks <= 0 {
		idxs := make([]int, 0, len(explicit))
		for i := range explicit {
			idxs = append(idxs, i)
		}
		sort.Ints(idxs)
		for _, i := range idxs {
			rows = append(rows, explicit[i])
		}
	} else {
		for wi := 1; wi <= totalWeeks; wi++ {
			if w, ok := explicit[wi]; ok {
				rows = append(rows, w)
				continue
			}
			start := planStart.AddDate(0, 0, (wi-1)*7)
			end := start.AddDate(0, 0, 6)
			ph := phaseForWeek(c.Phases, start, end)
			if ph == nil {
				continue
			}
			if !(ph.IsCompleted || !start.After(today)) {
				continue
			}
			rows = append(rows, map[string]any{
				"week_index":            wi,
				"week_start":            start.Format("2006-01-02"),
				"phase_id":              ph.ID,
				"target_weekly_km_low":  nil,
				"target_weekly_km_high": nil,
				"key_sessions":          []any{},
				"is_recovery_week":      false,
				"is_taper_week":         false,
			})
		}
	}

	var windows []storage.WeekWindow
	weekFinished := map[int]bool{}
	for _, row := range rows {
		idx := asInt(row["week_index"])
		start, ok := parseDate(asString(row["week_start"]))
		var end time.Time
		hasEnd := false
		if ok {
			end = start.AddDate(0, 0, 6)
			hasEnd = true
			row["week_end"] = end.Format("2006-01-02")
			row["is_completed"] = end.Before(today)
		} else {
			row["week_end"] = nil
			row["is_completed"] = false
		}
		row["planned_distance_km"] = plannedWeeklyKm(row)
		row["actual_avg_pace_s_km"] = nil
		row["actual_avg_pace_fmt"] = ""
		row["actual_avg_hr"] = nil
		row["actual_run_count"] = 0
		row["actual_duration_s"] = 0
		row["actual_training_dose"] = nil
		row["actual_training_dose_coverage"] = 0.0
		row["actual_training_dose_status"] = "unknown"

		hasStarted := ok && !start.After(today)
		if hasStarted {
			row["actual_distance_km"] = 0.0
			if idx > 0 && hasEnd {
				actualEnd := end
				if today.Before(end) {
					actualEnd = today
				}
				windows = append(windows, storage.WeekWindow{
					Index: idx,
					From:  start.Format("2006-01-02"),
					To:    actualEnd.Format("2006-01-02"),
				})
				weekFinished[idx] = end.Before(today)
			}
		}
	}
	return rows, windows, weekFinished
}

// overlayActuals writes the fetched running + dose summaries onto the expanded
// week rows. A dose "complete" for a week that has not yet finished is downgraded
// to "partial" (its load can still change until the day closes).
func overlayActuals(rows []map[string]any, run map[int]storage.RunningWeekSummary, dose map[int]storage.TrainingDoseWeekSummary, weekFinished map[int]bool) {
	for _, row := range rows {
		idx := asInt(row["week_index"])
		if d, ok := dose[idx]; ok {
			status := d.Status
			if status == "complete" && !weekFinished[idx] {
				status = "partial"
			}
			row["actual_training_dose"] = d.Dose
			row["actual_training_dose_coverage"] = d.Coverage
			row["actual_training_dose_status"] = status
		}
		if r, ok := run[idx]; ok {
			row["actual_distance_km"] = r.DistanceKm
			row["actual_avg_pace_s_km"] = r.AvgPaceSKm
			row["actual_avg_pace_fmt"] = formatPace(r.AvgPaceSKm)
			row["actual_avg_hr"] = r.AvgHR
			row["actual_run_count"] = r.RunCount
			row["actual_duration_s"] = r.TotalDurationS
		}
	}
}

// formatPace renders seconds-per-km as "M:SS"; "" when absent or non-positive.
func formatPace(sec *int) string {
	if sec == nil || *sec <= 0 {
		return ""
	}
	return fmt.Sprintf("%d:%02d", *sec/60, *sec%60)
}

func phaseForWeek(phases []mpPhase, weekStart, weekEnd time.Time) *mpPhase {
	for i := range phases {
		ps, ok1 := parseDate(phases[i].StartDate)
		pe, ok2 := parseDate(phases[i].EndDate)
		if !ok1 || !ok2 {
			continue
		}
		if !ps.After(weekEnd) && !pe.Before(weekStart) {
			return &phases[i]
		}
	}
	return nil
}

// plannedWeeklyKm mirrors the Python rule: prefer the high bound (unless nil/0),
// else the low bound, rounded to 1dp; nil when neither is present.
func plannedWeeklyKm(row map[string]any) any {
	high, hasHigh := asFloat(row["target_weekly_km_high"])
	low, hasLow := asFloat(row["target_weekly_km_low"])
	var v float64
	switch {
	case hasHigh && high != 0:
		v = high
	case hasLow:
		v = low
	default:
		return nil
	}
	return math.Round(v*10) / 10
}

// ── tiny JSON-any coercion helpers ───────────────────────────────────────────

func parseDate(s string) (time.Time, bool) {
	if len(s) < 10 {
		return time.Time{}, false
	}
	t, err := time.Parse("2006-01-02", s[:10])
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

func toMapSlice(v any) []map[string]any {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(arr))
	for _, e := range arr {
		if m, ok := e.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

func asInt(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	}
	return 0
}

func asFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	}
	return 0, false
}
