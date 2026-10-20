// workout.go — the unified "what do I train today" surface (devops#586):
//
//	GET    /api/users/me/plan/sessions?date_from&date_to   (three-source projection)
//	POST   /api/users/me/custom-workouts                   (save_token idempotent upsert)
//	GET    /api/users/me/custom-workouts?date_from&date_to
//	DELETE /api/users/me/custom-workouts/:workoutId        (soft delete)
//
// Every row is strictly user-private ("me" endpoints on the default-deny
// group); the store keeps tenant isolation and archived rows never appear.
package api

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
	"go.uber.org/zap"
)

//go:embed run-workout.schema.json
var runWorkoutSchemaJSON []byte

//go:embed run-workout.lenient.schema.json
var runWorkoutLenientSchemaJSON []byte

//go:embed strength-workout.schema.json
var strengthWorkoutSchemaJSON []byte

// Embedded P1-generated workout schemas (same generator as the weekly-plan
// schema): custom-workout specs must match the discriminated canonical shape
// before they reach the workout table. The lenient variant is the input-mode
// mirror of RunWorkoutLenientSchema (LLM noise keys tolerated, defaults
// optional) and is used for master-plan key-session deep validation, where the
// payload is P1 LLM output, not an internal producer.
var (
	runWorkoutSchema        = mustCompileWorkoutSchema("https://stride-running.cn/schemas/run-workout-v1.json", runWorkoutSchemaJSON)
	runWorkoutLenientSchema = mustCompileWorkoutSchema("https://stride-running.cn/schemas/run-workout-v1-lenient.json", runWorkoutLenientSchemaJSON)
	strengthWorkoutSchema   = mustCompileWorkoutSchema("https://stride-running.cn/schemas/strength-workout-v1.json", strengthWorkoutSchemaJSON)
)

func mustCompileWorkoutSchema(id string, raw []byte) *jsonschema.Schema {
	var document any
	if err := json.Unmarshal(raw, &document); err != nil {
		panic(fmt.Sprintf("decode embedded workout schema %s: %v", id, err))
	}
	compiler := jsonschema.NewCompiler()
	compiler.AssertFormat()
	if err := compiler.AddResource(id, document); err != nil {
		panic(fmt.Sprintf("load embedded workout schema %s: %v", id, err))
	}
	schema, err := compiler.Compile(id)
	if err != nil {
		panic(fmt.Sprintf("compile embedded workout schema %s: %v", id, err))
	}
	return schema
}

// PushedScheduleReader lists pushed watch rows for push-state annotation.
type PushedScheduleReader interface {
	ListPushedScheduledWorkouts(ctx context.Context, userID, dateFrom, dateTo string) ([]storage.ScheduledWorkout, error)
}

// WorkoutStore is the persistence the workout endpoints need.
type WorkoutStore interface {
	ListPlanSessions(ctx context.Context, userID, dateFrom, dateTo string) ([]storage.Workout, error)
	UpsertCustomWorkout(ctx context.Context, userID string, in storage.UpsertCustomWorkoutInput) (*storage.Workout, error)
	ListCustomWorkouts(ctx context.Context, userID, dateFrom, dateTo string) ([]storage.Workout, error)
	ArchiveCustomWorkout(ctx context.Context, userID, workoutID string) (bool, error)
	GetCustomWorkout(ctx context.Context, userID, workoutID string) (*storage.Workout, error)
}

type workoutRoutes struct {
	store WorkoutStore
	// Watch push (devops#587): nil pair leaves the push route unmounted (same
	// degradation as the other optional surfaces in partial test services).
	pusher  WorkoutPusher
	swstore ScheduledWorkoutStore
	// Push-state annotation for the unified read (may be nil in partial test
	// services — the DTO then simply reports pushed=false).
	pushed PushedScheduleReader
	log    *zap.Logger
}

func newWorkoutRoutes(store WorkoutStore, pusher WorkoutPusher, swstore ScheduledWorkoutStore, pushed PushedScheduleReader, log *zap.Logger) *workoutRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &workoutRoutes{store: store, pusher: pusher, swstore: swstore, pushed: pushed, log: log}
}

