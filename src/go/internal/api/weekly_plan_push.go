// weekly_plan_push.go adds the watch-workout push endpoint to the weekly-plan
// surface. Go port of Python routes/plan.py::push_planned_session:
//
//	POST /api/:user/plan/sessions/:date/:sessionIndex/push?target_date=...
//
// The handler reads the canonical structured plan, finds the planned session,
// validates kind/spec/capability + optional ±7-day move, best-effort clears
// prior [STRIDE] watch entries, pushes the normalized workout to the user's
// bound watch provider, and atomically records a scheduled_workout row
// (superseding the prior one).
package api

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
)

// How far a user can move a planned session when pushing to the watch (mirrors
// Python _PUSH_DATE_WINDOW_DAYS). Symmetric around the planned date.
const pushDateWindowDays = 7

// WorkoutPusher pushes normalized workouts to the user's bound watch provider.
// It is the api-package seam for the cmd-layer adapter that resolves the
// provider binding (registry) and constructs the concrete adapter — the api
// package stays free of provider/registry imports (ADR 0013/0018).
type WorkoutPusher interface {
	// Info returns the user's bound provider static info (name + capabilities).
	Info(ctx context.Context, user string) (provider.ProviderInfo, error)
	// PushRunWorkout pushes a normalized run workout, returning the watch-side id.
	PushRunWorkout(ctx context.Context, user string, w provider.RunWorkout) (string, error)
	// PushStrengthWorkout pushes a normalized strength workout.
	PushStrengthWorkout(ctx context.Context, user string, w provider.StrengthWorkout) (string, error)
	// DeleteScheduledWorkout clears prior [STRIDE]-prefixed watch entries on a
	// date, optionally name-filtered. Returns whether anything was deleted.
	DeleteScheduledWorkout(ctx context.Context, user, date, name string) (bool, error)
}

// ScheduledWorkoutStore reads/writes scheduled_workout execution rows. Satisfied
// by *storage.Store.
type ScheduledWorkoutStore interface {
	GetLatestScheduledWorkoutForPlanSession(ctx context.Context, userID, weekFolder, plannedDate string, sessionIndex int) (*storage.ScheduledWorkout, error)
	RecordPushedScheduledWorkout(ctx context.Context, userID string, in storage.RecordPushedWorkoutInput) (int64, error)
}

