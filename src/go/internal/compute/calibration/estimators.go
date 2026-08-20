package calibration

import (
	"math"
	"sort"
	"time"
)

// Default windows, mirroring the Python estimator signatures.
const (
	rhrLookbackDays = 90
	rhrMinSamples   = 14
	cpLookbackDays  = 180

	minRunningPowerW = 50.0
	maxRunningPowerW = 1000.0
)

// EstimateRHRBaseline is the P10 of valid daily-RHR samples in the last 90 days,
// or nil when fewer than 14 valid rows fall in the window. Mirrors
// core.estimate_rhr_baseline.
func EstimateRHRBaseline(rows []HealthRow, asOf time.Time) *float64 {
	windowStart := asOf.AddDate(0, 0, -rhrLookbackDays)
	var values []float64
	for _, r := range rows {
		if r.RHR == nil {
			continue
		}
		v := *r.RHR
		if v <= 0 || !inClosedRange(r.Date, windowStart, asOf) {
			continue
		}
		values = append(values, v)
	}
	if len(values) < rhrMinSamples {
		return nil
	}
	sort.Float64s(values)
	idx := pyRound(float64(len(values)-1) * 0.10)
	if idx < 0 {
		idx = 0
	}
	if idx > len(values)-1 {
		idx = len(values) - 1
	}
	v := values[idx]
	return &v
}

func validRunningPower(v *float64) bool {
	if v == nil {
		return false
	}
	p := *v
	return minRunningPowerW <= p && p <= maxRunningPowerW
}

// EstimateCriticalPower is the median running-power proxy over the last 180 days
// (activity avg power + valid sample power), with the sample count. Mirrors
// core.estimate_critical_power.
func EstimateCriticalPower(history []Activity, asOf time.Time) (*float64, int) {
	windowStart := asOf.AddDate(0, 0, -cpLookbackDays)
	var values []float64
	for _, a := range history {
		if !inClosedRange(a.ActivityDate, windowStart, asOf) || !isRunning(a) {
			continue
		}
		if validRunningPower(a.AvgPowerW) {
			values = append(values, *a.AvgPowerW)
		}
		for _, s := range a.Samples {
			if validRunningPower(s.PowerW) {
				values = append(values, *s.PowerW)
			}
		}
	}
	if len(values) == 0 {
		return nil, 0
	}
	m := medianFloat(values)
	return &m, len(values)
}

// supportedTimeseriesHRValues mirrors core._supported_timeseries_hr_values: keep
// each in-band (80..230) HR sample that has a neighbor within 5 bpm in the
// preceding 2 / following 2 samples (rejects optical dropout spikes).
func supportedTimeseriesHRValues(a Activity) []float64 {
	hrs := make([]*float64, len(a.Samples))
	for i, s := range a.Samples {
		if s.HeartRateBpm != nil {
			v := *s.HeartRateBpm
			if 80 <= v && v <= 230 {
				vv := v
				hrs[i] = &vv
			}
		}
	}
	var out []float64
	for i, hr := range hrs {
		if hr == nil {
			continue
		}
		lo := i - 2
		if lo < 0 {
			lo = 0
		}
		hi := i + 3
		if hi > len(hrs) {
			hi = len(hrs)
		}
		supported := false
		for j := lo; j < i && !supported; j++ {
			if hrs[j] != nil && math.Abs(*hr-*hrs[j]) <= 5.0 {
				supported = true
			}
		}
		for j := i + 1; j < hi && !supported; j++ {
			if hrs[j] != nil && math.Abs(*hr-*hrs[j]) <= 5.0 {
				supported = true
			}
		}
		if supported {
			out = append(out, *hr)
		}
	}
	return out
}

// activityMaxHRSupported mirrors core._activity_max_hr_supported.
func activityMaxHRSupported(a Activity, supported []float64) bool {
	if a.MaxHR == nil {
		return false
	}
	mh := *a.MaxHR
	if !(80 <= mh && mh <= 230) {
		return false
	}
	if len(a.Samples) == 0 {
		return true
	}
	var rawHRs []float64
	for _, s := range a.Samples {
		if s.HeartRateBpm != nil {
			v := *s.HeartRateBpm
			if 80 <= v && v <= 230 {
				rawHRs = append(rawHRs, v)
			}
		}
	}
	if len(rawHRs) == 0 {
		return true
	}
	rawContainsSummaryMax := false
	for _, hr := range rawHRs {
		if math.Abs(mh-hr) <= 2.0 {
			rawContainsSummaryMax = true
			break
		}
	}
	if !rawContainsSummaryMax {
		return true
	}
	for _, hr := range supported {
		if math.Abs(mh-hr) <= 2.0 {
			return true
		}
	}
	return false
}

// EstimateHRMaxProfile mirrors core.estimate_hrmax_profile: observed max valid
// HR + a 98th-percentile reference, with a HIGH/MEDIUM/LOW confidence tier.
func EstimateHRMaxProfile(history []Activity) HrMaxProfile {
	type samp struct {
		hr      float64
		src     string
		labelID string
	}
	var samples []samp
	for _, a := range history {
		supported := supportedTimeseriesHRValues(a)
		if activityMaxHRSupported(a, supported) {
			samples = append(samples, samp{*a.MaxHR, "activity", a.LabelID})
		}
		for _, hr := range supported {
			samples = append(samples, samp{hr, "timeseries", a.LabelID})
		}
	}
	if len(samples) == 0 {
		return HrMaxProfile{Confidence: ConfidenceNone}
	}
	values := make([]float64, len(samples))
	for i := range samples {
		values[i] = samples[i].hr
	}
	sort.Float64s(values)
	observedMax := values[len(values)-1]
	highRef, _ := percentileSorted(values, 0.98)

	nearSet := map[string]struct{}{}
	hasTimeseriesMax := false
	hasActivityMax := false
	for _, s := range samples {
		if s.hr >= observedMax-3.0 {
			nearSet[s.labelID] = struct{}{}
		}
		if s.hr == observedMax {
			switch s.src {
			case "timeseries":
				hasTimeseriesMax = true
			case "activity":
				hasActivityMax = true
			}
		}
	}

	var confidence Confidence
	switch {
	case len(values) >= 100 && len(nearSet) >= 2:
		confidence = ConfidenceHigh
	case len(values) >= 20 && (hasTimeseriesMax || hasActivityMax):
		confidence = ConfidenceMedium
	default:
		confidence = ConfidenceLow
	}

	om := observedMax
	em := observedMax
	hr := highRef
	return HrMaxProfile{
		ObservedMaxHR:   &om,
		EstimatedHRMax:  &em,
		Confidence:      confidence,
		HighHRReference: &hr,
		SampleCount:     len(values),
	}
}
