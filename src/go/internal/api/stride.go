// stride.go is the training-status metrics read surface (ADR 0023) for the
// STRIDE self-developed half: a sibling registrar shadowing the two FastAPI
// routes in stride_server/routes/stride.py
//
//   - GET /api/{user}/stride/zones          (calibration threshold + pace/HR zones)
//   - GET /api/{user}/stride/training-load   (daily PMC series + latest usable current)
//
// mirroring those routes so the Go endpoints emit the same JSON. It maps the
// split running_calibration_pace_zone / _hr_zone tables back onto the Python
// single-table zone output, formats zone paces from the speed columns via
// apifmt (byte-identical to the Python _pace_fmt), and sorts zones into
// physiological order.
package api

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"sort"
	"time"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/apifmt"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// ─────────────────────────────────────────────────────────────────────────────
// Dependency (ADR 0023). Satisfied by *storage.Store.
// ─────────────────────────────────────────────────────────────────────────────

// StrideStore is the read surface the stride zones / training-load endpoints need.
type StrideStore interface {
	LatestRunningCalibrationSnapshotForVersion(ctx context.Context, userID string, algorithmVersion int, asOf string) (*storage.RunningCalibrationSnapshot, error)
	CalibrationZonesForSnapshot(ctx context.Context, userID string, snapshotID uint64) ([]storage.RunningCalibrationPaceZone, []storage.RunningCalibrationHRZone, error)
	DailyTrainingLoadSeries(ctx context.Context, userID string, days int) ([]storage.DailyTrainingLoad, error)
	LatestUsableDailyTrainingLoad(ctx context.Context, userID string) (*storage.DailyTrainingLoad, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// Registrar
// ─────────────────────────────────────────────────────────────────────────────

type strideRoutes struct {
	store StrideStore
	log   *zap.Logger
}

func newStrideRoutes(store StrideStore, log *zap.Logger) *strideRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &strideRoutes{store: store, log: log}
}

func (sr *strideRoutes) register(rg *gin.RouterGroup) {
	rg.GET("/api/:user/stride/zones", sr.zones)
	rg.GET("/api/:user/stride/training-load", sr.trainingLoad)
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

// zones returns the STRIDE calibration threshold plus derived pace and HR zones.
//
//	@Summary		STRIDE calibration threshold + training zones
//	@Description	Returns the latest calibration snapshot's threshold pace/HR and the derived pace and heart-rate zones (physiological order). Empty threshold + zones when the user has no snapshot. A user caller may only read their own data; an internal caller may read any user.
//	@Tags			metrics
//	@Produce		json
//	@Param			user	path		string	true	"User id (JWT sub)"
//	@Success		200		{object}	strideZonesResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/stride/zones [get]
func (sr *strideRoutes) zones(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	ctx := c.Request.Context()

	snap, err := sr.store.LatestRunningCalibrationSnapshotForVersion(ctx, user, calibration.ModelVersion, "")
	if err != nil {
		sr.log.Error("stride zones: snapshot failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if snap == nil {
		c.JSON(http.StatusOK, strideZonesResponse{
			Threshold: nil,
			PaceZones: []stridePaceZoneDTO{},
			HRZones:   []strideHRZoneDTO{},
		})
		return
	}

	pace, hr, err := sr.store.CalibrationZonesForSnapshot(ctx, user, snap.ID)
	if err != nil {
		sr.log.Error("stride zones: zone rows failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}

	c.JSON(http.StatusOK, toStrideZonesResponse(snap, pace, hr))
}

// trainingLoad returns the daily PMC series through Shanghai today. Missing
// tail days are projected as zero-dose assumed rest on the server so every
// client sees the same calendar and ATL/CTL decay semantics.
//
//	@Summary		STRIDE daily training load (PMC)
//	@Description	Returns the most recent `days` daily training-load rows (oldest first), projecting missing tail dates through Shanghai today as zero-dose assumed rest with ATL/CTL decay. A user caller may only read their own data; an internal caller may read any user.
//	@Tags			metrics
//	@Produce		json
//	@Param			user	path		string	true	"User id (JWT sub)"
//	@Param			days	query		int		false	"Window 7–365 (default 90)"
//	@Success		200		{object}	strideTrainingLoadResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/stride/training-load [get]
func (sr *strideRoutes) trainingLoad(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	days, ok := parseDaysParam(c, 90, 7, 365)
	if !ok {
		return
	}
	ctx := c.Request.Context()

	series, err := sr.store.DailyTrainingLoadSeries(ctx, user, days)
	if err != nil {
		sr.log.Error("stride training-load: series failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if len(series) == 0 {
		c.JSON(http.StatusOK, strideTrainingLoadResponse{
			Current: nil,
			Series:  []strideTrainingLoadRecordDTO{},
		})
		return
	}

	current, err := sr.store.LatestUsableDailyTrainingLoad(ctx, user)
	if err != nil {
		sr.log.Error("stride training-load: latest usable failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}

	series, current = projectAssumedRestTail(series, current, timefmt.ShanghaiToday(), days)
	c.JSON(http.StatusOK, toStrideTrainingLoadResponse(series, current))
}

// ─────────────────────────────────────────────────────────────────────────────
// DTOs — /stride/zones
// ─────────────────────────────────────────────────────────────────────────────

// strideThresholdDTO is the calibration threshold block.
type strideThresholdDTO struct {
	SpeedMps        *float64 `json:"speed_mps"`
	PacePerKmSec    *int     `json:"pace_per_km_sec"`
	HRBpm           *float64 `json:"hr_bpm"`
	SpeedConfidence string   `json:"speed_confidence"`
	HRConfidence    string   `json:"hr_confidence"`
	AsOfDate        string   `json:"as_of_date"`
	CalibrationID   uint64   `json:"calibration_id"`
}

// stridePaceZoneDTO is one pace zone; lower_pace is the slower edge, upper_pace
// the faster edge, both "M:SS" per km (null when the edge is open).
type stridePaceZoneDTO struct {
	Name      string  `json:"name"`
	Label     string  `json:"label"`
	LowerPace *string `json:"lower_pace"`
	UpperPace *string `json:"upper_pace"`
}

// strideHRZoneDTO is one heart-rate zone (int-truncated bpm bounds).
type strideHRZoneDTO struct {
	Name     string `json:"name"`
	Label    string `json:"label"`
	LowerBpm *int   `json:"lower_bpm"`
	UpperBpm *int   `json:"upper_bpm"`
}

// strideZonesResponse is the GET /api/{user}/stride/zones body.
type strideZonesResponse struct {
	Threshold *strideThresholdDTO `json:"threshold"`
	PaceZones []stridePaceZoneDTO `json:"pace_zones"`
	HRZones   []strideHRZoneDTO   `json:"hr_zones"`
}

// ─────────────────────────────────────────────────────────────────────────────
// DTOs — /stride/training-load
// ─────────────────────────────────────────────────────────────────────────────

// strideTrainingLoadRecordDTO is one daily PMC row. The internal calibration_id
// and computed_at columns Python echoes via SELECT * are intentionally omitted
// (ADR 0023): they are not part of the consumed contract and computed_at has no
// stable cross-runtime representation.
type strideTrainingLoadRecordDTO struct {
	Date             string   `json:"date"`
	AlgorithmVersion int      `json:"algorithm_version"`
	TrainingDose     float64  `json:"training_dose"`
	AcuteLoad        float64  `json:"acute_load"`
	ChronicLoad      float64  `json:"chronic_load"`
	Form             float64  `json:"form"`
	LoadRatio        *float64 `json:"load_ratio"`
	CoverageStatus   string   `json:"coverage_status"`
	ReadinessGate    *string  `json:"readiness_gate"`
	ReadinessReasons []string `json:"readiness_reasons"`
}

// strideTrainingLoadResponse is the GET /api/{user}/stride/training-load body.
type strideTrainingLoadResponse struct {
	Current *strideTrainingLoadRecordDTO  `json:"current"`
	Series  []strideTrainingLoadRecordDTO `json:"series"`
}

// ─────────────────────────────────────────────────────────────────────────────
// Zone ordering / labels
// ─────────────────────────────────────────────────────────────────────────────

// zoneOrder is the physiological order recovery → repetition. It drives both
// the display label index and the sort. Mirrors the Python _ZONE_ORDER.
var zoneOrder = map[string]int{
	"recovery": 0, "easy": 1, "marathon": 2,
	"threshold": 3, "interval": 4, "repetition": 5,
}

// zoneSortKey returns the physiological rank of a zone name, or 99 for an
// unknown name (sorted last), matching the Python sort key default.
func zoneSortKey(name string) int {
	if idx, ok := zoneOrder[name]; ok {
		return idx
	}
	return 99
}

// zoneLabel renders "配速N区" / "心率N区" from the physiological index, falling
// back to the raw name for an unknown zone. Mirrors _zone_label.
func zoneLabel(kind, name string) string {
	idx, ok := zoneOrder[name]
	if !ok {
		return name
	}
	prefix := "配速"
	if kind == "hr" || kind == "heart_rate" {
		prefix = "心率"
	}
	return fmt.Sprintf("%s%d区", prefix, idx+1)
}

// ─────────────────────────────────────────────────────────────────────────────
// Mappers — /stride/zones
// ─────────────────────────────────────────────────────────────────────────────

func toStrideZonesResponse(
	snap *storage.RunningCalibrationSnapshot,
	pace []storage.RunningCalibrationPaceZone,
	hr []storage.RunningCalibrationHRZone,
) strideZonesResponse {
	threshold := &strideThresholdDTO{
		SpeedMps:        snap.ThresholdSpeedMps,
		PacePerKmSec:    apifmt.PacePerKmSec(snap.ThresholdSpeedMps),
		HRBpm:           snap.ThresholdHR,
		SpeedConfidence: snap.ThresholdSpeedConfidence,
		HRConfidence:    snap.ThresholdHRConfidence,
		AsOfDate:        snap.AsOfDate,
		CalibrationID:   snap.ID,
	}

	paceZones := make([]stridePaceZoneDTO, len(pace))
	for i, z := range pace {
		paceZones[i] = stridePaceZoneDTO{
			Name:      z.Name,
			Label:     zoneLabel("pace", z.Name),
			LowerPace: apifmt.PaceMinSec(z.MinSpeedMps), // slower edge
			UpperPace: apifmt.PaceMinSec(z.MaxSpeedMps), // faster edge
		}
	}
	sort.SliceStable(paceZones, func(i, j int) bool {
		return zoneSortKey(paceZones[i].Name) < zoneSortKey(paceZones[j].Name)
	})

	hrZones := make([]strideHRZoneDTO, len(hr))
	for i, z := range hr {
		hrZones[i] = strideHRZoneDTO{
			Name:     z.Name,
			Label:    zoneLabel("hr", z.Name),
			LowerBpm: intTruncPtr(z.MinBpm),
			UpperBpm: intTruncPtr(z.MaxBpm),
		}
	}
	sort.SliceStable(hrZones, func(i, j int) bool {
		return zoneSortKey(hrZones[i].Name) < zoneSortKey(hrZones[j].Name)
	})

	return strideZonesResponse{Threshold: threshold, PaceZones: paceZones, HRZones: hrZones}
}

// intTruncPtr truncates a float bpm bound toward zero (Python int()), preserving
// nil for an open bound.
func intTruncPtr(p *float64) *int {
	if p == nil {
		return nil
	}
	v := int(*p)
	return &v
}

// ─────────────────────────────────────────────────────────────────────────────
// Mappers — /stride/training-load
// ─────────────────────────────────────────────────────────────────────────────

func toStrideTrainingLoadResponse(series []storage.DailyTrainingLoad, current *storage.DailyTrainingLoad) strideTrainingLoadResponse {
	records := make([]strideTrainingLoadRecordDTO, len(series))
	for i := range series {
		records[i] = toStrideTrainingLoadRecord(&series[i])
	}
	var cur *strideTrainingLoadRecordDTO
	if current != nil {
		r := toStrideTrainingLoadRecord(current)
		cur = &r
	}
	return strideTrainingLoadResponse{Current: cur, Series: records}
}

func toStrideTrainingLoadRecord(r *storage.DailyTrainingLoad) strideTrainingLoadRecordDTO {
	return strideTrainingLoadRecordDTO{
		Date:             r.Date,
		AlgorithmVersion: r.AlgorithmVersion,
		TrainingDose:     r.TrainingDose,
		AcuteLoad:        r.AcuteLoad,
		ChronicLoad:      r.ChronicLoad,
		Form:             r.Form,
		LoadRatio:        r.LoadRatio,
		CoverageStatus:   r.CoverageStatus,
		ReadinessGate:    r.ReadinessGate,
		ReadinessReasons: jsonStringList(r.ReadinessReasonsJSON),
	}
}

// projectAssumedRestTail extends the latest persisted usable state through the
// requested Shanghai day. It is a read-only projection: sync/compute remains
// the owner of canonical MySQL rows, while the GET contract stays current even
// when no sync job ran on a no-activity day.
func projectAssumedRestTail(
	series []storage.DailyTrainingLoad,
	current *storage.DailyTrainingLoad,
	today time.Time,
	limit int,
) ([]storage.DailyTrainingLoad, *storage.DailyTrainingLoad) {
	if current == nil {
		return series, nil
	}
	anchor, err := time.Parse("2006-01-02", current.Date)
	if err != nil || !anchor.Before(today) {
		return series, current
	}

	// The response is bounded by `limit`. If the persisted state is very old,
	// advance ATL/CTL to the day before the visible window in closed form rather
	// than allocating one row per stale calendar day.
	firstProjectedDay := anchor.AddDate(0, 0, 1)
	visibleStart := today.AddDate(0, 0, -(limit - 1))
	if firstProjectedDay.Before(visibleStart) {
		skipped := int(visibleStart.Sub(firstProjectedDay).Hours() / 24)
		currentCopy := *current
		currentCopy.AcuteLoad *= math.Exp(-float64(skipped) / 7.0)
		currentCopy.ChronicLoad *= math.Exp(-float64(skipped) / 42.0)
		current = &currentCopy
		firstProjectedDay = visibleStart
	}

	projected := make([]storage.DailyTrainingLoad, 0, limit)
	for _, row := range series {
		day, parseErr := time.Parse("2006-01-02", row.Date)
		if parseErr == nil && !day.After(anchor) && !day.Before(visibleStart) {
			projected = append(projected, row)
		}
	}

	acute, chronic := current.AcuteLoad, current.ChronicLoad
	kAcute := 1.0 - math.Exp(-1.0/7.0)
	kChronic := 1.0 - math.Exp(-1.0/42.0)
	var latest *storage.DailyTrainingLoad
	for day := firstProjectedDay; !day.After(today); day = day.AddDate(0, 0, 1) {
		acute += kAcute * (0 - acute)
		chronic += kChronic * (0 - chronic)
		var ratio *float64
		if chronic > 0 {
			r := roundTrainingLoad(acute / chronic)
			ratio = &r
		}
		row := storage.DailyTrainingLoad{
			Date:             day.Format("2006-01-02"),
			AlgorithmVersion: current.AlgorithmVersion,
			TrainingDose:     0,
			AcuteLoad:        roundTrainingLoad(acute),
			ChronicLoad:      roundTrainingLoad(chronic),
			Form:             roundTrainingLoad(chronic - acute),
			LoadRatio:        ratio,
			CoverageStatus:   "rest_assumed",
		}
		projected = append(projected, row)
		latest = &projected[len(projected)-1]
	}
	if len(projected) > limit {
		projected = projected[len(projected)-limit:]
		latest = &projected[len(projected)-1]
	}
	if latest == nil {
		return projected, current
	}
	return projected, latest
}

func roundTrainingLoad(v float64) float64 {
	return math.Round(v*10000) / 10000
}
