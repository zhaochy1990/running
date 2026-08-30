package ability

import (
	"math"

	"github.com/zhaochy1990/stride/internal/normalize"
)

// ─── Aerobic ────────────────────────────────────────────────────────────────

// ComputeL3Aerobic mirrors ability.compute_l3_aerobic. targetHR defaults to
// AerobicTargetHR when 0.
func ComputeL3Aerobic(activities []Activity, targetHR int) (float64, []string, map[string]any) {
	if targetHR == 0 {
		targetHR = AerobicTargetHR
	}
	var (
		bestPace  *float64
		bestLabel string
		qualCount int
	)
	for i := range activities {
		a := &activities[i]
		if !isRunning(a) {
			continue
		}
		tk := string(resolveTrainKind(a))
		if aerobicExcludedTrainKinds[tk] {
			continue
		}
		hr := a.AvgHR
		maxHR := a.MaxHR
		pace := a.AvgPaceSKm
		dist := a.DistanceM
		if pace == nil || hr == nil {
			continue
		}
		distKm := dstToKm(dist, float64(a.SportType))
		if distKm < AerobicMinDistanceKM {
			continue
		}
		if abs(float64(*hr)-float64(targetHR)) > AerobicHRTolerance {
			continue
		}
		if maxHR != nil && float64(*maxHR) > float64(targetHR)+AerobicMaxPeakHRAboveTarget {
			continue
		}
		if (tk == "" || tk == string(normalize.TrainUnknown)) && looksLikeIntervalSession(a.Laps) {
			continue
		}
		qualCount++
		p := *pace
		if bestPace == nil || p < *bestPace {
			bestPace = &p
			bestLabel = "" // reset on every pace improvement (Python sets None)
			if a.LabelID != "" {
				bestLabel = a.LabelID
			}
		}
	}
	if bestPace == nil {
		return 0.0, []string{}, map[string]any{"best_pace_s_km": nil, "n_runs": 0}
	}
	score := clamp(AerobicScoreBase+(AerobicAnchorPaceSKm-*bestPace)*AerobicPointsPerSec, 0, 100)
	ev := []string{}
	if bestLabel != "" {
		ev = append(ev, bestLabel)
	}
	return round2(score), ev, map[string]any{
		"best_pace_s_km": roundN(*bestPace, 1),
		"n_runs":         qualCount,
	}
}

// looksLikeIntervalSession mirrors ability._looks_like_interval_session.
func looksLikeIntervalSession(laps []Lap) bool {
	if len(laps) < IntervalLapCountThreshold {
		return false
	}
	var dists []float64
	for _, lp := range laps {
		if isRestLap(lp) {
			continue
		}
		dKm := dstToKm(lp.DistanceM, 0)
		if dKm <= 0 {
			continue
		}
		if dKm > IntervalLapMaxKM {
			return false
		}
		dists = append(dists, dKm)
	}
	if len(dists) < IntervalLapCountThreshold {
		return false
	}
	m := mean(dists)
	if m <= 0 {
		return false
	}
	var variance float64
	for _, x := range dists {
		d := x - m
		variance += d * d
	}
	variance /= float64(len(dists))
	cv := math.Sqrt(variance) / m
	return cv <= IntervalLapUniformity
}

// ─── Lactate threshold ──────────────────────────────────────────────────────

// ComputeL3LT mirrors ability.compute_l3_lt.
func ComputeL3LT(activities []Activity) (float64, []string, map[string]any) {
	var (
		evidence    []string
		bestOverall *float64
	)
	for i := range activities {
		a := &activities[i]
		if !isRunning(a) {
			continue
		}
		if len(a.Laps) == 0 {
			continue
		}
		pace, _ := bestSustainedPaceSKm(a.Laps, LTMinDurationS, a.SportType)
		if pace == nil {
			continue
		}
		if bestOverall == nil || *pace < *bestOverall {
			bestOverall = pace
			evidence = []string{}
			if a.LabelID != "" {
				evidence = append(evidence, a.LabelID)
			}
		}
	}
	if bestOverall == nil {
		return 0.0, []string{}, map[string]any{"best_pace_s_km": nil}
	}
	score := clamp(80.0+(LTAnchorPaceSKm-*bestOverall)*LTPointsPerSec, 0, 100)
	return round2(score), evidence, map[string]any{"best_pace_s_km": roundN(*bestOverall, 1)}
}

