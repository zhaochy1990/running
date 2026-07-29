package trainingload

import (
	"math"
	"strings"
)

var runningSports = map[string]bool{
	"run": true, "run_outdoor": true, "run_indoor": true,
	"run_trail": true, "run_track": true, "run_treadmill": true,
}

const cardioHRRExponent = 4.0

// isRunning mirrors core._is_running: membership OR "run_" prefix.
func isRunning(sport string) bool {
	s := strings.ToLower(sport)
	return runningSports[s] || strings.HasPrefix(s, "run_")
}

func clamp(v, low, high float64) float64 { return math.Max(low, math.Min(high, v)) }

// round4 mirrors core._round: round(v, 4).
func round4(v float64) float64 { return math.Round(v*1e4) / 1e4 }

func round4Ptr(v *float64) *float64 {
	if v == nil {
		return nil
	}
	r := round4(*v)
	return &r
}

func sampleTime(s Sample, index int) float64 {
	if s.ElapsedS != nil {
		return *s.ElapsedS
	}
	if s.TimestampS != nil {
		return *s.TimestampS
	}
	return float64(index)
}

func explicitSampleTime(s Sample) (float64, bool) {
	if s.ElapsedS != nil {
		return *s.ElapsedS, true
	}
	if s.TimestampS != nil {
		return *s.TimestampS, true
	}
	return 0, false
}

type interval struct {
	index int
	delta float64
}

func positiveSampleIntervals(samples []Sample) []interval {
	var out []interval
	for i := 1; i < len(samples); i++ {
		cur, cok := explicitSampleTime(samples[i])
		prev, pok := explicitSampleTime(samples[i-1])
		if !cok || !pok {
			continue
		}
		if d := cur - prev; d > 0 {
			out = append(out, interval{i, d})
		}
	}
	return out
}

func validSampleIntervals(samples []Sample, maxGapS float64) []interval {
	var out []interval
	for _, iv := range positiveSampleIntervals(samples) {
		if iv.delta <= maxGapS {
			out = append(out, iv)
		}
	}
	return out
}

func coverageStatus(coverages ...float64) CoverageStatus {
	cov := 0.0
	for _, c := range coverages {
		if c > cov {
			cov = c
		}
	}
	if cov >= 0.8 {
		return CoverageComplete
	}
	if cov > 0 {
		return CoveragePartial
	}
	return CoverageUnknown
}

func confidenceForCoverage(cov float64) LoadConfidence {
	switch {
	case cov >= 0.8:
		return ConfidenceHigh
	case cov >= 0.5:
		return ConfidenceMedium
	case cov > 0:
		return ConfidenceLow
	default:
		return ConfidenceNone
	}
}

// cleanHRValues mirrors core._clean_hr_values: keep in-band (30..230) HR, then
// drop lone spikes (>12 from both neighbours while neighbours agree).
func cleanHRValues(samples []Sample) []*float64 {
	raw := make([]*float64, len(samples))
	for i, s := range samples {
		if s.HeartRateBpm == nil {
			continue
		}
		hr := *s.HeartRateBpm
		if hr >= 30 && hr <= 230 {
			v := hr
			raw[i] = &v
		}
	}
	clean := make([]*float64, len(raw))
	copy(clean, raw)
	for i := 1; i < len(raw)-1; i++ {
		cur, prev, nxt := raw[i], raw[i-1], raw[i+1]
		if cur == nil || prev == nil || nxt == nil {
			continue
		}
		if math.Abs(*cur-*prev) > 12 && math.Abs(*cur-*nxt) > 12 && math.Abs(*prev-*nxt) <= 12 {
			clean[i] = nil
		}
	}
	return clean
}

func banisterTrimp(hrr, minutes float64) float64 {
	return minutes * hrr * math.Exp(cardioHRRExponent*hrr)
}

func durationMinutes(a ActivityInput) (float64, bool) {
	if a.DurationS != nil && *a.DurationS > 0 {
		return *a.DurationS / 60.0, true
	}
	if len(a.Samples) >= 2 {
		start := sampleTime(a.Samples[0], 0)
		end := sampleTime(a.Samples[len(a.Samples)-1], len(a.Samples)-1)
		if end > start {
			return (end - start) / 60.0, true
		}
	}
	return 0, false
}
