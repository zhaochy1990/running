// Package calibrationsource is the Go equivalent of the Python calibration
// connector (stride_storage/sqlite/calibration_connector.py): it reads the
// synced watch tables and maps them into the infra-free calibration domain
// types, applying the exact unit conversions (speed m/s, elapsed centiseconds,
// distance scale, sport derivation, Shanghai-day) so the Go compute sees byte-
// identical inputs to Python. Keeping the conversions here keeps the calibration
// math package pure (ADR 0013).
package calibrationsource

import (
	"context"
	"math"
	"strings"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/storage"
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
		sport := sportFromRow(a.Sport, a.SportType)
		if !isRunningSport(sport) {
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
		distanceM := asActivityDistanceMeters(a.DistanceM)
		history = append(history, calibration.Activity{
			LabelID:      a.LabelID,
			ActivityDate: shanghaiDay(a.Date),
			Sport:        sport,
			DurationS:    a.DurationS,
			DistanceM:    distanceM,
			AvgHR:        intToFloat(a.AvgHR),
			MaxHR:        intToFloat(a.MaxHR),
			AvgPowerW:    intToFloat(a.AvgPower),
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
		health = append(health, calibration.HealthRow{Date: d, RHR: intToFloat(h.RHR)})
	}
	return history, health, nil
}

func mapSamples(rows []storage.TimeseriesPoint, activityDistanceM *float64, provider string) []calibration.Sample {
	if len(rows) == 0 {
		return nil
	}
	elapsed := normalizeElapsedSeconds(rows)
	scale := distanceScale(rows, activityDistanceM, provider)
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
			HeartRateBpm: intToFloat(r.HeartRate),
			SpeedMps:     asSpeedMps(r.Speed),
			PowerW:       intToFloat(r.Power),
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
			DistanceM:   asActivityDistanceMeters(r.DistanceM),
			DurationS:   r.DurationS,
			AvgSpeedMps: asSpeedMps(r.AvgPace),
			AvgHR:       intToFloat(r.AvgHR),
			MaxHR:       intToFloat(r.MaxHR),
			AvgPowerW:   intToFloat(r.AvgPower),
		})
	}
	return out
}

// asSpeedMps mirrors connector._as_speed_mps: nil/<=0 -> nil; 1000/speed when
// the raw value looks like sec/km pace (>20), else already m/s.
func asSpeedMps(value *float64) *float64 {
	if value == nil {
		return nil
	}
	speed := *value
	if speed <= 0 {
		return nil
	}
	if speed > 20 {
		v := 1000.0 / speed
		return &v
	}
	v := speed
	return &v
}

// asActivityDistanceMeters mirrors connector._as_activity_distance_meters.
func asActivityDistanceMeters(value *float64) *float64 {
	if value == nil || *value <= 0 {
		return nil
	}
	v := *value
	return &v
}

// normalizeElapsedSeconds mirrors connector._normalize_elapsed_seconds: the raw
// timestamp column is centiseconds; epoch-scale first values (>1e6) are made
// relative. Result rounded to 4 decimals.
func normalizeElapsedSeconds(rows []storage.TimeseriesPoint) []*float64 {
	out := make([]*float64, len(rows))
	var first float64
	haveFirst := false
	for _, r := range rows {
		if r.Timestamp != nil {
			first = float64(*r.Timestamp)
			haveFirst = true
			break
		}
	}
	if !haveFirst {
		return out
	}
	isEpochCentiseconds := first > 1_000_000
	for i, r := range rows {
		if r.Timestamp == nil {
			continue
		}
		v := float64(*r.Timestamp)
		var elapsed float64
		if isEpochCentiseconds {
			elapsed = (v - first) / 100.0
		} else {
			elapsed = v / 100.0
		}
		elapsed = math.Round(elapsed*1e4) / 1e4
		e := elapsed
		out[i] = &e
	}
	return out
}

// distanceScale mirrors connector._distance_scale_for_timeseries.
func distanceScale(rows []storage.TimeseriesPoint, activityDistanceM *float64, provider string) float64 {
	var maxDistance float64
	found := false
	for _, r := range rows {
		if r.Distance != nil && *r.Distance > 0 {
			if !found || *r.Distance > maxDistance {
				maxDistance = *r.Distance
			}
			found = true
		}
	}
	if !found {
		return 1.0
	}
	if activityDistanceM != nil && *activityDistanceM > 0 {
		if maxDistance/(*activityDistanceM) > 20.0 {
			return 0.01
		}
		return 1.0
	}
	if strings.ToLower(provider) == "coros" && maxDistance > 10_000 {
		return 0.01
	}
	return 1.0
}

// sportFromRow mirrors connector._sport_from_row: prefer the sport string, else
// derive from the COROS sport_type integer.
func sportFromRow(sport *string, sportType int) string {
	if sport != nil {
		if s := strings.TrimSpace(*sport); s != "" {
			return s
		}
	}
	switch sportType {
	case 100, 8001:
		return "run_outdoor"
	case 101, 104, 8002, 8003:
		return "run_indoor"
	case 102, 8005:
		return "run_trail"
	case 103, 8004:
		return "run_track"
	}
	return "unknown"
}

func isRunningSport(sport string) bool {
	s := strings.ToLower(sport)
	return s == "run" || strings.HasPrefix(s, "run_") || strings.HasPrefix(s, "running")
}

// shanghaiDay returns the Shanghai (UTC+8) civil day of a UTC instant, as a
// UTC-midnight time.Time so day arithmetic in the math package stays exact.
func shanghaiDay(utc time.Time) time.Time {
	sh := utc.UTC().Add(8 * time.Hour)
	return time.Date(sh.Year(), sh.Month(), sh.Day(), 0, 0, 0, 0, time.UTC)
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

func intToFloat(v *int) *float64 {
	if v == nil {
		return nil
	}
	f := float64(*v)
	return &f
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
