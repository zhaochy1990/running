// ability.go is the read + backfill surface for the 4-layer capability score. It
// shadows the five FastAPI routes in stride_server/routes/ability.py:
//
//   - GET  /api/{user}/ability/current                 (snapshot-first, ?refresh=1 live)
//   - POST /api/{user}/ability/backfill                (enqueue ability job)
//   - GET  /api/{user}/ability/history                 (pivoted per-day history)
//   - GET  /api/{user}/activities/{label_id}/ability   (L1 + contribution)
//   - GET  /api/{user}/ability/weights                 (L4 weights)
//
// The Python profile target payload (target_s/target_distance) is stubbed to null
// — Go has no profile.json source and the goal is decoupled from the reading.
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/compute/ability"
	"github.com/zhaochy1990/stride/internal/compute/abilitysource"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// l3Keys is the stable UI-friendly L3 dimension order.
var l3Keys = []string{"aerobic", "lt", "vo2max", "endurance", "economy", "recovery"}

// AbilityStore is the read surface the ability endpoints need: the source loader
// (for live compute / refresh), the snapshot row readers, and activity-ability.
// Satisfied by *storage.Store.
type AbilityStore interface {
	abilitysource.Reader
	AbilitySnapshotForDate(ctx context.Context, userID, date string) ([]storage.AbilitySnapshot, error)
	AbilitySnapshotWindow(ctx context.Context, userID string, days int) ([]storage.AbilitySnapshot, error)
	FetchActivityAbility(ctx context.Context, userID, labelID string) (*storage.ActivityAbility, error)
}

type abilityRoutes struct {
	store   AbilityStore
	enq     Enqueuer
	jobType string
	log     *zap.Logger
}

func newAbilityRoutes(store AbilityStore, enq Enqueuer, jobType string, log *zap.Logger) *abilityRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &abilityRoutes{store: store, enq: enq, jobType: jobType, log: log}
}

func (a *abilityRoutes) register(rg *gin.RouterGroup) {
	rg.GET("/api/:user/ability/current", a.getCurrent)
	rg.POST("/api/:user/ability/backfill", a.postBackfill)
	rg.GET("/api/:user/ability/history", a.getHistory)
	// :labelId must match the existing /api/:user/activities/:labelId route's
	// wildcard name — gin rejects a different name in the same position.
	rg.GET("/api/:user/activities/:labelId/ability", a.getActivityAbility)
	rg.GET("/api/:user/ability/weights", a.getWeights)
}

