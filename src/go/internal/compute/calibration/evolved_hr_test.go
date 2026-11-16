package calibration_test

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
)

// T3 #997 fixtures. The evolved v4 fits the individual HR dynamic model of
// estimation-contract-v2 section 2.2/2.3 jointly with the speed domain: an
// ordinary optical wrist HR series without any verified protocol must still
// produce a finite, physically legal threshold HR with a sensitivity range.
// The historical v4 returned nil here with reason
// no_independent_HR_protocol_support.

// evolvedHRRunActivity builds a constant-speed activity with a steady HR
// series (1 Hz samples, no protocol metadata, unknown sensor).
func evolvedHRRunActivity(id string, day time.Time, durationS int, speedMps, steadyHR float64) calibration.Activity {
	a := calibration.Activity{LabelID: id, ActivityDate: day, Sport: "run"}
	for t := 0; t <= durationS; t++ {
		a.Samples = append(a.Samples, calibration.Sample{
			ElapsedS:     f64p(float64(t)),
			SpeedMps:     f64p(speedMps),
			DistanceM:    f64p(float64(t) * speedMps),
			HeartRateBpm: f64p(steadyHR),
		})
	}
	return a
}

// TestEvolvedHROrdinaryOpticalSeriesWithoutProtocolYieldsFiniteEstimate is the
// mandated failing regression of #997: ordinary training with optical-only HR
// and no verified 30-min protocol still gets a finite model threshold HR plus
// a legal range, through the joint objective with the F(1.0)=0.92 bridge.
func TestEvolvedHROrdinaryOpticalSeriesWithoutProtocolYieldsFiniteEstimate(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	history := []calibration.Activity{
		evolvedHRRunActivity("easy-long", asOf.AddDate(0, 0, -9), 5400, 3.0, 141),
		evolvedHRRunActivity("steady", asOf.AddDate(0, 0, -2), 3600, 3.3, 150),
		evolvedHRRunActivity("tempo-short", asOf.AddDate(0, 0, -30), 1800, 3.6, 159),
	}
	result, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, history, asOf, nil, nil)
	if err != nil {
		t.Fatalf("evolved candidate must estimate from ordinary HR training: %v", err)
	}
	if result.Evolved == nil || result.Evolved.HR == nil {
		t.Fatal("evolved HR report missing")
	}
	hr := result.Evolved.HR
	if hr.State != calibration.StateModelEstimated {
		t.Fatalf("ordinary HR series without protocol must be model_estimated, got %s (reasons %v)", hr.State, hr.Reasons)
	}
	if hr.CenterBpm == nil || !evolvedFinite(*hr.CenterBpm) {
		t.Fatalf("HR center must be finite: %+v", hr.CenterBpm)
	}
	if *hr.CenterBpm < 100 || *hr.CenterBpm > 210 {
		t.Fatalf("HR center implausible for this training: %v", *hr.CenterBpm)
	}
	if hr.RangeLowBpm == nil || hr.RangeHighBpm == nil || !evolvedFinite(*hr.RangeLowBpm) || !evolvedFinite(*hr.RangeHighBpm) {
		t.Fatalf("HR sensitivity range must be finite: [%v, %v]", hr.RangeLowBpm, hr.RangeHighBpm)
	}
	if !(*hr.RangeLowBpm < *hr.CenterBpm && *hr.CenterBpm < *hr.RangeHighBpm) {
		t.Fatalf("HR range must bracket the center: [%v, %v] center %v", *hr.RangeLowBpm, *hr.RangeHighBpm, *hr.CenterBpm)
	}
	if *hr.RangeLowBpm < 80 || *hr.RangeHighBpm > 230 {
		t.Fatalf("HR range left the physiological domain: [%v, %v]", *hr.RangeLowBpm, *hr.RangeHighBpm)
	}
	// The optical downweight must be disclosed instead of an exclusion; no
	// implementation-pending reason may survive (the joint fit landed).
	foundOptical := false
	for _, r := range hr.Reasons {
		if r == calibration.ReasonOpticalHRDownweighted {
			foundOptical = true
		}
		if strings.Contains(r, "pending") {
			t.Fatalf("HR must not report a pending implementation: %v", hr.Reasons)
		}
	}
	if !foundOptical {
		t.Fatalf("unknown/optical-only sensor must be disclosed as downweighted: %v", hr.Reasons)
	}
	if hr.RangeMeaning == "" {
		t.Fatal("range meaning must be declared (model sensitivity, never a probability interval)")
	}
	if len(hr.PriorsIdentityHash) != 64 || len(hr.InputIdentityHash) != 64 {
		t.Fatalf("prior/input identity hashes must be sha256 digests: %q %q", hr.PriorsIdentityHash, hr.InputIdentityHash)
	}
	// Reference conditions must be declared and must not claim lab LTHR.
	if hr.ReferenceCondition == "" {
		t.Fatal("reference conditions of HRsteady(v60) must be declared")
	}
	// The snapshot publishes the joint center; never nil with a valid series.
	if result.Snapshot.ThresholdHR == nil || math.Abs(*result.Snapshot.ThresholdHR-*hr.CenterBpm) > 0.5 {
		t.Fatalf("snapshot threshold HR must carry the joint center: %v vs %v", result.Snapshot.ThresholdHR, hr.CenterBpm)
	}
	if result.Snapshot.ThresholdHRConfidence == calibration.ConfidenceNone {
		t.Fatal("threshold HR confidence must reflect the model_estimated state")
	}
}

// ---------------------------------------------------------------------------
// Synthetic model simulator and behavior fixtures
// ---------------------------------------------------------------------------

// evolvedHRSimParams carries the ground truth of the synthetic runner.
type evolvedHRSimParams struct {
	V60Mps         float64
	TauS           float64
	RestingHRBpm   float64
	MaxHRBpm       float64
	DayShiftBpm    float64
	DriftBpmPerDay float64
	StartHRBpm     float64
}

func evolvedHRDefaultSim() evolvedHRSimParams {
	// Slow drift across the window (heat/fatigue trend) is part of the truth:
	// the fit must absorb it in the drift term, never in tau or capability.
	return evolvedHRSimParams{V60Mps: 4.35, TauS: 35, RestingHRBpm: 48, MaxHRBpm: 196, StartHRBpm: 58, DriftBpmPerDay: 0.08}
}

