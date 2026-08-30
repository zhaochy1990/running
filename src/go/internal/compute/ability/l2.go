package ability

// ComputeL2Freshness mirrors ability.compute_l2_freshness.
func ComputeL2Freshness(dh *HealthRow, dash *Dashboard, baselineRHR *float64) *L2Result {
	if dh == nil {
		return &L2Result{Total: 50.0, Breakdown: L2Breakdown{TSBScore: 50, RHRScore: 50, HRVScore: 50, FatigueScore: 50}}
	}

	tsb := (*float64)(nil)
	if dh.ATI != nil && dh.CTI != nil {
		v := *dh.CTI - *dh.ATI
		tsb = &v
	}
	tsbScore := tsbToScore(tsb)
	rhrScore := rhrToScore(dh.RHR, baselineRHR)
	hrvScore := hrvToScore(dash)

	fatigueScore := 50.0
	if dh.Fatigue != nil {
		fatigueScore = clamp(100.0-*dh.Fatigue, 0, 100)
	}

	breakdown := L2Breakdown{
		TSBScore:     round2(tsbScore),
		RHRScore:     round2(rhrScore),
		HRVScore:     round2(hrvScore),
		FatigueScore: round2(fatigueScore),
	}
	total := 0.0
	for k, w := range L2Weights {
		total += breakdown.byName(k) * w
	}
	return &L2Result{Total: round2(total), Breakdown: breakdown, TSB: tsb}
}

func (b L2Breakdown) byName(k string) float64 {
	switch k {
	case "tsb_score":
		return b.TSBScore
	case "rhr_score":
		return b.RHRScore
	case "hrv_score":
		return b.HRVScore
	case "fatigue_score":
		return b.FatigueScore
	}
	return 0
}

// tsbToScore mirrors ability._tsb_to_score.
func tsbToScore(tsb *float64) float64 {
	if tsb == nil {
		return 50.0
	}
	v := *tsb
	if -10 <= v && v <= 10 {
		return 100.0
	}
	if v > 10 {
		return clamp(100.0-(v-10)*2.0, 0, 100)
	}
	return clamp(100.0-(abs(v)-10)*2.5, 0, 100)
}

// rhrToScore mirrors ability._rhr_to_score.
func rhrToScore(rhr *int, baselineRHR *float64) float64 {
	if rhr == nil || baselineRHR == nil {
		if rhr == nil {
			return 50.0
		}
		return 80.0
	}
	delta := float64(*rhr) - *baselineRHR
	if delta <= 0 {
		return 100.0
	}
	return clamp(100.0-delta*5.0, 0, 100)
}

// hrvToScore mirrors ability._hrv_to_score.
func hrvToScore(dash *Dashboard) float64 {
	if dash == nil {
		return 50.0
	}
	avg := dash.AvgSleepHRV
	lo := dash.HRVNormalLow
	hi := dash.HRVNormalHigh
	if avg == nil {
		return 50.0
	}
	if lo == nil || hi == nil || *lo >= *hi {
		return 70.0
	}
	if *lo <= *avg && *avg <= *hi {
		return 100.0
	}
	if *avg < *lo {
		return clamp(100.0-(*lo-*avg)*4.0, 0, 100)
	}
	return clamp(100.0-(*avg-*hi)*2.0, 0, 100)
}
