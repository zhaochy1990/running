// activities.go is the activity read surface (ADR 0019): a sibling registrar
// that shadows the two Python read endpoints
//
//   - GET /api/{user}/activities          (list + pagination + monthly summaries)
//   - GET /api/{user}/activities/{labelId} (detail, ?include=timeseries)
//
// mirroring stride_server/routes/activities.py so the Go endpoints emit the same
// JSON as the FastAPI routes they shadow. Like userRoutes, it mounts onto the
// shared authenticated group and reuses the two auth tiers. The presentation
// helpers (metre→km, duration/pace strings, Shanghai ISO, segment naming) live
// in internal/apifmt; the SQL lives in internal/storage.
package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/apifmt"
	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
)

// ─────────────────────────────────────────────────────────────────────────────
// Dependency (ADR 0019). A narrow read port so the api package stays free of
// GORM. Satisfied by *storage.Store.
// ─────────────────────────────────────────────────────────────────────────────

// ActivityStore is the read surface the activity list + detail endpoints need.
type ActivityStore interface {
	ListActivities(ctx context.Context, userID string, p storage.ActivityListParams) (*storage.ActivityPage, error)
	ActivityByID(ctx context.Context, userID, labelID string) (*storage.Activity, error)
	ActivityLapsByType(ctx context.Context, userID, labelID, lapType string) ([]storage.Lap, error)
	ActivityWatchZones(ctx context.Context, userID, labelID string) ([]storage.ActivityWatchZone, error)
	ActivityZones(ctx context.Context, userID, labelID string) ([]storage.ActivityZone, error)
	ActivityTrainingLoad(ctx context.Context, userID, labelID string) (*storage.ActivityTrainingLoad, error)
	ActivityTimeseries(ctx context.Context, userID, labelID string) ([]storage.TimeseriesPoint, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// Registrar
// ─────────────────────────────────────────────────────────────────────────────

// activityRoutes is the activity read endpoint set. It mounts onto the shared
// authed group so it reuses the JWT user-tier / internal-token auth.
type activityRoutes struct {
	store ActivityStore
	log   *zap.Logger
}

func newActivityRoutes(store ActivityStore, log *zap.Logger) *activityRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &activityRoutes{store: store, log: log}
}

// register mounts the routes on the (already authenticated) group. The `:user`
// param branch coexists with the static `/api/users/...` routes — gin routes the
// static segment when it matches and falls through to the param otherwise.
func (a *activityRoutes) register(rg *gin.RouterGroup) {
	rg.GET("/api/:user/activities", a.list)
	rg.GET("/api/:user/activities/:labelId", a.detail)
}

// authorizeUser enforces the tenant scope: a user-tier caller may only read
// their own {user} (path must equal the JWT sub); an internal-tier caller may
// read any user. It writes the 403 and returns false when denied.
func authorizeUser(c *gin.Context, userID string) bool {
	caller := callerFrom(c)
	if caller.Tier == TierUser && userID != caller.UserID {
		c.JSON(http.StatusForbidden, errorResponse{Error: "forbidden"})
		return false
	}
	return true
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

// list returns a filtered, paginated activity page plus per-visible-month
// summaries.
//
//	@Summary		List a user's activities
//	@Description	Returns a filtered, paginated activity page (newest first) plus run-distance/duration/count summaries for every Shanghai month on the page. A user caller may only list their own activities; an internal caller may list any user.
//	@Tags			activities
//	@Produce		json
//	@Param			user			path		string	true	"User id (JWT sub)"
//	@Param			offset			query		int		false	"Page offset (default 0)"
//	@Param			limit			query		int		false	"Page size 1–200 (default 50)"
//	@Param			sport			query		string	false	"Exact sport_name filter"
//	@Param			sport_category	query		string	false	"run | strength"
//	@Param			min_distance_km	query		number	false	"Minimum distance in km"
//	@Param			date_from		query		string	false	"Shanghai YYYY-MM-DD lower bound"
//	@Param			date_to			query		string	false	"Shanghai YYYY-MM-DD upper bound"
//	@Success		200				{object}	activitiesListResponse
//	@Failure		400				{object}	errorResponse
//	@Failure		401				{object}	errorResponse
//	@Failure		403				{object}	errorResponse
//	@Failure		500				{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/activities [get]
func (a *activityRoutes) list(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	params, ok := parseActivityListParams(c)
	if !ok {
		return
	}

	page, err := a.store.ListActivities(c.Request.Context(), user, params)
	if err != nil {
		a.log.Error("list activities failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusOK, toActivitiesListResponse(page, params.Offset, params.Limit))
}

// detail returns one activity's full detail payload. The heavy timeseries array
// is included only when `?include=timeseries` is passed (M1 mobile contract).
//
//	@Summary		Get one activity's detail
//	@Description	Assembles the activity, objective training load, laps, strength segments, watch-reported zones, and (with ?include=timeseries) the downsampled timeseries. A user caller may only read their own activities; an internal caller may read any user.
//	@Tags			activities
//	@Produce		json
//	@Param			user		path		string	true	"User id (JWT sub)"
//	@Param			labelId		path		string	true	"Activity label id"
//	@Param			include		query		string	false	"Comma list; pass 'timeseries' to inline the series"
//	@Success		200			{object}	activityDetailResponse
//	@Failure		401			{object}	errorResponse
//	@Failure		403			{object}	errorResponse
//	@Failure		404			{object}	errorResponse
//	@Failure		500			{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/activities/{labelId} [get]
func (a *activityRoutes) detail(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	labelID := c.Param("labelId")
	resp, found, err := assembleActivityDetail(
		c.Request.Context(), a.store, user, labelID,
		includeHas(c.Query("include"), "timeseries"),
	)
	if err != nil {
		a.log.Error("assemble activity detail failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	if !found {
		c.JSON(http.StatusNotFound, errorResponse{Error: "Not found"})
		return
	}
	c.JSON(http.StatusOK, resp)
}

// assembleActivityDetail is the shared MySQL-backed detail assembler used by
// both the owner-scoped activity route and the team-authorized activity route.
// found=false distinguishes an absent activity from a storage failure.
func assembleActivityDetail(ctx context.Context, store ActivityStore, userID, labelID string, includeTimeseries bool) (*activityDetailResponse, bool, error) {
	activity, err := store.ActivityByID(ctx, userID, labelID)
	if err != nil {
		return nil, false, err
	}
	if activity == nil {
		return nil, false, nil
	}

	laps, err := store.ActivityLapsByType(ctx, userID, labelID, "autoKm")
	if err != nil {
		return nil, false, err
	}
	segs, err := store.ActivityLapsByType(ctx, userID, labelID, "type2")
	if err != nil {
		return nil, false, err
	}
	watchZones, err := store.ActivityWatchZones(ctx, userID, labelID)
	if err != nil {
		return nil, false, err
	}
	var zones []zoneDTO
	if len(watchZones) > 0 {
		zones = toZoneDTOs(watchZones)
	} else {
		// Providers with no watch zones (Garmin) fall back to the STRIDE-calibrated
		// zones the compute job wrote post-sync (ADR 0019: the API picks the zone
		// source at read time).
		calibrated, err := store.ActivityZones(ctx, userID, labelID)
		if err != nil {
			return nil, false, err
		}
		zones = toActivityZoneDTOs(calibrated)
	}
	load, err := store.ActivityTrainingLoad(ctx, userID, labelID)
	if err != nil {
		return nil, false, err
	}

	resp := &activityDetailResponse{
		Activity:               toActivityDetail(activity),
		StrideTrainingLoad:     toStrideTrainingLoad(load),
		Laps:                   toLapDTOs(laps),
		Segments:               toSegmentDTOs(segs),
		Zones:                  zones,
		LinkedScheduledWorkout: nil,
	}
	if includeTimeseries {
		ts, err := store.ActivityTimeseries(ctx, userID, labelID)
		if err != nil {
			return nil, false, err
		}
		series := toTimeseriesDTOs(downsampleTimeseries(ts))
		resp.Timeseries = &series
	}
	return resp, true, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Query parsing
// ─────────────────────────────────────────────────────────────────────────────

// parseActivityListParams reads and validates the list query. Non-numeric
// offset/limit/min_distance_km and an out-of-range sport_category are rejected
// 400; numeric ranges are clamped (limit → [1,200], offset → ≥0,
// min_distance_km → ≥0), which is the pragmatic equivalent of the Python
// Query(ge/le) bounds (ADR 0019). It writes the error and returns ok=false on a
// bad param.
func parseActivityListParams(c *gin.Context) (storage.ActivityListParams, bool) {
	p := storage.ActivityListParams{Offset: 0, Limit: 50}

	if n, present, err := queryInt(c, "offset"); present {
		if err != nil {
			c.JSON(http.StatusBadRequest, errorResponse{Error: "offset must be an integer"})
			return p, false
		}
		if n < 0 {
			n = 0
		}
		p.Offset = n
	}
	if n, present, err := queryInt(c, "limit"); present {
		if err != nil {
			c.JSON(http.StatusBadRequest, errorResponse{Error: "limit must be an integer"})
			return p, false
		}
		if n < 1 {
			n = 1
		}
		if n > 200 {
			n = 200
		}
		p.Limit = n
	}

	p.Sport = c.Query("sport")

	if v := c.Query("sport_category"); v != "" {
		if v != "run" && v != "strength" {
			c.JSON(http.StatusBadRequest, errorResponse{Error: "sport_category must be 'run' or 'strength'"})
			return p, false
		}
		p.SportCategory = v
	}

	if v := c.Query("min_distance_km"); v != "" {
		f, err := strconv.ParseFloat(v, 64)
		if err != nil {
			c.JSON(http.StatusBadRequest, errorResponse{Error: "min_distance_km must be a number"})
			return p, false
		}
		if f < 0 {
			f = 0
		}
		p.MinDistanceKm = &f
	}

	p.DateFrom = c.Query("date_from")
	p.DateTo = c.Query("date_to")
	return p, true
}

// queryInt parses an integer query param. The bool reports presence (empty →
// absent, not an error) so the caller can keep its default.
func queryInt(c *gin.Context, name string) (int, bool, error) {
	v := c.Query(name)
	if v == "" {
		return 0, false, nil
	}
	n, err := strconv.Atoi(v)
	return n, true, err
}

// includeHas reports whether the comma-separated include list contains token
// (whitespace-trimmed), mirroring the Python `{tok.strip() ...}` set membership.
func includeHas(include, token string) bool {
	for _, t := range strings.Split(include, ",") {
		if strings.TrimSpace(t) == token {
			return true
		}
	}
	return false
}

// ─────────────────────────────────────────────────────────────────────────────
// DTOs — list
// ─────────────────────────────────────────────────────────────────────────────

// activityListItem is one row of the activity list. Nullable numeric/text
// columns are pointers so a missing value serializes as JSON null (matching the
// Python raw-column echo); the derived distance_km/duration_fmt/pace_fmt are
// always present. Commentary and route decoding differ from detail: the list
// carries route_thumb but not feel_type/sport_note/pauses/commentary.
type activityListItem struct {
	LabelID         string          `json:"label_id"`
	Name            *string         `json:"name"`
	SportType       int             `json:"sport_type"`
	SportName       *string         `json:"sport_name"`
	Date            string          `json:"date"`
	DistanceM       *float64        `json:"distance_m"`
	DurationS       *float64        `json:"duration_s"`
	AvgPaceSKm      *float64        `json:"avg_pace_s_km"`
	AvgHR           *int            `json:"avg_hr"`
	MaxHR           *int            `json:"max_hr"`
	AvgCadence      *int            `json:"avg_cadence"`
	CaloriesKcal    *int            `json:"calories_kcal"`
	TrainingLoad    *float64        `json:"training_load"`
	VO2Max          *float64        `json:"vo2max"`
	TrainType       *string         `json:"train_type"`
	AscentM         *float64        `json:"ascent_m"`
	AerobicEffect   *float64        `json:"aerobic_effect"`
	AnaerobicEffect *float64        `json:"anaerobic_effect"`
	Temperature     *float64        `json:"temperature"`
	Humidity        *float64        `json:"humidity"`
	FeelsLike       *float64        `json:"feels_like"`
	WindSpeed       *float64        `json:"wind_speed"`
	DistanceKm      float64         `json:"distance_km"`
	DurationFmt     string          `json:"duration_fmt"`
	PaceFmt         string          `json:"pace_fmt"`
	RouteThumb      json.RawMessage `json:"route_thumb" swaggertype:"object"`
}

// monthlySummaryDTO is one Shanghai-month aggregate. total_run_km is rounded to
// one decimal (Python round(..., 1)).
type monthlySummaryDTO struct {
	ActivityCount int     `json:"activity_count"`
	TotalRunKm    float64 `json:"total_run_km"`
	RunDurationS  int     `json:"run_duration_s"`
	DurationS     int     `json:"duration_s"`
}

// activitiesListResponse is the GET /api/{user}/activities body. offset/limit
// echo the (clamped) request values; monthly_summaries is always present (an
// empty object when the page has no rows).
type activitiesListResponse struct {
	Total            int64                        `json:"total"`
	Offset           int                          `json:"offset"`
	Limit            int                          `json:"limit"`
	Activities       []activityListItem           `json:"activities"`
	MonthlySummaries map[string]monthlySummaryDTO `json:"monthly_summaries"`
}

// ─────────────────────────────────────────────────────────────────────────────
// DTOs — detail
// ─────────────────────────────────────────────────────────────────────────────

// activityDetailDTO is the "activity" object of the detail payload: the same
// core as the list item minus route_thumb, plus feel_type, sport_note and the
// decoded pauses array. Commentary fields are omitted (ADR 0019).
type activityDetailDTO struct {
	LabelID         string          `json:"label_id"`
	Name            *string         `json:"name"`
	SportType       int             `json:"sport_type"`
	SportName       *string         `json:"sport_name"`
	Date            string          `json:"date"`
	DistanceM       *float64        `json:"distance_m"`
	DurationS       *float64        `json:"duration_s"`
	AvgPaceSKm      *float64        `json:"avg_pace_s_km"`
	AvgHR           *int            `json:"avg_hr"`
	MaxHR           *int            `json:"max_hr"`
	AvgCadence      *int            `json:"avg_cadence"`
	CaloriesKcal    *int            `json:"calories_kcal"`
	TrainingLoad    *float64        `json:"training_load"`
	VO2Max          *float64        `json:"vo2max"`
	TrainType       *string         `json:"train_type"`
	AscentM         *float64        `json:"ascent_m"`
	AerobicEffect   *float64        `json:"aerobic_effect"`
	AnaerobicEffect *float64        `json:"anaerobic_effect"`
	Temperature     *float64        `json:"temperature"`
	Humidity        *float64        `json:"humidity"`
	FeelsLike       *float64        `json:"feels_like"`
	WindSpeed       *float64        `json:"wind_speed"`
	FeelType        *int            `json:"feel_type"`
	SportNote       *string         `json:"sport_note"`
	DistanceKm      float64         `json:"distance_km"`
	DurationFmt     string          `json:"duration_fmt"`
	PaceFmt         string          `json:"pace_fmt"`
	Pauses          json.RawMessage `json:"pauses" swaggertype:"object"`
}

// lapDTO is one distance split (lap_type 'autoKm'). Derived
// distance_km/duration_fmt/pace_fmt are always present.
type lapDTO struct {
	LapIndex     int      `json:"lap_index"`
	LapType      string   `json:"lap_type"`
	DistanceM    *float64 `json:"distance_m"`
	DistanceKm   float64  `json:"distance_km"`
	DurationS    *float64 `json:"duration_s"`
	DurationFmt  string   `json:"duration_fmt"`
	AvgPace      *float64 `json:"avg_pace"`
	PaceFmt      string   `json:"pace_fmt"`
	AdjustedPace *float64 `json:"adjusted_pace"`
	AvgHR        *int     `json:"avg_hr"`
	MaxHR        *int     `json:"max_hr"`
	AvgCadence   *int     `json:"avg_cadence"`
	AvgPower     *int     `json:"avg_power"`
	AscentM      *float64 `json:"ascent_m"`
	DescentM     *float64 `json:"descent_m"`
}

// segmentDTO is one strength segment (lap_type 'type2'): the lap fields plus the
// resolved display name and raw mode. exercise_type/exercise_name_key are
// intentionally omitted (the frontend consumes only seg_name/mode, ADR 0019).
type segmentDTO struct {
	lapDTO
	SegName string `json:"seg_name"`
	Mode    *int   `json:"mode"`
}

// zoneDTO is one zone bucket. Projected from activity_watch_zones (watch-reported)
// rather than the calibrated `zones` table the Python endpoint reads — a semantic
// gap recorded in ADR 0019.
type zoneDTO struct {
	ZoneType  string   `json:"zone_type"`
	ZoneIndex int      `json:"zone_index"`
	RangeMin  *float64 `json:"range_min"`
	RangeMax  *float64 `json:"range_max"`
	RangeUnit *string  `json:"range_unit"`
	DurationS *int     `json:"duration_s"`
	Percent   *float64 `json:"percent"`
}

// strideTrainingLoadDTO is the objective training-load block. Mirrors
// _serialize_activity_training_load: excluded_from_pmc is a bool, reasons is the
// decoded string list (empty on null/invalid).
type strideTrainingLoadDTO struct {
	LabelID                string   `json:"label_id"`
	ActivityDate           string   `json:"activity_date"`
	Sport                  *string  `json:"sport"`
	SessionClass           *string  `json:"session_class"`
	AlgorithmVersion       int      `json:"algorithm_version"`
	CalibrationID          *int     `json:"calibration_id"`
	CardioLoadRaw          *float64 `json:"cardio_load_raw"`
	CardioTSS              *float64 `json:"cardio_tss"`
	ExternalTSS            *float64 `json:"external_tss"`
	HighIntensityTSS       *float64 `json:"high_intensity_tss"`
	MechanicalLoad         *float64 `json:"mechanical_load"`
	SubjectiveInternalLoad *float64 `json:"subjective_internal_load"`
	TrainingDose           *float64 `json:"training_dose"`
	TrainingDoseSource     *string  `json:"training_dose_source"`
	CardioCoverage         float64  `json:"cardio_coverage"`
	ExternalCoverage       float64  `json:"external_coverage"`
	HighIntensityCoverage  float64  `json:"high_intensity_coverage"`
	CoverageStatus         string   `json:"coverage_status"`
	LoadConfidence         *string  `json:"load_confidence"`
	ExcludedFromPMC        bool     `json:"excluded_from_pmc"`
	Reasons                []string `json:"reasons"`
}

// timeseriesDTO is one sampled point. Column set matches the Python detail SELECT
// (no running-dynamics columns).
type timeseriesDTO struct {
	Timestamp    *int64   `json:"timestamp"`
	Distance     *float64 `json:"distance"`
	HeartRate    *int     `json:"heart_rate"`
	Speed        *float64 `json:"speed"`
	AdjustedPace *float64 `json:"adjusted_pace"`
	Cadence      *int     `json:"cadence"`
	Altitude     *float64 `json:"altitude"`
	Power        *int     `json:"power"`
	GPSLat       *float64 `json:"gps_lat"`
	GPSLon       *float64 `json:"gps_lon"`
}

// linkedScheduledWorkoutDTO is the multi-variant fallback link. Always null in
// the Go payload (ADR 0019) — defined for the contract/swagger shape.
type linkedScheduledWorkoutDTO struct {
	ID                   int     `json:"id"`
	AbandonedByPromoteAt *string `json:"abandoned_by_promote_at"`
}

// activityDetailResponse is the GET /api/{user}/activities/{labelId} body.
// timeseries is omitted unless ?include=timeseries was passed (M1 mobile
// contract); stride_training_load and linked_scheduled_workout are always
// present (null when absent).
type activityDetailResponse struct {
	Activity               activityDetailDTO          `json:"activity"`
	StrideTrainingLoad     *strideTrainingLoadDTO     `json:"stride_training_load"`
	Laps                   []lapDTO                   `json:"laps"`
	Segments               []segmentDTO               `json:"segments"`
	Zones                  []zoneDTO                  `json:"zones"`
	Timeseries             *[]timeseriesDTO           `json:"timeseries,omitempty"`
	LinkedScheduledWorkout *linkedScheduledWorkoutDTO `json:"linked_scheduled_workout"`
}

// ─────────────────────────────────────────────────────────────────────────────
// Mappers
// ─────────────────────────────────────────────────────────────────────────────

func toActivitiesListResponse(page *storage.ActivityPage, offset, limit int) activitiesListResponse {
	items := make([]activityListItem, len(page.Rows))
	for i := range page.Rows {
		items[i] = toActivityListItem(&page.Rows[i])
	}
	summaries := make(map[string]monthlySummaryDTO, len(page.MonthlySummaries))
	for month, m := range page.MonthlySummaries {
		summaries[month] = monthlySummaryDTO{
			ActivityCount: m.ActivityCount,
			TotalRunKm:    apifmt.RoundTo(m.TotalRunKm, 1),
			RunDurationS:  m.RunDurationS,
			DurationS:     m.DurationS,
		}
	}
	return activitiesListResponse{
		Total:            page.Total,
		Offset:           offset,
		Limit:            limit,
		Activities:       items,
		MonthlySummaries: summaries,
	}
}

func toActivityListItem(a *storage.Activity) activityListItem {
	return activityListItem{
		LabelID:         a.LabelID,
		Name:            a.Name,
		SportType:       a.SportType,
		SportName:       a.SportName,
		Date:            apifmt.ShanghaiISO(a.Date),
		DistanceM:       a.DistanceM,
		DurationS:       a.DurationS,
		AvgPaceSKm:      a.AvgPaceSKm,
		AvgHR:           a.AvgHR,
		MaxHR:           a.MaxHR,
		AvgCadence:      a.AvgCadence,
		CaloriesKcal:    a.CaloriesKcal,
		TrainingLoad:    a.TrainingLoad,
		VO2Max:          a.VO2Max,
		TrainType:       a.TrainType,
		AscentM:         a.AscentM,
		AerobicEffect:   a.AerobicEffect,
		AnaerobicEffect: a.AnaerobicEffect,
		Temperature:     a.Temperature,
		Humidity:        a.Humidity,
		FeelsLike:       a.FeelsLike,
		WindSpeed:       a.WindSpeed,
		DistanceKm:      apifmt.DistanceKm(a.DistanceM),
		DurationFmt:     apifmt.DurationFmt(a.DurationS),
		PaceFmt:         apifmt.PaceFmt(a.AvgPaceSKm),
		RouteThumb:      routeThumbRaw(a.RouteThumbJSON),
	}
}

func toActivityDetail(a *storage.Activity) activityDetailDTO {
	return activityDetailDTO{
		LabelID:         a.LabelID,
		Name:            a.Name,
		SportType:       a.SportType,
		SportName:       a.SportName,
		Date:            apifmt.ShanghaiISO(a.Date),
		DistanceM:       a.DistanceM,
		DurationS:       a.DurationS,
		AvgPaceSKm:      a.AvgPaceSKm,
		AvgHR:           a.AvgHR,
		MaxHR:           a.MaxHR,
		AvgCadence:      a.AvgCadence,
		CaloriesKcal:    a.CaloriesKcal,
		TrainingLoad:    a.TrainingLoad,
		VO2Max:          a.VO2Max,
		TrainType:       a.TrainType,
		AscentM:         a.AscentM,
		AerobicEffect:   a.AerobicEffect,
		AnaerobicEffect: a.AnaerobicEffect,
		Temperature:     a.Temperature,
		Humidity:        a.Humidity,
		FeelsLike:       a.FeelsLike,
		WindSpeed:       a.WindSpeed,
		FeelType:        a.FeelType,
		SportNote:       a.SportNote,
		DistanceKm:      apifmt.DistanceKm(a.DistanceM),
		DurationFmt:     apifmt.DurationFmt(a.DurationS),
		PaceFmt:         apifmt.PaceFmt(a.AvgPaceSKm),
		Pauses:          pausesRaw(a.Pauses),
	}
}

func toLapDTO(l *storage.Lap) lapDTO {
	return lapDTO{
		LapIndex:     l.LapIndex,
		LapType:      l.LapType,
		DistanceM:    l.DistanceM,
		DistanceKm:   apifmt.DistanceKm(l.DistanceM),
		DurationS:    l.DurationS,
		DurationFmt:  apifmt.DurationFmt(l.DurationS),
		AvgPace:      l.AvgPace,
		PaceFmt:      apifmt.PaceFmt(l.AvgPace),
		AdjustedPace: l.AdjustedPace,
		AvgHR:        l.AvgHR,
		MaxHR:        l.MaxHR,
		AvgCadence:   l.AvgCadence,
		AvgPower:     l.AvgPower,
		AscentM:      l.AscentM,
		DescentM:     l.DescentM,
	}
}

func toLapDTOs(laps []storage.Lap) []lapDTO {
	out := make([]lapDTO, len(laps))
	for i := range laps {
		out[i] = toLapDTO(&laps[i])
	}
	return out
}

func toSegmentDTOs(segs []storage.Lap) []segmentDTO {
	out := make([]segmentDTO, len(segs))
	for i := range segs {
		s := &segs[i]
		out[i] = segmentDTO{
			lapDTO:  toLapDTO(s),
			SegName: apifmt.SegmentName(s.ExerciseNameKey, s.ExerciseType),
			Mode:    s.Mode,
		}
	}
	return out
}

func toZoneDTOs(zones []storage.ActivityWatchZone) []zoneDTO {
	out := make([]zoneDTO, len(zones))
	for i, z := range zones {
		out[i] = zoneDTO{
			ZoneType:  z.ZoneType,
			ZoneIndex: z.ZoneIndex,
			RangeMin:  z.RangeMin,
			RangeMax:  z.RangeMax,
			RangeUnit: z.RangeUnit,
			DurationS: z.DurationS,
			Percent:   z.Percent,
		}
	}
	return out
}

// toActivityZoneDTOs mirrors toZoneDTOs for the STRIDE-calibrated activity_zones
// table (same zoneDTO shape, separate source table per ADR 0019).
func toActivityZoneDTOs(rows []storage.ActivityZone) []zoneDTO {
	out := make([]zoneDTO, len(rows))
	for i, z := range rows {
		out[i] = zoneDTO{
			ZoneType:  z.ZoneType,
			ZoneIndex: z.ZoneIndex,
			RangeMin:  z.RangeMin,
			RangeMax:  z.RangeMax,
			RangeUnit: z.RangeUnit,
			DurationS: z.DurationS,
			Percent:   z.Percent,
		}
	}
	return out
}

func toStrideTrainingLoad(load *storage.ActivityTrainingLoad) *strideTrainingLoadDTO {
	if load == nil {
		return nil
	}
	return &strideTrainingLoadDTO{
		LabelID:                load.LabelID,
		ActivityDate:           load.ActivityDate,
		Sport:                  load.Sport,
		SessionClass:           load.SessionClass,
		AlgorithmVersion:       load.AlgorithmVersion,
		CalibrationID:          load.CalibrationID,
		CardioLoadRaw:          load.CardioLoadRaw,
		CardioTSS:              load.CardioTSS,
		ExternalTSS:            load.ExternalTSS,
		HighIntensityTSS:       load.HighIntensityTSS,
		MechanicalLoad:         load.MechanicalLoad,
		SubjectiveInternalLoad: load.SubjectiveInternalLoad,
		TrainingDose:           load.TrainingDose,
		TrainingDoseSource:     load.TrainingDoseSource,
		CardioCoverage:         load.CardioCoverage,
		ExternalCoverage:       load.ExternalCoverage,
		HighIntensityCoverage:  load.HighIntensityCoverage,
		CoverageStatus:         load.CoverageStatus,
		LoadConfidence:         load.LoadConfidence,
		ExcludedFromPMC:        load.ExcludedFromPMC,
		Reasons:                jsonStringList(load.ReasonsJSON),
	}
}

func toTimeseriesDTOs(points []storage.TimeseriesPoint) []timeseriesDTO {
	out := make([]timeseriesDTO, len(points))
	for i, p := range points {
		out[i] = timeseriesDTO{
			Timestamp:    p.Timestamp,
			Distance:     p.Distance,
			HeartRate:    p.HeartRate,
			Speed:        p.Speed,
			AdjustedPace: p.AdjustedPace,
			Cadence:      p.Cadence,
			Altitude:     p.Altitude,
			Power:        p.Power,
			GPSLat:       p.GPSLat,
			GPSLon:       p.GPSLon,
		}
	}
	return out
}

// downsampleTimeseries takes every step-th point where step = max(1, len/1000),
// mirroring the Python `all_ts[::step]` slice.
func downsampleTimeseries(points []storage.TimeseriesPoint) []storage.TimeseriesPoint {
	step := len(points) / 1000
	if step < 1 {
		step = 1
	}
	if step == 1 {
		return points
	}
	out := make([]storage.TimeseriesPoint, 0, len(points)/step+1)
	for i := 0; i < len(points); i += step {
		out = append(out, points[i])
	}
	return out
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON helpers
// ─────────────────────────────────────────────────────────────────────────────

// routeThumbRaw passes a stored route_thumb_json string through as a raw JSON
// value, or nil (→ JSON null) when absent/invalid. Mirrors the Python decode
// whose non-string / invalid path yields None. The bytes are opaque passthrough
// (the value is never inspected), so an insignificant whitespace difference from
// the Python re-encode is possible (ADR 0019).
func routeThumbRaw(raw *string) json.RawMessage {
	if raw == nil || *raw == "" {
		return nil
	}
	b := []byte(*raw)
	if !json.Valid(b) {
		return nil
	}
	return json.RawMessage(b)
}

// pausesRaw passes a stored pauses JSON string through, defaulting to an empty
// array `[]` (never null) when absent/invalid — matching the Python decode whose
// non-string / invalid path yields [].
func pausesRaw(raw *string) json.RawMessage {
	if raw == nil || *raw == "" {
		return json.RawMessage("[]")
	}
	b := []byte(*raw)
	if !json.Valid(b) {
		return json.RawMessage("[]")
	}
	return json.RawMessage(b)
}

// jsonStringList decodes a reasons_json string into a string slice, returning an
// empty (non-nil) slice on null/invalid/non-array input. Mirrors _json_list,
// including its str(item) coercion of each element. reasons_json holds a list of
// strings in practice; pyStr handles the other JSON scalars best-effort.
func jsonStringList(raw *string) []string {
	out := []string{}
	if raw == nil || *raw == "" {
		return out
	}
	var arr []any
	if err := json.Unmarshal([]byte(*raw), &arr); err != nil {
		return out
	}
	for _, item := range arr {
		out = append(out, pyStr(item))
	}
	return out
}

// pyStr approximates Python's str() for a JSON-decoded scalar. Strings pass
// through; bool/nil render as Python's "True"/"False"/"None"; other values fall
// back to their JSON encoding (reasons are strings in practice, so the fallback
// is not exercised).
func pyStr(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case bool:
		if x {
			return "True"
		}
		return "False"
	case nil:
		return "None"
	default:
		b, _ := json.Marshal(x)
		return string(b)
	}
}