// evolvedHRSimSteady evaluates the contract-prior shape F(r).
func evolvedHRSimShape(r float64) float64 {
	knots := [][2]float64{{0.55, 0.68}, {0.75, 0.82}, {0.90, 0.88}, {1.00, 0.92}, {1.15, 0.97}}
	switch {
	case r <= knots[0][0]:
		return math.Max(0, knots[0][1]-(knots[0][1]/knots[0][0])*(knots[0][0]-r))
	case r >= knots[len(knots)-1][0]:
		return math.Min(1.02, knots[len(knots)-1][1]+0.333*(r-knots[len(knots)-1][0]))
	}
	for i := 0; i+1 < len(knots); i++ {
		if r >= knots[i][0] && r <= knots[i+1][0] {
			s := (knots[i+1][1] - knots[i][1]) / (knots[i+1][0] - knots[i][0])
			return knots[i][1] + s*(r-knots[i][0])
		}
	}
	return 0.92
}

// evolvedHRSimActivity simulates the first-order response model dH/dt =
// (Hsteady - H)/tau at 1 Hz for a piecewise-constant speed plan.
func evolvedHRSimActivity(id string, day time.Time, p evolvedHRSimParams, plan []evolvedHRSpeedStep, ageDays float64) calibration.Activity {
	a := calibration.Activity{LabelID: id, ActivityDate: day, Sport: "run"}
	hr := p.StartHRBpm
	delta := p.MaxHRBpm - p.RestingHRBpm
	t := 0
	dist := 0.0
	for _, st := range plan {
		for i := 0; i < st.Seconds; i++ {
			hss := p.RestingHRBpm + delta*evolvedHRSimShape(st.SpeedMps/p.V60Mps) + p.DayShiftBpm + p.DriftBpmPerDay*ageDays
			hr += (hss - hr) / p.TauS
			a.Samples = append(a.Samples, calibration.Sample{
				ElapsedS:     f64p(float64(t)),
				SpeedMps:     f64p(st.SpeedMps),
				DistanceM:    f64p(dist),
				HeartRateBpm: f64p(math.Round(hr*10) / 10),
			})
			dist += st.SpeedMps
			t++
		}
	}
	return a
}

type evolvedHRSpeedStep struct {
	Seconds  int
	SpeedMps float64
}

// evolvedHRSimHistory builds a diverse four-activity window from one truth:
// constant, step-up, deceleration-recovery and warm-up shapes. Speeds follow
// the latent effort-margin model log v = a - k log(t/3600) - delta with
// k=0.06, delta=0.14 so both domains are generated from the same runner.
func evolvedHRSimHistory(asOf time.Time, p evolvedHRSimParams) []calibration.Activity {
	const k, delta = 0.06, 0.14
	v := func(durationS float64) float64 { return p.V60Mps * math.Pow(durationS/3600, -k) * math.Exp(-delta) }
	return []calibration.Activity{
		evolvedHRSimActivity("constant", asOf.AddDate(0, 0, -3), p, []evolvedHRSpeedStep{{Seconds: 2400, SpeedMps: v(2400)}}, 3),
		evolvedHRSimActivity("stepup", asOf.AddDate(0, 0, -8), p, []evolvedHRSpeedStep{{Seconds: 1200, SpeedMps: v(2700) * 0.86}, {Seconds: 1500, SpeedMps: v(2700) * 1.12}}, 8),
		evolvedHRSimActivity("recovery", asOf.AddDate(0, 0, -15), p, []evolvedHRSpeedStep{{Seconds: 1200, SpeedMps: v(2400) * 1.1}, {Seconds: 1200, SpeedMps: 1.4}}, 15),
		evolvedHRSimActivity("warmup", asOf.AddDate(0, 0, -22), p, []evolvedHRSpeedStep{{Seconds: 2700, SpeedMps: v(2700) * 0.94}}, 22),
	}
}

// TestEvolvedHRSyntheticParameterRecovery: the ticket's "known tau/curve
// parameter recovery check". A synthetic runner (tau=35, hrRest=48, hrMax=196,
// v60=4.35, contract shape) over constant/step/recovery/warm-up series must
// recover the dynamics and the bridge-pinned HRsteady(v60) within tolerance.
func TestEvolvedHRSyntheticParameterRecovery(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	p := evolvedHRDefaultSim()
	result, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, evolvedHRSimHistory(asOf, p), asOf, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	hr := result.Evolved.HR
	if hr.State != calibration.StateModelEstimated {
		t.Fatalf("state=%s reasons=%v", hr.State, hr.Reasons)
	}
	if hr.CenterBpm == nil || hr.TauS == nil || hr.RestingHRBpm == nil || hr.HRMaxBpm == nil {
		t.Fatalf("fitted parameters missing: %+v", hr)
	}
	truth := p.RestingHRBpm + (p.MaxHRBpm-p.RestingHRBpm)*evolvedHRSimShape(1.0)
	if math.Abs(*hr.CenterBpm-truth) > 7 {
		t.Fatalf("HRsteady(v60) not recovered: got %v want ~%v", *hr.CenterBpm, truth)
	}
	if math.Abs(*hr.TauS-p.TauS) > 12 {
		t.Fatalf("tau not recovered: got %v want ~%v", *hr.TauS, p.TauS)
	}
	if math.Abs(*hr.RestingHRBpm-p.RestingHRBpm) > 8 {
		t.Fatalf("resting HR not recovered: got %v want ~%v", *hr.RestingHRBpm, p.RestingHRBpm)
	}
	if math.Abs(*hr.HRMaxBpm-p.MaxHRBpm) > 12 {
		t.Fatalf("HRmax not recovered: got %v want ~%v", *hr.HRMaxBpm, p.MaxHRBpm)
	}
	if hr.BridgeFraction == nil || math.Abs(*hr.BridgeFraction-0.92) > 0.05 {
		t.Fatalf("bridge fraction must stay pinned near 0.92: %+v", hr.BridgeFraction)
	}
	if hr.DriftBpmPerDay == nil || math.Abs(*hr.DriftBpmPerDay) > 0.6 {
		t.Fatalf("slow drift must be absorbed by the drift term within its prior scale: %+v", hr.DriftBpmPerDay)
	}
	// The joint refit moved the capability through the shared objective.
	if !result.Evolved.Speed.JointHRRefit {
		t.Fatal("joint HR refit must be flagged on the speed report")
	}
	if result.Evolved.Speed.CenterMps == nil || math.Abs(*result.Evolved.Speed.CenterMps-p.V60Mps)/p.V60Mps > 0.12 {
		t.Fatalf("joint v60 drifted from the generating runner: %v vs %v", result.Evolved.Speed.CenterMps, p.V60Mps)
	}
}

