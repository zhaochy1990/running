// health.go is the training-status metrics read surface (ADR 0023) for the
// watch-passthrough half: a sibling registrar shadowing the three FastAPI routes
// in stride_server/routes/health.py
//
//   - GET /api/{user}/health  (daily-health rows + HRV snapshot + trend + rhr_baseline)
//   - GET /api/{user}/hrv     (per-day HRV detail + latest-reading summary)
//   - GET /api/{user}/pmc     (vendor ATI/CTI/TSB PMC + STRIDE-load PMC block)
//
// mirroring those routes so the Go endpoints emit the same JSON. Like
// activityRoutes it mounts onto the shared authed group and reuses the two auth
// tiers. The SQL lives in internal/storage (health_read.go); presentation reuses
// internal/apifmt. The stride block of /pmc reads daily_training_load (shared
// with strideRoutes) — /pmc deliberately spans vendor + STRIDE for contract
// parity (ADR 0023).
package api

import (
	"context"
	"net/http"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"

	"github.com/zhaochy1990/stride/internal/apifmt"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/logging"
	"github.com/zhaochy1990/stride/internal/storage"
)

// ─────────────────────────────────────────────────────────────────────────────
// Dependency (ADR 0023). A narrow read port so the api package stays free of
// GORM. Satisfied by *storage.Store.
// ─────────────────────────────────────────────────────────────────────────────

// HealthStore is the read surface the health / hrv / pmc endpoints need.
type HealthStore interface {
	DailyHealthWindow(ctx context.Context, userID string, days int) ([]storage.DailyHealth, error)
	DailyHRVWindow(ctx context.Context, userID string, days int) ([]storage.DailyHRV, error)
	LatestHRVDate(ctx context.Context, userID string) (string, error)
	DashboardSnapshot(ctx context.Context, userID string) (*storage.Dashboard, error)
	LatestRunningCalibrationSnapshotForVersion(ctx context.Context, userID string, algorithmVersion int, asOf string) (*storage.RunningCalibrationSnapshot, error)
	DailyTrainingLoadWithPrior(ctx context.Context, userID string, days int) ([]storage.DailyLoadWithPrior, error)
	LatestUsableDailyTrainingLoad(ctx context.Context, userID string) (*storage.DailyTrainingLoad, error)
}

// ─────────────────────────────────────────────────────────────────────────────
// Registrar
// ─────────────────────────────────────────────────────────────────────────────

type healthRoutes struct {
	store HealthStore
	log   *zap.Logger
}

func newHealthRoutes(store HealthStore, log *zap.Logger) *healthRoutes {
	if log == nil {
		log = logging.Default()
	}
	return &healthRoutes{store: store, log: log}
}

