package ability

import (
	"github.com/zhaochy1990/stride/internal/normalize"
)

// PlanTarget is the optional per-activity plan target passed to ComputeL1Quality
// (mirrors ability's plan_target dict). Nil means "no plan target".
type PlanTarget struct {
	PaceSKm *float64
	HRLo    *int
	HRHi    *int
}

// isRunning mirrors ability._is_running: sport_type in RUN_SPORT_IDS (0/unknown
// treated as running, matching Python's None→True).
func isRunning(a *Activity) bool {
	if a.SportType == 0 {
		return true
	}
	return runSportIDs[a.SportType]
}

// resolveTrainKind mirrors ability._resolve_train_kind: prefer the normalized
// train_kind, else derive from the legacy train_type.
func resolveTrainKind(a *Activity) normalize.TrainKind {
	if a.TrainKind != "" && a.TrainKind != normalize.TrainUnknown {
		return a.TrainKind
	}
	if a.TrainType != nil && *a.TrainType != "" {
		if k, ok := normalize.KindFromLegacyTrainType(*a.TrainType); ok {
			return k
		}
	}
	return normalize.TrainUnknown
}

// ComputeL1Quality mirrors ability.compute_l1_quality.
func ComputeL1Quality(a *Activity, plan *PlanTarget, hrMax int) *L1Result {
	if a == nil {
		b := emptyL1Breakdown()
		return &L1Result{Total: 0, Breakdown: b, Evidence: []string{}}
	}

	trainKind := resolveTrainKind(a)
	tk := string(trainKind)
	avgHR := a.AvgHR
	avgPace := a.AvgPaceSKm
	laps := a.Laps
	samples := a.Samples

	var hrLo, hrHi int
	if plan != nil && plan.HRLo != nil && plan.HRHi != nil {
		hrLo, hrHi = *plan.HRLo, *plan.HRHi
	} else {
		hrLo, hrHi = inferTargetHRRange(tk, hrMax)
	}

	paceAdherence := computePaceAdherence(avgPace, avgHR, plan, hrMax, laps, tk)
	hrZoneAdherence := computeHRZoneAdherence(samples, nil, hrLo, hrHi)

	coreLaps := lapsExcludingEnds(laps)
	workLaps := make([]Lap, 0, len(coreLaps))
	for _, lp := range coreLaps {
		if !isRestLap(lp) {
			workLaps = append(workLaps, lp)
		}
	}
	effectiveLaps := coreLaps
	if len(workLaps) >= 2 {
		effectiveLaps = workLaps
	}
	effectiveLaps = dedupeAndFilterLaps(effectiveLaps)
	lapPaces := lapPacesOf(effectiveLaps)
	paceCV := cv(lapPaces)
	paceStability := clamp(100.0*(1.0-paceCV*2.0), 0, 100)

	hrDecouplingRaw := computeHRDecoupling(samples, laps)
	hrDecouplingScore := clamp(100.0-max2(0.0, hrDecouplingRaw)*500.0, 0, 100)

	lapCadences := lapCadencesOf(coreLaps)
	cadCV := cv(lapCadences)
	cadenceStability := clamp(100.0*(1.0-cadCV*4.0), 0, 100)

	breakdown := L1Breakdown{
		PaceAdherence:    round2(paceAdherence),
		HRZoneAdherence:  round2(hrZoneAdherence),
		PaceStability:    round2(paceStability),
		HRDecoupling:     round2(hrDecouplingScore),
		CadenceStability: round2(cadenceStability),
		HRDecouplingRaw:  roundN(hrDecouplingRaw, 4),
		TargetHRRange:    [2]int{hrLo, hrHi},
	}
	total := 0.0
	for k, w := range L1Weights {
		total += breakdown.byName(k) * w
	}

	ev := []string{}
	if a.LabelID != "" {
		ev = append(ev, a.LabelID)
	}
	return &L1Result{Total: round2(total), Breakdown: breakdown, Evidence: ev}
}

func emptyL1Breakdown() L1Breakdown {
	return L1Breakdown{TargetHRRange: [2]int{}}
}

func (b L1Breakdown) byName(k string) float64 {
	switch k {
	case "pace_adherence":
		return b.PaceAdherence
	case "hr_zone_adherence":
		return b.HRZoneAdherence
	case "pace_stability":
		return b.PaceStability
	case "hr_decoupling":
		return b.HRDecoupling
	case "cadence_stability":
		return b.CadenceStability
	}
	return 0
}

// inferTargetHRRange mirrors ability._infer_target_hr_range.
func inferTargetHRRange(trainKind string, hrMax int) (int, int) {
	key := trainKind
	if key == "" {
		key = string(normalize.TrainBase)
	}
	band, ok := TrainKindHRTargets[key]
	if !ok {
		band = [2]float64{0.65, 0.78}
	}
	return roundToInt(float64(hrMax) * band[0]), roundToInt(float64(hrMax) * band[1])
}