func (w *workoutRoutes) register(rg *gin.RouterGroup) {
	if w.store == nil {
		return
	}
	rg.GET("/api/users/me/plan/sessions", w.listPlanSessions)
	rg.POST("/api/users/me/custom-workouts", w.upsertCustom)
	rg.GET("/api/users/me/custom-workouts", w.listCustom)
	rg.DELETE("/api/users/me/custom-workouts/:workoutId", w.deleteCustom)
	if w.pusher != nil && w.swstore != nil {
		rg.POST("/api/users/me/custom-workouts/:workoutId/push", w.pushCustomWorkout)
	}
}

// planSessionDTO is one row of the unified projection. spec carries the stored
// canonical spec verbatim (discriminated); dose follows the #526 progressive
// rule — weekly estimated, custom saved value, watch null.
type planSessionDTO struct {
	WorkoutID        string          `json:"workout_id"`
	Date             string          `json:"date"`
	Source           string          `json:"source"`
	Kind             string          `json:"kind"`
	Name             string          `json:"name"`
	Summary          *string         `json:"summary"`
	Spec             json.RawMessage `json:"spec"`
	TotalDistanceM   *float64        `json:"total_distance_m"`
	TotalDurationS   *int64          `json:"total_duration_s"`
	EstimatedDose    *float64        `json:"estimated_dose"`
	SessionIndex     *int            `json:"session_index"`
	PlanID           *string         `json:"plan_id"`
	Provider         *string         `json:"provider"`
	ProviderEntityID *string         `json:"provider_entity_id"`
	CreatedAt        string          `json:"created_at"`
	UpdatedAt        string          `json:"updated_at"`
	// SaveToken echoes the custom row's idempotency token so clients can
	// reconcile chat-card state ("已保存/已推送") across reloads.
	SaveToken *string `json:"save_token"`
	// Pushed reports whether a pushed scheduled_workout row exists for this
	// row (custom: same workout_id; weekly: same date + session_index).
	Pushed bool `json:"pushed"`
}

func newPlanSessionDTO(row storage.Workout) planSessionDTO {
	spec := json.RawMessage("null")
	if row.SpecJSON != nil && *row.SpecJSON != "" {
		spec = json.RawMessage(*row.SpecJSON)
	}
	created := row.CreatedAt.UTC().Format(time.RFC3339)
	updated := row.UpdatedAt.UTC().Format(time.RFC3339)
	return planSessionDTO{
		WorkoutID: row.WorkoutID, Date: row.Date, Source: row.Source,
		Kind: row.Kind, Name: row.Name, Summary: row.Summary, Spec: spec,
		TotalDistanceM: row.TotalDistanceM, TotalDurationS: row.TotalDurationS,
		EstimatedDose: row.EstimatedDose, SessionIndex: row.SessionIndex,
		PlanID: row.PlanID, Provider: row.Provider, ProviderEntityID: row.ProviderEntityID,
		CreatedAt: created, UpdatedAt: updated, SaveToken: row.SaveToken,
	}
}

func isoTime(t *time.Time) string { return t.UTC().Format(time.RFC3339) }

// listPlanSessions answers「某天(段)要练什么」in one query: weekly + custom +
// watch active rows in the inclusive Shanghai window, past days included
// (pure projection), ordered weekly → custom → watch.
func (w *workoutRoutes) listPlanSessions(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	dateFrom, dateTo := c.Query("date_from"), c.Query("date_to")
	if dateFrom == "" || dateTo == "" {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "date_from and date_to are required (YYYY-MM-DD)"})
		return
	}
	rows, err := w.store.ListPlanSessions(c.Request.Context(), uid, dateFrom, dateTo)
	if err != nil {
		if isInvalidDate(err) {
			c.JSON(http.StatusBadRequest, errorResponse{Error: err.Error()})
			return
		}
		w.log.Error("list plan sessions failed", zapErr(err), zap.String("user", uid))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	// Push-state annotation: pushed rows whose watch date falls within the
	// window widened by the ±7-day push offset (a workout planned at the
	// window edge may have been pushed up to 7 days off its planned date).
	pushed := map[string]bool{}
	if w.pushed != nil {
		from, _ := shiftDate(dateFrom, -7)
		to, _ := shiftDate(dateTo, 7)
		srows, err := w.pushed.ListPushedScheduledWorkouts(c.Request.Context(), uid, from, to)
		if err != nil {
			w.log.Error("list pushed scheduled workouts failed", zapErr(err), zap.String("user", uid))
			// Push state is decorative — degrade to pushed=false, not a 500.
		}
		for _, sr := range srows {
			if sr.WorkoutID != nil && *sr.WorkoutID != "" {
				pushed["wid:"+*sr.WorkoutID] = true
			} else if sr.PlannedDate != nil && sr.SessionIndex != nil {
				pushed["plan:"+*sr.PlannedDate+":"+fmt.Sprint(*sr.SessionIndex)] = true
			}
		}
	}
	dtos := make([]planSessionDTO, 0, len(rows))
	for _, row := range rows {
		dto := newPlanSessionDTO(row)
		if pushed != nil {
			if row.Source == "custom" {
				dto.Pushed = pushed["wid:"+row.WorkoutID]
			} else if row.Source == "weekly" && row.SessionIndex != nil {
				dto.Pushed = pushed["plan:"+row.Date+":"+fmt.Sprint(*row.SessionIndex)]
			}
		}
		dtos = append(dtos, dto)
	}
	c.JSON(http.StatusOK, gin.H{"sessions": dtos})
}