// pushPlannedSession godoc
//
//	@Summary		Push a planned run/strength session to the user's watch
//	@Description	Finds the planned session in the active structured weekly plan, translates its spec to the bound watch provider, clears prior [STRIDE] watch entries (best-effort), pushes, and records a scheduled_workout row. target_date optionally moves the session within ±7 days of the planned date.
//	@Tags			weekly-plan
//	@Accept			json
//	@Produce		json
//	@Param			user			path		string	true	"User id (JWT sub)"
//	@Param			date			path		string	true	"Planned session date (ISO YYYY-MM-DD)"
//	@Param			sessionIndex	path		int		true	"Session index within the day (0-based)"
//	@Param			target_date		query		string	false	"Optional ISO YYYY-MM-DD date to actually push to (within ±7 days of the planned date)"
//	@Success		200				{object}	pushPlannedSessionResponse
//	@Failure		400				{object}	object	"Unsupported kind / missing spec / bad target_date / provider lacks capability"
//	@Failure		401				{object}	errorResponse
//	@Failure		403				{object}	errorResponse
//	@Failure		404				{object}	errorResponse	"No planned session found"
//	@Failure		409				{object}	object	"Structured plan not fresh"
//	@Failure		502				{object}	object	"Upstream watch service rejected the push"
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/plan/sessions/{date}/{sessionIndex}/push [post]
func (w *weeklyPlanRoutes) pushPlannedSession(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	date := c.Param("date")
	sessionIndex, err := strconv.Atoi(c.Param("sessionIndex"))
	if err != nil || sessionIndex < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "invalid session_index"})
		return
	}
	targetDate := c.Query("target_date")
	ctx := c.Request.Context()

	// Canonical plan lookup: the session lives in the active weekly plan whose
	// Shanghai week (Monday-start) contains the planned date.
	weekStart, err := weekStartForDate(date)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "date must be ISO YYYY-MM-DD"})
		return
	}
	plan, err := w.store.GetActiveWeeklyPlan(ctx, user, weekStart)
	if err != nil {
		w.log.Error("get active weekly plan failed", zapErr(err), zap.String("user", user))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if plan == nil {
		c.JSON(http.StatusNotFound, errorResponse{Error: "Planned session not found"})
		return
	}
	if plan.ContentVersion != storage.WeeklyPlanContentStructured {
		c.JSON(http.StatusConflict, gin.H{
			"detail": map[string]any{
				"error":             "structured plan not fresh, click 重新解析 first",
				"structured_status": nil,
			},
		})
		return
	}

	kind, specJSON, ok, err := findPlanSession(plan.Content, date, sessionIndex)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "Stored spec is not a valid normalized workout: " + err.Error()})
		return
	}
	if !ok {
		c.JSON(http.StatusNotFound, errorResponse{Error: "Planned session not found"})
		return
	}
	if kind != "run" && kind != "strength" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": fmt.Sprintf("Push only supports kind=run or kind=strength; got %q", kind)})
		return
	}
	if specJSON == "" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "Planned session has no spec (aspirational); cannot push"})
		return
	}

	// Provider capability gate.
	info, err := w.pusher.Info(ctx, user)
	if err != nil {
		w.log.Error("resolve watch provider failed", zapErr(err), zap.String("user", user))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	requiredCap := provider.CapPushRunWorkout
	workoutLabel := "run workouts"
	if kind == "strength" {
		requiredCap = provider.CapPushStrengthWorkout
		workoutLabel = "strength workouts"
	}
	if !info.Capabilities.Has(requiredCap) {
		c.JSON(http.StatusBadRequest, gin.H{
			"detail": fmt.Sprintf("Provider %q does not support pushing %s", info.Name, workoutLabel),
		})
		return
	}

	// Build the normalized workout from the stored spec, resolving push_date
	// (optional target_date within ±7 days keeps the watch date consistent with
	// the spec's internal date field).
	workout, err := buildPushableWorkout(kind, specJSON, date, targetDate)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
		return
	}

	// Prior execution state for this canonical session.
	prior, err := w.swstore.GetLatestScheduledWorkoutForPlanSession(ctx, user, weekStart, date, sessionIndex)
	if err != nil {
		w.log.Error("get latest scheduled workout failed", zapErr(err), zap.String("user", user))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	var priorID *int64
	priorWasPushed := false
	priorPushedDate := ""
	if prior != nil {
		id := prior.ID
		priorID = &id
		if prior.Status == storage.ScheduledWorkoutStatusPushed {
			priorWasPushed = true
			priorPushedDate = prior.Date
		}
	}

	// Delete sweep: clear the new target date (any stale STRIDE entry) AND the
	// prior pushed date when the user moved the session — otherwise the old
	// watch entry is left as garbage. The adapter filters to [STRIDE]-prefixed
	// entries + exact name so user-authored workouts are never touched.
	if info.Capabilities.Has(provider.CapDeleteWorkout) {
		sweepDates := map[string]bool{workout.Date: true}
		if priorPushedDate != "" && priorPushedDate != workout.Date {
			sweepDates[priorPushedDate] = true
		}
		for sweepDate := range sweepDates {
			if _, err := w.pusher.DeleteScheduledWorkout(ctx, user, sweepDate, workout.Name); err != nil {
				// Best-effort: log and continue. Prefer "push succeeds with a
				// possible duplicate watch entry" over "push fails because the
				// cleanup leg failed".
				w.log.Warn("best-effort delete prior STRIDE workouts failed; continuing push",
					zapErr(err), zap.String("user", user), zap.String("date", sweepDate))
			}
		}
	} else if priorWasPushed {
		c.JSON(http.StatusBadRequest, gin.H{
			"detail": fmt.Sprintf(
				"Provider %q does not support deletion; remove the prior workout from the watch manually before re-pushing",
				info.Name),
		})
		return
	}

	// Push to the watch.
	var providerWorkoutID string
	if kind == "run" {
		providerWorkoutID, err = w.pusher.PushRunWorkout(ctx, user, *workout.Run)
	} else {
		providerWorkoutID, err = w.pusher.PushStrengthWorkout(ctx, user, *workout.Strength)
	}
	if err != nil {
		w.log.Error("push workout failed",
			zapErr(err), zap.String("user", user), zap.String("provider", info.Name), zap.String("kind", kind))
		c.JSON(http.StatusBadGateway, gin.H{"detail": "Could not push workout to watch service"})
		return
	}

	// Push succeeded — atomically record the new scheduled_workout row and
	// supersede the prior pushed row. The canonical plan remains unchanged.
	priorToSupersede := priorID
	if !priorWasPushed {
		priorToSupersede = nil
	}
	newID, err := w.swstore.RecordPushedScheduledWorkout(ctx, user, storage.RecordPushedWorkoutInput{
		WeekFolder:        weekStart,
		PlannedDate:       date,
		SessionIndex:      sessionIndex,
		PushDate:          workout.Date,
		Kind:              kind,
		Name:              workout.Name,
		SpecJSON:          workout.SpecJSON,
		Provider:          info.Name,
		ProviderWorkoutID: providerWorkoutID,
		PriorID:           priorToSupersede,
	})
	if err != nil {
		w.log.Error("record pushed scheduled workout failed", zapErr(err), zap.String("user", user))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}

	c.JSON(http.StatusOK, pushPlannedSessionResponse{
		OK:                 true,
		PlannedSessionID:   sessionAPIID(weekStart, date, sessionIndex),
		ScheduledWorkoutID: newID,
		Provider:           info.Name,
		ProviderWorkoutID:  providerWorkoutID,
		PushDate:           workout.Date,
	})
}

