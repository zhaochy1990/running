package ability

import "time"

// ComputeAbilitySnapshot mirrors ability.compute_ability_snapshot. It consumes a
// pre-assembled Source (the loader resolves HRMax from the calibration snapshot,
// best-per-race-type PBs, Shanghai-day-windowed activities/health) and produces
// the full 4-layer snapshot for `date`. Returns the empty snapshot when no HRMax
// is resolvable, matching Python.
func ComputeAbilitySnapshot(src *Source, date string, hrMax *int) *Snapshot {
	if src == nil {
		return emptySnapshot(date)
	}
	hrMaxVal := hrMax
	if hrMaxVal == nil {
		hrMaxVal = src.HRMax
	}
	if hrMaxVal == nil {
		return emptySnapshot(date)
	}
	hrMaxInt := *hrMaxVal

	activities := src.Activities
	health28d := src.Health28D
	dashboard := src.Dashboard

	var health7d []HealthRow
	for _, h := range health28d {
		if withinDays(h.Date, date, 7) {
			health7d = append(health7d, h)
		}
	}

	baselineRHR := baselineRHRFromHealth(health28d)

	var todayHealth *HealthRow
	dateCompact := stripDashes(date)
	for i := range health28d {
		if stripDashes(health28d[i].Date) == dateCompact {
			todayHealth = &health28d[i]
			break
		}
	}

	l2Today := ComputeL2Freshness(todayHealth, dashboard, baselineRHR)
	var l2Totals7d []float64
	for i := range health7d {
		r := ComputeL2Freshness(&health7d[i], dashboard, baselineRHR)
		l2Totals7d = append(l2Totals7d, r.Total)
	}

	aerScore, aerEv, aerDet := ComputeL3Aerobic(activities, AerobicTargetHR)
	ltScore, ltEv, ltDet := ComputeL3LT(activities)
	vo2Score, vo2Ev, vo2Det := ComputeL3Vo2Max(activities, health7d, hrMaxInt, src.Vo2MaxPBs, date)
	endScore, endEv, endDet := ComputeL3Endurance(activities)
	ecoScore, ecoEv, ecoDet := ComputeL3Economy(activities)
	recScore, _, recDet := ComputeL3Recovery(l2Totals7d)

	vo2UsedVdot := 0.0
	if v, ok := vo2Det["vo2max_used_vdot"].(float64); ok {
		vo2UsedVdot = v
	}

	l3Dimensions := L3Dimensions{
		Aerobic:        L3Score{Score: aerScore, Evidence: aerEv, Details: aerDet},
		LT:             L3Score{Score: ltScore, Evidence: ltEv, Details: ltDet},
		VO2Max:         L3Score{Score: vo2Score, Evidence: vo2Ev, Details: vo2Det},
		Endurance:      L3Score{Score: endScore, Evidence: endEv, Details: endDet},
		Economy:        L3Score{Score: ecoScore, Evidence: ecoEv, Details: ecoDet},
		Recovery:       L3Score{Score: recScore, Details: recDet},
		VO2MaxUsedVdot: vo2UsedVdot,
	}

	l3Scores := map[string]float64{
		"aerobic": aerScore, "lt": ltScore, "vo2max": vo2Score,
		"endurance": endScore, "economy": ecoScore, "recovery": recScore,
	}
	compositeMap := map[string]float64{}
	for k := range L4Weights {
		compositeMap[k] = l3Scores[k]
	}
	l4Composite := ComputeL4Composite(compositeMap)

	l3Any := map[string]any{
		"aerobic":          aerScore,
		"lt":               ltScore,
		"vo2max":           vo2Score,
		"endurance":        endScore,
		"economy":          ecoScore,
		"recovery":         recScore,
		"vo2max_used_vdot": vo2UsedVdot,
	}

	marathonTrainingS := estimateMarathonTimeS(l3Any)
	var marathonRaceS, marathonBestS *int
	raceBoost, bestBoost := 0.0, 0.0
	if marathonTrainingS != nil {
		raceBoost = scaledBoost(float64(*marathonTrainingS), RaceDayBoostMax, TheoreticalMinMarathonS, BoostNormalizeRangeS)
		bestBoost = scaledBoost(float64(*marathonTrainingS), BestCaseBoostMax, TheoreticalMinMarathonS, BoostNormalizeRangeS)
		v := roundToInt(float64(*marathonTrainingS) * (1.0 - raceBoost))
		marathonRaceS = &v
		v2 := roundToInt(float64(*marathonTrainingS) * (1.0 - bestBoost))
		marathonBestS = &v2
	}
	var l4MarathonEstimate *int
	if marathonRaceS != nil {
		l4MarathonEstimate = marathonRaceS
	}

	hmTrainingS := estimateHalfMarathonTimeS(l3Any)
	var hmRaceS, hmBestS *int
	hmRaceBoost, hmBestBoost := 0.0, 0.0
	if hmTrainingS != nil {
		hmRaceBoost = scaledBoost(float64(*hmTrainingS), RaceDayBoostMax, TheoreticalMinHMS, BoostNormalizeRangeHMS)
		hmBestBoost = scaledBoost(float64(*hmTrainingS), BestCaseBoostMax, TheoreticalMinHMS, BoostNormalizeRangeHMS)
		v := roundToInt(float64(*hmTrainingS) * (1.0 - hmRaceBoost))
		hmRaceS = &v
		v2 := roundToInt(float64(*hmTrainingS) * (1.0 - hmBestBoost))
		hmBestS = &v2
	}

	var latestL1 *L1Result
	if len(activities) > 0 {
		latestL1 = ComputeL1Quality(&activities[0], nil, hrMaxInt)
	}

	allEvidence := dedupeOrdered(append(append(append(append([]string{}, aerEv...), ltEv...), vo2Ev...), endEv...), ecoEv)

	var distanceToSub250 *int
	if marathonRaceS != nil {
		v := *marathonRaceS - 10200
		distanceToSub250 = &v
	}

	return &Snapshot{
		ModelVersion:          AbilityModelVersion,
		Date:                  date,
		L1Latest:              latestL1,
		L2Freshness:           l2Today,
		L3Dimensions:          l3Dimensions,
		L4Composite:           l4Composite,
		L4MarathonEstimateS:   l4MarathonEstimate,
		DistanceToSub250S:     distanceToSub250,
		MarathonEstimates:     buildEstimates(marathonTrainingS, marathonRaceS, marathonBestS, raceBoost, bestBoost),
		HalfMarathonEstimates: buildEstimates(hmTrainingS, hmRaceS, hmBestS, hmRaceBoost, hmBestBoost),
		EvidenceActivityIDs:   allEvidence,
		BaselineRHR:           baselineRHR,
	}
}

