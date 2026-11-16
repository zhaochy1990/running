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

// TestEvolvedCapabilityEasyOnlyDoesNotAutoDowngrade (#998): easy-only
// windows must not force a capability downgrade - the previous state's
// prediction is retained (fixed order: predict then update), the easy
// evidence updates it only within the wide submaximal margin prior, and no
// systematic decline may be inferred just because the runner chose easier
// paces. A real decline with comparable evidence is covered separately.
func TestEvolvedCapabilityEasyOnlyDoesNotAutoDowngrade(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	prior := &calibration.HistoricalCapabilityPrior{
		V60Mps: 3.92, AgeDays: 30, TrendPerDay: 0.0005,
		AsOfDate: asOf.AddDate(0, 0, -30), InputFingerprint: "feed0000feed0000feed0000feed0000",
	}
	predictLog := math.Log(3.92) + 0.0005*30
	// Three weeks of easy runs whose pace dropped ~9% versus the runner's
	// earlier easy pace: chose-to-run-easier, not lost capability.
	history := []calibration.Activity{}
	meta := []calibration.CandidateMetadata{}
	for i, age := 0, 2; age <= 22; age, i = age+2, i+1 {
		id := "easy-" + string(rune('a'+i))
		history = append(history, evolvedRunActivity(id, asOf.AddDate(0, 0, -age), 3600, 3.0))
		meta = append(meta, calibration.CandidateMetadata{ActivityID: id, SourceVersion: "audited-v1", EvidenceRef: "e", Submaximal: true})
	}
	r, err := calibration.EstimateEvolvedOffline(history, asOf, nil, meta, prior)
	if err != nil {
		t.Fatal(err)
	}
	speed := r.Evolved.Speed
	if speed.CenterMps == nil || speed.CapabilityState == nil {
		t.Fatalf("easy-only update must keep a state center: %+v", speed)
	}
	state := speed.CapabilityState
	// Lineage: the predict channel is auditable (trend used, fingerprint).
	if state.PriorPrediction == nil {
		t.Fatal("prior prediction must be stamped when a state prior exists")
	}
	if state.PriorPrediction.TrendPerDayUsed != 0.0005 || state.PriorPrediction.SourceInputFingerprint != prior.InputFingerprint {
		t.Fatalf("prediction lineage wrong: %+v", state.PriorPrediction)
	}
	if math.Abs(state.PriorPrediction.CenterLog-predictLog) > 1e-9 {
		t.Fatalf("prediction center must extrapolate the recorded trend: %v want %v", state.PriorPrediction.CenterLog, predictLog)
	}
	// The capability must not be dragged down with the easy pace: the prior
	// prediction is measurably retained (the hierarchical class margin lets N
	// easy windows pull the level with ONE class prior's precision, not N),
	// without fully locking the estimate to the prediction. The bare run
	// cancels the fixture's window-family bias, so the lift is attributable
	// to the prediction channel alone.
	bare, err := calibration.EstimateEvolvedOffline(history, asOf, nil, meta, nil)
	if err != nil {
		t.Fatal(err)
	}
	if bare.Evolved.Speed.CenterMps == nil {
		t.Fatal("easy-only cold window must still estimate")
	}
	lift := math.Log(*speed.CenterMps / *bare.Evolved.Speed.CenterMps)
	if lift < 0.03 || lift > 0.15 {
		t.Fatalf("easy-only update must retain the prediction partially: lift %v (drop from predict %v)", lift, predictLog-math.Log(*speed.CenterMps))
	}
	if state.TrendPerDay < -0.0004 {
		t.Fatalf("easy-only window must not infer a systematic decline: trend %v", state.TrendPerDay)
	}
	// Uncertainty stays honest: prior-limited share disclosed.
	if speed.PriorCurvatureShare < 0.4 {
		t.Fatalf("easy-only update must stay prior-limited: share %v", speed.PriorCurvatureShare)
	}
}