// TestEvolvedHRSensorArtifactsAndClockProblems: optical spikes (robust loss),
// suspected cadence lock (excluded), missing samples (gap re-init) and a
// disordered clock (excluded activity) must not fabricate or destroy the fit.
func TestEvolvedHRSensorArtifactsAndClockProblems(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	p := evolvedHRDefaultSim()
	clean := evolvedHRSimHistory(asOf, p)

	// Spikes: occasional large single-sample outliers on one activity.
	spiky := evolvedHRSimHistory(asOf, p)
	for i := range spiky[0].Samples {
		if i%433 == 200 {
			spiky[0].Samples[i].HeartRateBpm = f64p(215)
		}
	}
	base, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, clean, asOf, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	withSpikes, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, spiky, asOf, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if withSpikes.Evolved.HR.CenterBpm == nil || base.Evolved.HR.CenterBpm == nil {
		t.Fatal("both fits must produce centers")
	}
	if math.Abs(*withSpikes.Evolved.HR.CenterBpm-*base.Evolved.HR.CenterBpm) > 6 {
		t.Fatalf("optical spikes moved the center: %v vs %v", *withSpikes.Evolved.HR.CenterBpm, *base.Evolved.HR.CenterBpm)
	}

	// Suspected cadence lock: the flagged activity is excluded by role, the
	// rest of the window still fits.
	locked := append([]calibration.Activity(nil), clean...)
	lockedMeta := []calibration.CandidateMetadata{{
		ActivityID: "constant", SourceVersion: "audited-v1", EvidenceRef: "audit-1",
		HR: &calibration.CandidateHRMetadata{Protocol: "none", Sensor: "wrist_optical", SuspectedCadenceLock: true},
	}}
	lockedResult, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, locked, asOf, nil, lockedMeta)
	if err != nil {
		t.Fatal(err)
	}
	if lockedResult.Evolved.HR.CenterBpm == nil {
		t.Fatal("cadence-locked window must still fit from the other series")
	}
	foundRole := false
	for _, o := range lockedResult.Evolved.HR.Observations {
		if o.ActivityID == "constant" && strings.Contains(o.Role, "cadence_lock") {
			foundRole = true
		}
	}
	if !foundRole {
		t.Fatalf("cadence-locked activity must carry the exclusion role: %+v", lockedResult.Evolved.HR.Observations)
	}

	// Missing samples: a 3-minute HR hole splits the filter (re-init), the
	// fit stays finite.
	gappy := evolvedHRSimHistory(asOf, p)
	for i := range gappy[3].Samples {
		if *gappy[3].Samples[i].ElapsedS > 900 && *gappy[3].Samples[i].ElapsedS < 1080 {
			gappy[3].Samples[i].HeartRateBpm = nil
		}
	}
	gapResult, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, gappy, asOf, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if gapResult.Evolved.HR.CenterBpm == nil {
		t.Fatal("gap series must still fit")
	}
	reinits := 0
	for _, o := range gapResult.Evolved.HR.Observations {
		if o.ActivityID == "warmup" {
			reinits = o.InitBlocks
		}
	}
	if reinits < 2 {
		t.Fatalf("a 3-minute hole must re-initialize the filter (init blocks=%d)", reinits)
	}

	// Disordered clock: the activity is excluded, the rest still estimates.
	disordered := evolvedHRSimHistory(asOf, p)
	disordered[2].Samples[700], disordered[2].Samples[701] = disordered[2].Samples[701], disordered[2].Samples[700]
	disorderedResult, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, disordered, asOf, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if disorderedResult.Evolved.HR.CenterBpm == nil {
		t.Fatal("disordered-clock window must still fit from the clean series")
	}
	foundClock := false
	for _, o := range disorderedResult.Evolved.HR.Observations {
		if o.ActivityID == "recovery" && strings.Contains(o.Role, "non_increasing") {
			foundClock = true
		}
	}
	if !foundClock {
		t.Fatalf("disordered clock must be excluded by role: %+v", disorderedResult.Evolved.HR.Observations)
	}
}

