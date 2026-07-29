package trainingload

import (
	"math"
	"sort"
	"strings"
	"time"
)

// daily.go ports the daily PMC + readiness (core.compute_daily_load_series and
// _readiness_for_day): daily TSS-like dose plus fixed 7/42-day EWMA ATL/CTL.

func daterange(start, end time.Time) []time.Time {
	var out []time.Time
	for d := start; !d.After(end); d = d.AddDate(0, 0, 1) {
		out = append(out, d)
	}
	return out
}

// valuesBefore mirrors core._values_before: values with lower <= d < current.
func valuesBefore(rows []dateValue, current time.Time, days int) []float64 {
	lower := current.AddDate(0, 0, -days)
	var out []float64
	for _, r := range rows {
		if !r.date.Before(lower) && r.date.Before(current) {
			out = append(out, r.value)
		}
	}
	return out
}

type dateValue struct {
	date  time.Time
	value float64
}

func mad(values []float64) float64 {
	if len(values) == 0 {
		return 0.0
	}
	med := medianFloat(values)
	devs := make([]float64, len(values))
	for i, v := range values {
		devs[i] = math.Abs(v - med)
	}
	return medianFloat(devs)
}

func robustScale(values []float64) float64 {
	if len(values) == 0 {
		return 1.0
	}
	med := medianFloat(values)
	return math.Max(math.Max(1.4826*mad(values), 3.0), 0.05*med)
}

func zScore(value float64, values []float64) float64 {
	if len(values) == 0 {
		return 0.0
	}
	scale := robustScale(values)
	if scale > 0 {
		return (value - medianFloat(values)) / scale
	}
	return 0.0
}

func medianFloat(xs []float64) float64 {
	s := append([]float64(nil), xs...)
	sort.Float64s(s)
	n := len(s)
	if n == 0 {
		return 0
	}
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2.0
}

type classKey struct {
	sport   string
	session SessionClass
}

