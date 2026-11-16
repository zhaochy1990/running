package calibration_test

import (
	"math"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
)

// T4 #998 fixtures. The evolved v4 extends the joint objective with a
// time-structured capability state a(s) = a_now - trend*s + dayShift[d]:
// recent comparable HR-speed/duration evidence (ordinary training, no fresh
// PB) must move the capability estimate, day-level effects stay separated
// from the slow trend, and easy-only or absent new evidence must never
// auto-degrade the capability. The stationary scalar capability of #996
// remains the pure FitEvolvedSpeed seam bit-for-bit.

// evolvedStateV60At evaluates the true capability (m/s) age days before the
// as-of instant under a linear log-drift.
func evolvedStateV60At(vNow, driftPerDay float64, age float64) float64 {
	return vNow * math.Exp(-driftPerDay*age)
}

// evolvedStateOrdinaryHistory builds an ordinary-training window (no maximal
// anchors anywhere) from one ground truth: near-daily cadence, cycling
// durations for k identifiability, paces following the effort-margin model
// with the given per-class margin. The matching metadata labels every
// session honestly submaximal (the comparable-training vocabulary).
func evolvedStateOrdinaryHistory(asOf time.Time, vNow, driftPerDay float64, daySteps int, delta float64) ([]calibration.Activity, []calibration.CandidateMetadata) {
	const kTrue = 0.06
	history := []calibration.Activity{}
	meta := []calibration.CandidateMetadata{}
	durations := []int{1800, 2400, 3600, 5400}
	for i, age := 0, 0; age <= 120; age, i = age+daySteps, i+1 {
		id := "state-" + string(rune('a'+i))
		d := durations[i%len(durations)]
		speed := evolvedStateV60At(vNow, driftPerDay, float64(age)) * math.Exp(-delta) * math.Pow(float64(d)/3600, -kTrue)
		history = append(history, evolvedRunActivity(id, asOf.AddDate(0, 0, -age), d, speed))
		meta = append(meta, calibration.CandidateMetadata{ActivityID: id, SourceVersion: "audited-v1", EvidenceRef: "e", Submaximal: true})
	}
	return history, meta
}

// TestEvolvedCapabilityRecentComparableEvidenceMovesEstimate is the mandated
// first regression of #998: a runner improving steadily on ordinary
// comparable training (no PB, no maximal anchor) must have the capability
// estimate follow the improvement - the state tracks the recent level above
// the stationary window average, without any fresh historical maximum.
func TestEvolvedCapabilityRecentComparableEvidenceMovesEstimate(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	const vNow, drift = 4.2, 0.0009
	history, meta := evolvedStateOrdinaryHistory(asOf, vNow, drift, 3, 0.18)

	result, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, history, asOf, nil, meta)
	if err != nil {
		t.Fatal(err)
	}
	speed := result.Evolved.Speed
	if speed.CenterMps == nil {
		t.Fatal("state fit must publish a center")
	}
	if speed.MaximalAnchors != 0 {
		t.Fatalf("fixture must stay PB-free (maximal anchors=%d)", speed.MaximalAnchors)
	}
	state := speed.CapabilityState
	if state == nil {
		t.Fatal("multi-day ordinary training must produce a time-structured capability state")
	}
	if state.TrendPerDay <= 0 {
		t.Fatalf("steadily improving comparable evidence must push the trend positive: %+v", state.TrendPerDay)
	}
	// The trend is prior-shrunk; its magnitude must stay in the order of the
	// generating drift (never a numerical blow-up, never invisible).
	if state.TrendPerDay < 0.0003 || state.TrendPerDay > 0.0020 {
		t.Fatalf("trend magnitude implausible: %v (truth %v)", state.TrendPerDay, drift)
	}
	// The day effects are disclosed per distinct evidence day, bounded.
	if state.DistinctDays < 35 {
		t.Fatalf("distinct evidence days under-reported: %d", state.DistinctDays)
	}
	if len(state.DayEffects) == 0 || len(state.DayEffects) > 16 {
		t.Fatalf("day effects disclosure must be present and bounded: %d", len(state.DayEffects))
	}
	// Walk-forward tracking (the ticket's response-lag evaluation): evaluated
	// 60 days earlier on the same event stream, the state must sit below its
	// current level by roughly the true drift accumulated over those 60 days.
	// The window-family bias of constant-speed fixtures cancels in the
	// difference, so this asserts movement, not absolute level.
	asOf60 := asOf.AddDate(0, 0, -60)
	earlier, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, history, asOf60, nil, meta)
	if err != nil {
		t.Fatal(err)
	}
	if earlier.Evolved.Speed.CenterMps == nil || earlier.Evolved.Speed.CapabilityState == nil {
		t.Fatalf("earlier evaluation must also produce a state center: %+v", earlier.Evolved.Speed)
	}
	movement := math.Log(*speed.CenterMps / *earlier.Evolved.Speed.CenterMps)
	wantMove := drift * 60
	if movement < 0.3*wantMove || movement > 1.7*wantMove {
		t.Fatalf("state movement must track the true drift: got %v want ~%v", movement, wantMove)
	}
	// The sensitivity range stays finite and brackets the center.
	if speed.RangeLowMps == nil || speed.RangeHighMps == nil || !(*speed.RangeLowMps < *speed.CenterMps && *speed.CenterMps < *speed.RangeHighMps) {
		t.Fatalf("state range must bracket the center: %+v", speed)
	}
}

// evolvedStateEvidenceOf extracts the admitted evidence of a history plus
// metadata through the assembled path (stationary-seam comparisons).
func evolvedStateEvidenceOf(history []calibration.Activity, meta []calibration.CandidateMetadata, asOf time.Time) []calibration.CandidateEvidence {
	res, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, history, asOf, nil, meta)
	if err != nil {
		panic(err)
	}
	return res.Evidence.Candidates
}