// pushPlannedSessionResponse mirrors the Python route's success shape (the
// frontend PushPlannedSessionResponse).
type pushPlannedSessionResponse struct {
	OK                 bool   `json:"ok"`
	PlannedSessionID   int64  `json:"planned_session_id"`
	ScheduledWorkoutID int64  `json:"scheduled_workout_id"`
	Provider           string `json:"provider"`
	ProviderWorkoutID  string `json:"provider_workout_id"`
	PushDate           string `json:"push_date"`
}

// pushableWorkout is a parsed + date-resolved normalized workout ready to push.
type pushableWorkout struct {
	Kind     string
	Name     string
	Date     string // final push date (target_date or planned date)
	SpecJSON string // stored spec JSON, re-serialized when the date moved
	Run      *provider.RunWorkout
	Strength *provider.StrengthWorkout
}

// buildPushableWorkout parses the stored spec (run-workout/v1 or
// strength-workout/v1), validates it, and resolves the push date. When
// target_date is given it must be within ±pushDateWindowDays of the planned
// date; the workout's internal date is re-stamped to match.
func buildPushableWorkout(kind, specJSON, plannedDate, targetDate string) (*pushableWorkout, error) {
	pushDate, err := resolvePushDate(plannedDate, targetDate)
	if err != nil {
		return nil, err
	}
	out := &pushableWorkout{Kind: kind, Date: pushDate}
	if kind == "run" {
		run, err := provider.RunWorkoutFromJSON([]byte(specJSON))
		if err != nil {
			return nil, fmt.Errorf("stored spec is not a valid normalized run workout: %w", err)
		}
		if pushDate != plannedDate {
			run.Date = pushDate
			re, err := json.Marshal(run)
			if err != nil {
				return nil, fmt.Errorf("re-serialize run workout: %w", err)
			}
			specJSON = string(re)
		}
		out.Name, out.Run, out.SpecJSON = run.Name, run, specJSON
		return out, nil
	}
	str, err := provider.StrengthWorkoutFromJSON([]byte(specJSON))
	if err != nil {
		return nil, fmt.Errorf("stored spec is not a valid normalized strength workout: %w", err)
	}
	if pushDate != plannedDate {
		str.Date = pushDate
		re, err := json.Marshal(str)
		if err != nil {
			return nil, fmt.Errorf("re-serialize strength workout: %w", err)
		}
		specJSON = string(re)
	}
	out.Name, out.Strength, out.SpecJSON = str.Name, str, specJSON
	return out, nil
}