// getCurrent returns today's ability snapshot — snapshot-first with a live-compute
// fallback (mirrors get_ability_current).
//
//	@Summary		Today's ability snapshot
//	@Description	Reads the pre-computed ability_snapshot rows for today; when none exist (or ?refresh=1) it live-computes from the source without persisting.
//	@Tags			ability
//	@Produce		json
//	@Param			user	path		string	true	"User id (JWT sub)"
//	@Param			refresh	query		bool	false	"Force a live compute"
//	@Success		200		{object}	map[string]any
//	@Failure		404		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/ability/current [get]
func (a *abilityRoutes) getCurrent(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	ctx := c.Request.Context()
	today := timefmt.ShanghaiToday().Format("2006-01-02")

	refresh := false
	if q := c.Query("refresh"); q != "" {
		if b, err := strconv.ParseBool(q); err == nil {
			refresh = b
		}
	}

	if !refresh {
		rows, err := a.store.AbilitySnapshotForDate(ctx, user, today)
		if err != nil {
			a.log.Error("ability current: snapshot read failed", zapErr(err))
			c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
			return
		}
		if pivoted := pivotSnapshotRows(rows, today); pivoted != nil {
			c.JSON(http.StatusOK, attachTargetStub(pivoted))
			return
		}
	}

	src, err := abilitysource.Load(ctx, a.store, user, timefmt.ShanghaiToday(), ability.AbilityLookbackDays)
	if err != nil {
		a.log.Error("ability current: source load failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	snap := ability.ComputeAbilitySnapshot(src, today, nil)
	resp := snapshotToResponse(snap)
	resp["source"] = "computed"
	c.JSON(http.StatusOK, attachTargetStub(resp))
}

// postBackfill enqueues an ability job to seed history over `days` (async, ADR 0012).
//
//	@Summary		Backfill ability snapshots
//	@Description	Enqueues an ability compute job that recomputes + persists the ability_snapshot for the last `days` days (default 180, max 365), returning {job_id, days_requested}.
//	@Tags			ability
//	@Produce		json
//	@Param			user	path		string	true	"User id (JWT sub)"
//	@Param			days	query		int		false	"Days to backfill 7–365 (default 180)"
//	@Success		202		{object}	map[string]any
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/ability/backfill [post]
func (a *abilityRoutes) postBackfill(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	days, ok := parseDaysParam(c, 180, 7, 365)
	if !ok {
		return
	}
	input, _ := json.Marshal(map[string]any{"mode": "backfill", "days": days})
	jobID, err := a.enq.Enqueue(c.Request.Context(), job.EnqueueSpec{
		Type:      a.jobType,
		UserID:    user,
		CreatedBy: resolveCreatedBy(callerFrom(c)),
		InputJSON: string(input),
	})
	if err != nil {
		a.log.Error("ability backfill: enqueue failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusAccepted, gin.H{"job_id": jobID, "days_requested": days})
}

// getHistory returns the pivoted per-day history over `days`, sorted oldest-first.
//
//	@Summary		Ability history
//	@Description	Pivoted per-day ability history (date, l4_composite, l4_marathon_race_s, l4_hm_race_s, l3 scores) over the last `days` days, oldest first. Days missing from the snapshot table are absent (no synthesis).
//	@Tags			ability
//	@Produce		json
//	@Param			user	path		string	true	"User id (JWT sub)"
//	@Param			days	query		int		false	"Window 1–365 (default 90)"
//	@Success		200		{array}		map[string]any
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/ability/history [get]
func (a *abilityRoutes) getHistory(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	days, ok := parseDaysParam(c, 90, 1, 365)
	if !ok {
		return
	}
	rows, err := a.store.AbilitySnapshotWindow(c.Request.Context(), user, days)
	if err != nil {
		a.log.Error("ability history: window failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}

	byDate := map[string][]storage.AbilitySnapshot{}
	for i := range rows {
		byDate[rows[i].Date] = append(byDate[rows[i].Date], rows[i])
	}

	dates := make([]string, 0, len(byDate))
	for d := range byDate {
		dates = append(dates, d)
	}
	sort.Strings(dates)

	out := make([]gin.H, 0, len(dates))
	for _, date := range dates {
		if !dateIsVersioned(byDate[date]) {
			continue
		}
		item := gin.H{
			"date": date,
			"l3":   map[string]any{},
		}
		var l4Composite *float64
		var raceS, hmRaceS *int
		l3 := item["l3"].(map[string]any)
		for _, r := range byDate[date] {
			if r.Level == "L3" && r.Value != nil {
				l3[r.Dimension] = *r.Value
			}
			if r.Level == "L4" && r.Dimension == "composite" && r.Value != nil {
				l4Composite = r.Value
			}
			if r.Level == "L4" && r.Dimension == "marathon_race_s" && r.Value != nil {
				v := int(*r.Value)
				raceS = &v
			}
			if r.Level == "L4" && r.Dimension == "hm_race_s" && r.Value != nil {
				v := int(*r.Value)
				hmRaceS = &v
			}
		}
		item["l4_composite"] = l4Composite
		item["l4_marathon_race_s"] = raceS
		item["l4_hm_race_s"] = hmRaceS
		out = append(out, item)
	}
	c.JSON(http.StatusOK, out)
}

// getActivityAbility returns one activity's L1 quality + contribution, or 404.
//
//	@Summary		Single-activity ability
//	@Description	Returns an activity's L1 quality, breakdown and contribution. 404 when no row exists (the per-activity ability pipeline hasn't computed it).
//	@Tags			ability
//	@Produce		json
//	@Param			user	path		string	true	"User id (JWT sub)"
//	@Param			label_id	path	string	true	"Activity label id"
//	@Success		200		{object}	map[string]any
//	@Failure		404		{object}	map[string]string
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/activities/{label_id}/ability [get]
func (a *abilityRoutes) getActivityAbility(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	labelID := c.Param("labelId")
	row, err := a.store.FetchActivityAbility(c.Request.Context(), user, labelID)
	if err != nil {
		a.log.Error("activity ability: fetch failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if row == nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "ability not computed for activity"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"label_id":     row.LabelID,
		"l1_quality":   row.L1Quality,
		"l1_breakdown": parseJSONMap(row.L1Breakdown),
		"contribution": parseJSONMap(row.Contribution),
		"computed_at":  row.ComputedAt.UTC().Format(time.RFC3339),
	})
}

// getWeights returns the L4 weights for the frontend explanation.
//
//	@Summary		Ability L4 weights
//	@Description	Returns the L4 composite weights so the frontend can render the weighting without duplicating constants.
//	@Tags			ability
//	@Produce		json
//	@Param			user	path		string	true	"User id (JWT sub)"
//	@Success		200		{object}	map[string]any
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/ability/weights [get]
func (a *abilityRoutes) getWeights(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	c.JSON(http.StatusOK, gin.H{"l4_weights": ability.L4Weights})
}
