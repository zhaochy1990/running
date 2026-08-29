package ability

// ComputeL4Composite mirrors ability.compute_l4_composite. l3 is keyed by the
// six L4 dimension names → score (float64). Dimensions missing from the map are
// skipped (their weight is renormalized).
func ComputeL4Composite(l3 map[string]float64) float64 {
	total := 0.0
	wsum := 0.0
	for k, w := range L4Weights {
		v, ok := l3[k]
		if !ok {
			continue
		}
		total += v * w
		wsum += w
	}
	if wsum <= 0 {
		return 0.0
	}
	return round2(total / wsum * sumWeights(L4Weights))
}

// estimateMarathonTimeS mirrors ability.estimate_marathon_time_s. l3 carries the
// "vo2max_used_vdot" key produced by ComputeL3Vo2Max; falls back to the inverse
// anchor from the "vo2max" score.
func estimateMarathonTimeS(l3 map[string]any) *int {
	vdot := extractVdot(l3)
	if vdot == nil || *vdot <= 0 {
		return nil
	}
	baseS := vdotToMarathonS(*vdot)
	if baseS == nil {
		return nil
	}
	// Endurance correction: <70 → +2%, >85 → −2%, linear between.
	if e, ok := l3["endurance"].(float64); ok {
		var factor float64
		switch {
		case e <= 70:
			factor = 1.02
		case e >= 85:
			factor = 0.98
		default:
			factor = 1.02 - (e-70)/(85-70)*0.04
		}
		*baseS = *baseS * factor
	}
	v := roundToInt(*baseS)
	return &v
}

// estimateHalfMarathonTimeS mirrors ability.estimate_half_marathon_time_s.
func estimateHalfMarathonTimeS(l3 map[string]any) *int {
	vdot := extractVdot(l3)
	if vdot == nil || *vdot <= 0 {
		return nil
	}
	baseS := vdotToHalfMarathonS(*vdot)
	if baseS == nil {
		return nil
	}
	if e, ok := l3["endurance"].(float64); ok {
		var factor float64
		switch {
		case e <= 70:
			factor = 1.01
		case e >= 85:
			factor = 0.99
		default:
			factor = 1.01 - (e-70)/(85-70)*0.02
		}
		*baseS = *baseS * factor
	}
	v := roundToInt(*baseS)
	return &v
}

// ComputeContribution mirrors ability.compute_contribution.
func ComputeContribution(priorL3, posteriorL3 map[string]float64) map[string]float64 {
	out := map[string]float64{}
	for k := range L4Weights {
		p, pok := priorL3[k]
		q, qok := posteriorL3[k]
		if !pok || !qok {
			out[k] = 0.0
			continue
		}
		out[k] = round2(q - p)
	}
	return out
}

// scaledBoost mirrors ability._scaled_boost.
func scaledBoost(trainingS, maxBoost, floorS, rangeS float64) float64 {
	if trainingS <= 0 || trainingS <= floorS {
		return 0.0
	}
	progress := mathMin(1.0, (trainingS-floorS)/rangeS)
	return maxBoost * progress
}

// extractVdot returns the VDOT from l3 (the "vo2max_used_vdot" key, else the
// inverse anchor of the "vo2max" score). Mirrors estimate_*_time_s.
func extractVdot(l3 map[string]any) *float64 {
	if v, ok := l3["vo2max_used_vdot"].(float64); ok && v > 0 {
		return &v
	}
	if v, ok := l3["vo2max"].(float64); ok && v > 0 {
		w := VO2MaxReferenceVDOT + (v-VO2MaxScoreAtRef)/VO2MaxPointsPerVDOT
		return &w
	}
	return nil
}

func sumWeights(m map[string]float64) float64 {
	s := 0.0
	for _, v := range m {
		s += v
	}
	return s
}

func mathMin(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}