func readinessForDay(
	day time.Time,
	healthByDate map[time.Time]HealthRow,
	hrvByDate map[time.Time]HrvRow,
	allHealth []HealthRow,
	allHrv []HrvRow,
	dayActivities []ActivityLoadResult,
	feedbackByLabel map[string]FeedbackRow,
	historyByClass map[classKey][]ReadinessLoadHistory,
) (string, []string) {
	yellow, red := 0, 0
	var reasons []string

	todayHrv, hasHrv := hrvByDate[day]
	var hrvHistory []dateValue
	for _, row := range allHrv {
		if row.LastNightAvg != nil {
			hrvHistory = append(hrvHistory, dateValue{row.Date, *row.LastNightAvg})
		}
	}
	if hasHrv {
		status := ""
		if todayHrv.Status != nil {
			status = normLower(*todayHrv.Status)
		}
		if status == "poor" || status == "low" {
			red++
			reasons = append(reasons, "low_hrv")
		} else if todayHrv.LastNightAvg != nil {
			baseline := valuesBefore(hrvHistory, day, 28)
			if len(baseline) >= 14 {
				med := medianFloat(baseline)
				scale := robustScale(baseline)
				value := *todayHrv.LastNightAvg
				if value < med-2.5*scale {
					red++
					reasons = append(reasons, "low_hrv")
				} else if value < med-1.5*scale {
					yellow++
					reasons = append(reasons, "low_hrv")
				}
			}
		}
	}

	todayHealth, hasHealth := healthByDate[day]
	var rhrHistory []dateValue
	for _, row := range allHealth {
		if row.RHR != nil {
			rhrHistory = append(rhrHistory, dateValue{row.Date, *row.RHR})
		}
	}
	if hasHealth && todayHealth.RHR != nil {
		baseline := valuesBefore(rhrHistory, day, 90)
		if len(baseline) >= 14 {
			sorted := append([]float64(nil), baseline...)
			sort.Float64s(sorted)
			idx := int(float64(len(sorted)-1) * 0.1)
			if idx < 0 {
				idx = 0
			}
			if idx > len(sorted)-1 {
				idx = len(sorted) - 1
			}
			base := sorted[idx]
			if *todayHealth.RHR >= base+8 {
				red++
				reasons = append(reasons, "rhr_elevated")
			} else if *todayHealth.RHR >= base+5 {
				yellow++
				reasons = append(reasons, "rhr_elevated")
			}
		}
		if todayHealth.SleepTotalS != nil {
			sleepH := *todayHealth.SleepTotalS / 3600.0
			var recentSleep []float64
			for _, row := range allHealth {
				if row.SleepTotalS != nil && !row.Date.Before(day.AddDate(0, 0, -7)) && row.Date.Before(day) {
					recentSleep = append(recentSleep, *row.SleepTotalS/3600.0)
				}
			}
			if sleepH < 6.0 {
				red++
				reasons = append(reasons, "sleep_debt")
			} else if sleepH < 6.5 || (len(recentSleep) > 0 && sum(recentSleep)/float64(len(recentSleep)) < 7.0) {
				yellow++
				reasons = append(reasons, "sleep_debt")
			}
		}
	}

	for _, activity := range dayActivities {
		fb, ok := feedbackByLabel[activity.LabelID]
		if !ok || fb.RPE == nil || fb.DurationMinutes == nil || activity.TrainingDose == nil {
			continue
		}
		key := classKey{activity.Sport, activity.SessionClass}
		var history []ReadinessLoadHistory
		for _, item := range historyByClass[key] {
			if !item.ActivityDate.Before(day.AddDate(0, 0, -90)) && item.ActivityDate.Before(day) {
				history = append(history, item)
			}
		}
		if len(history) < 6 {
			continue
		}
		subjective := float64(*fb.RPE) * *fb.DurationMinutes
		var subjHistory, doseHistory []float64
		for _, item := range history {
			subjHistory = append(subjHistory, item.SubjectiveInternalLoad)
			doseHistory = append(doseHistory, item.TrainingDose)
		}
		zSubj := zScore(subjective, subjHistory)
		zDose := zScore(*activity.TrainingDose, doseHistory)
		d := zSubj - zDose
		if d >= 1.5 && zSubj >= 1.0 {
			red++
			reasons = append(reasons, "srpe_dissociation")
		} else if d >= 1.0 && zSubj >= 0.5 {
			yellow++
			reasons = append(reasons, "srpe_dissociation")
		}
	}

	gate := "green"
	if red > 0 || yellow >= 2 {
		gate = "red"
	} else if yellow > 0 {
		gate = "yellow"
	}
	return gate, dedupeReasons(reasons)
}