// TestEvolvedHRFeedbackMovesCapabilityPosterior: identical speed-duration
// inputs with different credible HR responses must move the joint capability
// in the physiological direction (higher HR at the same speed = lower
// capability), while the speed-only fits are identical - the difference is
// the HR soft feedback, not noise. Noisier HR widens the HR sensitivity.
func TestEvolvedHRFeedbackMovesCapabilityPosterior(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	faster := evolvedHRDefaultSim() // v60 4.35
	slower := evolvedHRDefaultSim()
	slower.V60Mps = 3.6 // same speeds => higher relative intensity => higher HR
	histFast := evolvedHRSimHistory(asOf, faster)
	histSlow := evolvedHRSimHistory(asOf, slower)
	// One shared near-threshold interval on both runners widens the observed
	// relative-intensity range, where the shape slope separates capability
	// from level parameters instead of letting hrRest/hrMax absorb it all.
	fastInterval := evolvedHRSimActivity("interval", asOf.AddDate(0, 0, -6), faster, []evolvedHRSpeedStep{{Seconds: 1200, SpeedMps: evolvedHRSimSpeed(1200)}, {Seconds: 900, SpeedMps: evolvedHRSimSpeed(1200) * 1.2}}, 6)
	histFast = append(histFast, fastInterval)
	histSlow = append(histSlow, evolvedHRSimActivity("interval", asOf.AddDate(0, 0, -6), slower, []evolvedHRSpeedStep{{Seconds: 1200, SpeedMps: evolvedHRSimSpeed(1200)}, {Seconds: 900, SpeedMps: evolvedHRSimSpeed(1200) * 1.2}}, 6))
	// The speed-domain observations must be identical: regenerate the slower
	// runner's activities from the faster runner's speeds.
	for i := range histSlow {
		for j := range histSlow[i].Samples {
			histSlow[i].Samples[j].SpeedMps = histFast[i].Samples[j].SpeedMps
			histSlow[i].Samples[j].DistanceM = histFast[i].Samples[j].DistanceM
		}
	}
	speedOnlyFast := calibration.FitEvolvedSpeed(evolvedTestEvidenceOf(histFast, asOf), asOf, calibration.DefaultEvolvedPriors(), nil)
	speedOnlySlow := calibration.FitEvolvedSpeed(evolvedTestEvidenceOf(histSlow, asOf), asOf, calibration.DefaultEvolvedPriors(), nil)
	if speedOnlyFast.CenterMps == nil || speedOnlySlow.CenterMps == nil || *speedOnlyFast.CenterMps != *speedOnlySlow.CenterMps {
		t.Fatalf("speed-only fits must be identical for identical speed inputs: %v vs %v", speedOnlyFast.CenterMps, speedOnlySlow.CenterMps)
	}
	resFast, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, histFast, asOf, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	resSlow, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, histSlow, asOf, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resFast.Evolved.Speed.CenterMps == nil || resSlow.Evolved.Speed.CenterMps == nil {
		t.Fatal("joint fits must produce capabilities")
	}
	t.Logf("joint: fast=%v slow=%v speed-only=%v", *resFast.Evolved.Speed.CenterMps, *resSlow.Evolved.Speed.CenterMps, *speedOnlyFast.CenterMps)
	// The channel is deliberately soft (the F bridge bounds how far HR can
	// move v60): the direction must hold and the move must be explainable in
	// the report's own curvature vocabulary, never a silent rescale.
	if !(*resFast.Evolved.Speed.CenterMps > *resSlow.Evolved.Speed.CenterMps+0.005) {
		t.Fatalf("credible higher HR at the same speed must lower the joint capability: %v vs %v", *resFast.Evolved.Speed.CenterMps, *resSlow.Evolved.Speed.CenterMps)
	}
	if resFast.Evolved.HR.DataCurvature <= 0 || resFast.Evolved.HR.PriorCurvatureShare >= 1 {
		t.Fatalf("HR data must carry explainable curvature: %+v", resFast.Evolved.HR)
	}
	// The HR centers move the same way and stay physiological.
	if !(*resFast.Evolved.HR.CenterBpm < *resSlow.Evolved.HR.CenterBpm) {
		t.Fatalf("HR centers must reflect the responses: %v vs %v", *resFast.Evolved.HR.CenterBpm, *resSlow.Evolved.HR.CenterBpm)
	}
	// Duplicating the same activities must not change anything (identity
	// dedup, one budget per root): same center, same input identity, no
	// manufactured certainty.
	dup, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, append(append([]calibration.Activity{}, histFast...), histFast...), asOf, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if *dup.Evolved.HR.CenterBpm != *resFast.Evolved.HR.CenterBpm || dup.Evolved.HR.InputIdentityHash != resFast.Evolved.HR.InputIdentityHash {
		t.Fatal("duplicated activities changed the HR estimate or its input identity")
	}
	if dup.Evolved.HR.EffectiveCurvature > resFast.Evolved.HR.EffectiveCurvature*1.0001 {
		t.Fatal("duplicated activities manufactured certainty (effective curvature grew)")
	}
	// Deterministic block-level noise (alternating +/-9 bpm over 30s spans)
	// widens the HR sensitivity and cannot manufacture confidence. Deep-copy
	// the sample slices so the pristine fixtures stay pristine.
	noisy := make([]calibration.Activity, len(histFast))
	for i := range histFast {
		noisy[i] = histFast[i]
		noisy[i].Samples = append([]calibration.Sample(nil), histFast[i].Samples...)
	}
	for i := range noisy {
		for j := range noisy[i].Samples {
			sign := 1.0
			if (j/30)%2 == 1 {
				sign = -1
			}
			noisy[i].Samples[j].HeartRateBpm = f64p(*noisy[i].Samples[j].HeartRateBpm + sign*9)
		}
	}
	resNoisy, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, noisy, asOf, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resNoisy.Evolved.HR.PosteriorSDBpm <= resFast.Evolved.HR.PosteriorSDBpm {
		t.Fatalf("noisy HR must widen the sensitivity: %v vs %v", resNoisy.Evolved.HR.PosteriorSDBpm, resFast.Evolved.HR.PosteriorSDBpm)
	}
}

// evolvedTestEvidenceOf extracts the admitted evidence of a history through
// the shared pipeline (assembly equivalence for pure-seam comparisons).
func evolvedTestEvidenceOf(history []calibration.Activity, asOf time.Time) []calibration.CandidateEvidence {
	res, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, history, asOf, nil, nil)
	if err != nil {
		panic(err)
	}
	return res.Evidence.Candidates
}

