package trainingload

// cardio.go ports core._compute_cardio_load: provider-neutral internal load from
// a Banister-style TRIMP over HR-reserve dwells, normalised so one hour at LTHR
// scores 100 (cardio TSS).

type cardioResult struct {
	raw        *float64
	tss        *float64
	reasons    []string
	confidence LoadConfidence
	coverage   float64
}

func computeCardioLoad(a ActivityInput, cal CalibrationSnapshot) cardioResult {
	if len(a.Samples) == 0 {
		return cardioResult{reasons: []string{"heart_rate_missing"}, confidence: ConfidenceNone}
	}
	if cal.RHRBaseline == nil || cal.HRMaxEstimate == nil || *cal.HRMaxEstimate <= *cal.RHRBaseline {
		return cardioResult{reasons: []string{"hr_calibration_missing"}, confidence: ConfidenceNone}
	}
	rhr := *cal.RHRBaseline
	hrmax := *cal.HRMaxEstimate

	cleanHR := cleanHRValues(a.Samples)
	hasValid := false
	for _, hr := range cleanHR {
		if hr != nil {
			hasValid = true
			break
		}
	}
	if !hasValid {
		return cardioResult{reasons: []string{"heart_rate_missing"}, confidence: ConfidenceNone}
	}

	raw := 0.0
	coveredMinutes := 0.0
	sampledMinutes := 0.0
	for _, iv := range validSampleIntervals(a.Samples, 300.0) {
		minutes := iv.delta / 60.0
		sampledMinutes += minutes
		hr := cleanHR[iv.index]
		if hr == nil || minutes <= 0 {
			continue
		}
		coveredMinutes += minutes
		hrr := clamp((*hr-rhr)/(hrmax-rhr), 0.0, 1.05)
		raw += banisterTrimp(hrr, minutes)
	}

	durationMin, ok := durationMinutes(a)
	if !ok {
		durationMin = sampledMinutes
	}
	coverage := 0.0
	if durationMin > 0 {
		coverage = clamp(coveredMinutes/durationMin, 0.0, 1.0)
	}
	confidence := confidenceForCoverage(coverage)
	var reasons []string
	if coverage < 0.8 {
		reasons = append(reasons, "heart_rate_low_coverage")
	}

	rawRounded := round4(raw)
	covRounded := round4(coverage)

	if cal.ThresholdHR == nil {
		reasons = append(reasons, "threshold_hr_missing")
		return cardioResult{raw: &rawRounded, reasons: reasons, confidence: confidence, coverage: covRounded}
	}
	thresholdHRR := (*cal.ThresholdHR - rhr) / (hrmax - rhr)
	if thresholdHRR <= 0 {
		reasons = append(reasons, "threshold_hr_invalid")
		return cardioResult{raw: &rawRounded, reasons: reasons, confidence: confidence, coverage: covRounded}
	}
	thresholdTrimp1h := banisterTrimp(clamp(thresholdHRR, 0.0, 1.05), 60.0)
	if thresholdTrimp1h <= 0 {
		reasons = append(reasons, "threshold_hr_invalid")
		return cardioResult{raw: &rawRounded, reasons: reasons, confidence: confidence, coverage: covRounded}
	}
	cardioTSS := round4(100.0 * raw / thresholdTrimp1h)
	return cardioResult{raw: &rawRounded, tss: &cardioTSS, reasons: reasons, confidence: confidence, coverage: covRounded}
}
