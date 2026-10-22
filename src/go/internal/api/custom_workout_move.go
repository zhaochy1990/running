// custom_workout_move.go adds the date-move endpoint for user-authored
// workouts (devops#696):
//
//	POST /api/users/me/custom-workouts/:workoutId/move   {"date": "YYYY-MM-DD"}
//
// The DB date change always lands first and is never blocked by watch sync
// (unlike upsert/save_token, which never reconciles the pushed state). When
// the workout was already pushed, the watch copy is re-published to the new
// date best-effort via the shared push cycle (sweep old+new dates, push,
// supersede the prior scheduled_workout row); any failure only downgrades the
// response's watch_synced to false. Move has no date window — custom workout
// dates are arbitrary — and same-day moves are a no-op.
package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/storage"
)

// moveCustomWorkoutRequest is the move body: the target calendar date.
type moveCustomWorkoutRequest struct {
	Date string `json:"date" binding:"required"`
}

// moveCustomWorkoutResponse is the moved row (planSessionDTO fields inlined)
// plus watch_synced: false only when a pushed copy exists on the watch but the
// re-publish to the new date failed.
type moveCustomWorkoutResponse struct {
	planSessionDTO
	WatchSynced bool `json:"watch_synced"`
}

// moveCustomWorkout godoc
//
//	@Summary		Move a user-authored workout to another date
//	@Description	Updates the caller's active custom workout date in place (same workout_id). When the workout was already pushed to the watch, the watch copy is re-published to the new date best-effort (sweep + push + supersede); a failure never blocks the date change and only reports watch_synced=false. Same-date moves are a no-op.
//	@Tags			workouts
//	@Accept			json
//	@Produce		json
//	@Param			workoutId	path		string					true	"Custom workout id"
//	@Param			body		body		moveCustomWorkoutRequest	true	"Target date"
//	@Success		200			{object}	moveCustomWorkoutResponse
//	@Failure		401			{object}	errorResponse
//	@Failure		404			{object}	errorResponse	"Workout not found"
//	@Failure		422			{object}	object	"date must be YYYY-MM-DD"
//	@Security		BearerAuth
//	@Router			/api/users/me/custom-workouts/{workoutId}/move [post]
func (w *workoutRoutes) moveCustomWorkout(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	workoutID := c.Param("workoutId")
	ctx := c.Request.Context()

	var req moveCustomWorkoutRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: bindingDetail(err)})
		return
	}
	if _, err := time.Parse("2006-01-02", req.Date); err != nil {
		c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: []validationDetailItem{{
			Loc: []string{"body", "date"}, Msg: "must be YYYY-MM-DD",
		}}})
		return
	}

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

	// Prior watch execution state drives the best-effort re-publish (nil on
	// partial services without watch stores — nothing on the watch to move).
	prior := w.latestPushedForWorkout(ctx, uid, workoutID)

	// Same-day move is a no-op: nothing to update; report the current sync
	// state (a prior push stranded on another date by an earlier failed move
	// stays reported as out of sync).
	if row.Date == req.Date {
		w.respondMoved(c, *row, prior == nil || prior.Date == req.Date, prior != nil)
		return
	}

	// DB first — the date change commits even when the watch re-publish fails.
	if err := w.store.UpdateCustomWorkoutDate(ctx, uid, workoutID, req.Date); err != nil {
		if errors.Is(err, storage.ErrCustomWorkoutNotFound) {
			c.JSON(http.StatusNotFound, errorResponse{Error: "workout not found"})
			return
		}
		w.log.Error("update custom workout date failed", zapErr(err), zap.String("user", uid))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	moved, err := w.store.GetCustomWorkout(ctx, uid, workoutID)
	if err != nil {
		w.log.Error("reload custom workout failed", zapErr(err), zap.String("user", uid))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if moved == nil {
		c.JSON(http.StatusNotFound, errorResponse{Error: "workout not found"})
		return
	}

	// Best-effort watch re-publish: the stored date is already the new date,
	// so the push cycle runs with no target_date and the ±7-day window is
	// trivially satisfied. Any failure — including a provider without delete
	// capability — only downgrades watch_synced; it never fails the move.
	watchSynced := true
	if prior != nil {
		if _, serr := w.syncCustomWorkoutToWatch(ctx, uid, moved, ""); serr != nil {
			w.log.Warn("best-effort watch re-publish after move failed; watch_synced=false",
				zap.String("user", uid), zap.String("workout", workoutID),
				zap.Int("status", serr.status), zap.String("detail", serr.detail))
			watchSynced = false
		}
	}
	w.respondMoved(c, *moved, watchSynced, prior != nil)
}

// respondMoved writes the move response: the row's DTO plus the watch-sync
// outcome. pushed mirrors listPlanSessions semantics (a pushed
// scheduled_workout row exists for this workout_id).
func (w *workoutRoutes) respondMoved(c *gin.Context, row storage.Workout, watchSynced, pushed bool) {
	dto := newPlanSessionDTO(row)
	dto.Pushed = pushed
	c.JSON(http.StatusOK, moveCustomWorkoutResponse{planSessionDTO: dto, WatchSynced: watchSynced})
}

// latestPushedForWorkout returns the latest pushed scheduled_workout row for
// the custom workout, or nil when none exists, its status is not pushed, or
// the watch stores are absent (partial services degrade to "nothing on the
// watch"). A lookup failure is warned and treated the same way — the date
// move must not fail on watch-side reads.
func (w *workoutRoutes) latestPushedForWorkout(ctx context.Context, uid, workoutID string) *storage.ScheduledWorkout {
	if w.swstore == nil {
		return nil
	}
	sw, err := w.swstore.GetLatestScheduledWorkoutForWorkout(ctx, uid, workoutID)
	if err != nil {
		w.log.Warn("get latest scheduled workout failed", zapErr(err), zap.String("user", uid))
		return nil
	}
	if sw == nil || sw.Status != storage.ScheduledWorkoutStatusPushed {
		return nil
	}
	return sw
}