// TestEvolvedHRSpeedRangePropagatesIntoHRRange: a window whose speed side is
// weakly identified (narrow duration/speed diversity) must propagate its
// wider v60 range into a wider HR range - the propagation is one-way, from
// speed uncertainty into HR uncertainty, never independent HR tightening.
func TestEvolvedHRSpeedRangePropagatesIntoHRRange(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	p := evolvedHRDefaultSim()
	wide := []calibration.Activity{
		evolvedHRSimActivity("wd1", asOf.AddDate(0, 0, -2), p, []evolvedHRSpeedStep{{Seconds: 1800, SpeedMps: evolvedHRSimSpeed(1800)}}, 2),
		evolvedHRSimActivity("wd2", asOf.AddDate(0, 0, -5), p, []evolvedHRSpeedStep{{Seconds: 3600, SpeedMps: evolvedHRSimSpeed(3600)}}, 5),
		evolvedHRSimActivity("wd3", asOf.AddDate(0, 0, -12), p, []evolvedHRSpeedStep{{Seconds: 5400, SpeedMps: evolvedHRSimSpeed(5400)}}, 12),
		evolvedHRSimActivity("wd4", asOf.AddDate(0, 0, -20), p, []evolvedHRSpeedStep{{Seconds: 1200, SpeedMps: evolvedHRSimSpeed(1200)}, {Seconds: 1500, SpeedMps: evolvedHRSimSpeed(2700) * 1.14}}, 20),
	}
	resWide, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, wide, asOf, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Narrow: same runner, every session at the same duration and near speed.
	narrow := []calibration.Activity{
		evolvedHRSimActivity("n1", asOf.AddDate(0, 0, -4), p, []evolvedHRSpeedStep{{Seconds: 2400, SpeedMps: evolvedHRSimSpeed(2400)}}, 4),
		evolvedHRSimActivity("n2", asOf.AddDate(0, 0, -11), p, []evolvedHRSpeedStep{{Seconds: 2400, SpeedMps: evolvedHRSimSpeed(2400) * 1.01}}, 11),
		evolvedHRSimActivity("n3", asOf.AddDate(0, 0, -25), p, []evolvedHRSpeedStep{{Seconds: 2400, SpeedMps: evolvedHRSimSpeed(2400) * 0.99}}, 25),
	}
	resNarrow, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, narrow, asOf, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	speedWide, speedNarrow := resWide.Evolved.Speed, resNarrow.Evolved.Speed
	if *speedNarrow.RangeHighMps / *speedNarrow.RangeLowMps <= *speedWide.RangeHighMps / *speedWide.RangeLowMps {
		t.Fatalf("fixture sanity: narrow speed range must be wider: %v vs %v", *speedNarrow.RangeHighMps / *speedNarrow.RangeLowMps, *speedWide.RangeHighMps / *speedWide.RangeLowMps)
	}
	hrWide, hrNarrow := resWide.Evolved.HR, resNarrow.Evolved.HR
	if *hrNarrow.RangeHighBpm-*hrNarrow.RangeLowBpm <= *hrWide.RangeHighBpm-*hrWide.RangeLowBpm {
		t.Fatalf("wider v60 range must propagate into a wider HR range: %v vs %v", *hrNarrow.RangeHighBpm-*hrNarrow.RangeLowBpm, *hrWide.RangeHighBpm-*hrWide.RangeLowBpm)
	}
	if hrNarrow.SpeedEnvelopeHighBpm == nil || hrWide.SpeedEnvelopeHighBpm == nil {
		t.Fatal("speed-envelope propagation must be published")
	}
	if math.Abs(*hrNarrow.SpeedEnvelopeHighBpm-*hrNarrow.SpeedEnvelopeLowBpm) <= math.Abs(*hrWide.SpeedEnvelopeHighBpm-*hrWide.SpeedEnvelopeLowBpm) {
		t.Fatalf("envelope spread must widen with the v60 range: %v vs %v",
			math.Abs(*hrNarrow.SpeedEnvelopeHighBpm-*hrNarrow.SpeedEnvelopeLowBpm), math.Abs(*hrWide.SpeedEnvelopeHighBpm-*hrWide.SpeedEnvelopeLowBpm))
	}
	// The published range must cover the envelope evaluations (v60 range in).
	lo := math.Min(*hrNarrow.RangeLowBpm, math.Min(*hrNarrow.SpeedEnvelopeLowBpm, *hrNarrow.SpeedEnvelopeHighBpm))
	hi := math.Max(*hrNarrow.RangeHighBpm, math.Max(*hrNarrow.SpeedEnvelopeLowBpm, *hrNarrow.SpeedEnvelopeHighBpm))
	if *hrNarrow.RangeLowBpm > lo+1e-9 || *hrNarrow.RangeHighBpm < hi-1e-9 {
		t.Fatalf("HR range must cover the speed envelope: [%v,%v] vs [%v,%v]", *hrNarrow.RangeLowBpm, *hrNarrow.RangeHighBpm, lo, hi)
	}
}

// evolvedHRSimSpeed is the effort-margin speed of the default runner at one
// duration (shared by the propagation fixtures).
func evolvedHRSimSpeed(durationS float64) float64 {
	return 4.35 * math.Pow(durationS/3600, -0.06) * math.Exp(-0.14)
}

