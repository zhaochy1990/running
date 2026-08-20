package calibration

import (
	"math"
	"sort"
	"time"
)

const (
	thresholdHRHRMaxLowRatio         = 0.82
	thresholdHRHRMaxHighRatio        = 0.94
	thresholdSpeedModelMinDurationS  = 20 * 60
	thresholdSpeedLongAnchorS        = 45 * 60
	thresholdSpeedLongAnchorCapRatio = 1.02
	thresholdSpeedRiegelExponent     = 0.06
	shortCircuitMaxAgeDays           = 60
)

// EstimateRunningCalibration mirrors core.estimate_running_calibration: the
// top-level assembly of the calibration snapshot from a running-activity history
// and daily-RHR rows. Evidence rows are not built (deferred; diagnostic only).
func EstimateRunningCalibration(history []Activity, asOf time.Time, health []HealthRow) Snapshot {
	recent := make([]Activity, 0, len(history))
	windowStart := asOf.AddDate(0, 0, -180)
	for _, a := range history {
		if inClosedRange(a.ActivityDate, windowStart, asOf) {
			recent = append(recent, a)
		}
	}

	hrmax := EstimateHRMaxProfile(recent)

	speedCandidates := BestSpeedCandidates(recent, BestEffortDurationsS)
	thresholdSpeed, speedConfidence, sdModel := estimateThresholdSpeed(speedCandidates, asOf)

	thresholdHR := (*float64)(nil)
	hrConfidence := ConfidenceNone
	if thresholdSpeed != nil {
		hrCandidates := StableThresholdHrCandidates(recent, *thresholdSpeed)
		thresholdHR, hrConfidence = estimateThresholdHR(hrCandidates, hrmax.EstimatedHRMax, hrmax.Confidence)
	}

	rhr := EstimateRHRBaseline(health, asOf)
	cp, _ := EstimateCriticalPower(history, asOf)

	return Snapshot{
		AsOfDate:                 asOf,
		ThresholdHR:              round4(thresholdHR),
		ThresholdSpeedMps:        round4(thresholdSpeed),
		ThresholdHRConfidence:    hrConfidence,
		ThresholdSpeedConfidence: speedConfidence,
		RHRBaseline:              round4(rhr),
		ObservedMaxHR:            round4(hrmax.ObservedMaxHR),
		HRMaxEstimate:            round4(hrmax.EstimatedHRMax),
		HRMaxConfidence:          hrmax.Confidence,
		HighHRReference:          round4(hrmax.HighHRReference),
		CriticalPowerW:           round4(cp),
		CriticalSpeedMps:         sdModel.CriticalSpeedMps,
		DPrimeM:                  sdModel.DPrimeM,
		RiegelK:                  sdModel.RiegelK,
		EnduranceIndex:           sdModel.EnduranceIndex,
		SpeedIndex:               sdModel.SpeedIndex,
		SpeedDurationConfidence:  sdModel.Confidence,
		AlgorithmVersion:         ModelVersion,
	}
}

// buildBestByDuration mirrors the bucketing in core._estimate_threshold_speed:
// each candidate maps to the nearest best-effort duration; keep the fastest.
func buildBestByDuration(candidates []SpeedCandidate) map[float64]SpeedCandidate {
	best := map[float64]SpeedCandidate{}
	for _, c := range candidates {
		bucket := nearestBucket(c.DurationS)
		existing, ok := best[bucket]
		if !ok || c.AvgSpeedMps > existing.AvgSpeedMps {
			best[bucket] = c
		}
	}
	return best
}

func nearestBucket(duration float64) float64 {
	bucket := float64(BestEffortDurationsS[0])
	bestDiff := math.Abs(bucket - duration)
	for _, d := range BestEffortDurationsS[1:] {
		diff := math.Abs(float64(d) - duration)
		if diff < bestDiff {
			bestDiff = diff
			bucket = float64(d)
		}
	}
	return bucket
}

