package ability

import "math"

// danielsVO2Required mirrors ability.daniels_vo2_required.
// VO2 = -4.60 + 0.1823·v + 0.000104·v² (v in m/min).
func danielsVO2Required(distanceM, timeS float64) float64 {
	if distanceM <= 0 || timeS <= 0 {
		return 0
	}
	v := distanceM / (timeS / 60.0) // m/min
	return -4.60 + 0.1823*v + 0.000104*v*v
}

// danielsPctVO2Max mirrors ability.daniels_pct_vo2max.
// %VO2max = 0.8 + 0.1894393·exp(-0.012778·T) + 0.2989558·exp(-0.1932605·T), T in min.
func danielsPctVO2Max(timeS float64) float64 {
	if timeS <= 0 {
		return 1.0
	}
	tMin := timeS / 60.0
	return 0.8 +
		0.1894393*math.Exp(-0.012778*tMin) +
		0.2989558*math.Exp(-0.1932605*tMin)
}

// danielsVdot mirrors ability.daniels_vdot.
func danielsVdot(distanceM, timeS float64) float64 {
	if distanceM <= 0 || timeS <= 0 {
		return 0
	}
	vo2Req := danielsVO2Required(distanceM, timeS)
	pct := danielsPctVO2Max(timeS)
	if pct <= 0 {
		return 0
	}
	return vo2Req / pct
}

// ComputePBVdotForSegment mirrors ability.compute_pb_vdot_for_segment. For
// "full" it uses the table reverse-lookup; other race types use the formula.
func ComputePBVdotForSegment(raceType string, distanceM, durationS float64) *float64 {
	if distanceM <= 0 || durationS <= 0 {
		return nil
	}
	if raceType == "full" {
		fastest, slowest := math.Inf(1), 0.0
		for _, v := range DanielsVDOTToMarathonS {
			if v < fastest {
				fastest = v
			}
			if v > slowest {
				slowest = v
			}
		}
		if durationS < fastest || durationS > slowest {
			return nil
		}
		vdot := marathonTimeToVdotTable(durationS)
		if vdot == nil {
			return nil
		}
		return vdot
	}
	vdot := danielsVdot(distanceM, durationS)
	if vdot <= 0 {
		return nil
	}
	f := vdot
	return &f
}

// acsmRunningVO2 mirrors ability.acsm_running_vo2.
func acsmRunningVO2(paceSKm float64) float64 {
	if paceSKm <= 0 {
		return 0
	}
	vMin := (1000.0 / paceSKm) * 60.0
	return 0.2*vMin + 3.5
}

// uthSorensenVO2Max mirrors ability.uth_sorensen_vo2max.
func uthSorensenVO2Max(hrMax, hrRest float64) float64 {
	if hrRest <= 0 || hrMax <= 0 {
		return 0
	}
	return 15.3 * hrMax / hrRest
}

// interpolateDanielsTable mirrors ability._interpolate_daniels_table. Linear
// interpolation over a VDOT(30..85)→seconds table. Returns nil outside range.
func interpolateDanielsTable(table map[float64]float64, vdot float64) *float64 {
	if vdot <= 0 {
		return nil
	}
	if vdot < 30 || vdot > 85 {
		return nil
	}
	lo := math.Floor(vdot/5) * 5
	hi := lo + 5
	if lo < 30 {
		lo, hi = 30, 35
	}
	if hi > 85 {
		lo, hi = 80, 85
	}
	loS := table[lo]
	hiS := table[hi]
	frac := 0.0
	if hi != lo {
		frac = (vdot - lo) / (hi - lo)
	}
	r := loS + frac*(hiS-loS)
	return &r
}

// vdotToMarathonS mirrors ability.vdot_to_marathon_s.
func vdotToMarathonS(vdot float64) *float64 {
	return interpolateDanielsTable(DanielsVDOTToMarathonS, vdot)
}

// vdotToHalfMarathonS mirrors ability.vdot_to_half_marathon_s.
func vdotToHalfMarathonS(vdot float64) *float64 {
	return interpolateDanielsTable(DanielsVDOTToHalfMarathonS, vdot)
}

