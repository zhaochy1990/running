// Package watchmap holds the shared watch-row -> domain unit conversions used by
// every compute reader (calibration, training load, ability): the Go equivalent
// of the Python connector normalisers (speed m/s, centisecond elapsed, distance
// scale, sport derivation). Single source so the conversions can never drift
// between compute slices (ADR 0015). Shanghai-day bucketing lives in
// internal/utils/timefmt (ADR 0022).
package watchmap

import (
	"math"
	"strings"

	"github.com/zhaochy1990/stride/internal/storage"
)

// AsSpeedMps mirrors connector._as_speed_mps: nil/<=0 -> nil; 1000/speed when
// the raw value looks like sec/km pace (>20), else already m/s.
func AsSpeedMps(value *float64) *float64 {
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

// AsActivityDistanceMeters mirrors connector._as_activity_distance_meters.
func AsActivityDistanceMeters(value *float64) *float64 {
	if value == nil || *value <= 0 {
		return nil
	}
	v := *value
	return &v
}

// NormalizeElapsedSeconds mirrors connector._normalize_elapsed_seconds: the raw
// timestamp column is centiseconds; epoch-scale first values (>1e6) are made
// relative. Result rounded to 4 decimals.
func NormalizeElapsedSeconds(rows []storage.TimeseriesPoint) []*float64 {
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

// DistanceScale mirrors connector._distance_scale_for_timeseries.
func DistanceScale(rows []storage.TimeseriesPoint, activityDistanceM *float64, provider string) float64 {
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

// SportFromRow mirrors connector._sport_from_row: prefer the sport string, else
// derive from the COROS sport_type integer.
func SportFromRow(sport *string, sportType int) string {
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

// IsRunningSport reports whether a sport string is a running variant.
func IsRunningSport(sport string) bool {
	s := strings.ToLower(sport)
	return s == "run" || strings.HasPrefix(s, "run_") || strings.HasPrefix(s, "running")
}

// IntToFloat converts a nullable int column to a nullable float.
func IntToFloat(v *int) *float64 {
	if v == nil {
		return nil
	}
	f := float64(*v)
	return &f
}