// shiftDate moves an ISO date by n days (used to widen the push-state window).
func shiftDate(date string, n int) (string, error) {
	t, err := time.Parse("2006-01-02", date)
	if err != nil {
		return "", err
	}
	return t.AddDate(0, 0, n).Format("2006-01-02"), nil
}

func isInvalidDate(err error) bool {
	var inv *time.ParseError
	return errors.As(err, &inv)
}

// customWorkoutRequest is the upsert body. save_token is the idempotency key:
// replaying it updates the existing active row (same workout_id).
type customWorkoutRequest struct {
	Date           string          `json:"date" binding:"required"`
	Kind           string          `json:"kind" binding:"required"`
	Name           string          `json:"name" binding:"required,max=255"`
	Summary        *string         `json:"summary"`
	Spec           json.RawMessage `json:"spec"`
	TotalDistanceM *float64        `json:"total_distance_m"`
	TotalDurationS *int64          `json:"total_duration_s"`
	EstimatedDose  *float64        `json:"estimated_dose"`
	SaveToken      string          `json:"save_token" binding:"required,max=64"`
}

// upsertCustom creates or save_token-updates one user-authored workout.
func (w *workoutRoutes) upsertCustom(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	var req customWorkoutRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: bindingDetail(err)})
		return
	}
	specJSON, err := validatedCustomSpec(req.Kind, req.Spec)
	if err != nil {
		c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: []validationDetailItem{{
			Loc: []string{"body", "spec"}, Msg: err.Error(),
		}}})
		return
	}
	var summary *string
	if req.Summary != nil && *req.Summary != "" {
		if len(*req.Summary) > 1000 {
			c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: []validationDetailItem{{
				Loc: []string{"body", "summary"}, Msg: "must be at most 1000 characters",
			}}})
			return
		}
		summary = req.Summary
	}
	row, err := w.store.UpsertCustomWorkout(c.Request.Context(), uid, storage.UpsertCustomWorkoutInput{
		Date: req.Date, Kind: req.Kind, Name: req.Name,
		Summary: summary, SpecJSON: specJSON,
		TotalDistanceM: req.TotalDistanceM, TotalDurationS: req.TotalDurationS,
		EstimatedDose: req.EstimatedDose, SaveToken: req.SaveToken,
	})
	if err != nil {
		if isInvalidDate(err) {
			c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: []validationDetailItem{{
				Loc: []string{"body", "date"}, Msg: "must be YYYY-MM-DD",
			}}})
			return
		}
		w.log.Error("upsert custom workout failed", zapErr(err), zap.String("user", uid))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusOK, newPlanSessionDTO(*row))
}

// validatedCustomSpec enforces the canonical spec contract: run/strength specs
// must match the P1-generated discriminated schemas; other kinds carry none.
// The original bytes are stored verbatim after validation.
func validatedCustomSpec(kind string, spec json.RawMessage) (*string, error) {
	if len(spec) == 0 || string(spec) == "null" {
		return nil, nil
	}
	var schema *jsonschema.Schema
	switch kind {
	case "run":
		schema = runWorkoutSchema
	case "strength":
		schema = strengthWorkoutSchema
	default:
		return nil, fmt.Errorf("spec is only supported for run/strength workouts")
	}
	var document any
	if err := json.Unmarshal(spec, &document); err != nil {
		return nil, fmt.Errorf("spec must be a JSON object: %w", err)
	}
	if err := schema.Validate(document); err != nil {
		return nil, fmt.Errorf("spec schema: %w", err)
	}
	validated := string(spec)
	return &validated, nil
}

