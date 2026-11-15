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
	"github.com/zhaochy1990/stride/internal/compute/trainingload"
	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// ─────────────────────────────────────────────────────────────────────────────
// Dependency (ADR 0023). Satisfied by *storage.Store.
// ─────────────────────────────────────────────────────────────────────────────

// StrideStore is the read surface the stride zones / training-load endpoints need.
type StrideStore interface {
	ReadEffectiveRunningCalibration(ctx context.Context, userID, cutoff string, mode storage.CalibrationMode) (storage.CalibrationBundle, error)
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

	bundle, err := sr.store.ReadEffectiveRunningCalibration(ctx, user, apifmt.TodayShanghai(), storage.CalibrationActive)
	if err != nil {
		sr.log.Error("stride zones: calibration bundle failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusOK, toStrideBundleResponse(bundle))
}

// trainingLoad returns the daily PMC series through Shanghai today. Missing
// tail days are projected as zero-dose assumed rest on the server so every
// client sees the same calendar and ATL/CTL decay semantics.
//
//	@Summary		STRIDE daily training load (PMC)
//	@Description	Returns the most recent `days` daily training-load rows (oldest first), projecting missing or unknown dates through Shanghai today as zero-dose assumed rest with canonical ATL/CTL decay. A user caller may only read their own data; an internal caller may read any user.
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

	series, current = projectAssumedRestDays(series, current, timefmt.ShanghaiToday(), days)
	c.JSON(http.StatusOK, toStrideTrainingLoadResponse(series, current))
}

// ─────────────────────────────────────────────────────────────────────────────
// DTOs — /stride/zones
// ─────────────────────────────────────────────────────────────────────────────

// strideThresholdDTO is the calibration threshold block.
type strideThresholdDTO struct {
	SpeedMps         *float64                      `json:"speed_mps"`
	PacePerKmSec     *int                          `json:"pace_per_km_sec"`
	HRBpm            *float64                      `json:"hr_bpm"`
	SpeedConfidence  string                        `json:"speed_confidence"`
	HRConfidence     string                        `json:"hr_confidence"`
	AsOfDate         string                        `json:"as_of_date"`
	CalibrationID    uint64                        `json:"calibration_id"`
	AlgorithmVersion int                           `json:"algorithm_version"`
	ComputedAt       string                        `json:"computed_at,omitempty"`
	Selection        *storage.CalibrationSelection `json:"selection,omitempty"`
	Source           *calibration.SourceSummary    `json:"source,omitempty"`
	Fingerprint      string                        `json:"fingerprint,omitempty"`
	SpeedRange       *stridePaceRangeDTO           `json:"speed_range_pace_per_km_sec,omitempty"`
}

// calibrationMetadataDTO lets health expose the same selected source without
// exposing the storage row or the diagnostic source_json blob.
type calibrationMetadataDTO struct {
	CalibrationID    uint64                       `json:"calibration_id,omitempty"`
	AlgorithmVersion int                          `json:"algorithm_version,omitempty"`
	AsOfDate         string                       `json:"as_of_date,omitempty"`
	ComputedAt       string                       `json:"computed_at,omitempty"`
	Selection        storage.CalibrationSelection `json:"selection"`
	Source           calibration.SourceSummary    `json:"source"`
	Fingerprint      string                       `json:"fingerprint,omitempty"`
}

func toCalibrationMetadata(bundle storage.CalibrationBundle) *calibrationMetadataDTO {
	out := &calibrationMetadataDTO{Selection: bundle.Selection, Source: bundle.Source, Fingerprint: bundle.Fingerprint}
	if snap := bundle.Snapshot; snap != nil {
		out.CalibrationID, out.AlgorithmVersion, out.AsOfDate = snap.ID, snap.AlgorithmVersion, snap.AsOfDate
		if !snap.ComputedAt.IsZero() {
			out.ComputedAt = snap.ComputedAt.UTC().Format(time.RFC3339Nano)
		}
	}
	return out
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

// stridePaceRangeDTO preserves inverse speed/pace ordering and absent sides.
// It is a sensitivity/support range, never an implied statistical confidence interval.
type stridePaceRangeDTO struct {
	Fast      *int   `json:"fast"`
	Slow      *int   `json:"slow"`
	Meaning   string `json:"meaning"`
	BoundKind string `json:"bound_kind"`
}

// strideZonesResponse is the GET /api/{user}/stride/zones body.
type strideZonesResponse struct {
	Selection *storage.CalibrationSelection `json:"selection,omitempty"`
	Source    *calibration.SourceSummary    `json:"source,omitempty"`
	Threshold *strideThresholdDTO           `json:"threshold"`
	PaceZones []stridePaceZoneDTO           `json:"pace_zones"`
	HRZones   []strideHRZoneDTO             `json:"hr_zones"`
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

func toStrideBundleResponse(bundle storage.CalibrationBundle) strideZonesResponse {
	out := strideZonesResponse{PaceZones: []stridePaceZoneDTO{}, HRZones: []strideHRZoneDTO{}, Selection: &bundle.Selection, Source: &bundle.Source}
	if bundle.Snapshot == nil {
		return out
	}
	out = toStrideZonesResponse(bundle.Snapshot, bundle.PaceZones, bundle.HRZones)
	out.Selection, out.Source = &bundle.Selection, &bundle.Source
	out.Threshold.Selection, out.Threshold.Source = &bundle.Selection, &bundle.Source
	out.Threshold.Fingerprint = bundle.Fingerprint
	if speed := bundle.Source.Speed; speed != nil {
		fast, slow := finitePace(speed.RangeHigh), finitePace(speed.RangeLow)
		kind := "unavailable"
		switch {
		case fast != nil && slow != nil:
			kind = "two_sided"
		case slow != nil:
			kind = "speed_lower_bound"
		case fast != nil:
			kind = "speed_upper_bound"
		}
		out.Threshold.SpeedRange = &stridePaceRangeDTO{Fast: fast, Slow: slow, Meaning: speed.RangeMeaning, BoundKind: kind}
	}
	return out
}

func finitePace(speed *float64) *int {
	if speed == nil || math.IsNaN(*speed) || math.IsInf(*speed, 0) {
		return nil
	}
	return apifmt.PacePerKmSec(speed)
}

func toStrideZonesResponse(
	snap *storage.RunningCalibrationSnapshot,
	pace []storage.RunningCalibrationPaceZone,
	hr []storage.RunningCalibrationHRZone,
) strideZonesResponse {
	threshold := &strideThresholdDTO{
		SpeedMps:         snap.ThresholdSpeedMps,
		PacePerKmSec:     apifmt.PacePerKmSec(snap.ThresholdSpeedMps),
		HRBpm:            snap.ThresholdHR,
		SpeedConfidence:  snap.ThresholdSpeedConfidence,
		HRConfidence:     snap.ThresholdHRConfidence,
		AsOfDate:         snap.AsOfDate,
		CalibrationID:    snap.ID,
		AlgorithmVersion: snap.AlgorithmVersion,
	}

	if !snap.ComputedAt.IsZero() {
		threshold.ComputedAt = snap.ComputedAt.UTC().Format(time.RFC3339Nano)
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

// projectAssumedRestDays produces a calendar-continuous read-only view through
// Shanghai today. Missing and unknown days become zero-dose assumed rest; the
// canonical EWMA calculation remains in internal/compute/trainingload.
func projectAssumedRestDays(
	series []storage.DailyTrainingLoad,
	current *storage.DailyTrainingLoad,
	today time.Time,
	limit int,
) ([]storage.DailyTrainingLoad, *storage.DailyTrainingLoad) {
	if current == nil {
		return series, nil
	}

	anchorRow := current
	for i := range series {
		if isPersistedUsableCoverage(series[i].CoverageStatus) {
			anchorRow = &series[i]
			break
		}
	}
	anchor, err := time.Parse("2006-01-02", anchorRow.Date)
	if err != nil || anchor.After(today) {
		return series, current
	}

	persistedByDate := make(map[string]storage.DailyTrainingLoad, len(series))
	for _, row := range series {
		persistedByDate[row.Date] = row
	}

	inputs := make([]trainingload.DailyProjectionInput, 0, int(today.Sub(anchor).Hours()/24))
	for day := anchor.AddDate(0, 0, 1); !day.After(today); day = day.AddDate(0, 0, 1) {
		date := day.Format("2006-01-02")
		input := trainingload.DailyProjectionInput{
			Date:           day,
			CoverageStatus: trainingload.CoverageRestAssumed,
		}
		if row, ok := persistedByDate[date]; ok && isPersistedUsableCoverage(row.CoverageStatus) {
			input.TrainingDose = row.TrainingDose
			input.CoverageStatus = trainingload.CoverageStatus(row.CoverageStatus)
		}
		inputs = append(inputs, input)
	}
	daily := trainingload.ComputeDailyLoadProjection(
		trainingload.PriorLoadState{AcuteLoad: anchorRow.AcuteLoad, ChronicLoad: anchorRow.ChronicLoad},
		inputs,
	)
	projected := make([]storage.DailyTrainingLoad, 0, len(daily)+1)
	projected = append(projected, *anchorRow)
	for _, result := range daily {
		row := storage.DailyTrainingLoad{
			Date:             result.Date.Format("2006-01-02"),
			AlgorithmVersion: anchorRow.AlgorithmVersion,
			TrainingDose:     result.TrainingDose,
			AcuteLoad:        result.AcuteLoad,
			ChronicLoad:      result.ChronicLoad,
			Form:             result.Form,
			LoadRatio:        result.LoadRatio,
			CoverageStatus:   string(result.CoverageStatus),
		}
		if persisted, ok := persistedByDate[row.Date]; ok && isPersistedUsableCoverage(persisted.CoverageStatus) {
			row.CalibrationID = persisted.CalibrationID
			row.ReadinessGate = persisted.ReadinessGate
			row.ReadinessReasonsJSON = persisted.ReadinessReasonsJSON
		}
		projected = append(projected, row)
	}
	if len(projected) > limit {
		projected = projected[len(projected)-limit:]
	}
	return projected, &projected[len(projected)-1]
}

func isPersistedUsableCoverage(status string) bool {
	switch status {
	case string(trainingload.CoverageComplete),
		string(trainingload.CoveragePartial),
		string(trainingload.CoverageRestConfirmed):
		return true
	default:
		return false
	}
}