// bestSustainedPaceSKm mirrors ability._best_sustained_pace_s_km.
func bestSustainedPaceSKm(laps []Lap, minSeconds float64, sportType int) (*float64, float64) {
	if len(laps) == 0 {
		return nil, 0
	}
	n := len(laps)
	durs := make([]float64, n)
	dists := make([]float64, n)
	isRest := make([]bool, n)
	// Legacy heuristic when sport unknown (Python sport_type None path): one
	// global km_scale over all dists, mirroring _best_sustained_pace_s_km.
	kmScale := false
	if sportType == 0 {
		allSmall := true
		anySet := false
		for _, lp := range laps {
			if lp.DistanceM > 0 {
				anySet = true
				if lp.DistanceM >= 200 {
					allSmall = false
					break
				}
			}
		}
		kmScale = anySet && allSmall
	}
	for i, lp := range laps {
		durs[i] = lp.DurationS
		if sportType != 0 {
			dists[i] = dstToKm(lp.DistanceM, float64(sportType))
		} else if kmScale {
			dists[i] = lp.DistanceM
		} else {
			dists[i] = lp.DistanceM / 1000.0
		}
		isRest[i] = isRestLap(lp)
	}
	var (
		bestPace *float64
		bestDur  float64
	)
	for i := 0; i < n; i++ {
		if isRest[i] {
			continue
		}
		dur := 0.0
		distKm := 0.0
		for j := i; j < n; j++ {
			if isRest[j] {
				break
			}
			dur += durs[j]
			distKm += dists[j]
			if dur >= minSeconds && distKm > 0 {
				pace := dur / distKm
				if bestPace == nil || pace < *bestPace {
					p := pace
					bestPace = &p
					bestDur = dur
				}
				break
			}
		}
	}
	return bestPace, bestDur
}

// ─── VO2max ─────────────────────────────────────────────────────────────────

type intervalRep struct{ distM, timeS float64 }

// extractIntervalReps mirrors ability._extract_interval_reps.
func extractIntervalReps(a *Activity) []intervalRep {
	var cleaned []Lap
	for _, lp := range a.Laps {
		if lp.DistanceM < 0.3 || lp.DurationS < 60 {
			continue
		}
		cleaned = append(cleaned, lp)
	}
	var candidates []Lap
	var type2Work []Lap
	for _, lp := range cleaned {
		if lp.LapType == "type2" && (lp.ExerciseType == nil || *lp.ExerciseType == 2) {
			type2Work = append(type2Work, lp)
		}
	}
	if len(type2Work) > 0 {
		candidates = type2Work
	} else {
		candidates = cleaned
	}
	var reps []intervalRep
	for _, lp := range candidates {
		if lp.ExerciseType != nil && *lp.ExerciseType != 2 {
			continue
		}
		d := lp.DistanceM
		t := lp.DurationS
		if t <= 0 {
			continue
		}
		dM := d // _distance_to_meters returns metres as-is
		if dM < VO2MaxIntervalMinDistM {
			continue
		}
		reps = append(reps, intervalRep{dM, t})
	}
	return reps
}

