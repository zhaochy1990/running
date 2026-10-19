// custom_workout_push.go adds the watch push for user-authored workouts
// (devops#587):
//
//	POST /api/users/me/custom-workouts/:workoutId/push?target_date=...
//
// It reuses the weekly push core verbatim — provider capability gating and
// failure copy, ±7-day target-date window ([STRIDE] delete sweep, supersede
// semantics — only the canonical identity differs: the scheduled_workout row
// carries workout_id instead of the plan triple.
package api

import (
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
)

// pushCustomWorkout godoc
//
//	@Summary		Push a user-authored workout to the user's watch
//	@Description	Loads the caller's active custom workout, validates kind/spec/capability + optional ±7-day target_date, clears prior [STRIDE] watch entries (best-effort), pushes the normalized workout to the bound watch provider, and records a scheduled_workout row keyed by workout_id (superseding the prior one).
//	@Tags			workouts
//	@Accept			json
//	@Produce		json
//	@Param			workoutId	path		string	true	"Custom workout id"
//	@Param			target_date	query		string	false	"Optional ISO YYYY-MM-DD date to actually push to (within ±7 days of the workout date)"
//	@Success		200			{object}	pushCustomWorkoutResponse
//	@Failure		400			{object}	object	"Unsupported kind / missing spec / bad target_date / provider lacks capability"
//	@Failure		401			{object}	errorResponse
//	@Failure		404			{object}	errorResponse	"Workout not found"
//	@Failure		502			{object}	object	"Upstream watch service rejected the push"
//	@Security		BearerAuth
//	@Router			/api/users/me/custom-workouts/{workoutId}/push [post]
func (w *workoutRoutes) pushCustomWorkout(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	workoutID := c.Param("workoutId")
	targetDate := c.Query("target_date")
	ctx := c.Request.Context()

	row, err := w.store.GetCustomWorkout(ctx, uid, workoutID)
	if err != nil {
		w.log.Error("get custom workout failed", zapErr(err), zap.String("user", uid))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if row == nil {
		c.JSON(http.StatusNotFound, errorResponse{Error: "workout not found"})
		return
	}
	if row.Kind != "run" && row.Kind != "strength" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": fmt.Sprintf("Push only supports kind=run or kind=strength; got %q", row.Kind)})
		return
	}
	if row.SpecJSON == nil || *row.SpecJSON == "" {
		c.JSON(http.StatusBadRequest, gin.H{"detail": "Custom workout has no spec; cannot push"})
		return
	}

	// Provider capability gate — same copy as the weekly push.
	info, err := w.pusher.Info(ctx, uid)
	if err != nil {
		w.log.Error("resolve watch provider failed", zapErr(err), zap.String("user", uid))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	requiredCap := provider.CapPushRunWorkout
	workoutLabel := "run workouts"
	if row.Kind == "strength" {
		requiredCap = provider.CapPushStrengthWorkout
		workoutLabel = "strength workouts"
	}
	if !info.Capabilities.Has(requiredCap) {
		c.JSON(http.StatusBadRequest, gin.H{
			"detail": fmt.Sprintf("Provider %q does not support pushing %s", info.Name, workoutLabel),
		})
		return
	}

	// Build the normalized workout from the stored spec; target_date moves the
	// push within ±7 days of the workout date (resolvePushDate validates).
	workout, err := buildPushableWorkout(row.Kind, *row.SpecJSON, row.Date, targetDate)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"detail": err.Error()})
		return
	}

	// Prior execution state for this custom workout.
	prior, err := w.swstore.GetLatestScheduledWorkoutForWorkout(ctx, uid, workoutID)
	if err != nil {
		w.log.Error("get latest scheduled workout failed", zapErr(err), zap.String("user", uid))
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

	// Delete sweep — same discipline as the weekly push: clear the target date
	// plus the prior pushed date when the workout moved; [STRIDE] prefix +
	// exact name filtering keeps user-authored watch entries untouched.
	if info.Capabilities.Has(provider.CapDeleteWorkout) {
		sweepDates := map[string]bool{workout.Date: true}
		if priorPushedDate != "" && priorPushedDate != workout.Date {
			sweepDates[priorPushedDate] = true
		}
		for sweepDate := range sweepDates {
			if _, err := w.pusher.DeleteScheduledWorkout(ctx, uid, sweepDate, workout.Name); err != nil {
				w.log.Warn("best-effort delete prior STRIDE workouts failed; continuing push",
					zapErr(err), zap.String("user", uid), zap.String("date", sweepDate))
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
	if row.Kind == "run" {
		providerWorkoutID, err = w.pusher.PushRunWorkout(ctx, uid, *workout.Run)
	} else {
		providerWorkoutID, err = w.pusher.PushStrengthWorkout(ctx, uid, *workout.Strength)
	}
	if err != nil {
		w.log.Error("push workout failed",
			zapErr(err), zap.String("user", uid), zap.String("provider", info.Name), zap.String("kind", row.Kind))
		c.JSON(http.StatusBadGateway, gin.H{"detail": "Could not push workout to watch service"})
		return
	}

	// Push succeeded — record the new scheduled_workout row (identity =
	// workout_id) and supersede the prior pushed row.
	priorToSupersede := priorID
	if !priorWasPushed {
		priorToSupersede = nil
	}
	newID, err := w.swstore.RecordPushedScheduledWorkout(ctx, uid, storage.RecordPushedWorkoutInput{
		WorkoutID:         workoutID,
		PushDate:          workout.Date,
		Kind:              workout.Kind,
		Name:              workout.Name,
		SpecJSON:          workout.SpecJSON,
		Provider:          info.Name,
		ProviderWorkoutID: providerWorkoutID,
		PriorID:           priorToSupersede,
	})
	if err != nil {
		w.log.Error("record pushed scheduled workout failed", zapErr(err), zap.String("user", uid))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}

	c.JSON(http.StatusOK, pushCustomWorkoutResponse{
		OK:                 true,
		WorkoutID:          workoutID,
		ScheduledWorkoutID: newID,
		Provider:           info.Name,
		ProviderWorkoutID:  providerWorkoutID,
		PushDate:           workout.Date,
	})
}

// pushCustomWorkoutResponse mirrors the weekly push response with the custom
// identity (workout_id) in place of planned_session_id.
type pushCustomWorkoutResponse struct {
	OK                 bool   `json:"ok"`
	WorkoutID          string `json:"workout_id"`
	ScheduledWorkoutID int64  `json:"scheduled_workout_id"`
	Provider           string `json:"provider"`
	ProviderWorkoutID  string `json:"provider_workout_id"`
	PushDate           string `json:"push_date"`
}