func estimateThresholdSpeed(candidates []SpeedCandidate, asOf time.Time) (*float64, Confidence, SpeedDurationModel) {
	if len(candidates) == 0 {
		return nil, ConfidenceNone, emptyModel()
	}
	best := buildBestByDuration(candidates)
	model := fitSpeedDurationModel(best, asOf)
	exponent := riegelExponent(model)

	if b60, ok := best[float64(60*60)]; ok {
		age := dayDiff(asOf, b60.Activity.ActivityDate)
		if b60.Confidence == ConfidenceHigh && b60.Source == "timeseries" && age <= shortCircuitMaxAgeDays {
			v := b60.AvgSpeedMps
			return &v, ConfidenceHigh, model
		}
	}

	if len(best) >= 2 {
		if modelSpeed := thresholdSpeedModel(best, asOf, exponent); modelSpeed != nil {
			conf := ConfidenceMedium
			if hasLongHighQuality(best, asOf) {
				conf = ConfidenceHigh
			}
			return modelSpeed, conf, model
		}
	}

	var longest SpeedCandidate
	first := true
	for _, c := range best {
		if first || c.DurationS > longest.DurationS {
			longest = c
			first = false
		}
	}
	if longest.DurationS >= 20*60 {
		adjusted := riegelThresholdProjection(longest, exponent)
		conf := ConfidenceLow
		if longest.DurationS >= 30*60 {
			conf = ConfidenceMedium
		}
		return &adjusted, conf, model
	}
	return nil, ConfidenceNone, model
}

func riegelExponent(model SpeedDurationModel) float64 {
	if model.RiegelK != nil && (model.Confidence == ConfidenceHigh || model.Confidence == ConfidenceMedium) {
		return *model.RiegelK
	}
	return thresholdSpeedRiegelExponent
}

func hasLongHighQuality(best map[float64]SpeedCandidate, asOf time.Time) bool {
	for d, c := range best {
		if d >= 45*60 && c.Confidence == ConfidenceHigh && dayDiff(asOf, c.Activity.ActivityDate) <= shortCircuitMaxAgeDays {
			return true
		}
	}
	return false
}

func criticalSpeedCurve(best map[float64]SpeedCandidate, exponent float64) *float64 {
	type pt struct{ x, y float64 }
	pts := make([]pt, 0, len(best))
	for d, c := range best {
		pts = append(pts, pt{d, c.AvgSpeedMps * d})
	}
	if len(pts) < 2 {
		return nil
	}
	sort.Slice(pts, func(i, j int) bool { return pts[i].x < pts[j].x })
	var xBar, yBar float64
	for _, p := range pts {
		xBar += p.x
		yBar += p.y
	}
	xBar /= float64(len(pts))
	yBar /= float64(len(pts))
	denom := 0.0
	for _, p := range pts {
		denom += (p.x - xBar) * (p.x - xBar)
	}
	if denom <= 0 {
		return nil
	}
	num := 0.0
	for _, p := range pts {
		num += (p.x - xBar) * (p.y - yBar)
	}
	slope := num / denom
	if math.IsInf(slope, 0) || math.IsNaN(slope) || slope <= 0 {
		return nil
	}
	maxSpeed := 0.0
	for _, c := range best {
		if c.AvgSpeedMps > maxSpeed {
			maxSpeed = c.AvgSpeedMps
		}
	}
	if slope > maxSpeed {
		return nil
	}
	var longest SpeedCandidate
	firstLong := true
	for _, c := range best {
		if firstLong || c.DurationS > longest.DurationS {
			longest = c
			firstLong = false
		}
	}
	projected := riegelThresholdProjection(longest, exponent)
	v := math.Min(projected, math.Max(slope, 0.9*projected))
	return &v
}

type speedProjection struct {
	value    float64
	weight   float64
	duration float64
	age      int
}

func thresholdSpeedModel(best map[float64]SpeedCandidate, asOf time.Time, exponent float64) *float64 {
	projections := thresholdSpeedProjections(best, asOf, exponent)
	if len(projections) > 0 {
		speed := weightedQuantile(projections, 0.75)
		var longAnchor *float64
		for _, p := range projections {
			if p.duration >= thresholdSpeedLongAnchorS && p.age <= shortCircuitMaxAgeDays {
				if longAnchor == nil || p.value > *longAnchor {
					v := p.value
					longAnchor = &v
				}
			}
		}
		if speed != nil && longAnchor != nil {
			m := math.Min(*speed, *longAnchor*thresholdSpeedLongAnchorCapRatio)
			speed = &m
		}
		if speed != nil {
			curve := criticalSpeedCurve(best, exponent)
			if curve != nil {
				m := math.Max(*speed, *curve)
				return &m
			}
			return speed
		}
	}
	return criticalSpeedCurve(best, exponent)
}