// ComputeL3Vo2Max mirrors ability.compute_l3_vo2max.
func ComputeL3Vo2Max(activities []Activity, health7d []HealthRow, hrMax int, pbs []Vo2MaxPB, todayISO string) (float64, []string, map[string]any) {
	if hrMax <= 0 {
		hrMax = 0
	}

	// Primary: Daniels VDOT from best interval set / race-like effort.
	bestVdot := 0.0
	var bestEvidence []string
	for i := range activities {
		a := &activities[i]
		if !isRunning(a) {
			continue
		}
		reps := extractIntervalReps(a)
		if len(reps) >= VO2MaxIntervalMinReps {
			var totalD, totalT float64
			for _, r := range reps {
				totalD += r.distM
				totalT += r.timeS
			}
			vdot := danielsVdot(totalD, totalT)
			if vdot > bestVdot {
				bestVdot = vdot
				bestEvidence = []string{}
				if a.LabelID != "" {
					bestEvidence = append(bestEvidence, a.LabelID)
				}
			}
		}
		distM := a.DistanceM
		durS := a.DurationS
		distNorm := distM
		tk := string(resolveTrainKind(a))
		var lapsForRace []Lap = a.Laps
		hasRestSegment := false
		for _, lp := range lapsForRace {
			if lp.ExerciseType != nil && (*lp.ExerciseType == 1 || *lp.ExerciseType == 3) {
				continue // ignore warmup/cooldown
			}
			if isRestLap(lp) {
				hasRestSegment = true
				break
			}
		}
		isRaceLike := (4800 <= distNorm && distNorm <= 21500) &&
			durS > 0 &&
			!hasRestSegment &&
			(tk == "" || tk == string(normalize.TrainUnknown) || intervalLikeKinds[tk] || durS < 3600)
		if isRaceLike {
			vdot := danielsVdot(distNorm, durS)
			if vdot > bestVdot {
				bestVdot = vdot
				bestEvidence = []string{}
				if a.LabelID != "" {
					bestEvidence = append(bestEvidence, a.LabelID)
				}
			}
		}
	}
	vo2Primary := bestVdot

	// Secondary: HR-pace regression.
	vo2Secondary := vo2maxFromHRPace(activities, hrMax)

	// Floor: Uth-Sorensen from median RHR (last 7 days).
	var rhrVals []float64
	for _, r := range health7d {
		if r.RHR != nil {
			rhrVals = append(rhrVals, float64(*r.RHR))
		}
	}
	rhrMed := 0.0
	if len(rhrVals) > 0 {
		rhrMed = median(rhrVals)
	}
	vo2Floor := 0.0
	if rhrMed > 0 {
		vo2Floor = uthSorensenVO2Max(float64(hrMax), rhrMed)
	}

	secondaryQ := secondaryHRPaceQuality(activities, hrMax)
	secondaryEligible := vo2Secondary > 0 &&
		secondaryQ.nPoints >= SecondaryMinPoints &&
		secondaryQ.hrSpan >= SecondaryHRSpanMin &&
		secondaryQ.r2 >= SecondaryMinR2

	var floorRhrDays int
	for _, r := range health7d {
		if r.RHR != nil {
			floorRhrDays++
		}
	}
	floorEligible := vo2Floor > 0 && floorRhrDays >= FloorMinRHRDays

	primaryEligible := vo2Primary > 0

	var used, usedVdot float64
	source := "none"
	switch {
	case primaryEligible:
		used = vo2Primary
		usedVdot = vo2Primary
		source = "primary"
	case secondaryEligible:
		used = vo2Secondary
		usedVdot = vo2maxToVdotApprox(vo2Secondary)
		source = "secondary"
	case floorEligible:
		corrected := vo2Floor * UthSorensenCorrection
		used = corrected
		usedVdot = vo2maxToVdotApprox(corrected)
		source = "floor"
	default:
		used, source, usedVdot = 0.0, "none", 0.0
	}

	if usedVdot > 0 {
		usedVdot = clamp(usedVdot, VDOTClampMin, VDOTClampMax)
	} else {
		usedVdot = 0
	}

	// PB-memory floor.
	pbDecayed, pbLabel := bestDecayedPB(pbs, todayISO)
	if pbDecayed > usedVdot {
		usedVdot = clamp(pbDecayed, VDOTClampMin, VDOTClampMax)
		used = pbDecayed
		source = "pb_decayed"
		if pbLabel != "" {
			seen := false
			for _, e := range bestEvidence {
				if e == pbLabel {
					seen = true
					break
				}
			}
			if !seen {
				bestEvidence = append([]string{pbLabel}, bestEvidence...)
			}
		}
	}

	score := 0.0
	if usedVdot > 0 {
		score = clamp(VO2MaxScoreAtRef+(usedVdot-VO2MaxReferenceVDOT)*VO2MaxPointsPerVDOT, 0, 100)
	}

	details := map[string]any{
		"vo2max_primary":   optRound2(vo2Primary),
		"vo2max_secondary": optRound2(vo2Secondary),
		"vo2max_floor":     optRound2(vo2Floor),
		"vo2max_used":      optRound2(used),
		"vo2max_used_vdot": optRound2(usedVdot),
		"vo2max_source":    source,
		"hr_max_used":      hrMax,
		"vo2max_eligible": map[string]bool{
			"primary":   primaryEligible,
			"secondary": secondaryEligible,
			"floor":     floorEligible,
		},
		"vo2max_secondary_quality": map[string]any{
			"n_points": secondaryQ.nPoints,
			"hr_span":  roundN(secondaryQ.hrSpan, 1),
			"r2":       roundN(secondaryQ.r2, 3),
		},
		"vo2max_floor_rhr_days": floorRhrDays,
		"vo2max_pb_decayed":     optRound2(pbDecayed),
		"vo2max_pb_label":       nilIfEmpty(pbLabel),
	}
	return round2(score), bestEvidence, details
}