// TestEvolvedHRStatesAcrossWindows: the HR five-state contract across
// windows - no input at all (unavailable with reason), resting-HR rows only
// (prior_dominated, bridge-composed center), ordinary series
// (model_estimated), verified protocol (measured_reference keeps its own
// source), stale-only support, and rejected-protocol history staying
// separated from the current estimate.
func TestEvolvedHRStatesAcrossWindows(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	p := evolvedHRDefaultSim()

	// No HR anywhere and no physiological prior: unavailable with the
	// categorical reason, never a fabricated constant.
	bare := []calibration.Activity{
		evolvedRunActivity("a", asOf.AddDate(0, 0, -3), 3600, 3.3),
		evolvedRunActivity("b", asOf.AddDate(0, 0, -9), 5400, 3.0),
	}
	resBare, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, bare, asOf, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resBare.Evolved.HR.State != calibration.StateUnavailable || resBare.Evolved.HR.CenterBpm != nil {
		t.Fatalf("no-input HR must be unavailable without center: %+v", resBare.Evolved.HR)
	}
	found := false
	for _, r := range resBare.Evolved.HR.Reasons {
		if r == calibration.ReasonNoHRSeriesOrPrior {
			found = true
		}
	}
	if !found {
		t.Fatalf("unavailable reason missing: %v", resBare.Evolved.HR.Reasons)
	}

	// Resting-HR rows only: qualified physiological prior, finite
	// prior_dominated center composed through the bridge (no 185/90% truth).
	health := []calibration.HealthRow{}
	for d := 0; d < 30; d++ {
		v := 50.0
		health = append(health, calibration.HealthRow{Date: asOf.AddDate(0, 0, -d), RHR: &v})
	}
	resPrior, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, bare, asOf, health, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resPrior.Evolved.HR.State != calibration.StatePriorDominated {
		t.Fatalf("prior-only state=%s", resPrior.Evolved.HR.State)
	}
	if resPrior.Evolved.HR.CenterBpm == nil {
		t.Fatal("prior-only must publish a center")
	}
	wantPrior := 50.0 + (188.0-50.0)*0.92
	if math.Abs(*resPrior.Evolved.HR.CenterBpm-wantPrior) > 0.01 {
		t.Fatalf("prior-only center must be the RHR-bridged composition: %v want %v", *resPrior.Evolved.HR.CenterBpm, wantPrior)
	}
	if resPrior.Snapshot.ThresholdHRConfidence != calibration.ConfidenceLow {
		t.Fatalf("prior-only confidence=%s", resPrior.Snapshot.ThresholdHRConfidence)
	}

	// Ordinary series: model_estimated (covered in depth above).
	resModel, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, evolvedHRSimHistory(asOf, p), asOf, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resModel.Evolved.HR.State != calibration.StateModelEstimated {
		t.Fatalf("ordinary series state=%s", resModel.Evolved.HR.State)
	}
	if resModel.Snapshot.ThresholdHRConfidence != calibration.ConfidenceMedium {
		t.Fatalf("model_estimated confidence=%s", resModel.Snapshot.ThresholdHRConfidence)
	}

	// Verified field protocol: measured_reference keeps its own source and
	// centers on the protocol value; the model prediction is published
	// separately and never masquerades as a lab LTHR.
	fieldAct, fieldMeta, _ := hrProtocolFixture()
	withRef := append(evolvedHRSimHistory(asOf, p), fieldAct)
	resRef, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, withRef, asOf, nil, []calibration.CandidateMetadata{fieldMeta})
	if err != nil {
		t.Fatal(err)
	}
	if resRef.Evolved.HR.State != calibration.StateMeasuredReference {
		t.Fatalf("verified protocol state=%s reasons=%v", resRef.Evolved.HR.State, resRef.Evolved.HR.Reasons)
	}
	if resRef.Evolved.HR.CenterBpm == nil || math.Abs(*resRef.Evolved.HR.CenterBpm-170) > 0.5 {
		t.Fatalf("measured reference must center on the protocol value: %+v", resRef.Evolved.HR.CenterBpm)
	}
	if resRef.Evolved.HR.ModelCenterBpm == nil {
		t.Fatal("joint model center must still be published alongside the reference")
	}
	if strings.Contains(resRef.Evolved.HR.TargetType, "LTHR") && !strings.Contains(resRef.Evolved.HR.TargetType, "not_") {
		t.Fatalf("target type must not claim lab LTHR: %q", resRef.Evolved.HR.TargetType)
	}

	// Stale-only support: series older than the 60-day HR window keeps a
	// finite center flagged stale.
	staleHistory := []calibration.Activity{
		evolvedHRSimActivity("s1", asOf.AddDate(0, 0, -80), p, []evolvedHRSpeedStep{{Seconds: 2400, SpeedMps: evolvedHRSimSpeed(2400)}}, 80),
		evolvedHRSimActivity("s2", asOf.AddDate(0, 0, -95), p, []evolvedHRSpeedStep{{Seconds: 2700, SpeedMps: evolvedHRSimSpeed(2700)}}, 95),
	}
	resStale, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, staleHistory, asOf, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resStale.Evolved.HR.State != calibration.StateStale {
		t.Fatalf("stale-only state=%s", resStale.Evolved.HR.State)
	}
	if resStale.Evolved.HR.CenterBpm == nil || !evolvedFinite(*resStale.Evolved.HR.CenterBpm) {
		t.Fatalf("stale must keep a finite center: %+v", resStale.Evolved.HR.CenterBpm)
	}

	// A verified-but-stale protocol stays as separated rejected history: it
	// neither becomes the center nor contaminates the current reasons.
	oldDay := asOf.AddDate(0, 0, -70)
	oldAct, oldMeta, _ := hrProtocolFixture()
	oldAct.ActivityDate = oldDay
	oldMeta.ActivityID = oldAct.LabelID
	resRejected, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, append(evolvedHRSimHistory(asOf, p), oldAct), asOf, nil, []calibration.CandidateMetadata{oldMeta})
	if err != nil {
		t.Fatal(err)
	}
	if resRejected.Evolved.HR.State != calibration.StateModelEstimated {
		t.Fatalf("stale protocol must not raise the state: %s", resRejected.Evolved.HR.State)
	}
	summary := calibration.SummarizeSource(resRejected)
	if summary.HR == nil || summary.HR.LatestRejectedEvidenceDate != oldDay.Format("2006-01-02") {
		t.Fatalf("rejected protocol history must stay separated: %+v", summary.HR)
	}
	for _, r := range summary.HR.Reasons {
		if strings.Contains(r, "stale_HR_support") {
			t.Fatalf("rejected history leaked into current reasons: %v", summary.HR.Reasons)
		}
	}
}

// TestEvolvedHRSeriesFutureActivitiesCannotChangePastFit: HR series dated
// after the as-of instant never enter the joint fit (time machine).
func TestEvolvedHRSeriesFutureActivitiesCannotChangePastFit(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	p := evolvedHRDefaultSim()
	past := evolvedHRSimHistory(asOf, p)
	future := evolvedHRSimActivity("future", asOf.AddDate(0, 0, 5), p, []evolvedHRSpeedStep{{Seconds: 2400, SpeedMps: evolvedHRSimSpeed(2400) * 1.3}}, -5)
	base, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, past, asOf, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	withFuture, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, append(append([]calibration.Activity{}, past...), future), asOf, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if *withFuture.Evolved.HR.CenterBpm != *base.Evolved.HR.CenterBpm || withFuture.Evolved.HR.InputIdentityHash != base.Evolved.HR.InputIdentityHash {
		t.Fatalf("future HR series changed the past fit: %v vs %v", *withFuture.Evolved.HR.CenterBpm, *base.Evolved.HR.CenterBpm)
	}
	if *withFuture.Evolved.Speed.CenterMps != *base.Evolved.Speed.CenterMps {
		t.Fatal("future HR series changed the past capability")
	}
}

