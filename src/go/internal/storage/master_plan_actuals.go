package storage

import (
	"context"
	"math"
	"time"
)

// WeekWindow is one (Shanghai-local) week span to aggregate actuals over.
// From/To are inclusive "YYYY-MM-DD" Shanghai calendar-day bounds; To is the
// caller-clamped end (min(week_end, today)) so future days are never counted.
type WeekWindow struct {
	Index int
	From  string
	To    string
}

// RunningWeekSummary is a week's actual running rollup (duration-weighted pace/HR),
// mirroring the Python get_running_week_summaries.
type RunningWeekSummary struct {
	RunCount       int
	DistanceKm     float64
	TotalDurationS int
	AvgPaceSKm     *int // duration-weighted; nil when no pace data
	AvgHR          *int // duration-weighted; nil when no HR data
}

// TrainingDoseWeekSummary is a week's actual STRIDE dose rollup, mirroring the
// Python get_training_dose_week_summaries.
type TrainingDoseWeekSummary struct {
	Dose     *float64 // nil when the window has no available day
	Coverage float64  // available days / expected calendar days, rounded 3
	Status   string   // "complete" | "partial" | "unknown"
}

// runWeekAgg / doseWeekAgg are the raw scan targets.
type runWeekAgg struct {
	RunCount         int
	ActualDistanceKm float64
	TotalDurationS   float64
	AvgPaceSKm       *float64
	AvgHR            *float64
}

type doseWeekAgg struct {
	TotalDose     float64
	AvailableDays int
	NonFullDays   int
}

// runWeekSQL sums running activities in a Shanghai-day window. It reuses the
// canonical running predicate (activity_read.go) and the Shanghai-day expression
// DATE(date + INTERVAL 8 HOUR). The distance CASE preserves the Python
// legacy-row correction (a few rows kept a pre-normalisation distance while
// duration+pace were canonical). Pace/HR are duration-weighted.
const runWeekSQL = `SELECT
    COUNT(*) AS run_count,
    ROUND(COALESCE(SUM(CASE
        WHEN avg_pace_s_km IS NOT NULL AND avg_pace_s_km > 0 AND duration_s IS NOT NULL AND duration_s >= 1200
             AND COALESCE(distance_m, 0) BETWEEN 0 AND 999 AND duration_s / avg_pace_s_km * 1000.0 >= 3000
        THEN duration_s / avg_pace_s_km * 1000.0 ELSE COALESCE(distance_m, 0) END), 0) / 1000.0, 1) AS actual_distance_km,
    ROUND(COALESCE(SUM(duration_s), 0), 0) AS total_duration_s,
    ROUND(SUM(CASE WHEN avg_pace_s_km IS NOT NULL AND duration_s IS NOT NULL AND duration_s > 0 THEN avg_pace_s_km * duration_s ELSE 0 END)
        / NULLIF(SUM(CASE WHEN avg_pace_s_km IS NOT NULL AND duration_s IS NOT NULL AND duration_s > 0 THEN duration_s ELSE 0 END), 0), 0) AS avg_pace_s_km,
    ROUND(SUM(CASE WHEN avg_hr IS NOT NULL AND duration_s IS NOT NULL AND duration_s > 0 THEN avg_hr * duration_s ELSE 0 END)
        / NULLIF(SUM(CASE WHEN avg_hr IS NOT NULL AND duration_s IS NOT NULL AND duration_s > 0 THEN duration_s ELSE 0 END), 0), 0) AS avg_hr
  FROM activities
 WHERE ` + runningActivityPredicate + `
   AND user_id = ?
   AND DATE(date + INTERVAL 8 HOUR) BETWEEN ? AND ?`

// doseWeekSQL sums STRIDE dose from daily_training_load in a Shanghai-day window.
// available = coverage_status IN (complete, partial, rest_confirmed); the sole
// non-full available status is 'partial' (full = complete/rest_confirmed).
const doseWeekSQL = `SELECT
    COALESCE(SUM(CASE WHEN coverage_status IN ('complete','partial','rest_confirmed') THEN training_dose ELSE 0 END), 0) AS total_dose,
    COUNT(DISTINCT CASE WHEN coverage_status IN ('complete','partial','rest_confirmed') THEN date END) AS available_days,
    COUNT(DISTINCT CASE WHEN coverage_status = 'partial' THEN date END) AS non_full_days
  FROM daily_training_load
 WHERE user_id = ? AND date BETWEEN ? AND ?`

// RunningWeekSummaries returns the actual running rollup per week window. A window
// with zero runs is omitted (parity with the Python behaviour). Read-only.
func (s *Store) RunningWeekSummaries(ctx context.Context, userID string, windows []WeekWindow) (map[int]RunningWeekSummary, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	out := make(map[int]RunningWeekSummary, len(windows))
	for _, w := range windows {
		var agg runWeekAgg
		if err := s.db.WithContext(ctx).Raw(runWeekSQL, uid, w.From, w.To).Scan(&agg).Error; err != nil {
			return nil, err
		}
		if agg.RunCount == 0 {
			continue
		}
		out[w.Index] = RunningWeekSummary{
			RunCount:       agg.RunCount,
			DistanceKm:     math.Round(agg.ActualDistanceKm*10) / 10,
			TotalDurationS: int(agg.TotalDurationS),
			AvgPaceSKm:     roundToIntPtr(agg.AvgPaceSKm),
			AvgHR:          roundToIntPtr(agg.AvgHR),
		}
	}
	return out, nil
}

// TrainingDoseWeekSummaries returns the canonical actual STRIDE-dose rollup per
// week window. algorithm_version is provenance metadata, not a read filter.
func (s *Store) TrainingDoseWeekSummaries(ctx context.Context, userID string, windows []WeekWindow) (map[int]TrainingDoseWeekSummary, error) {
	uid, err := canonicalUserID(userID)
	if err != nil {
		return nil, err
	}
	out := make(map[int]TrainingDoseWeekSummary, len(windows))
	for _, w := range windows {
		expected := daysBetweenInclusive(w.From, w.To)
		if expected <= 0 {
			continue
		}
		var agg doseWeekAgg
		if err := s.db.WithContext(ctx).Raw(doseWeekSQL, uid, w.From, w.To).Scan(&agg).Error; err != nil {
			return nil, err
		}
		if agg.AvailableDays == 0 {
			out[w.Index] = TrainingDoseWeekSummary{Dose: nil, Coverage: 0, Status: "unknown"}
			continue
		}
		coverage := math.Round(math.Min(1.0, float64(agg.AvailableDays)/float64(expected))*1000) / 1000
		dose := math.Round(agg.TotalDose*10) / 10
		status := "partial"
		if agg.NonFullDays == 0 && agg.AvailableDays >= expected {
			status = "complete"
		}
		out[w.Index] = TrainingDoseWeekSummary{Dose: &dose, Coverage: coverage, Status: status}
	}
	return out, nil
}

func roundToIntPtr(v *float64) *int {
	if v == nil {
		return nil
	}
	i := int(math.Round(*v))
	return &i
}

func daysBetweenInclusive(from, to string) int {
	f, err1 := time.Parse("2006-01-02", from)
	t, err2 := time.Parse("2006-01-02", to)
	if err1 != nil || err2 != nil {
		return 0
	}
	return int(t.Sub(f).Hours()/24) + 1
}