// vo2maxFromHRPace mirrors ability._vo2max_from_hr_pace.
func vo2maxFromHRPace(activities []Activity, hrMax int) float64 {
	lo := float64(hrMax) * EasyHRLowFactor
	hi := float64(hrMax) * EasyHRHighFactor
	var points [][2]float64
	for i := range activities {
		a := &activities[i]
		if !isRunning(a) {
			continue
		}
		if a.AvgHR == nil || a.AvgPaceSKm == nil {
			continue
		}
		hr := float64(*a.AvgHR)
		pace := *a.AvgPaceSKm
		if !(lo <= hr && hr <= hi) {
			continue
		}
		points = append(points, [2]float64{hr, pace})
	}
	if len(points) < 3 {
		return 0
	}
	slope, intercept, ok := linreg(points)
	if !ok {
		return 0
	}
	paceAtHRMax := slope*float64(hrMax) + intercept
	if paceAtHRMax <= 0 {
		return 0
	}
	return acsmRunningVO2(paceAtHRMax)
}

// vo2maxToVdotApprox mirrors ability._vo2max_to_vdot_approx.
func vo2maxToVdotApprox(vo2 float64) float64 {
	return vo2
}

// monthsBetween mirrors ability._months_between (30.44-day month). Negative →
// treated by callers as no decay; parse failure → +Inf so the age check drops it.
func monthsBetween(earlierISO, laterISO string) float64 {
	if earlierISO == "" || laterISO == "" {
		return math.Inf(1)
	}
	a, err1 := parseYMD(earlierISO)
	b, err2 := parseYMD(laterISO)
	if err1 != nil || err2 != nil {
		return math.Inf(1)
	}
	return float64(b.Sub(a).Hours()) / 24.0 / 30.4375
}

// decayedPBVdot mirrors ability._decayed_pb_vdot.
func decayedPBVdot(pbVdot float64, pbDateISO, todayISO string) float64 {
	if pbVdot <= 0 {
		return 0
	}
	months := monthsBetween(pbDateISO, todayISO)
	if months <= 0 {
		return pbVdot
	}
	if months > PBMaxAgeMonths {
		return 0
	}
	return pbVdot * (1.0 - PBDecayPctPerMonth*months)
}

// bestDecayedPB mirrors ability._best_decayed_pb.
func bestDecayedPB(pbs []Vo2MaxPB, todayISO string) (float64, string) {
	if len(pbs) == 0 || todayISO == "" {
		return 0.0, ""
	}
	bestVdot := 0.0
	bestLabel := ""
	for _, p := range pbs {
		if p.Vdot <= 0 || p.PBDate == "" {
			continue
		}
		decayed := decayedPBVdot(p.Vdot, p.PBDate, todayISO)
		if decayed > bestVdot {
			bestVdot = decayed
			bestLabel = p.LabelID
		}
	}
	return bestVdot, bestLabel
}

type secondaryQual struct {
	nPoints int
	hrSpan  float64
	r2      float64
}

// secondaryHRPaceQuality mirrors ability._secondary_hr_pace_quality.
func secondaryHRPaceQuality(activities []Activity, hrMax int) secondaryQual {
	lo := float64(hrMax) * EasyHRLowFactor
	hi := float64(hrMax) * EasyHRHighFactor
	var points [][2]float64
	for i := range activities {
		a := &activities[i]
		if !isRunning(a) {
			continue
		}
		if a.AvgHR == nil || a.AvgPaceSKm == nil {
			continue
		}
		hr := float64(*a.AvgHR)
		pace := *a.AvgPaceSKm
		if !(lo <= hr && hr <= hi) {
			continue
		}
		points = append(points, [2]float64{hr, pace})
	}
	if len(points) < 2 {
		return secondaryQual{nPoints: len(points)}
	}
	hrs := make([]float64, len(points))
	paces := make([]float64, len(points))
	for i, p := range points {
		hrs[i] = p[0]
		paces[i] = p[1]
	}
	hrMin, hrMaxH := hrs[0], hrs[0]
	for _, h := range hrs {
		if h < hrMin {
			hrMin = h
		}
		if h > hrMaxH {
			hrMaxH = h
		}
	}
	hrSpan := hrMaxH - hrMin
	slope, intercept, ok := linreg(points)
	if !ok {
		return secondaryQual{nPoints: len(points), hrSpan: hrSpan, r2: 0}
	}
	meanPace := mean(paces)
	var ssTot float64
	for _, p := range paces {
		d := p - meanPace
		ssTot += d * d
	}
	if ssTot <= 0 {
		return secondaryQual{nPoints: len(points), hrSpan: hrSpan, r2: 1.0}
	}
	var ssRes float64
	for i := range points {
		pred := slope*hrs[i] + intercept
		d := paces[i] - pred
		ssRes += d * d
	}
	r2 := 1.0 - (ssRes / ssTot)
	r2 = clamp(r2, 0, 1)
	return secondaryQual{nPoints: len(points), hrSpan: hrSpan, r2: r2}
}