// ComputeDailyLoadSeries mirrors core.compute_daily_load_series.
func ComputeDailyLoadSeries(
	activityResults []ActivityLoadResult,
	healthRows []HealthRow,
	hrvRows []HrvRow,
	feedbackRows []FeedbackRow,
	start, end time.Time,
	priorState *PriorLoadState,
	readinessHistory []ReadinessLoadHistory,
) []DailyLoadResult {
	byDate := map[time.Time][]ActivityLoadResult{}
	for _, a := range activityResults {
		byDate[a.ActivityDate] = append(byDate[a.ActivityDate], a)
	}
	healthByDate := map[time.Time]HealthRow{}
	for _, h := range healthRows {
		healthByDate[h.Date] = h
	}
	hrvByDate := map[time.Time]HrvRow{}
	for _, h := range hrvRows {
		hrvByDate[h.Date] = h
	}
	feedbackByLabel := map[string]FeedbackRow{}
	for _, f := range feedbackRows {
		feedbackByLabel[f.LabelID] = f
	}
	historyByClass := map[classKey][]ReadinessLoadHistory{}
	sortedHistory := append([]ReadinessLoadHistory(nil), readinessHistory...)
	sort.SliceStable(sortedHistory, func(i, j int) bool { return sortedHistory[i].ActivityDate.Before(sortedHistory[j].ActivityDate) })
	for _, item := range sortedHistory {
		key := classKey{item.Sport, item.SessionClass}
		historyByClass[key] = append(historyByClass[key], item)
	}

	acute, chronic := 0.0, 0.0
	if priorState != nil {
		acute = priorState.AcuteLoad
		chronic = priorState.ChronicLoad
	}
	kAcute := 1.0 - math.Exp(-1.0/7.0)
	kChronic := 1.0 - math.Exp(-1.0/42.0)
	var out []DailyLoadResult

	for _, day := range daterange(start, end) {
		dayActivities := byDate[day]
		var coverage CoverageStatus
		if len(dayActivities) > 0 {
			var usable []ActivityLoadResult
			for _, a := range dayActivities {
				if a.TrainingDose != nil && !a.ExcludedFromPMC {
					usable = append(usable, a)
				}
			}
			allComplete := len(usable) == len(dayActivities)
			for _, a := range usable {
				if a.CoverageStatus != CoverageComplete {
					allComplete = false
				}
			}
			switch {
			case allComplete:
				coverage = CoverageComplete
			case len(usable) > 0:
				coverage = CoveragePartial
			default:
				coverage = CoverageUnknown
			}
		} else if _, ok := healthByDate[day]; ok {
			coverage = CoverageRestConfirmed
		} else {
			coverage = CoverageUnknown
		}

		dose := 0.0
		for _, a := range dayActivities {
			if a.TrainingDose != nil && !a.ExcludedFromPMC {
				dose += *a.TrainingDose
			}
		}
		if coverage != CoverageUnknown {
			acute += kAcute * (dose - acute)
			chronic += kChronic * (dose - chronic)
		}
		gate, readinessReasons := readinessForDay(day, healthByDate, hrvByDate, healthRows, hrvRows, dayActivities, feedbackByLabel, historyByClass)

		var ratio *float64
		if chronic > 0 {
			r := round4(acute / chronic)
			ratio = &r
		}
		var calID *int
		for _, a := range dayActivities {
			if a.CalibrationID != nil {
				calID = a.CalibrationID
				break
			}
		}
		out = append(out, DailyLoadResult{
			Date:             day,
			AlgorithmVersion: ModelVersion,
			CalibrationID:    calID,
			TrainingDose:     round4(dose),
			AcuteLoad:        round4(acute),
			ChronicLoad:      round4(chronic),
			Form:             round4(chronic - acute),
			LoadRatio:        ratio,
			CoverageStatus:   coverage,
			ReadinessGate:    gate,
			ReadinessReasons: readinessReasons,
		})

		// Extend readiness history with today's feedback-backed activities.
		for _, a := range dayActivities {
			fb, ok := feedbackByLabel[a.LabelID]
			if !ok || fb.RPE == nil || fb.DurationMinutes == nil || a.TrainingDose == nil {
				continue
			}
			key := classKey{a.Sport, a.SessionClass}
			historyByClass[key] = append(historyByClass[key], ReadinessLoadHistory{
				ActivityDate:           day,
				Sport:                  a.Sport,
				SessionClass:           a.SessionClass,
				SubjectiveInternalLoad: float64(*fb.RPE) * *fb.DurationMinutes,
				TrainingDose:           *a.TrainingDose,
			})
			var trimmed []ReadinessLoadHistory
			for _, item := range historyByClass[key] {
				if !item.ActivityDate.Before(day.AddDate(0, 0, -90)) && !item.ActivityDate.After(day) {
					trimmed = append(trimmed, item)
				}
			}
			if len(trimmed) > 90 {
				trimmed = trimmed[len(trimmed)-90:]
			}
			historyByClass[key] = trimmed
		}
	}
	return out
}

func sum(xs []float64) float64 {
	s := 0.0
	for _, v := range xs {
		s += v
	}
	return s
}

func normLower(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}
