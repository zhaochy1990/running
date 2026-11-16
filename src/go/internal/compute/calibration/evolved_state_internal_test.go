package calibration

import (
	"math"
	"strings"
	"testing"
	"time"
)

// White-box tests of the #998 state scale-guard path (weekly effect
// resolution) and of the research-prior lock (review P1/P2-3).

// TestEvolvedStampSolvedWeeklyResidualsIncludeDayEffects (review P1): in
// weekly mode the published per-observation residuals must evaluate the
// effective capability through the ISO-week effect key - a raw-day lookup
// silently drops the day-shift term.
func TestEvolvedStampSolvedWeeklyResidualsIncludeDayEffects(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	priors := DefaultEvolvedPriors()
	evidence := []CandidateEvidence{}
	durations := []float64{1800, 3600, 5400}
	for i, age := 0, 0; age < 70; age, i = age+1, i+1 {
		id := "ws-" + string(rune('a'+i%26)) + string(rune('0'+i/26))
		d := durations[i%3]
		speed := 4.0 * math.Exp(-0.0005*float64(age)) * math.Exp(-0.18) * math.Pow(d/3600, -0.06)
		evidence = append(evidence, CandidateEvidence{
			ActivityID: id, RootActivityID: id, ActivityDate: asOf.AddDate(0, 0, -age),
			DurationS: d, AvgSpeedMps: speed, Continuous: true, Selected: true,
			MeasurementQuality: ConfidenceHigh, EffortSupport: EffortSubmaximal,
		})
	}
	fit, ok := evolvedAttachCapabilityState(evidence, asOf, priors, true)
	if !ok {
		t.Fatal("attach failed")
	}
	if !fit.state.weekly {
		t.Fatalf("fixture sanity: 70 distinct days must trigger weekly resolution")
	}
	// Pin a non-trivial state: trend plus a week shift on the first week.
	const trend, shift = 0.0002, -0.03
	fit.state.trend = trend
	targetDay := asOf.AddDate(0, 0, -1)
	ty, tw := targetDay.ISOWeek()
	targetKey := evolvedStateEffectKey(targetDay.Format("2006-01-02"), true)
	if !strings.Contains(targetKey, "-W") {
		t.Fatalf("fixture sanity: weekly key format: %q", targetKey)
	}
	fit.state.dayShift[targetKey] = shift
	sol := evolvedSolution{a: math.Log(4.0), k: 0.06, deltas: make([]float64, len(fit.groups))}
	evolvedProfile(&fit, priors, nil, nil, sol.k, sol.a, true)
	for g := range fit.groups {
		sol.deltas[g] = fit.groups[g].delta
	}
	sol.trend, sol.dayShift = fit.state.snapshot()
	evolvedStampSolved(fit, sol)
	// Find the observation(s) of the target day and check the residual
	// formula evaluates the week shift through the effect key.
	checked := 0
	for i := range fit.obs {
		p := &fit.obs[i]
		if p.day != targetDay.Format("2006-01-02") || p.constraint {
			continue
		}
		row := fit.rows[p.index]
		if row.Residual == nil || row.Delta == nil {
			t.Fatalf("model observation must carry residual/delta: %+v", row)
		}
		aEff := sol.a - sol.trend*p.age + shift
		want := (p.y - aEff + sol.k*p.x + *row.Delta) / p.sigma
		if math.Abs(*row.Residual-want) > 1e-12 {
			t.Fatalf("weekly residual must include the week effect: got %v want %v", *row.Residual, want)
		}
		// And the no-shift formula must NOT match (the test must have teeth).
		noShift := (p.y - (sol.a - sol.trend*p.age) + sol.k*p.x + *row.Delta) / p.sigma
		if math.Abs(*row.Residual-noShift) < 1e-9 {
			t.Fatalf("residual equals the shift-free formula - the week effect is dropped")
		}
		checked++
	}
	if checked == 0 {
		t.Fatalf("fixture sanity: no observations on day %v (week %d-W%02d)", targetDay, ty, tw)
	}
}

// TestEvolvedStateResearchPriorsLockedToDocumentedValues (review P2-3): the
// state research priors are exempted from contract_priors.go (decision:
// structural regularization of the time parameterization, like delta >= 0).
// This lock makes the exemption non-driftable: every value below is
// documented verbatim in estimation-contract-v2.md section 2.1 and
// evolved-state-rev2.md - changing a constant or a doc number breaks this
// test, forcing a conscious contract-doc sync in the same commit.
func TestEvolvedStateResearchPriorsLockedToDocumentedValues(t *testing.T) {
	lock := map[string][2]float64{
		"trend prior sd per day (doc: 0.0005)":            {evolvedCapabilityTrendSDPerDay, 0.0005},
		"trend clamp (doc: 0.003)":                        {evolvedCapabilityTrendClamp, 0.003},
		"capability day-effect sd (doc: 0.02)":            {evolvedCapabilityDaySDLog, 0.02},
		"capability day-effect clamp (doc: 0.15)":         {evolvedCapabilityDayClamp, 0.15},
		"day-cap before weekly coarsening (doc: 60)":      {float64(evolvedStateDayCap), 60},
		"day-effect disclosure cap (doc: 16)":             {float64(evolvedStateDayEffectsCap), 16},
		"IRLS rounds (evolved-state-rev2.md: 25)":         {float64(evolvedStateIRLSIters), 25},
		"IRLS rounds at scale (evolved-state-rev2.md: 8)": {float64(evolvedStateIRLSItersLarge), 8},
		"line-search halvings (doc: 8)":                   {float64(evolvedStateLineHalvings), 8},
	}
	for name, pair := range lock {
		if pair[0] != pair[1] {
			t.Errorf("%s: constant %v drifted from the documented %v", name, pair[0], pair[1])
		}
	}
}

// TestEvolvedJointShellPreservesStationaryLimitations (#1001 finding): the
// joint re-stamp shell must carry the stationary report's limitations (e.g.
// the state-solve fallback disclosure or the large-input k-grid coarsening)
// instead of silently rebuilding the base list and dropping them.
func TestEvolvedJointShellPreservesStationaryLimitations(t *testing.T) {
	stationary := EvolvedSpeedReport{
		State:        StateModelEstimated,
		RangeMeaning: contractRangeSemantics,
		Limitations:  append(evolvedSpeedLimitations(), "capability_state_solve_failed_stationary_center_retained", "k_grid_coarsened_large_input"),
	}
	shell := evolvedJointSpeedOutShell(stationary, evolvedFit{}, DefaultEvolvedPriors())
	for _, want := range []string{"capability_state_solve_failed_stationary_center_retained", "k_grid_coarsened_large_input"} {
		found := false
		for _, l := range shell.Limitations {
			if l == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("shell dropped stationary limitation %q; got %v", want, shell.Limitations)
		}
	}
}