// computePaceAdherence mirrors ability._compute_pace_adherence.
func computePaceAdherence(avgPace *float64, avgHR *int, plan *PlanTarget, hrMax int, laps []Lap, trainKind string) float64 {
	effectivePace := avgPace
	if laps != nil && intervalLikeKinds[trainKind] {
		var workPaces []float64
		for _, lp := range laps {
			if lp.AvgPace != nil && !isRestLap(lp) {
				workPaces = append(workPaces, *lp.AvgPace)
			}
		}
		if len(workPaces) >= 2 {
			m := median(workPaces)
			effectivePace = &m
		}
	}
	if effectivePace == nil {
		return 0
	}
	var targetPace *float64
	if plan != nil && plan.PaceSKm != nil {
		p := *plan.PaceSKm
		targetPace = &p
	} else if avgHR != nil && hrMax > 0 {
		frac := clamp(float64(*avgHR)/float64(hrMax), 0.5, 1.05)
		t := 370.0 - (frac-0.65)/(0.90-0.65)*(370.0-230.0)
		targetPace = &t
	}
	if targetPace == nil || *targetPace <= 0 {
		return 60.0
	}
	if !(plan != nil && plan.PaceSKm != nil) {
		clamped := clamp(*targetPace, 200.0, 540.0)
		targetPace = &clamped
	}
	errFrac := abs(*effectivePace-*targetPace) / *targetPace
	return clamp(100.0-errFrac*300.0, 0, 100)
}

// computeHRZoneAdherence mirrors ability._compute_hr_zone_adherence. Only the
// timeseries branch is reachable on the snapshot path (zones are never attached
// by the loader); an empty timeseries yields 0, matching the Python empty-zones
// fallback.
func computeHRZoneAdherence(samples []Sample, _ map[string]any, hrLo, hrHi int) float64 {
	var hrs []int
	for _, p := range samples {
		if p.HeartRate != nil {
			hrs = append(hrs, *p.HeartRate)
		}
	}
	if len(hrs) == 0 {
		return 0
	}
	inRange := 0
	for _, h := range hrs {
		if hrLo <= h && h <= hrHi {
			inRange++
		}
	}
	return 100.0 * float64(inRange) / float64(len(hrs))
}

type hrPaceSample struct {
	hr int
	sp float64
}

// computeHRDecoupling mirrors ability._compute_hr_decoupling.
func computeHRDecoupling(samples []Sample, laps []Lap) float64 {
	var s []hrPaceSample
	for _, p := range samples {
		if p.HeartRate != nil && p.Speed != nil && *p.Speed > 0 {
			s = append(s, hrPaceSample{*p.HeartRate, *p.Speed})
		}
	}
	if len(s) < 20 {
		s = s[:0]
		for _, lp := range laps {
			if lp.AvgHR != nil && lp.AvgPace != nil && *lp.AvgPace > 0 {
				s = append(s, hrPaceSample{*lp.AvgHR, 1.0 / *lp.AvgPace})
			}
		}
	}
	if len(s) < 4 {
		return 0.0
	}
	half := len(s) / 2
	r1 := hrPaceRatio(s[:half])
	r2 := hrPaceRatio(s[half:])
	if r1 <= 0 {
		return 0.0
	}
	return (r2 - r1) / r1
}

func hrPaceRatio(pairs []hrPaceSample) float64 {
	if len(pairs) == 0 {
		return 0.0
	}
	var hsum, ssum float64
	for _, p := range pairs {
		hsum += float64(p.hr)
		ssum += p.sp
	}
	meanSP := ssum / float64(len(pairs))
	if meanSP <= 0 {
		return 0.0
	}
	return (hsum / float64(len(pairs))) / meanSP
}

// isRestLap mirrors ability._is_rest_lap.
func isRestLap(lp Lap) bool {
	if lp.ExerciseType != nil {
		if *lp.ExerciseType == 3 || *lp.ExerciseType == 4 {
			return true
		}
		return false
	}
	if lp.AvgPace != nil && *lp.AvgPace > 480 {
		return true
	}
	return false
}

// lapsExcludingEnds mirrors ability._laps_excluding_ends.
func lapsExcludingEnds(laps []Lap) []Lap {
	out := make([]Lap, 0, len(laps))
	for _, lp := range laps {
		ex := lp.ExerciseType
		if ex != nil && (*ex == 1 || *ex == 3 || *ex == 4) {
			continue
		}
		out = append(out, lp)
	}
	if len(out) == 0 && len(laps) >= 3 {
		return laps[1 : len(laps)-1]
	}
	if len(out) == 0 {
		return laps
	}
	return out
}

// dedupeAndFilterLaps mirrors ability._dedupe_and_filter_laps.
func dedupeAndFilterLaps(laps []Lap) []Lap {
	byIdx := map[int]Lap{}
	for _, lp := range laps {
		if existing, ok := byIdx[lp.LapIndex]; !ok {
			byIdx[lp.LapIndex] = lp
		} else if lp.LapType == "type2" && existing.LapType != "type2" {
			byIdx[lp.LapIndex] = lp
		}
	}
	deduped := make([]Lap, 0, len(byIdx))
	for _, lp := range byIdx {
		deduped = append(deduped, lp)
	}
	out := make([]Lap, 0, len(deduped))
	for _, lp := range deduped {
		if lp.DistanceM < 0.3 || lp.DurationS < 60 {
			continue
		}
		out = append(out, lp)
	}
	if len(out) < 2 && len(deduped) >= 2 {
		return deduped
	}
	if len(out) == 0 {
		return deduped
	}
	return out
}

func lapPacesOf(laps []Lap) []float64 {
	var out []float64
	for _, lp := range laps {
		if lp.AvgPace != nil {
			out = append(out, *lp.AvgPace)
		}
	}
	return out
}

func lapCadencesOf(laps []Lap) []float64 {
	var out []float64
	for _, lp := range laps {
		if lp.AvgCadence != nil {
			out = append(out, float64(*lp.AvgCadence))
		}
	}
	return out
}
