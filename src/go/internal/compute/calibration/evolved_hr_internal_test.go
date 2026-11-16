package calibration

import (
	"math"
	"testing"
	"time"
)

// White-box tests of the #997-era solver internals that are not reachable
// through the assembled path (T2 review P2 items resolved with #997).

// TestEvolvedSpeedQualityGapReasonNamesTheDivergence: pure-seam calls whose
// selected continuous rows all fail the measurement-quality gate must report
// the categorical quality-gap reason next to the numerical failure - the
// assembled path (buildCandidateEvidence) never produces this, the seam can.
func TestEvolvedSpeedQualityGapReasonNamesTheDivergence(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	evidence := []CandidateEvidence{{
		ActivityID: "q", RootActivityID: "q", ActivityDate: asOf.AddDate(0, 0, -2),
		DurationS: 3600, AvgSpeedMps: 3.3, Continuous: true, Selected: true,
		MeasurementQuality: ConfidenceNone, EffortSupport: EffortSubmaximal,
	}}
	report := FitEvolvedSpeed(evidence, asOf, DefaultEvolvedPriors(), nil)
	if report.State != StateUnavailable || report.CenterMps != nil {
		t.Fatalf("quality-gap seam must not fabricate a center: %+v", report)
	}
	foundGap, foundFailure := false, false
	for _, r := range report.Reasons {
		if r == ReasonAdmissionQualityGap {
			foundGap = true
		}
		if r == ReasonSolverNumericalFailure {
			foundFailure = true
		}
	}
	if !foundGap || !foundFailure {
		t.Fatalf("quality gap must be named next to the failure: %v", report.Reasons)
	}
}

// TestEvolvedSolveMAPFailureDisclosesActualKGrid: when the deterministic MAP
// solve fails, the returned solution still carries the k-grid resolution
// actually used, so the report discloses the coarsened grid on the failure
// path too (T2 review nit).
func TestEvolvedSolveMAPFailureDisclosesActualKGrid(t *testing.T) {
	priors := DefaultEvolvedPriors()
	// Degenerate fit: a zero-sigma observation poisons the profile with NaN,
	// forcing the nonfinite failure branch while the large-observation guard
	// selects the coarsened grid.
	obs := make([]evolvedObsPoint, evolvedLargeObservationThreshold+1)
	for i := range obs {
		obs[i] = evolvedObsPoint{y: math.Log(3.3), x: 0, sigma: 1, w: 1, root: "r", day: "d", duration: 3600, group: 0, effort: EffortSubmaximal, quality: ConfidenceHigh}
	}
	obs[0].sigma = 0 // division by zero -> nonfinite objective
	fit := evolvedFit{obs: obs, groups: []evolvedGroup{{root: "r", day: "d", effort: EffortSubmaximal, prior: priors.EffortMargin.Submaximal, obsIdx: nil}}}
	for i := range fit.obs {
		fit.groups[0].obsIdx = append(fit.groups[0].obsIdx, i)
	}
	sol, ok := evolvedSolveMAP(fit, priors, nil, nil)
	if ok {
		t.Fatalf("degenerate input must fail the solve, got %+v", sol)
	}
	wantStep := (riegelKMax - riegelKMin) / evolvedKCoarseStepsLarge / (evolvedKFineStepsLarge/2 + 1)
	if !sol.gridCoarsened {
		t.Fatal("large-input guard must be flagged on the failure path")
	}
	if math.Abs(sol.gridResolution-wantStep) > 1e-12 {
		t.Fatalf("failure path must disclose the actual grid: %v want %v", sol.gridResolution, wantStep)
	}
}

// TestEvolvedPriorEntersObjectiveExactlyOnceNumerically: with no data at all,
// the prior-only center must equal the closed-form precision-weighted blend
// of the population prior and the aged historical prior - counting the
// historical prior twice would double its precision and move the center.
func TestEvolvedPriorEntersObjectiveExactlyOnceNumerically(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	priors := DefaultEvolvedPriors()
	hist := &HistoricalCapabilityPrior{V60Mps: 3.0, AgeDays: 100}
	report := FitEvolvedSpeed(nil, asOf, priors, hist)
	if report.CenterMps == nil || report.State != StatePriorDominated {
		t.Fatalf("prior-only fit must publish a center: %+v", report)
	}
	mPop, sPop := priors.LogV60.Mean, priors.LogV60.SD
	mHist, sHist := math.Log(3.0), priors.HistoricalCapabilitySD(100)
	wPop, wHist := 1/(sPop*sPop), 1/(sHist*sHist)
	want := math.Exp((mPop*wPop + mHist*wHist) / (wPop + wHist))
	if math.Abs(*report.CenterMps-want) > 1e-9 {
		t.Fatalf("prior counted more than once: center %v want %v", *report.CenterMps, want)
	}
	// Double-counting check: doubling the historical precision moves the
	// center well outside the equality tolerance above.
	doubled := math.Exp((mPop*wPop + mHist*2*wHist) / (wPop + 2*wHist))
	if math.Abs(doubled-want) < 1e-6 {
		t.Fatal("fixture is insensitive to double counting; test is toothless")
	}
}
