// shared_workout.go is the public workout share-link read (devops#701):
//
//	GET /api/workouts/shared/:user_id/:workout_id   (no auth)
//
// mounted straight on the engine (registerPublic, same pattern as the #506
// race-strategy share link): the viewer may have no account, and the
// (user_id, workout_id) UUID pair is the whole access boundary.
//
// SECURITY: only source=custom AND status=active rows resolve — anything else
// (weekly/watch lineage, archived, wrong owner, missing, malformed UUID) is
// one uniform 404 so the pair space can't be probed for meaning. There is
// deliberately NO list/enumerate route under this prefix, now or ever: a
// share link is a single-workout read, and an index would defeat the
// unguessable-pair model.
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
)

// sharedWorkoutStore is the persistence the share link needs (narrow port so
// the api package stays free of GORM; satisfied by *storage.Store).
type sharedWorkoutStore interface {
	GetCustomWorkout(ctx context.Context, userID, workoutID string) (*storage.Workout, error)
}

// Basic per-IP fixed-window rate limit (devops#701): the UUID pair is
// unguessable, this is only an anti-abuse backstop. Keys are pruned back to
// ≤ limit entries each call; an IP's map entry is deleted once idle past the
// window.
const (
	sharedWorkoutRateLimit  = 30
	sharedWorkoutRateWindow = time.Minute
)

type sharedWorkoutRoutes struct {
	store sharedWorkoutStore
	log   *zap.Logger

	mu   sync.Mutex
	hits map[string][]time.Time
}

func newSharedWorkoutRoutes(store sharedWorkoutStore, log *zap.Logger) *sharedWorkoutRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &sharedWorkoutRoutes{store: store, log: log, hits: map[string][]time.Time{}}
}

// registerPublic mounts the share-link read (devops#701) straight on the
// engine, outside the authed group: the viewer may have no account, and the
// UUID pair is the whole access boundary. Read-only by construction.
func (r *sharedWorkoutRoutes) registerPublic(engine *gin.Engine) {
	if r.store == nil {
		return
	}
	engine.GET("/api/workouts/shared/:user_id/:workout_id", r.getShared)
}

func (r *sharedWorkoutRoutes) allow(ip string, now time.Time) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	kept := r.hits[ip][:0]
	for _, t := range r.hits[ip] {
		if now.Sub(t) < sharedWorkoutRateWindow {
			kept = append(kept, t)
		}
	}
	if len(kept) >= sharedWorkoutRateLimit {
		r.hits[ip] = kept
		return false
	}
	r.hits[ip] = append(kept, now)
	return true
}

// sharedWorkoutDTO is the share-link payload: exactly the fields the landing
// page renders. Deliberately no owner, save_token, plan or provider fields —
// #691 zero-identity shares; spec is the stored canonical workout spec
// verbatim.
type sharedWorkoutDTO struct {
	Kind           string          `json:"kind"`
	Name           string          `json:"name"`
	Summary        *string         `json:"summary"`
	Date           string          `json:"date"`
	Spec           json.RawMessage `json:"spec"`
	TotalDistanceM *float64        `json:"total_distance_m"`
	TotalDurationS *int64          `json:"total_duration_s"`
	EstimatedDose  *float64        `json:"estimated_dose"`
}

// getShared answers a read-only workout share link (devops#701): anyone with
// the link — logged in or not — sees that one saved custom workout. Missing,
// wrong owner, archived, non-custom source and malformed UUID all answer the
// same 404 (never a 400): the pair is the access boundary, and the landing
// page maps any miss on this prefix to「该分享已失效」.
//
//	@Summary		Get a shared workout
//	@Description	Read-only share-link read. Returns one active custom workout's render fields (kind, name, summary, date, spec, totals, dose) with zero owner identity. Any miss (bad UUID, wrong owner, archived, weekly/watch source) answers 404 without saying which part missed.
//	@Tags			workouts
//	@Produce		json
//	@Param			user_id		path	string	true	"Owner user UUID"
//	@Param			workout_id	path	string	true	"Workout UUID"
//	@Success		200			{object}	sharedWorkoutDTO
//	@Failure		404			{object}	errorResponse
//	@Failure		429			{object}	errorResponse
//	@Failure		500			{object}	errorResponse
//	@Router			/api/workouts/shared/{user_id}/{workout_id} [get]
func (r *sharedWorkoutRoutes) getShared(c *gin.Context) {
	if !r.allow(c.ClientIP(), time.Now()) {
		c.JSON(http.StatusTooManyRequests, errorResponse{Error: "too_many_requests"})
		return
	}
	uid := c.Param("user_id")
	wid := c.Param("workout_id")
	// Anti-probe: a malformed UUID is indistinguishable from a miss, so it
	// answers 404 (unlike the authed surfaces' 400).
	if _, err := uuid.Parse(uid); err != nil {
		c.JSON(http.StatusNotFound, errorResponse{Error: "workout_not_found"})
		return
	}
	if _, err := uuid.Parse(wid); err != nil {
		c.JSON(http.StatusNotFound, errorResponse{Error: "workout_not_found"})
		return
	}
	row, err := r.store.GetCustomWorkout(c.Request.Context(), uid, wid)
	if err != nil {
		r.log.Error("load shared workout failed", zapErr(err), zap.String("user_id", uid))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if row == nil {
		// GetCustomWorkout answers nil for missing / wrong owner / archived /
		// non-custom rows: one uniform 404, never a hint which part missed.
		c.JSON(http.StatusNotFound, errorResponse{Error: "workout_not_found"})
		return
	}
	spec := json.RawMessage("null")
	if row.SpecJSON != nil && *row.SpecJSON != "" {
		spec = json.RawMessage(*row.SpecJSON)
	}
	c.JSON(http.StatusOK, sharedWorkoutDTO{
		Kind: row.Kind, Name: row.Name, Summary: row.Summary, Date: row.Date,
		Spec:           spec,
		TotalDistanceM: row.TotalDistanceM, TotalDurationS: row.TotalDurationS,
		EstimatedDose: row.EstimatedDose,
	})
}