// resolvePushDate validates an optional target_date (ISO) within ±7 days of the
// planned date and returns the effective push date.
func resolvePushDate(plannedDate, targetDate string) (string, error) {
	if targetDate == "" {
		return plannedDate, nil
	}
	pd, err := time.Parse("2006-01-02", plannedDate)
	if err != nil {
		return "", fmt.Errorf("planned date must be ISO YYYY-MM-DD")
	}
	td, err := time.Parse("2006-01-02", targetDate)
	if err != nil {
		return "", fmt.Errorf("target_date must be ISO YYYY-MM-DD")
	}
	delta := int(td.Sub(pd).Hours() / 24)
	if delta < 0 {
		delta = -delta
	}
	if delta > pushDateWindowDays {
		return "", fmt.Errorf(
			"target_date %s is %d days from planned date %s; allowed window is ±%d days",
			targetDate, delta, plannedDate, pushDateWindowDays)
	}
	return targetDate, nil
}

// findPlanSession locates the session at (date, session_index) inside the
// structured weekly-plan content and returns its kind + spec JSON ("" when the
// session has no spec). A parse failure of the plan document or the session's
// spec is an error (the caller 400s — mirrors Python's from_dict validation).
func findPlanSession(content, date string, sessionIndex int) (kind, specJSON string, ok bool, err error) {
	var document struct {
		Sessions []json.RawMessage `json:"sessions"`
	}
	if err := json.Unmarshal([]byte(content), &document); err != nil {
		return "", "", false, fmt.Errorf("plan content is not valid structured JSON: %w", err)
	}
	for _, raw := range document.Sessions {
		var s struct {
			Date         string          `json:"date"`
			SessionIndex int             `json:"session_index"`
			Kind         string          `json:"kind"`
			Spec         json.RawMessage `json:"spec"`
		}
		if err := json.Unmarshal(raw, &s); err != nil {
			continue // skip malformed session rows, keep scanning
		}
		if s.Date == date && s.SessionIndex == sessionIndex {
			spec := ""
			if len(s.Spec) > 0 && string(s.Spec) != "null" {
				spec = string(s.Spec)
			}
			return s.Kind, spec, true, nil
		}
	}
	return "", "", false, nil
}

// weekStartForDate returns the Shanghai Monday (YYYY-MM-DD) of the week
// containing date — the weekly_plan.week_start identity for the plan whose
// sessions include date.
func weekStartForDate(date string) (string, error) {
	d, err := time.Parse("2006-01-02", date)
	if err != nil {
		return "", fmt.Errorf("date must be ISO YYYY-MM-DD")
	}
	offset := (int(d.Weekday()) + 6) % 7 // days since Monday
	return d.AddDate(0, 0, -offset).Format("2006-01-02"), nil
}

// sessionAPIID mirrors Python session_api_id: a stable numeric compatibility id
// (sha256 of folder\0date\0index, first 6 bytes big-endian). Canonical identity
// remains the (date, session_index) tuple.
func sessionAPIID(folder, date string, sessionIndex int) int64 {
	raw := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%s\x00%d", folder, date, sessionIndex)))
	// First 6 bytes big-endian, like Python's int.from_bytes(..., "big").
	return int64(binary.BigEndian.Uint64(append([]byte{0, 0}, raw[:6]...)))
}
