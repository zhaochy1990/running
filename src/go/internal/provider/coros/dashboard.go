// dashboard.go parses the COROS /dashboard/query + /dashboard/detail/query
// payloads into the dashboard singleton, the per-day HRV trend, and the race
// predictions. Go port of stride_core.models.Dashboard.from_api +
// coros_sync.models.hrv_list_from_dashboard (+ daily_hrv_from_coros).
//
// COROS embeds three health domains in one dashboard summary:
//   - summaryInfo               → the dashboard singleton (levels, thresholds, HRV)
//   - summaryInfo.runScoreList  → race predictions (marathon/HM/10K/5K)
//   - summaryInfo.sleepHrvData.sleepHrvList → the per-day HRV trend (last ~7d)
//
// The current-week distance/duration comes from the separate detail payload's
// currentWeekRecord. Values pass through unconverted (COROS already reports
// pace in s/km and distance in metres here, unlike the activity detail feed),
// matching the Python path so the shadow store stays byte-comparable.
package coros

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"time"

	"github.com/zhaochy1990/stride/internal/storage"
)

// raceTypeByCode maps the COROS runScoreList `type` code to the canonical race
// label. Mirrors stride_core.models.RACE_TYPES; unknown codes keep an explicit
// "Unknown (N)" label so the raw value stays traceable (matches Python).
var raceTypeByCode = map[int]string{
	1: "Marathon",
	2: "Half Marathon",
	4: "10K",
	5: "5K",
}

func raceTypeName(code int) string {
	if s, ok := raceTypeByCode[code]; ok {
		return s
	}
	return fmt.Sprintf("Unknown (%d)", code)
}

// rawDashboardData is the `data` object returned by GetDashboard (already
// unwrapped from the envelope). Python reads data.summaryInfo.
type rawDashboardData struct {
	SummaryInfo rawDashboardSummary `json:"summaryInfo"`
}

// rawDashboardSummary mirrors /dashboard/query data.summaryInfo. The score
// fields are the COROS running-ability breakdown; lthr/ltsp are the threshold
// heart rate and pace; sleepHrvData carries both the current baseline and the
// per-day trend list.
type rawDashboardSummary struct {
	StaminaLevel                  *float64 `json:"staminaLevel"`
	AerobicEnduranceScore         *float64 `json:"aerobicEnduranceScore"`
	LactateThresholdCapacityScore *float64 `json:"lactateThresholdCapacityScore"`
	AnaerobicEnduranceScore       *float64 `json:"anaerobicEnduranceScore"`
	AnaerobicCapacityScore        *float64 `json:"anaerobicCapacityScore"`
	// RHR / LTHR are integers, but decoded as float so a stray JSON float
	// (e.g. 46.0) does not fail the whole summary unmarshal and silently drop
	// the dashboard + HRV + race rows. Converted to *int in parseDashboard.
	RHR          *float64        `json:"rhr"`
	LTHR         *float64        `json:"lthr"`
	LTSP         *float64        `json:"ltsp"`
	RecoveryPct  *float64        `json:"recoveryPct"`
	SleepHrvData rawSleepHrvData `json:"sleepHrvData"`
	RunScoreList []rawRunScore   `json:"runScoreList"`
}

type rawSleepHrvData struct {
	AvgSleepHrv *float64 `json:"avgSleepHrv"`
	// sleepHrvAllIntervalList is [absolute_floor, low_upper, balanced_low,
	// balanced_upper]; indices 2 and 3 are the dashboard's normal HRV band.
	SleepHrvAllIntervalList []*float64        `json:"sleepHrvAllIntervalList"`
	SleepHrvList            []rawSleepHrvItem `json:"sleepHrvList"`
}

// rawSleepHrvItem is one entry of sleepHrvList. avgSleepHrv / the interval
// values are decoded as `any` so a stray boolean is rejected (matching the
// Python _is_real_number guard), and happenDay as `any` because COROS reports
// it as an int or a float (e.g. 20260516 or 20260516.0).
type rawSleepHrvItem struct {
	AvgSleepHrv          any   `json:"avgSleepHrv"`
	HappenDay            any   `json:"happenDay"`
	SleepHrvIntervalList []any `json:"sleepHrvIntervalList"`
}

type rawRunScore struct {
	Type     int      `json:"type"`
	Duration *float64 `json:"duration"`
	AvgPace  *float64 `json:"avgPace"`
}

// rawDashboardDetailData is the `data` object returned by GetDashboardDetail.
// Python reads data.currentWeekRecord.
type rawDashboardDetailData struct {
	CurrentWeekRecord rawWeekRecord `json:"currentWeekRecord"`
}

type rawWeekRecord struct {
	DistanceRecord *float64 `json:"distanceRecord"`
	DurationRecord *float64 `json:"durationRecord"`
}

