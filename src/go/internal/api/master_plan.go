package api

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies (ADR 0024). The master-plan read surface is a sibling registrar
// with its own store port, mounted on the shared authed group.
// ─────────────────────────────────────────────────────────────────────────────

// MasterPlanStore is the master-plan persistence the read handlers need.
// Satisfied by *storage.Store. The plan getters return (nil, nil) when absent;
// the week-summary methods aggregate the athlete's activities / training dose for
// the #6 weeks[].actual_* fields.
type MasterPlanStore interface {
	GetActiveStructuredPlan(ctx context.Context, userID string) (*storage.MasterPlan, error)
	GetMarkdownOverview(ctx context.Context, userID string) (*storage.MasterPlan, error)
	RunningWeekSummaries(ctx context.Context, userID string, windows []storage.WeekWindow) (map[int]storage.RunningWeekSummary, error)
	TrainingDoseWeekSummaries(ctx context.Context, userID string, windows []storage.WeekWindow) (map[int]storage.TrainingDoseWeekSummary, error)
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

// register mounts the two read endpoints on the (already authenticated) group.
// Paths mirror the Python contract so a later BFF cutover is just routing.
func (m *masterPlanRoutes) register(rg *gin.RouterGroup) {
	rg.GET("/api/users/me/master-plan/current", m.getCurrent)
	rg.GET("/api/:user/training-plan", m.getTrainingPlan)
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/users/me/master-plan/current  (#6 — the active structured plan)
// ─────────────────────────────────────────────────────────────────────────────

// getCurrent returns the user's active structured (content_version=2) master
// plan, enriched with three date-derived position fields, or 404 when none
// (the frontend then falls back to the markdown overview).
//
//	@Summary		Get the current user's active season training plan
//	@Tags			master-plan
//	@Produce		json
//	@Success		200	{object}	map[string]interface{}
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
	plan, err := m.store.GetActiveStructuredPlan(c.Request.Context(), uid)
	if err != nil {
		m.log.Error("get active master plan failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if plan == nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "当前没有激活的赛季训练计划"})
		return
	}
	doc, windows, weekFinished, err := buildCurrentResponse(plan, timefmt.ShanghaiToday())
	if err != nil {
		m.log.Error("master plan content is not valid JSON", zapErr(err), zap.String("plan_id", plan.PlanID))
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
		if weeks, ok := doc["weeks"].([]map[string]any); ok {
			overlayActuals(weeks, run, dose, weekFinished)
		}
	}
	c.JSON(http.StatusOK, doc)
}

func cmpErr(a, b error) error {
	if a != nil {
		return a
	}
	return b
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/{user}/training-plan  (legacy markdown overview)
// ─────────────────────────────────────────────────────────────────────────────

// trainingPlanResponse is the markdown-overview wire shape. `phases` is always an
// empty array and `current_phase` always null: the Python endpoint derived them
// from a hard-coded single-athlete phase timeline, which is wrong for a general
// user and is dropped in the greenfield port (ADR 0024). `content` is the raw
// markdown, or null when the user has no overview.
type trainingPlanResponse struct {
	Content      *string       `json:"content"`
	Phases       []interface{} `json:"phases"`
	CurrentPhase *string       `json:"current_phase"`
}

// getTrainingPlan returns the user's markdown (content_version=1) season-plan
// overview. A user caller may only read their own {user}; an internal caller any.
//
//	@Summary		Get a user's legacy markdown training overview
//	@Tags			master-plan
//	@Produce		json
//	@Param			user	path		string	true	"User id (JWT sub)"
//	@Success		200		{object}	trainingPlanResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/{user}/training-plan [get]
func (m *masterPlanRoutes) getTrainingPlan(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	plan, err := m.store.GetMarkdownOverview(c.Request.Context(), user)
	if err != nil {
		m.log.Error("get markdown overview failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	resp := trainingPlanResponse{Content: nil, Phases: []interface{}{}, CurrentPhase: nil}
	if plan != nil {
		content := plan.Content
		resp.Content = &content
	}
	c.JSON(http.StatusOK, resp)
}

// ─────────────────────────────────────────────────────────────────────────────
// #6 response builder (pure — unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

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
