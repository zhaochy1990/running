package trainingload

import "math"

// computeMechanicalLoad mirrors core._compute_mechanical_load.
func computeMechanicalLoad(a ActivityInput, normalizedIf *float64) *float64 {
	if a.DistanceM == nil || *a.DistanceM <= 0 {
		return nil
	}
	distanceKm := *a.DistanceM / 1000.0
	if distanceKm <= 0 {
		return nil
	}
	ascent := 0.0
	if a.AscentM != nil {
		ascent = *a.AscentM
	}
	descent := 0.0
	if a.DescentM != nil {
		descent = *a.DescentM
	}
	ascentPerKm := math.Max(0.0, ascent/distanceKm)
	descentPerKm := math.Max(0.0, descent/distanceKm)
	gradeFactor := math.Min(1.5, 1.0+0.006*ascentPerKm)
	descentFactor := math.Min(1.4, 1.0+0.004*math.Max(0.0, descentPerKm-20.0))
	intensity := 0.75
	if normalizedIf != nil {
		intensity = *normalizedIf
	}
	intensityFactor := math.Min(1.4, 1.0+0.5*math.Pow(math.Max(0.0, intensity-0.85), 2))
	v := round4(distanceKm * gradeFactor * descentFactor * intensityFactor)
	return &v
}

func confidenceFromParts(parts ...LoadConfidence) LoadConfidence {
	var usable []LoadConfidence
	for _, p := range parts {
		if p != ConfidenceNone {
			usable = append(usable, p)
		}
	}
	if len(usable) == 0 {
		return ConfidenceNone
	}
	for _, p := range usable {
		if p == ConfidenceLow {
			return ConfidenceLow
		}
	}
	for _, p := range usable {
		if p == ConfidenceMedium {
			return ConfidenceMedium
		}
	}
	return ConfidenceHigh
}

// dedupeReasons preserves first-seen order (Python dict.fromkeys).
func dedupeReasons(reasons []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, r := range reasons {
		if !seen[r] {
			seen[r] = true
			out = append(out, r)
		}
	}
	return out
}

// ComputeActivityLoad mirrors core.compute_activity_load: fuse the channels into
// one PMC training dose.
func ComputeActivityLoad(a ActivityInput, cal CalibrationSnapshot) ActivityLoadResult {
	durMin, hasDur := durationMinutes(a)
	var subjective *float64
	if a.RPE != nil && hasDur {
		v := float64(*a.RPE) * durMin
		subjective = &v
	}

	cardio := computeCardioLoad(a, cal)
	external := computeExternalTSS(a, cal)
	hi := computeHighIntensityTSS(a, cal)
	mechanical := computeMechanicalLoad(a, external.normalizedIf)

	reasons := append([]string{}, cardio.reasons...)
	for _, r := range external.reasons {
		if r != "grade_unavailable_flat_speed" {
			reasons = append(reasons, r)
		}
	}
	reasons = append(reasons, hi.reasons...)

	var trainingDose *float64
	var trainingDoseSource *string
	confidence := ConfidenceNone

	setSource := func(s string) *string { return &s }

	switch {
	case cardio.tss != nil && external.tss != nil && cardio.coverage >= 0.8 && external.coverage >= 0.8:
		dose := math.Min(*cardio.tss, *external.tss)
		src := "conservative_fusion"
		confidence = confidenceFromParts(cardio.confidence, external.confidence)
		if hi.tss != nil && hi.coverage >= 0.8 {
			dose += *hi.tss
			if *hi.tss > 0 {
				src = "conservative_fusion+high_intensity"
			}
			confidence = confidenceFromParts(confidence, hi.confidence)
		}
		trainingDose = &dose
		trainingDoseSource = setSource(src)
	case cardio.tss != nil && cardio.coverage >= 0.8:
		d := *cardio.tss
		trainingDose = &d
		trainingDoseSource = setSource("cardio")
		confidence = cardio.confidence
	case external.tss != nil && external.coverage >= 0.8:
		d := *external.tss
		trainingDose = &d
		trainingDoseSource = setSource("external")
		confidence = external.confidence
	case cardio.tss != nil || external.tss != nil:
		reasons = append(reasons, "objective_load_partial_coverage")
	}

	if trainingDose == nil {
		reasons = append(reasons, "no_tss_like_objective_load")
	}

	var durMinPtr *float64
	if hasDur {
		v := round4(durMin)
		durMinPtr = &v
	}

	return ActivityLoadResult{
		LabelID:                a.LabelID,
		ActivityDate:           a.ActivityDate,
		Sport:                  a.Sport,
		SessionClass:           a.SessionClass,
		DurationMinutes:        durMinPtr,
		AlgorithmVersion:       ModelVersion,
		CalibrationID:          cal.ID,
		CardioLoadRaw:          cardio.raw,
		CardioTSS:              cardio.tss,
		ExternalTSS:            external.tss,
		HighIntensityTSS:       hi.tss,
		MechanicalLoad:         mechanical,
		SubjectiveInternalLoad: round4Ptr(subjective),
		TrainingDose:           round4Ptr(trainingDose),
		TrainingDoseSource:     trainingDoseSource,
		CardioCoverage:         cardio.coverage,
		ExternalCoverage:       external.coverage,
		HighIntensityCoverage:  hi.coverage,
		CoverageStatus:         coverageStatus(cardio.coverage, external.coverage),
		LoadConfidence:         confidence,
		ExcludedFromPMC:        trainingDose == nil,
		Reasons:                dedupeReasons(reasons),
	}
}
