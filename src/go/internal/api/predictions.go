// predictions.go is the read surface for the "成绩预测" (race prediction) feature.
// It shadows the two FastAPI routes in stride_server/routes/predictions.py:
//
//   - GET /api/{user}/race-predictions   (current predictions)
//   - GET /api/{user}/race-predictions/history?days=180
//
// Predictions come from the ability_snapshot L3 vo2max score → VDOT → Daniels
// tables (FM/HM) / bisection (5K/10K). The Python `target_gap` comparison is
// intentionally dropped — race prediction is a pure fitness estimate and is not
// coupled to the user's target goal (per decision).
package api

import (
	"context"
	"math"
	"net/http"
	"sort"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/compute/ability"
	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
)

// PredictionStore is the read surface the race-prediction endpoints need.
// Satisfied by *storage.Store.
type PredictionStore interface {
	LatestAbilityVo2Max(ctx context.Context, userID string, days int) (*storage.AbilitySnapshot, error)
	AbilityVo2MaxTrend(ctx context.Context, userID string) (string, error)
	ModelVersionForDate(ctx context.Context, userID, date string) (*float64, error)
	AbilitySnapshotWindow(ctx context.Context, userID string, days int) ([]storage.AbilitySnapshot, error)
}

type predictionRoutes struct {
	store PredictionStore
	log   *zap.Logger
}

func newPredictionRoutes(store PredictionStore, log *zap.Logger) *predictionRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &predictionRoutes{store: store, log: log}
}

func (p *predictionRoutes) register(rg *gin.RouterGroup) {
	rg.GET("/api/:user/race-predictions", p.getRacePredictions)
	rg.GET("/api/:user/race-predictions/history", p.getRacePredictionsHistory)
}

// raceDistances is the canonical label → metres map, mirroring _DIST_M.
var raceDistances = map[string]float64{
	"5K": 5000.0, "10K": 10000.0, "HM": 21097.5, "FM": 42195.0,
}

// getRacePredictions returns the current race predictions derived from the latest
// ability_snapshot VO2max (404 when no snapshot exists).
//
//	@Summary		Race time predictions (5K/10K/HM/FM)
//	@Description	Predicts finish times for the four canonical distances from the latest ability_snapshot VO2max, via Daniels tables (FM/HM) and a bisection solver (5K/10K). Returns 404 when the user has no ability snapshot.
//	@Tags			metrics
//	@Produce		json
//	@Param			user	path		string	true	"User id (JWT sub)"
//	@Success		200		{object}	map[string]any
//	@Failure		404		{object}	map[string]string
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/race-predictions [get]
func (p *predictionRoutes) getRacePredictions(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	ctx := c.Request.Context()

	snap, err := p.store.LatestAbilityVo2Max(ctx, user, 90)
	if err != nil {
		p.log.Error("race-predictions: latest vo2max failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if snap == nil || snap.Value == nil {
		c.JSON(http.StatusNotFound, gin.H{"detail": "No ability snapshot found for user"})
		return
	}

	trend, err := p.store.AbilityVo2MaxTrend(ctx, user)
	if err != nil {
		p.log.Error("race-predictions: vo2max trend failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}

	vdot := ability.VdotFromScore(*snap.Value)
	distances := predictionsFromVdot(vdot)

	c.JSON(http.StatusOK, gin.H{
		"user_id":      user,
		"computed_at":  snap.Date,
		"vo2max":       math.Round(vdot*10) / 10,
		"vo2max_trend": trend,
		"distances":    distances,
	})
}

// getRacePredictionsHistory returns per-day predicted times over `days`, oldest
// first, for each distance that has a versioned ability snapshot. Days without a
// snapshot are absent (no synthesis).
//
//	@Summary		Race prediction history
//	@Description	Historical per-distance predicted finish times for each day that has a current-model ability snapshot, sorted oldest-first. Days missing from the snapshot table are absent (no synthesis).
//	@Tags			metrics
//	@Produce		json
//	@Param			user	path		string	true	"User id (JWT sub)"
//	@Param			days	query		int		false	"Window 1–365 (default 180)"
//	@Success		200		{object}	map[string]any
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/race-predictions/history [get]
func (p *predictionRoutes) getRacePredictionsHistory(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	days, ok := parseDaysParam(c, 180, 1, 365)
	if !ok {
		return
	}
	ctx := c.Request.Context()

	rows, err := p.store.AbilitySnapshotWindow(ctx, user, days)
	if err != nil {
		p.log.Error("race-predictions/history: window failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}

	// Separate vo2max scores by date from the model-version markers.
	scoresByDate := map[string]float64{}
	versioned := map[string]bool{}
	for i := range rows {
		r := rows[i]
		if r.Level == "L3" && r.Dimension == "vo2max" && r.Value != nil {
			scoresByDate[r.Date] = *r.Value
		}
		if r.Level == "meta" && r.Dimension == "model_version" && r.Value != nil {
			if *r.Value == float64(ability.AbilityModelVersion) {
				versioned[r.Date] = true
			}
		}
	}

	dateSet := make([]string, 0, len(scoresByDate))
	for date := range scoresByDate {
		if versioned[date] {
			dateSet = append(dateSet, date)
		}
	}
	sort.Strings(dateSet)

	series := make(map[string][]raceHistoryPoint, len(raceDistances))
	for label := range raceDistances {
		series[label] = []raceHistoryPoint{}
	}
	for _, date := range dateSet {
		vdot := ability.VdotFromScore(scoresByDate[date])
		for label, dm := range raceDistances {
			t := ability.DanielsRaceTimeS(dm, vdot)
			if t > 0 {
				series[label] = append(series[label], raceHistoryPoint{
					Date:             date,
					PredictedTimeSec: int(math.Round(t)),
				})
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"user_id": user,
		"days":    days,
		"series":  series,
	})
}

// raceHistoryPoint is one per-day predicted time in a distance series.
type raceHistoryPoint struct {
	Date             string `json:"date"`
	PredictedTimeSec int    `json:"predicted_time_sec"`
}

// predictionsFromVdot returns predicted time + pace for the four canonical
// distances, mirroring _predictions_from_vdot.
func predictionsFromVdot(vdot float64) map[string]map[string]int {
	out := make(map[string]map[string]int, len(raceDistances))
	for label, dm := range raceDistances {
		t := ability.DanielsRaceTimeS(dm, vdot)
		if t <= 0 {
			out[label] = map[string]int{"predicted_time_sec": 0, "predicted_pace_sec_per_km": 0}
			continue
		}
		pace := t / (dm / 1000.0)
		out[label] = map[string]int{
			"predicted_time_sec":        int(math.Round(t)),
			"predicted_pace_sec_per_km": int(math.Round(pace)),
		}
	}
	return out
}