func buildEstimates(trainingS, raceS, bestS *int, raceBoost, bestBoost float64) MarathonEstimates {
	return MarathonEstimates{
		TrainingS:            trainingS,
		RaceS:                raceS,
		BestCaseS:            bestS,
		RaceDayBoostMax:      RaceDayBoostMax,
		BestCaseBoostMax:     BestCaseBoostMax,
		RaceDayBoostApplied:  roundN(raceBoost, 4),
		BestCaseBoostApplied: roundN(bestBoost, 4),
	}
}

// emptySnapshot mirrors ability._empty_snapshot.
func emptySnapshot(date string) *Snapshot {
	return &Snapshot{
		ModelVersion: AbilityModelVersion,
		Date:         date,
		L2Freshness:  &L2Result{Total: 50.0, Breakdown: L2Breakdown{TSBScore: 50, RHRScore: 50, HRVScore: 50, FatigueScore: 50}},
		L3Dimensions: L3Dimensions{
			Aerobic: L3Score{Score: 0, Evidence: []string{}}, LT: L3Score{Score: 0, Evidence: []string{}},
			VO2Max: L3Score{Score: 0, Evidence: []string{}}, Endurance: L3Score{Score: 0, Evidence: []string{}},
			Economy: L3Score{Score: 0, Evidence: []string{}}, Recovery: L3Score{Score: 0, Evidence: []string{}},
		},
		MarathonEstimates:     emptyEstimates(),
		HalfMarathonEstimates: emptyEstimates(),
		EvidenceActivityIDs:   []string{},
	}
}

func emptyEstimates() MarathonEstimates {
	return MarathonEstimates{
		RaceDayBoostMax: RaceDayBoostMax, BestCaseBoostMax: BestCaseBoostMax,
	}
}

// baselineRHRFromHealth mirrors ability._median over 28d RHR, with 0 → nil.
func baselineRHRFromHealth(health []HealthRow) *float64 {
	var vals []float64
	for _, h := range health {
		if h.RHR != nil {
			vals = append(vals, float64(*h.RHR))
		}
	}
	if len(vals) == 0 {
		return nil
	}
	m := median(vals)
	if m == 0 {
		return nil
	}
	return &m
}

// withinDays mirrors ability._within_days: 0 <= (end - cur).days <= days.
// Inputs are YYYY-MM-DD or YYYYMMDD; the leading 8 chars are compared as dates.
func withinDays(val string, endISO string, days int) bool {
	if val == "" || endISO == "" {
		return false
	}
	s := stripDashes(val)
	end := stripDashes(endISO)
	if len(s) < 8 || len(end) < 8 {
		return false
	}
	cur, err1 := time.Parse("20060102", s[:8])
	endD, err2 := time.Parse("20060102", end[:8])
	if err1 != nil || err2 != nil {
		return false
	}
	delta := int(endD.Sub(cur).Hours() / 24)
	return delta >= 0 && delta <= days
}

func dedupeOrdered(listsOfStrings ...[]string) []string {
	var out []string
	seen := map[string]bool{}
	for _, lst := range listsOfStrings {
		for _, s := range lst {
			if s == "" || seen[s] {
				continue
			}
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func stripDashes(s string) string {
	if len(s) == 0 {
		return s
	}
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '-' || s[i] == 'T' {
			continue
		}
		out = append(out, s[i])
	}
	return string(out)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