// ─── Endurance ──────────────────────────────────────────────────────────────

// ComputeL3Endurance mirrors ability.compute_l3_endurance.
func ComputeL3Endurance(activities []Activity) (float64, []string, map[string]any) {
	var (
		evidence  []string
		bestKM    = 0.0
		bestDrift = 0.0
	)
	for i := range activities {
		a := &activities[i]
		if !isRunning(a) {
			continue
		}
		dist := a.DistanceM
		distKm := dstToKm(dist, float64(a.SportType))
		if distKm < EnduranceMinDistanceKM {
			continue
		}
		if distKm <= bestKM {
			continue
		}
		drift := 0.0
		if len(a.Samples) > 0 || len(a.Laps) > 0 {
			drift = computeHRDecoupling(a.Samples, a.Laps)
		}
		bestKM = distKm
		bestDrift = drift
		evidence = []string{}
		if a.LabelID != "" {
			evidence = append(evidence, a.LabelID)
		}
	}
	if bestKM == 0 {
		return 0.0, []string{}, map[string]any{"longest_km": nil, "drift": nil}
	}
	score := 80.0 + (bestKM-EnduranceAnchorKM)*EndurancePointsPerKM
	if bestDrift > 0.08 {
		score -= EnduranceDriftPenalty
	}
	score = clamp(score, 0, 100)
	return round2(score), evidence, map[string]any{
		"longest_km": roundN(bestKM, 1),
		"drift":      roundN(bestDrift, 4),
	}
}

// ─── Economy ───────────────────────────────────────────────────────────────

// ComputeL3Economy mirrors ability.compute_l3_economy.
func ComputeL3Economy(activities []Activity) (float64, []string, map[string]any) {
	var evidence []string
	var cadences []float64
	for i := range activities {
		a := &activities[i]
		if !isRunning(a) {
			continue
		}
		laps := dedupeAndFilterLaps(a.Laps)
		took := false
		for _, lp := range laps {
			if lp.AvgPace == nil || lp.AvgCadence == nil {
				continue
			}
			if 280 <= *lp.AvgPace && *lp.AvgPace <= 300 {
				cadences = append(cadences, float64(*lp.AvgCadence))
				took = true
			}
		}
		if took && a.LabelID != "" {
			evidence = append(evidence, a.LabelID)
		}
	}
	if len(cadences) == 0 {
		return 0.0, []string{}, map[string]any{"median_cadence": nil}
	}
	med := median(cadences)
	score := clamp(80.0+(med-EconomyAnchorCadence)*EconomyPointsPerSPM, 0, 100)
	return round2(score), evidence, map[string]any{"median_cadence": roundN(med, 1)}
}

// ─── Recovery ───────────────────────────────────────────────────────────────

// ComputeL3Recovery mirrors ability.compute_l3_recovery.
func ComputeL3Recovery(l2Totals7d []float64) (float64, []string, map[string]any) {
	var vals []float64
	for _, v := range l2Totals7d {
		vals = append(vals, v)
	}
	if len(vals) == 0 {
		return 50.0, []string{}, map[string]any{"n_days": 0}
	}
	avg := mean(vals)
	return round2(clamp(avg, 0, 100)), []string{}, map[string]any{"n_days": len(vals)}
}

// optRound2 returns a rounded-two-decimal float, or nil for 0/absent.
func optRound2(x float64) any {
	if x <= 0 {
		return nil
	}
	return round2(x)
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