func (h *healthRoutes) register(rg *gin.RouterGroup) {
	rg.GET("/api/:user/health", h.health)
	rg.GET("/api/:user/hrv", h.hrv)
	rg.GET("/api/:user/pmc", h.pmc)
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

// health returns daily-health rows, the dashboard HRV snapshot (+ per-day trend
// and latest-reading date), and the athlete rhr baseline.
//
//	@Summary		Daily health rows, HRV snapshot, and rhr baseline
//	@Description	Returns the most recent `days` daily-health rows (newest first), the dashboard HRV normal-band snapshot with a per-day trend (oldest first) and its latest-reading date, and the calibrated rhr baseline. A user caller may only read their own data; an internal caller may read any user.
//	@Tags			metrics
//	@Produce		json
//	@Param			user	path		string	true	"User id (JWT sub)"
//	@Param			days	query		int		false	"Window 1–365 (default 30)"
//	@Success		200		{object}	healthResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/health [get]
func (h *healthRoutes) health(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	days, ok := parseDaysParam(c, 30, 1, 365)
	if !ok {
		return
	}
	ctx := c.Request.Context()

	rows, err := h.store.DailyHealthWindow(ctx, user, days)
	if err != nil {
		h.log.Error("health: daily_health failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	dash, err := h.store.DashboardSnapshot(ctx, user)
	if err != nil {
		h.log.Error("health: dashboard failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	latestHRVDate, err := h.store.LatestHRVDate(ctx, user)
	if err != nil {
		h.log.Error("health: latest hrv date failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	trend, err := h.store.DailyHRVWindow(ctx, user, days)
	if err != nil {
		h.log.Error("health: hrv trend failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	snap, err := h.store.LatestRunningCalibrationSnapshotForVersion(ctx, user, calibration.ModelVersion, apifmt.TodayShanghai())
	if err != nil {
		h.log.Error("health: calibration snapshot failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}

	c.JSON(http.StatusOK, toHealthResponse(rows, dash, latestHRVDate, trend, snap))
}

// hrv returns per-day HRV detail (oldest first) plus a summary for the latest
// reading.
//
//	@Summary		Per-day HRV detail + latest-reading summary
//	@Description	Returns the most recent `days` daily-hrv rows (oldest first) plus a small summary block for the latest reading. A user caller may only read their own data; an internal caller may read any user.
//	@Tags			metrics
//	@Produce		json
//	@Param			user	path		string	true	"User id (JWT sub)"
//	@Param			days	query		int		false	"Window 1–365 (default 30)"
//	@Success		200		{object}	hrvResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/hrv [get]
func (h *healthRoutes) hrv(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	days, ok := parseDaysParam(c, 30, 1, 365)
	if !ok {
		return
	}
	rows, err := h.store.DailyHRVWindow(c.Request.Context(), user, days)
	if err != nil {
		h.log.Error("hrv failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	c.JSON(http.StatusOK, toHRVResponse(rows))
}

// pmc returns the vendor Performance Management Chart (ATI/CTI/TSB, ACWR-banded)
// plus the STRIDE-load PMC block (dose/acute/chronic/form + chronic_load_ramp).
//
//	@Summary		Performance Management Chart (vendor + STRIDE)
//	@Description	Returns the vendor ATI/CTI/TSB series with ACWR-derived TSB zones and 7-day CTL ramp, plus the STRIDE training-load PMC series and latest-usable summary. A user caller may only read their own data; an internal caller may read any user.
//	@Tags			metrics
//	@Produce		json
//	@Param			user	path		string	true	"User id (JWT sub)"
//	@Param			days	query		int		false	"Window 14–365 (default 90)"
//	@Success		200		{object}	pmcResponse
//	@Failure		400		{object}	errorResponse
//	@Failure		401		{object}	errorResponse
//	@Failure		403		{object}	errorResponse
//	@Failure		500		{object}	errorResponse
//	@Security		InternalToken
//	@Security		BearerAuth
//	@Router			/api/{user}/pmc [get]
func (h *healthRoutes) pmc(c *gin.Context) {
	user := c.Param("user")
	if !authorizeUser(c, user) {
		return
	}
	days, ok := parseDaysParam(c, 90, 14, 365)
	if !ok {
		return
	}
	ctx := c.Request.Context()

	healthRows, err := h.store.DailyHealthWindow(ctx, user, days)
	if err != nil {
		h.log.Error("pmc: daily_health failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	strideRows, err := h.store.DailyTrainingLoadWithPrior(ctx, user, days)
	if err != nil {
		h.log.Error("pmc: stride series failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}
	latestUsable, err := h.store.LatestUsableDailyTrainingLoad(ctx, user)
	if err != nil {
		h.log.Error("pmc: latest usable failed", zapErr(err))
		c.JSON(http.StatusInternalServerError, errorResponse{Error: "internal error"})
		return
	}

	c.JSON(http.StatusOK, toPMCResponse(healthRows, strideRows, latestUsable))
}

// ─────────────────────────────────────────────────────────────────────────────
// Query parsing
// ─────────────────────────────────────────────────────────────────────────────

// parseDaysParam reads the `days` query, applying the endpoint default when
// absent and clamping to [lo, hi] (the pragmatic equivalent of the Python
// Query(ge/le) bounds, matching the activities-endpoint convention, ADR 0019).
// A non-integer value is rejected 400.
func parseDaysParam(c *gin.Context, def, lo, hi int) (int, bool) {
	n, present, err := queryInt(c, "days")
	if !present {
		return def, true
	}
	if err != nil {
		c.JSON(http.StatusBadRequest, errorResponse{Error: "days must be an integer"})
		return 0, false
	}
	if n < lo {
		n = lo
	}
	if n > hi {
		n = hi
	}
	return n, true
}

// ─────────────────────────────────────────────────────────────────────────────
// DTOs — /health
// ─────────────────────────────────────────────────────────────────────────────

// healthRecordDTO is one daily-health row. Field set/order matches the frontend
// HealthRecord contract (the Python route echoes the raw daily_health columns;
// the internal user_id is dropped). `date` is normalized YYYYMMDD→ISO.
type healthRecordDTO struct {
	Date              string   `json:"date"`
	ATI               *float64 `json:"ati"`
	CTI               *float64 `json:"cti"`
	RHR               *int     `json:"rhr"`
	DistanceM         *float64 `json:"distance_m"`
	DurationS         *float64 `json:"duration_s"`
	TrainingLoadRatio *float64 `json:"training_load_ratio"`
	TrainingLoadState *string  `json:"training_load_state"`
	Fatigue           *float64 `json:"fatigue"`
	BodyBatteryHigh   *int     `json:"body_battery_high"`
	BodyBatteryLow    *int     `json:"body_battery_low"`
	StressAvg         *int     `json:"stress_avg"`
	SleepTotalS       *int     `json:"sleep_total_s"`
	SleepDeepS        *int     `json:"sleep_deep_s"`
	SleepLightS       *int     `json:"sleep_light_s"`
	SleepRemS         *int     `json:"sleep_rem_s"`
	SleepAwakeS       *int     `json:"sleep_awake_s"`
	SleepScore        *int     `json:"sleep_score"`
	RespirationAvg    *float64 `json:"respiration_avg"`
	Spo2Avg           *float64 `json:"spo2_avg"`
	Provider          string   `json:"provider"`
}

// hrvTrendPointDTO is one point of the per-day HRV trend on /health. The DB
// baseline_balanced_* columns are renamed daily_balanced_* so consumers don't
// conflate them with the user-level hrv_normal_* band.
type hrvTrendPointDTO struct {
	Date               string  `json:"date"`
	LastNightAvg       *int    `json:"last_night_avg"`
	Status             *string `json:"status"`
	DailyBalancedLow   *int    `json:"daily_balanced_low"`
	DailyBalancedUpper *int    `json:"daily_balanced_upper"`
}

// hrvSnapshotDTO is the dashboard HRV block on /health. Every field is present
// even for a user with no dashboard row (all null then); `trend` is always an
// array; `date` is the latest daily_hrv reading date.
type hrvSnapshotDTO struct {
	AvgSleepHRV   *float64           `json:"avg_sleep_hrv"`
	HRVNormalLow  *float64           `json:"hrv_normal_low"`
	HRVNormalHigh *float64           `json:"hrv_normal_high"`
	RecoveryPct   *float64           `json:"recovery_pct"`
	Trend         []hrvTrendPointDTO `json:"trend"`
	Date          *string            `json:"date"`
}

// healthResponse is the GET /api/{user}/health body.
type healthResponse struct {
	Health      []healthRecordDTO `json:"health"`
	HRV         hrvSnapshotDTO    `json:"hrv"`
	RHRBaseline *int              `json:"rhr_baseline"`
}

// ─────────────────────────────────────────────────────────────────────────────
// DTOs — /hrv
// ─────────────────────────────────────────────────────────────────────────────

// hrvDailyRecordDTO is one daily-hrv row. Field set/order matches the frontend
// HrvDailyRecord contract.
type hrvDailyRecordDTO struct {
	Date               string  `json:"date"`
	WeeklyAvg          *int    `json:"weekly_avg"`
	LastNightAvg       *int    `json:"last_night_avg"`
	LastNight5MinHigh  *int    `json:"last_night_5min_high"`
	Status             *string `json:"status"`
	BaselineLowUpper   *int    `json:"baseline_low_upper"`
	DailyBalancedLow   *int    `json:"daily_balanced_low"`
	DailyBalancedUpper *int    `json:"daily_balanced_upper"`
	FeedbackPhrase     *string `json:"feedback_phrase"`
	Provider           string  `json:"provider"`
}

// hrvSummaryDTO summarizes the latest HRV reading.
type hrvSummaryDTO struct {
	Date               *string `json:"date"`
	LastNightAvg       *int    `json:"last_night_avg"`
	WeeklyAvg          *int    `json:"weekly_avg"`
	Status             *string `json:"status"`
	DailyBalancedLow   *int    `json:"daily_balanced_low"`
	DailyBalancedUpper *int    `json:"daily_balanced_upper"`
}

// hrvResponse is the GET /api/{user}/hrv body.
type hrvResponse struct {
	HRV     []hrvDailyRecordDTO `json:"hrv"`
	Summary hrvSummaryDTO       `json:"summary"`
}

// ─────────────────────────────────────────────────────────────────────────────
// DTOs — /pmc
// ─────────────────────────────────────────────────────────────────────────────

// pmcRecordDTO is one vendor PMC day: raw ATI/CTI/etc plus the derived tsb and
// ACWR-banded zone and 7-day CTL ramp.
type pmcRecordDTO struct {
	Date              string   `json:"date"`
	ATI               *float64 `json:"ati"`
	CTI               *float64 `json:"cti"`
	TrainingLoadRatio *float64 `json:"training_load_ratio"`
	TrainingLoadState *string  `json:"training_load_state"`
	Fatigue           *float64 `json:"fatigue"`
	RHR               *int     `json:"rhr"`
	TSB               float64  `json:"tsb"`
	TSBZone           string   `json:"tsb_zone"`
	TSBZoneLabel      string   `json:"tsb_zone_label"`
	CTLRamp           *float64 `json:"ctl_ramp"`
}

// pmcSummaryDTO summarizes the latest vendor PMC day.
type pmcSummaryDTO struct {
	CurrentCTI          *float64 `json:"current_cti"`
	CurrentATI          *float64 `json:"current_ati"`
	CurrentTSB          *float64 `json:"current_tsb"`
	CurrentTSBZone      *string  `json:"current_tsb_zone"`
	CurrentTSBZoneLabel *string  `json:"current_tsb_zone_label"`
	CurrentFatigue      *float64 `json:"current_fatigue"`
	CurrentRHR          *int     `json:"current_rhr"`
	CTLRamp             *float64 `json:"ctl_ramp"`
	Date                *string  `json:"date"`
}

// stridePMCRecordDTO is one STRIDE-load PMC day: a training-load record plus the
// derived chronic_load_ramp. It embeds strideTrainingLoadRecordDTO so the shared
// fields (and their mapper) are defined once; encoding/json promotes the
// embedded fields inline, then appends chronic_load_ramp.
type stridePMCRecordDTO struct {
	strideTrainingLoadRecordDTO
	ChronicLoadRamp *float64 `json:"chronic_load_ramp"`
}

// stridePMCSummaryDTO summarizes the latest usable STRIDE-load day. Fields are
// nullable so an athlete with no usable row serializes them as null;
// current_readiness_reasons is an array when a row exists, null otherwise.
type stridePMCSummaryDTO struct {
	Date                    *string  `json:"date"`
	CurrentTrainingDose     *float64 `json:"current_training_dose"`
	CurrentAcuteLoad        *float64 `json:"current_acute_load"`
	CurrentChronicLoad      *float64 `json:"current_chronic_load"`
	CurrentForm             *float64 `json:"current_form"`
	CurrentLoadRatio        *float64 `json:"current_load_ratio"`
	CurrentCoverageStatus   *string  `json:"current_coverage_status"`
	CurrentReadinessGate    *string  `json:"current_readiness_gate"`
	CurrentReadinessReasons []string `json:"current_readiness_reasons"`
	ChronicLoadRamp         *float64 `json:"chronic_load_ramp"`
}

// pmcResponse is the GET /api/{user}/pmc body (vendor + STRIDE, combined).
type pmcResponse struct {
	PMC           []pmcRecordDTO       `json:"pmc"`
	Summary       pmcSummaryDTO        `json:"summary"`
	StridePMC     []stridePMCRecordDTO `json:"stride_pmc"`
	StrideSummary stridePMCSummaryDTO  `json:"stride_summary"`
}

// ─────────────────────────────────────────────────────────────────────────────
// Mappers — /health
// ─────────────────────────────────────────────────────────────────────────────

func toHealthResponse(
	rows []storage.DailyHealth,
	dash *storage.Dashboard,
	latestHRVDate string,
	trend []storage.DailyHRV,
	snap *storage.RunningCalibrationSnapshot,
) healthResponse {
	health := make([]healthRecordDTO, len(rows))
	for i := range rows {
		health[i] = toHealthRecordDTO(&rows[i])
	}

	snapshot := hrvSnapshotDTO{Trend: toHRVTrend(trend)}
	if dash != nil {
		snapshot.AvgSleepHRV = dash.AvgSleepHRV
		snapshot.HRVNormalLow = dash.HRVNormalLow
		snapshot.HRVNormalHigh = dash.HRVNormalHigh
		snapshot.RecoveryPct = dash.RecoveryPct
	}
	if latestHRVDate != "" {
		d := latestHRVDate
		snapshot.Date = &d
	}

	// rhr_baseline is int()-truncated from the calibration snapshot (intTruncPtr,
	// shared with the zone bpm bounds).
	rhrBaseline := intTruncPtr(snapRHRBaseline(snap))

	return healthResponse{Health: health, HRV: snapshot, RHRBaseline: rhrBaseline}
}

// snapRHRBaseline returns the snapshot's rhr baseline pointer, or nil when the
// snapshot (or its baseline) is absent.
func snapRHRBaseline(snap *storage.RunningCalibrationSnapshot) *float64 {
	if snap == nil {
		return nil
	}
	return snap.RHRBaseline
}

func toHealthRecordDTO(r *storage.DailyHealth) healthRecordDTO {
	return healthRecordDTO{
		Date:              normalizeHealthDate(r.Date),
		ATI:               r.ATI,
		CTI:               r.CTI,
		RHR:               r.RHR,
		DistanceM:         r.DistanceM,
		DurationS:         r.DurationS,
		TrainingLoadRatio: r.TrainingLoadRatio,
		TrainingLoadState: r.TrainingLoadState,
		Fatigue:           r.Fatigue,
		BodyBatteryHigh:   r.BodyBatteryHigh,
		BodyBatteryLow:    r.BodyBatteryLow,
		StressAvg:         r.StressAvg,
		SleepTotalS:       r.SleepTotalS,
		SleepDeepS:        r.SleepDeepS,
		SleepLightS:       r.SleepLightS,
		SleepRemS:         r.SleepRemS,
		SleepAwakeS:       r.SleepAwakeS,
		SleepScore:        r.SleepScore,
		RespirationAvg:    r.RespirationAvg,
		Spo2Avg:           r.Spo2Avg,
		Provider:          r.Provider,
	}
}

// toHRVTrend maps the newest-first daily_hrv window into the oldest-first trend
// points /health emits (chart-friendly), keeping only the trend's columns.
func toHRVTrend(rows []storage.DailyHRV) []hrvTrendPointDTO {
	out := make([]hrvTrendPointDTO, len(rows))
	for i := range rows {
		r := &rows[len(rows)-1-i] // reverse to oldest-first
		out[i] = hrvTrendPointDTO{
			Date:               r.Date,
			LastNightAvg:       r.LastNightAvg,
			Status:             r.Status,
			DailyBalancedLow:   r.BaselineBalancedLow,
			DailyBalancedUpper: r.BaselineBalancedUpper,
		}
	}
	return out
}

// normalizeHealthDate coerces a daily_health.date to bare ISO YYYY-MM-DD. COROS
// rows store YYYYMMDD; Garmin rows store ISO (sometimes with a T-suffix). Both
// are already Shanghai-local. Mirrors _normalize_health_date.
func normalizeHealthDate(d string) string {
	if d == "" {
		return d
	}
	if len(d) == 8 && isAllDigits(d) {
		return d[:4] + "-" + d[4:6] + "-" + d[6:]
	}
	if len(d) >= 10 && d[4] == '-' {
		return d[:10]
	}
	return d
}

func isAllDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// ─────────────────────────────────────────────────────────────────────────────
// Mappers — /hrv
// ─────────────────────────────────────────────────────────────────────────────

func toHRVResponse(rows []storage.DailyHRV) hrvResponse {
	// rows are newest-first; the payload is oldest-first with the summary
	// drawn from the latest (newest) reading.
	records := make([]hrvDailyRecordDTO, len(rows))
	for i := range rows {
		r := &rows[len(rows)-1-i]
		records[i] = hrvDailyRecordDTO{
			Date:               r.Date,
			WeeklyAvg:          r.WeeklyAvg,
			LastNightAvg:       r.LastNightAvg,
			LastNight5MinHigh:  r.LastNight5MinHigh,
			Status:             r.Status,
			BaselineLowUpper:   r.BaselineLowUpper,
			DailyBalancedLow:   r.BaselineBalancedLow,
			DailyBalancedUpper: r.BaselineBalancedUpper,
			FeedbackPhrase:     r.FeedbackPhrase,
			Provider:           r.Provider,
		}
	}

	var summary hrvSummaryDTO
	if len(records) > 0 {
		latest := records[len(records)-1]
		d := latest.Date
		summary = hrvSummaryDTO{
			Date:               &d,
			LastNightAvg:       latest.LastNightAvg,
			WeeklyAvg:          latest.WeeklyAvg,
			Status:             latest.Status,
			DailyBalancedLow:   latest.DailyBalancedLow,
			DailyBalancedUpper: latest.DailyBalancedUpper,
		}
	}
	return hrvResponse{HRV: records, Summary: summary}
}

// ─────────────────────────────────────────────────────────────────────────────
// Mappers — /pmc
// ─────────────────────────────────────────────────────────────────────────────

func toPMCResponse(
	healthRows []storage.DailyHealth,
	strideRows []storage.DailyLoadWithPrior,
	latestUsable *storage.DailyTrainingLoad,
) pmcResponse {
	pmc, summary := toVendorPMC(healthRows)
	stridePMC := toStridePMC(strideRows)
	strideSummary := toStrideSummary(latestUsable, stridePMC)
	return pmcResponse{
		PMC:           pmc,
		Summary:       summary,
		StridePMC:     stridePMC,
		StrideSummary: strideSummary,
	}
}

// toVendorPMC builds the vendor ATI/CTI/TSB records (oldest first) and the
// latest-day summary. Mirrors the get_pmc vendor loop: tsb = round(cti−ati, 1)
// on coalesced values, ACWR-banded tsb_zone, and a 7-day CTL ramp.
func toVendorPMC(rows []storage.DailyHealth) ([]pmcRecordDTO, pmcSummaryDTO) {
	// rows are newest-first; reverse to oldest-first.
	n := len(rows)
	ordered := make([]*storage.DailyHealth, n)
	for i := 0; i < n; i++ {
		ordered[i] = &rows[n-1-i]
	}

	records := make([]pmcRecordDTO, n)
	for i, r := range ordered {
		ati := deref(r.ATI)
		cti := deref(r.CTI)
		tsb := apifmt.RoundTo(cti-ati, 1)

		zone, label := tsbZone(r.TrainingLoadRatio, ati, cti)

		var ctlRamp *float64
		if i >= 7 {
			prevCTI := deref(ordered[i-7].CTI)
			v := apifmt.RoundTo(cti-prevCTI, 1)
			ctlRamp = &v
		}

		records[i] = pmcRecordDTO{
			Date:              r.Date,
			ATI:               r.ATI,
			CTI:               r.CTI,
			TrainingLoadRatio: r.TrainingLoadRatio,
			TrainingLoadState: r.TrainingLoadState,
			Fatigue:           r.Fatigue,
			RHR:               r.RHR,
			TSB:               tsb,
			TSBZone:           zone,
			TSBZoneLabel:      label,
			CTLRamp:           ctlRamp,
		}
	}

	var summary pmcSummaryDTO
	if n > 0 {
		latest := records[n-1]
		d := latest.Date
		tsb := latest.TSB
		zone := latest.TSBZone
		zoneLabel := latest.TSBZoneLabel
		summary = pmcSummaryDTO{
			CurrentCTI:          latest.CTI,
			CurrentATI:          latest.ATI,
			CurrentTSB:          &tsb,
			CurrentTSBZone:      &zone,
			CurrentTSBZoneLabel: &zoneLabel,
			CurrentFatigue:      latest.Fatigue,
			CurrentRHR:          latest.RHR,
			CTLRamp:             latest.CTLRamp,
			Date:                &d,
		}
	}
	return records, summary
}

// tsbZone classifies a PMC day by ACWR (training_load_ratio, falling back to
// ati/cti when the stored ratio is missing) rather than absolute TSB, because
// COROS and Garmin ATI/CTI use different scales. Mirrors the get_pmc bands.
func tsbZone(ratioPtr *float64, ati, cti float64) (zone, label string) {
	ratio := ratioPtr
	if ratio == nil && cti > 0 {
		v := ati / cti
		ratio = &v
	}
	switch {
	case ratio == nil:
		return "neutral", "维持期"
	case *ratio < 0.6:
		return "overtaper", "减量过多"
	case *ratio < 0.85:
		return "race_ready", "比赛就绪"
	case *ratio < 1.1:
		return "neutral", "维持期"
	case *ratio < 1.3:
		return "training", "提升期"
	default:
		return "overreaching", "过度负荷"
	}
}

// toStridePMC maps the windowed daily-load rows (oldest first) into the STRIDE
// PMC records, computing chronic_load_ramp from the 7-days-prior chronic load.
// The shared training-load fields reuse toStrideTrainingLoadRecord.
func toStridePMC(rows []storage.DailyLoadWithPrior) []stridePMCRecordDTO {
	out := make([]stridePMCRecordDTO, len(rows))
	for i := range rows {
		r := &rows[i].Row
		var ramp *float64
		if rows[i].PriorChronic != nil {
			v := apifmt.RoundTo(r.ChronicLoad-*rows[i].PriorChronic, 1)
			ramp = &v
		}
		out[i] = stridePMCRecordDTO{
			strideTrainingLoadRecordDTO: toStrideTrainingLoadRecord(r),
			ChronicLoadRamp:             ramp,
		}
	}
	return out
}

// toStrideSummary builds the latest-usable STRIDE summary. chronic_load_ramp is
// taken from the windowed record with the same date (nil when the latest usable
// row falls outside the requested window). Mirrors the get_pmc stride_summary.
func toStrideSummary(latest *storage.DailyTrainingLoad, stridePMC []stridePMCRecordDTO) stridePMCSummaryDTO {
	if latest == nil {
		return stridePMCSummaryDTO{}
	}
	date := latest.Date
	dose := latest.TrainingDose
	acute := latest.AcuteLoad
	chronic := latest.ChronicLoad
	form := latest.Form
	coverage := latest.CoverageStatus

	var ramp *float64
	for i := range stridePMC {
		if stridePMC[i].Date == latest.Date {
			ramp = stridePMC[i].ChronicLoadRamp
			break
		}
	}

	return stridePMCSummaryDTO{
		Date:                    &date,
		CurrentTrainingDose:     &dose,
		CurrentAcuteLoad:        &acute,
		CurrentChronicLoad:      &chronic,
		CurrentForm:             &form,
		CurrentLoadRatio:        latest.LoadRatio,
		CurrentCoverageStatus:   &coverage,
		CurrentReadinessGate:    latest.ReadinessGate,
		CurrentReadinessReasons: jsonStringList(latest.ReadinessReasonsJSON),
		ChronicLoadRamp:         ramp,
	}
}

// deref returns *p or 0 for a nil pointer — the Go analogue of Python's
// `rec.get(k) or 0` coalescing used in the tsb / ctl_ramp math.
func deref(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}