// TestEvolvedCapabilityNoNewDataKeepsPredictOnlyState (#998): with a valid
// prior state and no admissible new evidence, the retained estimate IS the
// aged prediction - a predict-only state stamp, never a fabricated fit.
func TestEvolvedCapabilityNoNewDataKeepsPredictOnlyState(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	prior := &calibration.HistoricalCapabilityPrior{
		V60Mps: 3.8, AgeDays: 45, TrendPerDay: -0.0002,
		AsOfDate: asOf.AddDate(0, 0, -45), InputFingerprint: "abcd0000abcd0000abcd0000abcd0000",
	}
	r, err := calibration.EstimateEvolvedOffline(nil, asOf, nil, nil, prior)
	if err != nil {
		t.Fatal(err)
	}
	speed := r.Evolved.Speed
	if speed.State != calibration.StatePriorDominated {
		t.Fatalf("no-data state=%s want prior_dominated", speed.State)
	}
	foundAged := false
	for _, reason := range speed.Reasons {
		if reason == calibration.ReasonPriorOnlyAged {
			foundAged = true
		}
	}
	if !foundAged {
		t.Fatalf("prior-only reason missing: %v", speed.Reasons)
	}
	state := speed.CapabilityState
	if state == nil {
		t.Fatal("predict-only state stamp missing")
	}
	if state.Method != "prior_predict_only" {
		t.Fatalf("predict-only method: %q", state.Method)
	}
	if state.PriorPrediction == nil || state.PriorPrediction.TrendPerDayUsed != -0.0002 {
		t.Fatalf("prediction must retain the recorded trend: %+v", state.PriorPrediction)
	}
	if state.DistinctDays != 0 || len(state.DayEffects) != 0 {
		t.Fatalf("predict-only state must not fabricate time structure: %+v", state)
	}
	foundNoNew := false
	for _, reason := range state.Reasons {
		if reason == "no_new_comparable_evidence_capability_predict_only" {
			foundNoNew = true
		}
	}
	if !foundNoNew {
		t.Fatalf("no-new-evidence reason missing: %v", state.Reasons)
	}
	// The center is the precision-weighted prediction blend (closed form,
	// same as the T2 prior-only semantics with the trend-extrapolated mean).
	priors := calibration.DefaultEvolvedPriors()
	mPop, sPop := priors.LogV60.Mean, priors.LogV60.SD
	mHist := math.Log(3.8) - 0.0002*45
	sHist := priors.HistoricalCapabilitySD(45)
	want := math.Exp((mPop/(sPop*sPop) + mHist/(sHist*sHist)) / (1/(sPop*sPop) + 1/(sHist*sHist)))
	if math.Abs(*speed.CenterMps-want) > 1e-9 {
		t.Fatalf("predict-only center must be the closed-form blend: %v want %v", *speed.CenterMps, want)
	}
}

// TestEvolvedCapabilityRealDeclineIsAllowed (#998): a genuine decline on
// comparable evidence must move the state DOWN - no one-way improvement
// clamp exists.
func TestEvolvedCapabilityRealDeclineIsAllowed(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	const vNow, drift = 3.6, -0.0008
	history, meta := evolvedStateOrdinaryHistory(asOf, vNow, drift, 3, 0.18)
	r, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, history, asOf, nil, meta)
	if err != nil {
		t.Fatal(err)
	}
	speed := r.Evolved.Speed
	state := speed.CapabilityState
	if state == nil || speed.CenterMps == nil {
		t.Fatalf("declining window must produce a state: %+v", speed)
	}
	if state.TrendPerDay > -0.0003 {
		t.Fatalf("a real decline must be allowed to push the trend negative: %v (truth %v)", state.TrendPerDay, drift)
	}
	if state.TrendPerDay < -0.0020 {
		t.Fatalf("decline trend implausible: %v", state.TrendPerDay)
	}
	// Walk-forward: the state 60 days earlier sits ABOVE the current level
	// by roughly the true decline accumulated over those days.
	asOf60 := asOf.AddDate(0, 0, -60)
	earlier, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, history, asOf60, nil, meta)
	if err != nil {
		t.Fatal(err)
	}
	if earlier.Evolved.Speed.CenterMps == nil {
		t.Fatal("earlier evaluation must produce a center")
	}
	movement := math.Log(*earlier.Evolved.Speed.CenterMps / *speed.CenterMps)
	wantMove := -drift * 60
	if movement < 0.3*wantMove || movement > 1.7*wantMove {
		t.Fatalf("decline movement must track the truth: got %v want ~%v", movement, wantMove)
	}
}