// listCustom lists the caller's active custom workouts in the window.
func (w *workoutRoutes) listCustom(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	dateFrom, dateTo := c.Query("date_from"), c.Query("date_to")
	if dateFrom == "" || dateTo == "" {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "date_from and date_to are required (YYYY-MM-DD)"})
		return
	}
	rows, err := w.store.ListCustomWorkouts(c.Request.Context(), uid, dateFrom, dateTo)
	if err != nil {
		if isInvalidDate(err) {
			c.JSON(http.StatusBadRequest, errorResponse{Error: err.Error()})
			return
		}
		w.log.Error("list custom workouts failed", zapErr(err), zap.String("user", uid))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	dtos := make([]planSessionDTO, 0, len(rows))
	for _, row := range rows {
		dtos = append(dtos, newPlanSessionDTO(row))
	}
	c.JSON(http.StatusOK, gin.H{"workouts": dtos})
}

// deleteCustom soft-deletes the caller's custom workout: the row is archived
// (frees its save_token identity for reuse), never physically removed. When
// the workout was already pushed to a watch, the watch-side copy is deleted
// too (best-effort — a provider failure never blocks the local delete).
func (w *workoutRoutes) deleteCustom(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	row, err := w.store.GetCustomWorkout(ctx, uid, c.Param("workoutId"))
	if err != nil {
		w.log.Error("get custom workout failed", zapErr(err), zap.String("user", uid))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if row == nil {
		c.JSON(http.StatusNotFound, errorResponse{Error: "workout not found"})
		return
	}
	if _, err := w.store.ArchiveCustomWorkout(ctx, uid, row.WorkoutID); err != nil {
		w.log.Error("archive custom workout failed", zapErr(err), zap.String("user", uid))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	w.deleteWatchCopy(ctx, uid, row)
	c.Status(http.StatusNoContent)
}

// workoutDeleterByID is implemented by providers that can delete a pushed
// workout precisely by the provider_workout_id recorded at push time (Garmin).
// Providers without it fall back to the date+name sweep (COROS).
type workoutDeleterByID interface {
	DeleteWorkoutByID(ctx context.Context, user, providerWorkoutID string) (bool, error)
}

// deleteWatchCopy best-effort deletes the watch-side copy of a pushed custom
// workout. Never fails the caller: every error is logged and swallowed — the
// local archive is already committed and the user can always remove the watch
// entry manually.
func (w *workoutRoutes) deleteWatchCopy(ctx context.Context, uid string, row *storage.Workout) {
	if w.pusher == nil || w.swstore == nil {
		return
	}
	sw, err := w.swstore.GetLatestScheduledWorkoutForWorkout(ctx, uid, row.WorkoutID)
	if err != nil {
		w.log.Warn("look up pushed scheduled workout failed", zapErr(err), zap.String("user", uid))
		return
	}
	if sw == nil || sw.Status != storage.ScheduledWorkoutStatusPushed {
		return
	}
	providerName := ""
	if sw.Provider != nil {
		providerName = *sw.Provider
	}
	if byID, ok := w.pusher.(workoutDeleterByID); ok && sw.ProviderWorkoutID != nil && *sw.ProviderWorkoutID != "" {
		_, err := byID.DeleteWorkoutByID(ctx, uid, *sw.ProviderWorkoutID)
		if err == nil {
			return
		}
		var fns *provider.FeatureNotSupported
		if !errors.As(err, &fns) {
			// Real provider failure — logged, never blocks the local delete.
			w.log.Warn("best-effort watch workout delete failed", zapErr(err),
				zap.String("user", uid), zap.String("provider", providerName),
				zap.String("provider_workout_id", *sw.ProviderWorkoutID))
			return
		}
		// Bound provider has no by-ID delete (COROS): fall through to the
		// date+name sweep below.
	}
	info, err := w.pusher.Info(ctx, uid)
	if err != nil {
		w.log.Warn("resolve watch provider failed", zapErr(err), zap.String("user", uid))
		return
	}
	if !info.Capabilities.Has(provider.CapDeleteWorkout) {
		return
	}
	if _, err := w.pusher.DeleteScheduledWorkout(ctx, uid, sw.Date, row.Name); err != nil {
		w.log.Warn("best-effort watch workout delete failed", zapErr(err),
			zap.String("user", uid), zap.String("provider", providerName), zap.String("date", sw.Date))
	}
}
