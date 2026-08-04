package api

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies (ADR 0021). The race-goal surface is a sibling registrar with its
// own store port, so the ADR 0012 job/pipeline Service and the ADR 0013 profile
// registrar stay focused.
// ─────────────────────────────────────────────────────────────────────────────

// GoalStore is the race-goal persistence the handlers need. Satisfied by
// *storage.Store. All ≤1-active state transitions are owned by the store's
// transactional methods, so the handlers never touch active_flag directly.
type GoalStore interface {
	GetActiveRaceGoal(ctx context.Context, userID string) (*storage.RaceGoal, error)
	CreateRaceGoal(ctx context.Context, g *storage.RaceGoal) (*storage.RaceGoal, error)
	UpdateActiveRaceGoal(ctx context.Context, upd *storage.RaceGoal) (*storage.RaceGoal, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// Registrar
// ─────────────────────────────────────────────────────────────────────────────

// goalRoutes is the race-goal endpoint set (POST/GET/PUT /api/users/me/
// training-goal). It mounts onto the shared authed group so it reuses the JWT
// user-tier auth (ADR 0021).
type goalRoutes struct {
	store GoalStore
	log   *zap.Logger
}

func newGoalRoutes(store GoalStore, log *zap.Logger) *goalRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &goalRoutes{store: store, log: log}
}

// register mounts the routes on the (already authenticated) group. Paths mirror
// the Python contract so a later BFF cutover is just routing.
func (g *goalRoutes) register(rg *gin.RouterGroup) {
	rg.GET("/api/users/me/training-goal", g.getGoal)
	rg.POST("/api/users/me/training-goal", g.postGoal)
	rg.PUT("/api/users/me/training-goal", g.putGoal)
}

// ─────────────────────────────────────────────────────────────────────────────
// DTOs
// ─────────────────────────────────────────────────────────────────────────────

// goalResponse is the race-goal wire shape. Optional string fields serialize as
// JSON null when absent; available_time_slots is always a (possibly empty)
// array, never null (parity with the Python default_factory=list).
type goalResponse struct {
	GoalID              string   `json:"goal_id"`
	RaceDate            string   `json:"race_date"`
	RaceDistance        string   `json:"race_distance"`
	RaceName            *string  `json:"race_name"`
	TargetFinishTime    *string  `json:"target_finish_time"`
	WeeklyTrainingDays  int      `json:"weekly_training_days"`
	AvailableTimeSlots  []string `json:"available_time_slots"`
	StrengthWillingness *string  `json:"strength_willingness"`
	RaceLocation        *string  `json:"race_location"`
	RaceTimezone        *string  `json:"race_timezone"`
	CreatedAt           string   `json:"created_at"`
	UpdatedAt           string   `json:"updated_at"`
}

// goalInput is the POST body — the race target plus availability preferences.
// The dropped type enum and any client-sent goal_id are ignored (the server
// mints the id). race_date's future-in-Shanghai check is enforced in the handler
// (not expressible as a struct tag).
type goalInput struct {
	RaceDate            string   `json:"race_date" binding:"required,datetime=2006-01-02"`
	RaceDistance        string   `json:"race_distance" binding:"required,oneof=5K 10K HM FM trail"`
	RaceName            *string  `json:"race_name"`
	TargetFinishTime    *string  `json:"target_finish_time"`
	WeeklyTrainingDays  int      `json:"weekly_training_days" binding:"required,min=3,max=6"`
	AvailableTimeSlots  []string `json:"available_time_slots" binding:"omitempty,dive,oneof=morning noon evening"`
	StrengthWillingness *string  `json:"strength_willingness" binding:"omitempty,oneof=yes no conditional"`
	RaceLocation        *string  `json:"race_location"`
	RaceTimezone        *string  `json:"race_timezone"`
}

// goalUpdateInput is the PUT body: the same fields plus the goal_id being edited.
// goal_id is a required concurrency guard — the store matches it against the
// active goal and 404s on mismatch (parity with the Python contract).
type goalUpdateInput struct {
	GoalID string `json:"goal_id" binding:"required"`
	goalInput
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

// getGoal returns the user's active race goal, or 404 when none is set.
//
//	@Summary		Get the current user's active race goal
//	@Tags			training-goal
//	@Produce		json
//	@Success		200	{object}	goalResponse
//	@Failure		401	{object}	errorResponse
//	@Failure		404	{object}	map[string]string
//	@Failure		500	{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/training-goal [get]
func (g *goalRoutes) getGoal(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	goal, err := g.store.GetActiveRaceGoal(c.Request.Context(), uid)
	if err != nil {
		g.log.Error("get race goal failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if goal == nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "No training goal found"})
		return
	}
	c.JSON(http.StatusOK, toGoalResponse(goal))
}

// postGoal validates and creates a new active race goal, archiving the prior
// active one. Returns 201 with the created goal.
//
//	@Summary		Set (create) the current user's race goal
//	@Description	Creates a new active race goal and archives the previous active one. race_date must be a future date in Asia/Shanghai.
//	@Tags			training-goal
//	@Accept			json
//	@Produce		json
//	@Param			body	body		goalInput	true	"Race goal fields"
//	@Success		201		{object}	goalResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		422		{object}	validationErrorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/training-goal [post]
func (g *goalRoutes) postGoal(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	var in goalInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: bindingDetail(err)})
		return
	}
	if resp, ok := validateFutureRaceDate(in.RaceDate); !ok {
		c.JSON(http.StatusUnprocessableEntity, resp)
		return
	}

	goal, err := g.store.CreateRaceGoal(c.Request.Context(), in.toRaceGoal(uid))
	if err != nil {
		g.log.Error("create race goal failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusCreated, toGoalResponse(goal))
}

// putGoal edits the active race goal in place. goal_id must match the active
// goal, else 404. Returns 200 with the updated goal.
//
//	@Summary		Update the current user's active race goal
//	@Description	Edits the active race goal in place. goal_id must match the current active goal. race_date must be a future date in Asia/Shanghai.
//	@Tags			training-goal
//	@Accept			json
//	@Produce		json
//	@Param			body	body		goalUpdateInput	true	"Race goal fields (with goal_id)"
//	@Success		200		{object}	goalResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		404		{object}	map[string]string
//	@Failure		422		{object}	validationErrorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		BearerAuth
//	@Router			/api/users/me/training-goal [put]
func (g *goalRoutes) putGoal(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	var in goalUpdateInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusUnprocessableEntity, validationErrorResponse{Detail: bindingDetail(err)})
		return
	}
	if resp, ok := validateFutureRaceDate(in.RaceDate); !ok {
		c.JSON(http.StatusUnprocessableEntity, resp)
		return
	}

	target := in.goalInput.toRaceGoal(uid)
	target.GoalID = in.GoalID
	updated, err := g.store.UpdateActiveRaceGoal(c.Request.Context(), target)
	if err != nil {
		g.log.Error("update race goal failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if updated == nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": fmt.Sprintf("Training goal '%s' not found", in.GoalID)})
		return
	}
	c.JSON(http.StatusOK, toGoalResponse(updated))
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// toRaceGoal maps a validated input to a storage row (identity/status/timestamps
// are the store's job). available_time_slots normalizes nil -> [] so the column
// round-trips as an empty array.
func (in goalInput) toRaceGoal(userID string) *storage.RaceGoal {
	slots := in.AvailableTimeSlots
	if slots == nil {
		slots = []string{}
	}
	return &storage.RaceGoal{
		UserID:              userID,
		RaceDate:            in.RaceDate,
		RaceDistance:        in.RaceDistance,
		RaceName:            in.RaceName,
		TargetFinishTime:    in.TargetFinishTime,
		WeeklyTrainingDays:  in.WeeklyTrainingDays,
		AvailableTimeSlots:  slots,
		StrengthWillingness: in.StrengthWillingness,
		RaceLocation:        in.RaceLocation,
		RaceTimezone:        in.RaceTimezone,
	}
}

