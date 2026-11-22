package api

import (
	"cmp"
	"math"
	"slices"

	"github.com/zhaochy1990/stride/internal/compute/watchmap"
	"github.com/zhaochy1990/stride/internal/normalize"
	"github.com/zhaochy1990/stride/internal/storage"
)

const derivedKilometerLapType = "timeseriesKm"

type splitAverage struct {
	total, seconds float64
}

func (a *splitAverage) add(sample *int, seconds float64) {
	if sample != nil && *sample > 0 {
		a.total += float64(*sample) * seconds
		a.seconds += seconds
	}
}

func (a splitAverage) value() *int {
	if a.seconds == 0 {
		return nil
	}
	value := int(math.Round(a.total / a.seconds))
	return &value
}

// deriveKilometerSplits uses cumulative distance from the full, ordered stream.
// Boundaries between samples are interpolated, and recorded pauses are removed
// from split times. Incomplete streams and long gaps are left unavailable.
func deriveKilometerSplits(activity *storage.Activity, points []storage.TimeseriesPoint) []storage.Lap {
	pauses, err := normalize.ParsePauseIntervals(activity.Pauses)
	if err != nil {
		return nil
	}
	slices.SortFunc(pauses, func(a, b normalize.PauseInterval) int {
		return cmp.Compare(a.Start, b.Start)
	})
	var splits []storage.Lap
	var lastDistance, lastTime, duration float64
	var hr, cadence, power splitAverage
	var maxHR int
	var started bool

	finish := func(distance float64) {
		if duration <= 0 {
			return
		}
		pace := duration * 1000 / distance
		seconds := duration
		lap := storage.Lap{
			LapIndex: len(splits) + 1, LapType: derivedKilometerLapType,
			DistanceM: &distance, DurationS: &seconds, AvgPace: &pace,
			AvgHR: hr.value(), AvgCadence: cadence.value(), AvgPower: power.value(),
		}
		if maxHR > 0 {
			value := maxHR
			lap.MaxHR = &value
		}
		splits = append(splits, lap)
		duration, maxHR = 0, 0
		hr, cadence, power = splitAverage{}, splitAverage{}, splitAverage{}
	}

	record := func(point storage.TimeseriesPoint, seconds float64) {
		if seconds <= 0 {
			return
		}
		duration += seconds
		hr.add(point.HeartRate, seconds)
		cadence.add(point.Cadence, seconds)
		power.add(point.Power, seconds)
		if point.HeartRate != nil {
			maxHR = max(maxHR, *point.HeartRate)
		}
	}

	distanceScale := watchmap.DistanceScale(points, activity.DistanceM, activity.Provider)
	nextBoundary := 1000.0
	for _, point := range points {
		if point.Timestamp == nil || point.Distance == nil || !(*point.Distance >= 0) || math.IsInf(*point.Distance, 0) {
			continue
		}
		distance, timestamp := *point.Distance*distanceScale, float64(*point.Timestamp)
		if !started {
			if distance > 20 {
				return nil
			}
			started, lastTime = true, timestamp
			continue
		}
		if timestamp < lastTime || distance < lastDistance-10 || distance-lastDistance > 150 {
			return nil
		}
		distance = max(distance, lastDistance)
		if timestamp == lastTime {
			if distance != lastDistance {
				return nil
			}
			continue
		}
		moving := splitMovingSeconds(lastTime, timestamp, pauses)
		if moving > 30 {
			return nil
		}
		if distance >= nextBoundary {
			beforeBoundary := moving * (nextBoundary - lastDistance) / (distance - lastDistance)
			record(point, beforeBoundary)
			if duration <= 0 {
				return nil
			}
			finish(1000)
			nextBoundary += 1000
			moving -= beforeBoundary
		}
		record(point, moving)
		lastTime, lastDistance = timestamp, distance
	}
	if len(splits) == 0 || activity.DistanceM == nil ||
		math.Abs(lastDistance-*activity.DistanceM) > 20 {
		return nil
	}
	if remaining := lastDistance - (nextBoundary - 1000); remaining >= 1 {
		finish(remaining)
	}
	return splits
}

// Allow modest provider rounding, but reject a stream or device table that
// materially undershoots the last complete kilometer of the activity.
func coversKilometerDistance(actual, reported float64) bool {
	const toleranceM = 20
	return math.Abs(actual-reported) <= max(toleranceM, reported*0.01) &&
		actual+toleranceM >= math.Floor(reported/1000)*1000
}

// Use a cursor to count overlapping pause records only once.
func splitMovingSeconds(start, end float64, pauses []normalize.PauseInterval) float64 {
	moving := end - start
	cursor := start
	for _, pause := range pauses {
		lo, hi := max(cursor, float64(pause.Start)), min(end, float64(pause.End))
		if hi > lo {
			moving -= hi - lo
			cursor = hi
		}
	}
	return max(moving, 0) / 100
}
