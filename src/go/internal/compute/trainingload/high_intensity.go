package trainingload

import "math"

const (
	hiSpeedSmoothingSeconds  = 20.0
	hiWorkIF                 = 1.05
	hiMinWorkSeconds         = 60.0
	hiRecoveryIF             = 0.90
	hiRecoveryHRIF           = 0.85
	hiRecoveryWindowSeconds  = 120.0
	hiArmWindowSeconds       = 240.0
	hiRecoveryWeight         = 50.0
	hiSeverityWeight         = 100.0
	hiSeverityExponent       = 4.0
	hiMaxTSSPerHour          = 75.0
)

type highIntensityResult struct {
	tss        *float64
	reasons    []string
	confidence LoadConfidence
	coverage   float64
}

// computeHighIntensityTSS mirrors core._compute_high_intensity_tss: an EPOC-style
// supplement from post-work recovery HR after sustained supra-threshold bouts.
func computeHighIntensityTSS(a ActivityInput, cal CalibrationSnapshot) highIntensityResult {
	if len(a.Samples) == 0 {
		return highIntensityResult{reasons: []string{"high_intensity_samples_missing"}, confidence: ConfidenceNone}
	}
	if !isRunning(a.Sport) {
		return highIntensityResult{reasons: []string{"high_intensity_not_supported_for_sport"}, confidence: ConfidenceNone}
	}
	if cal.RHRBaseline == nil || cal.HRMaxEstimate == nil || *cal.HRMaxEstimate <= *cal.RHRBaseline ||
		cal.ThresholdHR == nil || cal.ThresholdSpeedMps == nil || *cal.ThresholdSpeedMps <= 0 {
		return highIntensityResult{reasons: []string{"high_intensity_calibration_missing"}, confidence: ConfidenceNone}
	}
	rhr := *cal.RHRBaseline
	hrmax := *cal.HRMaxEstimate
	thresholdSpeed := *cal.ThresholdSpeedMps
	thresholdHRR := (*cal.ThresholdHR - rhr) / (hrmax - rhr)
	if thresholdHRR <= 0 {
		return highIntensityResult{reasons: []string{"high_intensity_calibration_invalid"}, confidence: ConfidenceNone}
	}
	durationMin, ok := durationMinutes(a)
	if !ok || durationMin <= 0 {
		return highIntensityResult{reasons: []string{"duration_missing"}, confidence: ConfidenceNone}
	}

	cleanHR := cleanHRValues(a.Samples)
	coveredSeconds := 0.0
	thresholdHRSeconds := 0.0
	recoveryResidualTSS := 0.0
	var smoothedIf *float64
	peakSmoothedIf := 0.0
	recoveryArmed := false
	workSeconds := 0.0
	recoverySeconds := 0.0
	armedSeconds := 0.0

	reset := func() {
		recoveryArmed = false
		workSeconds = 0.0
		recoverySeconds = 0.0
		armedSeconds = 0.0
		smoothedIf = nil
	}

	for _, iv := range positiveSampleIntervals(a.Samples) {
		deltaS := iv.delta
		if deltaS > 300.0 {
			reset()
			continue
		}
		hr := cleanHR[iv.index]
		speed := a.Samples[iv.index].SpeedMps
		if hr == nil || speed == nil || *speed <= 0 {
			if recoveryArmed {
				armedSeconds += deltaS
				if armedSeconds >= hiArmWindowSeconds {
					reset()
				}
			} else {
				workSeconds = math.Max(0.0, workSeconds-2.0*deltaS)
			}
			continue
		}
		coveredSeconds += deltaS

		hrr := clamp((*hr-rhr)/(hrmax-rhr), 0.0, 1.05)
		hrIf := hrr / thresholdHRR
		rawSpeedIf := clamp(*speed/thresholdSpeed, 0.0, 2.0)
		alpha := 1.0 - math.Exp(-deltaS/hiSpeedSmoothingSeconds)
		if smoothedIf == nil {
			v := rawSpeedIf
			smoothedIf = &v
		} else {
			v := *smoothedIf + alpha*(rawSpeedIf-*smoothedIf)
			smoothedIf = &v
		}
		peakSmoothedIf = math.Max(peakSmoothedIf, *smoothedIf)
		if hrIf >= 1.0 {
			thresholdHRSeconds += deltaS
		}

		isObservedWork := *smoothedIf >= hiWorkIF && rawSpeedIf >= hiWorkIF
		if isObservedWork {
			workSeconds += deltaS
			recoverySeconds = 0.0
			armedSeconds = 0.0
			if workSeconds >= hiMinWorkSeconds {
				recoveryArmed = true
			}
		} else if recoveryArmed {
			armedSeconds += deltaS
			if *smoothedIf <= hiRecoveryIF {
				recoverySeconds += deltaS
				recoveryResidualTSS += 100.0 * deltaS / 3600.0 * math.Max(hrIf-hiRecoveryHRIF, 0.0)
			} else {
				recoverySeconds = 0.0
			}
			if recoverySeconds >= hiRecoveryWindowSeconds || armedSeconds >= hiArmWindowSeconds || hrIf < hiRecoveryHRIF {
				recoveryArmed = false
				workSeconds = 0.0
				recoverySeconds = 0.0
				armedSeconds = 0.0
			}
		} else if !recoveryArmed {
			workSeconds = 0.0
		}
	}

	coverage := clamp(coveredSeconds/(durationMin*60.0), 0.0, 1.0)
	confidence := confidenceForCoverage(coverage)
	if coverage < 0.8 {
		return highIntensityResult{reasons: []string{"high_intensity_low_coverage"}, confidence: confidence, coverage: round4(coverage)}
	}
	if recoveryResidualTSS <= 0 {
		zero := 0.0
		return highIntensityResult{tss: &zero, confidence: confidence, coverage: round4(coverage)}
	}

	peakExcess := math.Max(peakSmoothedIf-1.0, 0.0)
	thresholdHRMinutes := thresholdHRSeconds / 60.0
	supplement := recoveryResidualTSS * (hiRecoveryWeight + hiSeverityWeight*math.Pow(peakExcess, hiSeverityExponent)*thresholdHRMinutes)
	supplement = math.Min(supplement, hiMaxTSSPerHour*coveredSeconds/3600.0)
	s := round4(supplement)
	return highIntensityResult{tss: &s, confidence: confidence, coverage: round4(coverage)}
}