func toGoalResponse(g *storage.RaceGoal) goalResponse {
	slots := g.AvailableTimeSlots
	if slots == nil {
		slots = []string{}
	}
	return goalResponse{
		GoalID:              g.GoalID,
		RaceDate:            g.RaceDate,
		RaceDistance:        g.RaceDistance,
		RaceName:            g.RaceName,
		TargetFinishTime:    g.TargetFinishTime,
		WeeklyTrainingDays:  g.WeeklyTrainingDays,
		AvailableTimeSlots:  slots,
		StrengthWillingness: g.StrengthWillingness,
		RaceLocation:        g.RaceLocation,
		RaceTimezone:        g.RaceTimezone,
		CreatedAt:           g.CreatedAt.UTC().Format(time.RFC3339),
		UpdatedAt:           g.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

// validateFutureRaceDate enforces that race_date is strictly after today in
// Asia/Shanghai (ADR 0021/0022). The YYYY-MM-DD format is already guaranteed by
// the binding tag; this adds the future-date rule as a FastAPI-shaped 422.
func validateFutureRaceDate(raceDate string) (validationErrorResponse, bool) {
	rd, err := time.Parse("2006-01-02", raceDate)
	if err != nil {
		return raceDateDetail("race_date must be a valid YYYY-MM-DD date"), false
	}
	if !rd.After(timefmt.ShanghaiToday()) {
		return raceDateDetail("race_date must be a future date"), false
	}
	return validationErrorResponse{}, true
}

func raceDateDetail(msg string) validationErrorResponse {
	return validationErrorResponse{Detail: []validationDetailItem{
		{Loc: []string{"body", "race_date"}, Msg: msg},
	}}
}