// TestEvolvedHRSummaryAndConfidenceWiring: the SourceSummary carries the HR
// five-state, method, model-prediction target type (never an LTHR claim),
// ranges and sensor-labelled evidence; the derived speed labels replace the
// old hardcoded tags.
func TestEvolvedHRSummaryAndConfidenceWiring(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	result, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, evolvedHRSimHistory(asOf, evolvedHRDefaultSim()), asOf, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	summary := calibration.SummarizeSource(result)
	if summary.HR == nil {
		t.Fatal("HR summary missing")
	}
	hr := summary.HR
	if hr.State != string(calibration.StateModelEstimated) || hr.Method == "" {
		t.Fatalf("HR summary state/method: %+v", hr)
	}
	if strings.Contains(hr.TargetType, "LTHR") {
		t.Fatalf("model HR target type must not claim LTHR: %q", hr.TargetType)
	}
	if hr.RangeLow == nil || hr.RangeHigh == nil || hr.RangeMeaning == "unavailable" {
		t.Fatalf("HR summary must publish the sensitivity range: %+v", hr)
	}
	if hr.EvidenceCount == 0 || len(hr.Evidence) == 0 {
		t.Fatalf("HR summary evidence missing: %+v", hr)
	}
	for _, e := range hr.Evidence {
		if !strings.HasPrefix(e.MeasurementQuality, "sensor_") {
			t.Fatalf("HR evidence must label the sensor source: %+v", e)
		}
	}
	if sp := summary.Speed; sp == nil || sp.MeasurementQuality == "model_fit" || sp.EffortSupport == "mixed_ordinary_training" {
		t.Fatalf("speed labels must be derived, not hardcoded: %+v", sp)
	}
	// Round-trip through the persisted JSON shape.
	raw, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	parsed := calibration.ParseSource((*string)(&[]string{string(raw)}[0]))
	if parsed.HR == nil || parsed.HR.State != hr.State {
		t.Fatalf("HR state lost in serialization: %+v", parsed.HR)
	}
}

// ---------------------------------------------------------------------------
// Review P1 regressions (2026-11-16 FAIL -> fix round)
// ---------------------------------------------------------------------------

// TestEvolvedHRSameRootAliasesCannotMultiplySupport (review P1-1): re-uploaded
// content under new activity IDs sharing one RootActivityID must not multiply
// the HR support - the HR budget shares one unit per root (mirroring the
// speed side), so weights, curvature and the joint center all stay put.
func TestEvolvedHRSameRootAliasesCannotMultiplySupport(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	p := evolvedHRDefaultSim()
	base := []calibration.Activity{
		evolvedHRSimActivity("solo", asOf.AddDate(0, 0, -3), p, []evolvedHRSpeedStep{{Seconds: 2400, SpeedMps: evolvedHRSimSpeed(2400)}}, 3),
	}
	resBase, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, base, asOf, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Same content twice under alias IDs sharing one root via metadata.
	aliased := []calibration.Activity{
		evolvedHRSimActivity("alias-1", asOf.AddDate(0, 0, -3), p, []evolvedHRSpeedStep{{Seconds: 2400, SpeedMps: evolvedHRSimSpeed(2400)}}, 3),
		evolvedHRSimActivity("alias-2", asOf.AddDate(0, 0, -3), p, []evolvedHRSpeedStep{{Seconds: 2400, SpeedMps: evolvedHRSimSpeed(2400)}}, 3),
	}
	meta := []calibration.CandidateMetadata{
		{ActivityID: "alias-1", RootActivityID: "shared-root", SourceVersion: "audited-v1", EvidenceRef: "r1"},
		{ActivityID: "alias-2", RootActivityID: "shared-root", SourceVersion: "audited-v1", EvidenceRef: "r2"},
	}
	resAlias, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, aliased, asOf, nil, meta)
	if err != nil {
		t.Fatal(err)
	}
	hrBase, hrAlias := resBase.Evolved.HR, resAlias.Evolved.HR
	if hrBase.CenterBpm == nil || hrAlias.CenterBpm == nil {
		t.Fatal("both fits must produce centers")
	}
	totalWeight := func(hr *calibration.EvolvedHRReport) float64 {
		sum := 0.0
		for _, o := range hr.Observations {
			sum += o.Weight
		}
		return sum
	}
	if math.Abs(totalWeight(hrAlias)-totalWeight(hrBase)) > 1e-9 {
		t.Fatalf("same-root aliases changed the total HR weight: %v vs %v", totalWeight(hrAlias), totalWeight(hrBase))
	}
	if hrAlias.EffectiveCurvature > hrBase.EffectiveCurvature*1.0001 {
		t.Fatalf("same-root aliases manufactured certainty: %v vs %v", hrAlias.EffectiveCurvature, hrBase.EffectiveCurvature)
	}
	// The weighted objective is mathematically identical, but two aliased
	// activities accumulate float sums in a different order, so equality is
	// asserted at round-off scale - four orders below the ~0.01 m/s support
	// inflation this test guards against.
	if d := math.Abs(*hrAlias.CenterBpm - *hrBase.CenterBpm); d > 1e-8 {
		t.Fatalf("same-root aliases moved the HR center: %v vs %v (delta %v)", *hrAlias.CenterBpm, *hrBase.CenterBpm, d)
	}
	if resAlias.Evolved.Speed.CenterMps == nil || resBase.Evolved.Speed.CenterMps == nil ||
		math.Abs(*resAlias.Evolved.Speed.CenterMps-*resBase.Evolved.Speed.CenterMps) > 1e-9 {
		t.Fatalf("same-root aliases moved the joint capability: %v vs %v", resAlias.Evolved.Speed.CenterMps, resBase.Evolved.Speed.CenterMps)
	}
}

