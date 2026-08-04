// Package calibrationsource is the Go equivalent of the Python calibration
// connector (stride_storage/sqlite/calibration_connector.py): it reads the
// synced watch tables and maps them into the infra-free calibration domain
// types via the shared watchmap conversions, keeping the calibration math pure
// (ADR 0015).
package calibrationsource

import (
	"context"
	"strings"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/compute/watchmap"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// Reader is the storage read surface Load needs. *storage.Store satisfies it.
type Reader interface {
	ActivitiesInWindow(ctx context.Context, userID, provider string, start, end time.Time) ([]storage.Activity, error)
	ActivityTimeseries(ctx context.Context, userID, labelID string) ([]storage.TimeseriesPoint, error)
	ActivityLaps(ctx context.Context, userID, labelID string) ([]storage.Lap, error)
	DailyHealthWithRHR(ctx context.Context, userID string) ([]storage.DailyHealth, error)
}

// Load reads the running-activity history over [asOf-lookbackDays, asOf] (with
// timeseries + laps) and every daily-RHR row, mapped into calibration domain
// types. Non-running activities are dropped, mirroring the Python connector's
// _activity_from_row returning None for non-run sports.
func Load(ctx context.Context, r Reader, user, provider string, asOf time.Time, lookbackDays int) ([]calibration.Activity, []calibration.HealthRow, error) {
	start := asOf.AddDate(0, 0, -lookbackDays)
	rows, err := r.ActivitiesInWindow(ctx, user, provider, start, asOf)
	if err != nil {
		return nil, nil, err
	}
	history := make([]calibration.Activity, 0, len(rows))
	for i := range rows {
		a := rows[i]
		sport := watchmap.SportFromRow(a.Sport, a.SportType)
		if !watchmap.IsRunningSport(sport) {
			continue
		}
		ts, err := r.ActivityTimeseries(ctx, user, a.LabelID)
		if err != nil {
			return nil, nil, err
		}
		laps, err := r.ActivityLaps(ctx, user, a.LabelID)
		if err != nil {
			return nil, nil, err
		}
		distanceM := watchmap.AsActivityDistanceMeters(a.DistanceM)
		history = append(history, calibration.Activity{
			LabelID:      a.LabelID,
			ActivityDate: timefmt.ShanghaiDay(a.Date),
			Sport:        sport,
			DurationS:    a.DurationS,
			DistanceM:    distanceM,
			AvgHR:        watchmap.IntToFloat(a.AvgHR),
			MaxHR:        watchmap.IntToFloat(a.MaxHR),
			AvgPowerW:    watchmap.IntToFloat(a.AvgPower),
			Samples:      mapSamples(ts, distanceM, provider),
			Laps:         mapLaps(laps),
			Source:       strPtr(provider),
		})
	}

	healthRows, err := r.DailyHealthWithRHR(ctx, user)
	if err != nil {
		return nil, nil, err
	}
	health := make([]calibration.HealthRow, 0, len(healthRows))
	for i := range healthRows {
		h := healthRows[i]
		d, ok := parseHealthDay(h.Date)
		if !ok {
			continue
		}
		health = append(health, calibration.HealthRow{Date: d, RHR: watchmap.IntToFloat(h.RHR)})
	}
	return history, health, nil
}

func mapSamples(rows []storage.TimeseriesPoint, activityDistanceM *float64, provider string) []calibration.Sample {
	if len(rows) == 0 {
		return nil
	}
	elapsed := watchmap.NormalizeElapsedSeconds(rows)
	scale := watchmap.DistanceScale(rows, activityDistanceM, provider)
	out := make([]calibration.Sample, 0, len(rows))
	for i := range rows {
		r := rows[i]
		var dist *float64
		if r.Distance != nil {
			v := *r.Distance * scale
			dist = &v
		}
		out = append(out, calibration.Sample{
			TimestampS:   elapsed[i],
			ElapsedS:     elapsed[i],
			DistanceM:    dist,
			HeartRateBpm: watchmap.IntToFloat(r.HeartRate),
			SpeedMps:     watchmap.AsSpeedMps(r.Speed),
			PowerW:       watchmap.IntToFloat(r.Power),
			AltitudeM:    r.Altitude,
		})
	}
	return out
}

func mapLaps(rows []storage.Lap) []calibration.Lap {
	if len(rows) == 0 {
		return nil
	}
	out := make([]calibration.Lap, 0, len(rows))
	for i := range rows {
		r := rows[i]
		lapType := r.LapType
		out = append(out, calibration.Lap{
			LapIndex:    r.LapIndex,
			LapType:     &lapType,
			DistanceM:   watchmap.AsActivityDistanceMeters(r.DistanceM),
			DurationS:   r.DurationS,
			AvgSpeedMps: watchmap.AsSpeedMps(r.AvgPace),
			AvgHR:       watchmap.IntToFloat(r.AvgHR),
			MaxHR:       watchmap.IntToFloat(r.MaxHR),
			AvgPowerW:   watchmap.IntToFloat(r.AvgPower),
		})
	}
	return out
}

// parseHealthDay parses a daily_health.date (Shanghai-local, "YYYYMMDD" or
// "YYYY-MM-DD") into a UTC-midnight civil day.
func parseHealthDay(s string) (time.Time, bool) {
	s = strings.ReplaceAll(strings.TrimSpace(s), "-", "")
	if len(s) < 8 {
		return time.Time{}, false
	}
	t, err := time.Parse("20060102", s[:8])
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
