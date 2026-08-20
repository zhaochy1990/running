package trainingload

import "math"

const externalNormalizationExponent = 6.0

func seriesCount(samples []Sample, get func(Sample) *float64) int {
	n := 0
	for _, s := range samples {
		if get(s) != nil {
			n++
		}
	}
	return n
}

// distanceWindowGrade mirrors core._distance_window_grade (reference per-index).
func distanceWindowGrade(samples []Sample, index int) *float64 {
	cur := samples[index]
	if cur.DistanceM == nil || cur.AltitudeM == nil {
		return nil
	}
	lo, hi := index, index
	for lo > 0 {
		other := samples[lo-1]
		if other.DistanceM == nil || *cur.DistanceM-*other.DistanceM > 50 {
			break
		}
		lo--
	}
	for hi < len(samples)-1 {
		other := samples[hi+1]
		if other.DistanceM == nil || *other.DistanceM-*cur.DistanceM > 50 {
			break
		}
		hi++
	}
	first, last := samples[lo], samples[hi]
	if first.DistanceM == nil || last.DistanceM == nil || first.AltitudeM == nil || last.AltitudeM == nil {
		return nil
	}
	dist := *last.DistanceM - *first.DistanceM
	if dist < 20 {
		return nil
	}
	g := clamp((*last.AltitudeM-*first.AltitudeM)/dist, -0.2, 0.2)
	return &g
}

// precomputeGrades mirrors core._precompute_grades (O(n) two-pointer, with the
// exact reference fallback for non-monotonic distance traces).
func precomputeGrades(samples []Sample) []*float64 {
	n := len(samples)
	if n == 0 {
		return nil
	}
	var present []float64
	for _, s := range samples {
		if s.DistanceM != nil {
			present = append(present, *s.DistanceM)
		}
	}
	for i := 1; i < len(present); i++ {
		if present[i] < present[i-1] {
			out := make([]*float64, n)
			for i := 0; i < n; i++ {
				out[i] = distanceWindowGrade(samples, i)
			}
			return out
		}
	}

	result := make([]*float64, n)
	L, R := 0, 0
	for i := 0; i < n; i++ {
		curDist := samples[i].DistanceM
		curAlt := samples[i].AltitudeM
		if curDist == nil {
			L = i + 1
			R = i
			continue
		}
		if curAlt == nil {
			continue
		}
		for L < i {
			prevDist := samples[L].DistanceM
			if prevDist == nil {
				L++
				continue
			}
			if *curDist-*prevDist > 50 {
				L++
				continue
			}
			break
		}
		if R < i {
			R = i
		}
		for R < n-1 {
			nextDist := samples[R+1].DistanceM
			if nextDist == nil || *nextDist-*curDist > 50 {
				break
			}
			R++
		}
		first, last := samples[L], samples[R]
		if first.DistanceM == nil || last.DistanceM == nil || first.AltitudeM == nil || last.AltitudeM == nil {
			continue
		}
		dist := *last.DistanceM - *first.DistanceM
		if dist < 20 {
			continue
		}
		g := clamp((*last.AltitudeM-*first.AltitudeM)/dist, -0.2, 0.2)
		result[i] = &g
	}
	return result
}

func gradeAdjustedSpeed(speed float64, grade *float64) float64 {
	if grade == nil {
		return speed
	}
	factor := math.Max(0.7, 1.0+3.0**grade)
	factor = math.Min(1.5, factor)
	return math.Max(0.0, speed*factor)
}

type externalResult struct {
	tss          *float64
	reasons      []string
	confidence   LoadConfidence
	normalizedIf *float64
	coverage     float64
}

// computeExternalTSS mirrors core._compute_external_tss: grade-adjusted pace TSS.
func computeExternalTSS(a ActivityInput, cal CalibrationSnapshot) externalResult {
	samples := a.Samples
	if len(samples) == 0 {
		return externalResult{reasons: []string{"external_samples_missing"}, confidence: ConfidenceNone}
	}
	if !isRunning(a.Sport) {
		return externalResult{reasons: []string{"external_not_supported_for_sport"}, confidence: ConfidenceNone}
	}
	useSpeed := cal.ThresholdSpeedMps != nil && *cal.ThresholdSpeedMps > 0
	if !useSpeed {
		return externalResult{reasons: []string{"external_calibration_missing"}, confidence: ConfidenceNone}
	}
	durationMin, ok := durationMinutes(a)
	if !ok || durationMin <= 0 {
		return externalResult{reasons: []string{"duration_missing"}, confidence: ConfidenceNone}
	}
	altitudePresent := float64(seriesCount(samples, func(s Sample) *float64 { return s.AltitudeM }))/float64(len(samples)) >= 0.8
	distancePresent := float64(seriesCount(samples, func(s Sample) *float64 { return s.DistanceM }))/float64(len(samples)) >= 0.8
	gradeOK := altitudePresent && distancePresent
	var reasons []string
	if !gradeOK {
		reasons = append(reasons, "grade_unavailable_flat_speed")
	}

	weightedIfPower := 0.0
	coveredSeconds := 0.0
	var grades []*float64
	if gradeOK {
		grades = precomputeGrades(samples)
	}
	thr := *cal.ThresholdSpeedMps
	for _, iv := range validSampleIntervals(samples, 300.0) {
		speed := samples[iv.index].SpeedMps
		if speed == nil || *speed <= 0 {
			continue
		}
		var grade *float64
		if grades != nil {
			grade = grades[iv.index]
		}
		adjusted := gradeAdjustedSpeed(*speed, grade)
		intensity := clamp(adjusted/thr, 0.0, 2.0)
		weightedIfPower += iv.delta * math.Pow(intensity, externalNormalizationExponent)
		coveredSeconds += iv.delta
	}
	if coveredSeconds <= 0 {
		reasons = append(reasons, "external_samples_missing")
		return externalResult{reasons: reasons, confidence: ConfidenceNone}
	}
	normalizedIf := math.Pow(weightedIfPower/coveredSeconds, 1.0/externalNormalizationExponent)
	tss := 100.0 * (coveredSeconds / 3600.0) * normalizedIf * normalizedIf
	coverage := clamp(coveredSeconds/(durationMin*60.0), 0.0, 1.0)
	confidence := confidenceForCoverage(coverage)
	if coverage < 0.8 {
		reasons = append(reasons, "external_low_coverage")
	}
	tssR := round4(tss)
	nifR := round4(normalizedIf)
	return externalResult{tss: &tssR, reasons: reasons, confidence: confidence, normalizedIf: &nifR, coverage: round4(coverage)}
}