// parseDashboard converts the COROS dashboard summary + week payloads (each the
// already-unwrapped envelope `data` object) into the dashboard singleton, the
// per-day HRV rows, and the race predictions. summaryData is required; weekData
// may be nil (the week record is optional — only weekly distance/duration).
func parseDashboard(userID string, summaryData, weekData json.RawMessage) (
	*storage.Dashboard, []*storage.DailyHRV, []storage.RacePrediction,
) {
	var sd rawDashboardData
	if err := json.Unmarshal(summaryData, &sd); err != nil {
		return nil, nil, nil
	}
	s := sd.SummaryInfo

	var wk rawWeekRecord
	if len(weekData) > 0 {
		var dd rawDashboardDetailData
		if json.Unmarshal(weekData, &dd) == nil {
			wk = dd.CurrentWeekRecord
		}
	}

	now := time.Now().UTC()
	dash := &storage.Dashboard{
		UserID:                  userID,
		RunningLevel:            s.StaminaLevel,
		AerobicScore:            s.AerobicEnduranceScore,
		LactateThresholdScore:   s.LactateThresholdCapacityScore,
		AnaerobicEnduranceScore: s.AnaerobicEnduranceScore,
		AnaerobicCapacityScore:  s.AnaerobicCapacityScore,
		RHR:                     floatToIntPtr(s.RHR),
		ThresholdHR:             floatToIntPtr(s.LTHR),
		ThresholdPaceSKm:        s.LTSP,
		RecoveryPct:             s.RecoveryPct,
		AvgSleepHRV:             s.SleepHrvData.AvgSleepHrv,
		HRVNormalLow:            intervalAt(s.SleepHrvData.SleepHrvAllIntervalList, 2),
		HRVNormalHigh:           intervalAt(s.SleepHrvData.SleepHrvAllIntervalList, 3),
		WeeklyDistanceM:         wk.DistanceRecord,
		WeeklyDurationS:         wk.DurationRecord,
		Provider:                providerName,
		UpdatedAt:               now,
	}

	hrvRows := hrvRowsFromSummary(userID, s.SleepHrvData.SleepHrvList)

	var preds []storage.RacePrediction
	for _, r := range s.RunScoreList {
		preds = append(preds, storage.RacePrediction{
			UserID:    userID,
			RaceType:  raceTypeName(r.Type),
			DurationS: r.Duration,
			AvgPace:   r.AvgPace,
			UpdatedAt: now,
		})
	}
	return dash, hrvRows, preds
}

// hrvRowsFromSummary builds the per-day daily_hrv rows from sleepHrvList,
// skipping entries whose happenDay can't produce a usable date (mirrors
// hrv_list_from_dashboard).
func hrvRowsFromSummary(userID string, list []rawSleepHrvItem) []*storage.DailyHRV {
	var out []*storage.DailyHRV
	for _, item := range list {
		date := happenDayToISO(item.HappenDay)
		if date == "" {
			continue
		}
		value := realNumber(item.AvgSleepHrv)
		out = append(out, &storage.DailyHRV{
			UserID:                userID,
			Date:                  date,
			Provider:              providerName,
			LastNightAvg:          floatToIntPtr(value),
			Status:                deriveHRVStatus(value, item.SleepHrvIntervalList),
			BaselineLowUpper:      baselineField(item.SleepHrvIntervalList, 1),
			BaselineBalancedLow:   baselineField(item.SleepHrvIntervalList, 2),
			BaselineBalancedUpper: baselineField(item.SleepHrvIntervalList, 3),
		})
	}
	return out
}

// deriveHRVStatus classifies a daily HRV value against the per-day baseline band
// [floor, low_upper, balanced_low, balanced_upper]. Port of _derive_status.
func deriveHRVStatus(value *float64, intervals []any) *string {
	if value == nil || len(intervals) < 4 {
		return nil
	}
	floor := realNumber(intervals[0])
	lowUpper := realNumber(intervals[1])
	balancedLow := realNumber(intervals[2])
	balancedUpper := realNumber(intervals[3])
	if floor == nil || lowUpper == nil || balancedLow == nil || balancedUpper == nil {
		return nil
	}
	v := *value
	switch {
	case v < *floor:
		return sptr("POOR")
	case v < *lowUpper:
		return sptr("LOW")
	case v < *balancedLow:
		return sptr("UNBALANCED")
	case v <= *balancedUpper:
		return sptr("BALANCED")
	default:
		return sptr("UNBALANCED")
	}
}

// baselineField returns intervals[index] as a rounded int pointer, or nil when
// absent / non-numeric (port of _baseline_field).
func baselineField(intervals []any, index int) *int {
	if len(intervals) <= index {
		return nil
	}
	return floatToIntPtr(realNumber(intervals[index]))
}

// intervalAt returns intervals[index] only when the list has the full 4-tuple
// [floor, low_upper, balanced_low, balanced_upper] — matching Python's
// `intervals[i] if len(intervals) >= 4 else None`. A shorter list (seen while
// the HRV baseline is still being established) yields nil for BOTH normal-band
// fields, not just the missing index.
func intervalAt(intervals []*float64, index int) *float64 {
	if len(intervals) < 4 {
		return nil
	}
	return intervals[index]
}

// realNumber returns v as a float pointer when it is a real JSON number,
// rejecting nil and booleans (a JSON bool decodes to Go bool, which
// json.Unmarshal never coerces to a number). Port of _is_real_number.
func realNumber(v any) *float64 {
	if f, ok := v.(float64); ok {
		return &f
	}
	return nil
}

// happenDayToISO normalizes a COROS YYYYMMDD calendar day to an ISO date,
// returning "" for anything the caller's empty-date filter should drop (nil,
// NaN/inf, malformed). COROS reports happenDay as an int, a float (20260516.0),
// or occasionally a string; all three normalize the same way. Port of
// _happen_day_to_iso.
func happenDayToISO(v any) string {
	var digits string
	switch t := v.(type) {
	case float64:
		if math.IsNaN(t) || math.IsInf(t, 0) {
			return ""
		}
		digits = strconv.FormatInt(int64(t), 10)
	case string:
		digits = t
	default:
		return ""
	}
	if len(digits) != 8 || !isAllDigits(digits) {
		return ""
	}
	return digits[:4] + "-" + digits[4:6] + "-" + digits[6:]
}

func isAllDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// floatToIntPtr rounds a float pointer to the nearest int, preserving nil. HRV
// values are integers in practice, so rounding is exact.
func floatToIntPtr(f *float64) *int {
	if f == nil {
		return nil
	}
	n := int(math.Round(*f))
	return &n
}