// TestEvolvedCapabilityLongBreakKeepsStalePrediction (#998): a long
// training break (all support older than the frozen staleness window)
// keeps a finite center flagged stale, widens with age, and never invents
// fresh time structure.
func TestEvolvedCapabilityLongBreakKeepsStalePrediction(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	const vNow = 3.9
	// The frozen T1 staleness window for speed support.
	breakDays := int(calibration.ContractSpeedStaleAfterDays) + 15
	history := []calibration.Activity{}
	meta := []calibration.CandidateMetadata{}
	durations := []int{1800, 3600, 5400}
	for i := 0; i < 9; i++ {
		id := "old-" + string(rune('a'+i))
		age := breakDays + i*3
		speed := vNow * math.Exp(-0.18) * math.Pow(float64(durations[i%3])/3600, -0.06)
		history = append(history, evolvedRunActivity(id, asOf.AddDate(0, 0, -age), durations[i%3], speed))
		meta = append(meta, calibration.CandidateMetadata{ActivityID: id, SourceVersion: "audited-v1", EvidenceRef: "e", Submaximal: true})
	}
	prior := &calibration.HistoricalCapabilityPrior{V60Mps: vNow, AgeDays: float64(breakDays - 10), TrendPerDay: 0.0003}
	r, err := calibration.EstimateEvolvedOffline(history, asOf, nil, meta, prior)
	if err != nil {
		t.Fatal(err)
	}
	speed := r.Evolved.Speed
	if speed.State != calibration.StateStale {
		t.Fatalf("long-break state=%s want stale (frozen window %v days)", speed.State, calibration.ContractSpeedStaleAfterDays)
	}
	if speed.CenterMps == nil || !evolvedFinite(*speed.CenterMps) {
		t.Fatalf("stale must keep a finite center: %+v", speed.CenterMps)
	}
	if speed.CapabilityState == nil {
		t.Fatal("stale windows keep their time structure for audit")
	}
	// Widened with age: the aged prior sd floor dominates the range width.
	if speed.RangeLowMps == nil || speed.RangeHighMps == nil {
		t.Fatal("range required")
	}
	if width := math.Log(*speed.RangeHighMps / *speed.RangeLowMps); width < 0.2 {
		t.Fatalf("long-break range must widen with age: %v", width)
	}
	// The predict channel extrapolates only within the clamped trend domain.
	if pp := speed.CapabilityState.PriorPrediction; pp == nil || pp.TrendPerDayUsed != 0.0003 {
		t.Fatalf("prediction must carry the recorded trend: %+v", pp)
	}
}

// TestEvolvedCapabilitySingleDayWindowStaysStationary (#998): a single-day
// window cannot structure time; the honest output is the stationary scalar
// capability (cold start without a prior still estimates).
func TestEvolvedCapabilitySingleDayWindowStaysStationary(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	history := []calibration.Activity{
		evolvedRunActivity("solo-a", asOf.AddDate(0, 0, -3), 3600, 3.4),
		evolvedRunActivity("solo-b", asOf.AddDate(0, 0, -3), 1800, 3.6),
	}
	r, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, history, asOf, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	speed := r.Evolved.Speed
	if speed.CenterMps == nil || !evolvedFinite(*speed.CenterMps) {
		t.Fatalf("single-day window must still estimate: %+v", speed)
	}
	if speed.CapabilityState != nil {
		t.Fatalf("single-day window must stay stationary, got state %+v", speed.CapabilityState)
	}
}
