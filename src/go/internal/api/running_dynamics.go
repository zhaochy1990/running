package api

import (
	"math"
	"slices"

	"github.com/zhaochy1990/stride/internal/storage"
)

const dynamicsWindowSeconds = 90

type runningDynamicsDTO struct {
	DurationS float64                          `json:"duration_s"`
	WindowS   int                              `json:"window_s"`
	Metrics   map[string]runningDynamicsMetric `json:"metrics"`
}

type runningDynamicsMetric struct {
	Average float64                `json:"average"`
	Min     float64                `json:"min"`
	Max     float64                `json:"max"`
	Windows []runningDynamicsRange `json:"windows"`
}

type runningDynamicsRange struct {
	Index int     `json:"index"`
	Min   float64 `json:"min"`
	Max   float64 `json:"max"`
}

type dynamicsSample struct {
	elapsed float64
	value   float64
}

// buildRunningDynamics works on the full stored series. Its time base is the
// first timestamp (both providers store centiseconds, with different origins).
func buildRunningDynamics(points []storage.TimeseriesPoint, activity *storage.Activity) *runningDynamicsDTO {
	timed := make([]storage.TimeseriesPoint, 0, len(points))
	for _, point := range points {
		if point.Timestamp != nil && *point.Timestamp >= 0 {
			timed = append(timed, point)
		}
	}
	if len(timed) == 0 {
		return nil
	}
	slices.SortStableFunc(timed, func(a, b storage.TimeseriesPoint) int {
		if *a.Timestamp < *b.Timestamp {
			return -1
		}
		if *a.Timestamp > *b.Timestamp {
			return 1
		}
		return 0
	})
	origin := *timed[0].Timestamp
	duration := float64(*timed[len(timed)-1].Timestamp-origin) / 100
	if recordedDuration := activity.DurationS; recordedDuration != nil && !math.IsInf(*recordedDuration, 0) && *recordedDuration > duration {
		duration = *recordedDuration
	}
	if duration <= 0 {
		return nil
	}

	result := &runningDynamicsDTO{DurationS: duration, WindowS: dynamicsWindowSeconds, Metrics: make(map[string]runningDynamicsMetric)}
	oscillationDivisor := 10.0
	if activity.Provider == "garmin" {
		// Garmin Connect supplies centimetres. The historical shared storage
		// field is named for COROS's millimetres but stores the Garmin value as-is.
		oscillationDivisor = 1
	}
	fields := []struct {
		key         string
		filterEdges bool
		read        func(storage.TimeseriesPoint) float64
	}{
		{"cadence", false, func(p storage.TimeseriesPoint) float64 {
			if p.Cadence == nil {
				return 0
			}
			return float64(*p.Cadence)
		}},
		{"stride_length", false, func(p storage.TimeseriesPoint) float64 { return dynamicsValue(p.CadenceLengthCm) / 100 }},
		{"vertical_oscillation", true, func(p storage.TimeseriesPoint) float64 {
			return dynamicsValue(p.VerticalOscillationMm) / oscillationDivisor
		}},
		{"ground_contact_time", true, func(p storage.TimeseriesPoint) float64 { return dynamicsValue(p.GroundContactTimeMs) }},
	}
	for _, field := range fields {
		samples := make([]dynamicsSample, 0, len(timed))
		for _, point := range timed {
			value := field.read(point)
			if value > 0 && !math.IsInf(value, 0) {
				samples = append(samples, dynamicsSample{float64(*point.Timestamp-origin) / 100, value})
			}
		}
		if len(samples) > 0 {
			if field.key == "cadence" && activity.Provider == "garmin" {
				normalizeGarminDynamicsCadence(samples, activity.AvgCadence)
			}
			result.Metrics[field.key] = aggregateDynamics(samples, duration, field.filterEdges)
		}
	}
	if len(result.Metrics) == 0 {
		return nil
	}
	return result
}

func dynamicsValue(value *float64) float64 {
	if value == nil {
		return 0
	}
	return *value
}

// Older Garmin series can contain one-foot cycles. The Garmin activity
// summary is already in steps/min and distinguishes these from total cadence.
func normalizeGarminDynamicsCadence(samples []dynamicsSample, averageSteps *int) {
	if averageSteps == nil || *averageSteps <= 0 {
		return
	}
	var sum float64
	for _, sample := range samples {
		sum += sample.value
	}
	ratio := sum / float64(len(samples)) / float64(*averageSteps)
	if ratio >= 0.45 && ratio <= 0.55 {
		for i := range samples {
			samples[i].value *= 2
		}
	}
}

func aggregateDynamics(samples []dynamicsSample, duration float64, filterEdges bool) runningDynamicsMetric {
	result := runningDynamicsMetric{Min: math.Inf(1)}
	lastWindow := int(math.Ceil(duration/dynamicsWindowSeconds)) - 1
	var sum float64
	for i, sample := range samples {
		// The activity average uses all valid samples. Filtering changes the
		// plotted ranges and their bounds, as in the approved prototype.
		sum += sample.value
		if filterEdges && isDynamicsEdgeSpike(samples, i, duration) {
			continue
		}
		index := min(int(sample.elapsed/dynamicsWindowSeconds), lastWindow)
		last := len(result.Windows) - 1
		if last < 0 || result.Windows[last].Index != index {
			result.Windows = append(result.Windows, runningDynamicsRange{index, sample.value, sample.value})
		} else {
			window := &result.Windows[last]
			window.Min = min(window.Min, sample.value)
			window.Max = max(window.Max, sample.value)
		}
		result.Min = min(result.Min, sample.value)
		result.Max = max(result.Max, sample.value)
	}
	result.Average = sum / float64(len(samples))
	return result
}

// A point within 15 seconds of either edge must differ by at least 25%
// from at least three nearby, mutually consistent readings to be excluded.
func isDynamicsEdgeSpike(samples []dynamicsSample, index int, duration float64) bool {
	point := samples[index]
	if min(point.elapsed, duration-point.elapsed) > 15 {
		return false
	}
	var neighbors [6]float64
	n := 0
	for i := max(0, index-3); i < min(len(samples), index+4); i++ {
		if i != index && math.Abs(samples[i].elapsed-point.elapsed) <= 4 {
			neighbors[n] = samples[i].value
			n++
		}
	}
	if n < 3 {
		return false
	}
	slices.Sort(neighbors[:n])
	baseline := (neighbors[(n-1)/2] + neighbors[n/2]) / 2
	return neighbors[n-1]-neighbors[0] <= baseline*0.10 && math.Abs(point.value-baseline) >= baseline*0.25
}