// marathonTimeToVdotTable mirrors ability._marathon_time_to_vdot_table.
// Inverse lookup of the marathon table; interpolates the closest VDOT.
func marathonTimeToVdotTable(timeS float64) *float64 {
	if timeS <= 0 {
		return nil
	}
	table := DanielsVDOTToMarathonS
	vdots := sortedVdots(table)
	// Times decrease as VDOT increases; clamp outside range.
	if timeS >= table[vdots[0]] {
		v := vdots[0]
		return &v
	}
	if timeS <= table[vdots[len(vdots)-1]] {
		v := vdots[len(vdots)-1]
		return &v
	}
	for i := 0; i < len(vdots)-1; i++ {
		tLo := table[vdots[i]]
		tHi := table[vdots[i+1]] // tLo > tHi
		if tHi <= timeS && timeS <= tLo {
			frac := 0.0
			if tLo != tHi {
				frac = (tLo - timeS) / (tLo - tHi)
			}
			v := vdots[i] + frac*(vdots[i+1]-vdots[i])
			return &v
		}
	}
	return nil
}

// VdotFromScore mirrors routes.predictions._vdot_from_score: invert the L3
// VO2max scoring formula (score = SCORE_AT_REF + (vdot - REF)*POINTS), clamped to
// the Daniels VDOT range.
func VdotFromScore(score float64) float64 {
	vdot := VO2MaxReferenceVDOT + (score-VO2MaxScoreAtRef)/VO2MaxPointsPerVDOT
	return clamp(vdot, VDOTClampMin, VDOTClampMax)
}

func sortedVdots(table map[float64]float64) []float64 {
	keys := make([]float64, 0, len(table))
	for k := range table {
		keys = append(keys, k)
	}
	sortFloats(keys)
	return keys
}

// canonical race distances (m) used by the Daniels solver. Mirrors
// routes.predictions._DIST_M.
var distM = map[string]float64{
	"5K": 5000.0, "10K": 10000.0, "HM": 21097.5, "FM": 42195.0,
}

// search bounds (seconds) for the numerical VDOT→time solver. Mirrors
// routes.predictions._SOLVER_BOUNDS.
var solverBounds = map[string][2]float64{
	"5K": {600, 3600}, "10K": {1200, 7200}, "HM": {2400, 10800}, "FM": {5400, 21600},
}

// DanielsRaceTimeS mirrors routes.predictions._daniels_race_time_s: solve for the
// race time T such that pct(T)*vdot == vo2_required(distance,T). FM/HM use the
// interpolation tables; 5K/10K solve by bisection. Returns 0 on failure.
func DanielsRaceTimeS(distanceM, vdot float64) float64 {
	if vdot <= 0 || distanceM <= 0 {
		return 0
	}
	distKey := ""
	for k, v := range distM {
		if abs(v-distanceM) < 1 {
			distKey = k
			break
		}
	}
	if distKey == "FM" {
		r := vdotToMarathonS(vdot)
		if r == nil {
			return 0
		}
		return *r
	}
	if distKey == "HM" {
		r := vdotToHalfMarathonS(vdot)
		if r == nil {
			return 0
		}
		return *r
	}

	f := func(t float64) float64 {
		return danielsPctVO2Max(t)*vdot - danielsVO2Required(distanceM, t)
	}
	lo, hi := 600.0, 21600.0
	if b, ok := solverBounds[distKey]; ok {
		lo, hi = b[0], b[1]
	}
	fLo, fHi := f(lo), f(hi)
	if fLo*fHi > 0 {
		return 0
	}
	for i := 0; i < 60; i++ {
		mid := (lo + hi) / 2.0
		fMid := f(mid)
		if abs(fMid) < 1e-6 || (hi-lo) < 0.5 {
			return mid
		}
		if fLo*fMid < 0 {
			hi = mid
			fHi = fMid
		} else {
			lo = mid
			fLo = fMid
		}
	}
	return (lo + hi) / 2.0
}