// TestEvolvedHRAllSeriesQualityExcludedStateIsHonest (review P1-2): when the
// window holds a valid HR series but every row was excluded by the quality
// gates, the prior-composed output must be prior_dominated (never
// model_estimated dressed on a prior), or unavailable with BOTH categorical
// reasons when no qualified physiological prior exists.
func TestEvolvedHRAllSeriesQualityExcludedStateIsHonest(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	p := evolvedHRDefaultSim()
	history := evolvedHRSimHistory(asOf, p)
	lockAll := []calibration.CandidateMetadata{}
	for _, id := range []string{"constant", "stepup", "recovery", "warmup"} {
		lockAll = append(lockAll, calibration.CandidateMetadata{
			ActivityID: id, SourceVersion: "audited-v1", EvidenceRef: "lock-" + id,
			HR: &calibration.CandidateHRMetadata{Protocol: "none", Sensor: "wrist_optical", SuspectedCadenceLock: true},
		})
	}
	rhr := 52.0
	health := []calibration.HealthRow{{Date: asOf.AddDate(0, 0, -5), RHR: &rhr}}

	// With a qualified physiological prior: finite prior_dominated estimate
	// with the quality-exclusion and prior-only reasons; never medium.
	withPrior, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, history, asOf, health, lockAll)
	if err != nil {
		t.Fatal(err)
	}
	hr := withPrior.Evolved.HR
	if hr.State != calibration.StatePriorDominated {
		t.Fatalf("all-quality-excluded with prior must be prior_dominated, got %s (reasons %v)", hr.State, hr.Reasons)
	}
	if hr.CenterBpm == nil {
		t.Fatal("prior branch must publish a center")
	}
	wantPrior := 52.0 + (188.0-52.0)*0.92
	if math.Abs(*hr.CenterBpm-wantPrior) > 0.01 {
		t.Fatalf("center must be the RHR-bridged composition: %v want %v", *hr.CenterBpm, wantPrior)
	}
	foundExcluded, foundPriorOnly := false, false
	for _, r := range hr.Reasons {
		if r == calibration.ReasonHRSeriesQualityExcluded {
			foundExcluded = true
		}
		if r == calibration.ReasonPriorOnlyHR {
			foundPriorOnly = true
		}
	}
	if !foundExcluded || !foundPriorOnly {
		t.Fatalf("reasons must name the quality exclusion and the prior-only composition: %v", hr.Reasons)
	}
	if withPrior.Snapshot.ThresholdHRConfidence != calibration.ConfidenceLow {
		t.Fatalf("prior-only confidence must be low, got %s", withPrior.Snapshot.ThresholdHRConfidence)
	}

	// Without a qualified prior: unavailable with BOTH categorical reasons -
	// the series existed, the quality gates excluded it, no prior remains.
	withoutPrior, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, history, asOf, nil, lockAll)
	if err != nil {
		t.Fatal(err)
	}
	hr2 := withoutPrior.Evolved.HR
	if hr2.State != calibration.StateUnavailable || hr2.CenterBpm != nil {
		t.Fatalf("all-quality-excluded without prior must be unavailable without center: %+v", hr2)
	}
	foundNoPrior, foundExcluded2 := false, false
	for _, r := range hr2.Reasons {
		if r == calibration.ReasonNoHRSeriesOrPrior {
			foundNoPrior = true
		}
		if r == calibration.ReasonHRSeriesQualityExcluded {
			foundExcluded2 = true
		}
	}
	if !foundNoPrior || !foundExcluded2 {
		t.Fatalf("unavailable must carry both categorical reasons: %v", hr2.Reasons)
	}
}

// TestEvolvedHRSpeedlessPriorSpreadWidensHRRange (review P1-3): with a usable
// HR series but no admissible speed observation (sub-model-domain durations),
// the v60 prior spread must propagate into the HR range via the prior-sd
// envelope - the range may not stay at the level-only ~14 bpm width.
func TestEvolvedHRSpeedlessPriorSpreadWidensHRRange(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	p := evolvedHRDefaultSim()
	// 150 s activities: enough HR blocks (5 per series), too short for any
	// speed observation (model domain starts at 180 s) and no historical
	// prior - the speed side is honestly unavailable.
	history := []calibration.Activity{
		evolvedHRSimActivity("short-a", asOf.AddDate(0, 0, -2), p, []evolvedHRSpeedStep{{Seconds: 150, SpeedMps: evolvedHRSimSpeed(150)}}, 2),
		evolvedHRSimActivity("short-b", asOf.AddDate(0, 0, -6), p, []evolvedHRSpeedStep{{Seconds: 150, SpeedMps: evolvedHRSimSpeed(150)}}, 6),
		evolvedHRSimActivity("short-c", asOf.AddDate(0, 0, -11), p, []evolvedHRSpeedStep{{Seconds: 150, SpeedMps: evolvedHRSimSpeed(150)}}, 11),
	}
	result, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, history, asOf, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	hr := result.Evolved.HR
	if result.Evolved.Speed.CenterMps != nil {
		t.Fatal("fixture sanity: sub-180s window must leave the speed side unavailable")
	}
	if hr.State != calibration.StateModelEstimated {
		t.Fatalf("HR series alone is model_estimated for HR: %s (reasons %v)", hr.State, hr.Reasons)
	}
	if hr.CenterBpm == nil || hr.RangeLowBpm == nil || hr.RangeHighBpm == nil {
		t.Fatalf("speedless joint fit must publish center and range: %+v", hr)
	}
	foundReason := false
	for _, r := range hr.Reasons {
		if r == "speed_basis_absent_v60_prior_only" {
			foundReason = true
		}
	}
	if !foundReason {
		t.Fatalf("speedless reason must be stamped: %v", hr.Reasons)
	}
	if hr.SpeedEnvelopeLowBpm == nil || hr.SpeedEnvelopeHighBpm == nil {
		t.Fatal("prior-sd envelope must be published for the speedless case")
	}
	spread := math.Abs(*hr.SpeedEnvelopeHighBpm - *hr.SpeedEnvelopeLowBpm)
	if spread < 5 {
		t.Fatalf("prior-sd envelope must be non-degenerate: spread %v", spread)
	}
	width := *hr.RangeHighBpm - *hr.RangeLowBpm
	if width < 25 {
		t.Fatalf("v60 prior spread must widen the HR range beyond the level-only width: %v", width)
	}
	if *hr.RangeLowBpm > math.Min(*hr.SpeedEnvelopeLowBpm, *hr.SpeedEnvelopeHighBpm)-1e-9 ||
		*hr.RangeHighBpm < math.Max(*hr.SpeedEnvelopeLowBpm, *hr.SpeedEnvelopeHighBpm)-1e-9 {
		t.Fatalf("HR range must cover the prior-sd envelope: [%v,%v] vs [%v,%v]",
			*hr.RangeLowBpm, *hr.RangeHighBpm, *hr.SpeedEnvelopeLowBpm, *hr.SpeedEnvelopeHighBpm)
	}
}