func thresholdSpeedProjections(best map[float64]SpeedCandidate, asOf time.Time, exponent float64) []speedProjection {
	// Deterministic order (sorted bucket) for reproducible weighted-quantile sums.
	buckets := make([]float64, 0, len(best))
	for d := range best {
		buckets = append(buckets, d)
	}
	sort.Float64s(buckets)
	var out []speedProjection
	for _, d := range buckets {
		c := best[d]
		if c.DurationS < thresholdSpeedModelMinDurationS {
			continue
		}
		speed := riegelThresholdProjection(c, exponent)
		if math.IsInf(speed, 0) || math.IsNaN(speed) || speed <= 0 {
			continue
		}
		weight := candidateWeight(c, asOf)
		age := dayDiff(asOf, c.Activity.ActivityDate)
		if age < 0 {
			age = 0
		}
		out = append(out, speedProjection{speed, weight, c.DurationS, age})
	}
	return out
}

func riegelThresholdProjection(c SpeedCandidate, exponent float64) float64 {
	duration := math.Max(c.DurationS, 1.0)
	return c.AvgSpeedMps * math.Pow(duration/(60*60), exponent)
}

func weightedQuantile(values []speedProjection, quantile float64) *float64 {
	if len(values) == 0 {
		return nil
	}
	type vw struct{ v, w float64 }
	ordered := make([]vw, len(values))
	for i, p := range values {
		ordered[i] = vw{p.value, math.Max(0.0, p.weight)}
	}
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].v < ordered[j].v })
	total := 0.0
	for _, o := range ordered {
		total += o.w
	}
	if total <= 0 {
		vals := make([]float64, len(ordered))
		for i, o := range ordered {
			vals[i] = o.v
		}
		m := medianFloat(vals)
		return &m
	}
	target := total * math.Max(0.0, math.Min(1.0, quantile))
	acc := 0.0
	for _, o := range ordered {
		acc += o.w
		if acc >= target {
			v := o.v
			return &v
		}
	}
	v := ordered[len(ordered)-1].v
	return &v
}

func estimateThresholdHR(candidates []ThresholdHrCandidate, hrmaxEstimate *float64, hrmaxConfidence Confidence) (*float64, Confidence) {
	if len(candidates) == 0 {
		return nil, ConfidenceNone
	}
	candidates = filterHRMaxPlausible(candidates, hrmaxEstimate, hrmaxConfidence)
	if len(candidates) == 0 {
		return nil, ConfidenceNone
	}
	candidates = filterHROutliers(candidates)
	if len(candidates) == 0 {
		return nil, ConfidenceNone
	}
	var weights [][2]float64
	for _, c := range candidates {
		weight := c.DurationS / 60.0
		if c.Confidence == ConfidenceHigh {
			weight *= 1.5
		}
		weights = append(weights, [2]float64{c.AvgHR, weight})
	}
	value := weightedMedian(weights)
	highCount := 0
	for _, c := range candidates {
		if c.Confidence == ConfidenceHigh {
			highCount++
		}
	}
	conf := ConfidenceMedium
	if highCount >= 1 {
		conf = ConfidenceHigh
	}
	return value, conf
}

func filterHRMaxPlausible(candidates []ThresholdHrCandidate, hrmaxEstimate *float64, hrmaxConfidence Confidence) []ThresholdHrCandidate {
	if hrmaxEstimate == nil || *hrmaxEstimate <= 0 || hrmaxConfidence == ConfidenceNone {
		return candidates
	}
	low := thresholdHRHRMaxLowRatio * *hrmaxEstimate
	high := thresholdHRHRMaxHighRatio * *hrmaxEstimate
	var aboveLow []ThresholdHrCandidate
	for _, c := range candidates {
		if c.AvgHR >= low {
			aboveLow = append(aboveLow, c)
		}
	}
	if len(aboveLow) == 0 {
		return nil
	}
	var withinBand []ThresholdHrCandidate
	for _, c := range aboveLow {
		if c.AvgHR <= high {
			withinBand = append(withinBand, c)
		}
	}
	if len(withinBand) > 0 {
		return withinBand
	}
	return aboveLow
}

func filterHROutliers(candidates []ThresholdHrCandidate) []ThresholdHrCandidate {
	if len(candidates) < 3 {
		return candidates
	}
	hrs := make([]float64, len(candidates))
	for i, c := range candidates {
		hrs[i] = c.AvgHR
	}
	med := medianFloat(hrs)
	devs := make([]float64, len(hrs))
	for i, hr := range hrs {
		devs[i] = math.Abs(hr - med)
	}
	mad := medianFloat(devs)
	threshold := math.Max(8.0, 2.5*math.Max(1.4826*mad, 3.0))
	var filtered []ThresholdHrCandidate
	for _, c := range candidates {
		if math.Abs(c.AvgHR-med) <= threshold {
			filtered = append(filtered, c)
		}
	}
	if len(filtered) > 0 {
		return filtered
	}
	return candidates
}
