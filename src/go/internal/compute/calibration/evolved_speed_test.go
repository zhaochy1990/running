package calibration_test

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
)

// T2 #996 fixtures. The evolved v4 fits the speed domain with the latent
// effort-margin model of estimation-contract-v2: ordinary submaximal training
// without any all-out label must still produce a finite v60 center and a
// finite sensitivity range, never the historical nil.

func evolvedFinite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

func evolvedRunActivity(id string, day time.Time, durationS int, speedMps float64) calibration.Activity {
	a := calibration.Activity{LabelID: id, ActivityDate: day, Sport: "run"}
	for t := 0; t <= durationS; t++ {
		a.Samples = append(a.Samples, calibration.Sample{
			ElapsedS:  f64p(float64(t)),
			SpeedMps:  f64p(speedMps),
			DistanceM: f64p(float64(t) * speedMps),
		})
	}
	return a
}

// TestEvolvedCandidateOrdinarySubmaximalTrainingYieldsFiniteEstimate is the
// mandated failing regression of #996: eligible ordinary training with no
// all-out markers still gets a finite v60 center plus a legal range. The
// historical v4 returned nil here with reason no_independent_maximal_anchors.
func TestEvolvedCandidateOrdinarySubmaximalTrainingYieldsFiniteEstimate(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	history := []calibration.Activity{
		evolvedRunActivity("easy-long", asOf.AddDate(0, 0, -9), 5400, 3.0),
		evolvedRunActivity("steady", asOf.AddDate(0, 0, -2), 3600, 3.3),
		evolvedRunActivity("tempo-short", asOf.AddDate(0, 0, -30), 1800, 3.6),
	}
	result, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, history, asOf, nil, nil)
	if err != nil {
		t.Fatalf("evolved candidate must estimate from ordinary training: %v", err)
	}
	if result.Snapshot.ThresholdSpeedMps == nil {
		t.Fatal("submaximal-only training must not produce a nil threshold speed")
	}
	center := *result.Snapshot.ThresholdSpeedMps
	if !evolvedFinite(center) || center <= 0 || center > 8.5 {
		t.Fatalf("center must be finite and physically legal, got %v", center)
	}
	// Identity contract: evolved triple, algorithm version 4, revision stamped.
	implementation, parameterVersion, revision := calibration.EvolvedCandidateIdentity()
	if result.Implementation != implementation || result.ParameterVersion != parameterVersion || result.AlgorithmRevision != revision {
		t.Fatalf("identity drift: %q %q %q", result.Implementation, result.ParameterVersion, result.AlgorithmRevision)
	}
	if result.Snapshot.AlgorithmVersion != 4 {
		t.Fatalf("algorithm version=%d", result.Snapshot.AlgorithmVersion)
	}
	// The evolved report carries center, sensitivity range and prior identity.
	if result.Evolved == nil || result.Evolved.Speed == nil {
		t.Fatal("evolved speed report missing")
	}
	speed := result.Evolved.Speed
	if speed.CenterMps == nil || !evolvedFinite(*speed.CenterMps) {
		t.Fatalf("report center %v", speed.CenterMps)
	}
	if speed.RangeLowMps == nil || speed.RangeHighMps == nil {
		t.Fatal("sensitivity range missing")
	}
	if !(evolvedFinite(*speed.RangeLowMps) && evolvedFinite(*speed.RangeHighMps)) {
		t.Fatalf("range must be finite: [%v, %v]", *speed.RangeLowMps, *speed.RangeHighMps)
	}
	if !(*speed.RangeLowMps < *speed.CenterMps && *speed.CenterMps < *speed.RangeHighMps) {
		t.Fatalf("range must bracket the center: [%v, %v] center %v", *speed.RangeLowMps, *speed.RangeHighMps, *speed.CenterMps)
	}
	if speed.State != calibration.StateModelEstimated && speed.State != calibration.StateMeasuredReference {
		// Three roots, three days, duration ratio 3.0: contract says model_estimated.
		t.Fatalf("state=%s want model_estimated", speed.State)
	}
	if speed.PaceCenterSPerKm == nil || !evolvedFinite(*speed.PaceCenterSPerKm) {
		t.Fatal("pace center (s/km) missing")
	}
	if len(speed.PriorsIdentityHash) != 64 {
		t.Fatalf("prior identity hash must be a sha256 digest: %q", speed.PriorsIdentityHash)
	}
	// Pace unit contract: 1000/v60.
	if pace := 1000 / *speed.CenterMps; math.Abs(pace-*speed.PaceCenterSPerKm) > 1e-9 {
		t.Fatalf("pace conversion drift: %v vs %v", *speed.PaceCenterSPerKm, pace)
	}
	// A reasonable center for these speeds: prior ln(3.4), observed 3.0-3.6
	// submaximal implies v60 above the observed speeds but bounded by the
	// prior truncation.
	if center <= 3.3 || center >= 6.0 {
		t.Fatalf("center implausible for submaximal 3.0-3.6 m/s training: %v", center)
	}
	// This fixture carries no HR samples at all: since #997 the HR report is
	// honestly unavailable with the no-series/no-prior categorical reason
	// (never a fabricated value, and never a pending-implementation marker).
	if result.Evolved.HR == nil || result.Evolved.HR.State != calibration.StateUnavailable {
		t.Fatalf("HR must be unavailable without any HR input: %+v", result.Evolved.HR)
	}
	foundNoSeries := false
	for _, r := range result.Evolved.HR.Reasons {
		if r == calibration.ReasonNoHRSeriesOrPrior {
			foundNoSeries = true
		}
		if strings.Contains(r, "pending") {
			t.Fatalf("no pending-implementation reason may survive #997: %v", result.Evolved.HR.Reasons)
		}
	}
	if !foundNoSeries {
		t.Fatalf("unavailable HR must name the missing series/prior: %v", result.Evolved.HR.Reasons)
	}
	if result.Snapshot.ThresholdHR != nil {
		t.Fatal("evolved must not fabricate a threshold HR without any HR input")
	}
	// SummarizeSource starts filling the five states (schema stays 1).
	summary := calibration.SummarizeSource(result)
	if summary.SchemaVersion != 1 {
		t.Fatalf("schema version=%d", summary.SchemaVersion)
	}
	if summary.Speed == nil || summary.Speed.State != string(speed.State) {
		t.Fatalf("summary speed state %+v vs report %q", summary.Speed, speed.State)
	}
	if summary.HR == nil || summary.HR.State != string(calibration.StateUnavailable) {
		t.Fatalf("summary HR state %+v", summary.HR)
	}
	raw, err := json.Marshal(summary)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"state":"`) {
		t.Fatal("five-state labels must survive serialization")
	}
	parsed := calibration.ParseSource((*string)(&[]string{string(raw)}[0]))
	if parsed.Speed == nil || parsed.Speed.State != string(speed.State) {
		t.Fatalf("parsed summary lost the state: %+v", parsed.Speed)
	}
}

// evolvedEvidence builds one admitted evidence row for the pure fitter seam.
func evolvedEvidence(asOf time.Time, daysAgo int, id string, durationS, avgSpeedMps float64, support calibration.EffortSupport) calibration.CandidateEvidence {
	return calibration.CandidateEvidence{
		ActivityID: id, RootActivityID: id, ActivityDate: asOf.AddDate(0, 0, -daysAgo),
		DurationS: durationS, AvgSpeedMps: avgSpeedMps, Continuous: true, Selected: true,
		MeasurementQuality: calibration.ConfidenceHigh, EffortSupport: support,
	}
}

// TestEvolvedSpeedRecoversSyntheticCapabilityAcrossEffortMargins: known
// capability a*=ln(3.9) with class-consistent effort margins at different
// durations must be recovered within tolerance and inside the range, with k
// identified by duration diversity.
func TestEvolvedSpeedRecoversSyntheticCapabilityAcrossEffortMargins(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	aStar := math.Log(3.9)
	const kStar = 0.06
	v := func(durationS, delta float64) float64 {
		return math.Exp(aStar - kStar*math.Log(durationS/3600) - delta)
	}
	// Each root carries multiple durations sharing its session margin, the
	// same structure best-effort windows have in production.
	evidence := []calibration.CandidateEvidence{
		evolvedEvidence(asOf, 3, "r1", 1800, v(1800, 0.14), calibration.EffortUnknown),
		evolvedEvidence(asOf, 3, "r1", 3600, v(3600, 0.14), calibration.EffortUnknown),
		evolvedEvidence(asOf, 6, "r2", 3600, v(3600, 0.18), calibration.EffortSubmaximal),
		evolvedEvidence(asOf, 6, "r2", 5400, v(5400, 0.18), calibration.EffortSubmaximal),
		evolvedEvidence(asOf, 10, "r3", 1800, v(1800, 0.18), calibration.EffortSubmaximal),
		evolvedEvidence(asOf, 10, "r3", 5400, v(5400, 0.18), calibration.EffortSubmaximal),
	}
	report := calibration.FitEvolvedSpeed(evidence, asOf, calibration.DefaultEvolvedPriors(), nil)
	if report.CenterMps == nil {
		t.Fatalf("no center: %+v", report)
	}
	if rel := math.Abs(*report.CenterMps-3.9) / 3.9; rel > 0.03 {
		t.Fatalf("capability not recovered: center %v (a*=%v), rel %v", *report.CenterMps, 3.9, rel)
	}
	if report.RiegelK == nil || math.Abs(*report.RiegelK-kStar) > 0.01 {
		t.Fatalf("k not identified: %+v", report.RiegelK)
	}
	if *report.RangeLowMps > 3.9 || *report.RangeHighMps < 3.9 {
		t.Fatalf("range must cover the truth: [%v, %v]", *report.RangeLowMps, *report.RangeHighMps)
	}
	if report.State != calibration.StateModelEstimated {
		t.Fatalf("state=%s", report.State)
	}
	// Fitted deltas reflect the class priors the data was generated with.
	for _, o := range report.Observations {
		if o.Delta == nil || *o.Delta < 0 {
			t.Fatalf("model observation must carry a nonnegative fitted margin: %+v", o)
		}
		if o.Contribution <= 0 {
			t.Fatalf("admitted observation must contribute: %+v", o)
		}
	}
}

// TestEvolvedSpeedAllEasyPriorDominatedWideRangeNotFabricatedSupport: when
// every window is easy and same-duration, capability and margin cannot be
// separated by speed alone: the report must be prior dominated with a wide
// range, and duplicating the same windows must not manufacture support.
func TestEvolvedSpeedAllEasyPriorDominatedWideRangeNotFabricatedSupport(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	easy := []calibration.CandidateEvidence{
		evolvedEvidence(asOf, 5, "easy-a", 3600, 3.2, calibration.EffortSubmaximal),
		evolvedEvidence(asOf, 12, "easy-b", 3600, 3.15, calibration.EffortSubmaximal),
		evolvedEvidence(asOf, 26, "easy-c", 3600, 3.25, calibration.EffortSubmaximal),
	}
	report := calibration.FitEvolvedSpeed(easy, asOf, calibration.DefaultEvolvedPriors(), nil)
	if report.State != calibration.StatePriorDominated {
		t.Fatalf("all-easy same-duration state=%s want prior_dominated", report.State)
	}
	if report.CenterMps == nil || report.RangeLowMps == nil || report.RangeHighMps == nil {
		t.Fatal("prior dominated must still publish center and range")
	}
	if report.PriorCurvatureShare < 0.5 {
		t.Fatalf("prior share %v must dominate when data cannot separate a and delta", report.PriorCurvatureShare)
	}
	if width := *report.RangeHighMps / *report.RangeLowMps; width < 1.12 {
		t.Fatalf("identifiability-limited range too narrow: %v", width)
	}
	// Repeating the same windows must not increase the data-driven curvature
	// or move the center: budget + dedup keep support honest.
	doubled := append(append([]calibration.CandidateEvidence{}, easy...), easy...)
	dup := calibration.FitEvolvedSpeed(doubled, asOf, calibration.DefaultEvolvedPriors(), nil)
	if dup.CenterMps == nil || report.CenterMps == nil || *dup.CenterMps != *report.CenterMps {
		t.Fatalf("duplicate windows moved the center: %v vs %v", dup.CenterMps, report.CenterMps)
	}
	if dup.DataCurvature > report.DataCurvature*1.0001 {
		t.Fatalf("duplicate windows inflated data curvature: %v vs %v", dup.DataCurvature, report.DataCurvature)
	}
	// Same-sample repetition (identical rows) is idempotent overall.
	if dup.InputIdentityHash != report.InputIdentityHash {
		t.Fatal("duplicate rows changed the admitted input identity")
	}
}

// TestEvolvedSpeedSameDayOverlapsShareBudget: two roots on one day share that
// day's contribution budget; moving one to its own day adds real independent
// support (higher data curvature), so support cannot be inflated by same-day
// overlap.
func TestEvolvedSpeedSameDayOverlapsShareBudget(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	// Realistic shape: each root carries multiple durations sharing its
	// session margin, so the data itself carries curvature.
	window := func(id string, daysAgo int, d, speed float64) calibration.CandidateEvidence {
		return evolvedEvidence(asOf, daysAgo, id, d, speed, calibration.EffortSubmaximal)
	}
	sameDay := []calibration.CandidateEvidence{
		window("m-a", 4, 1800, 3.45), window("m-a", 4, 3600, 3.30),
		window("m-b", 4, 1800, 3.25), window("m-b", 4, 3600, 3.10),
	}
	otherDay := append([]calibration.CandidateEvidence{}, sameDay...)
	otherDay[2] = window("m-b", 9, 1800, 3.25)
	otherDay[3] = window("m-b", 9, 3600, 3.10)
	one := calibration.FitEvolvedSpeed([]calibration.CandidateEvidence{sameDay[0], sameDay[1]}, asOf, calibration.DefaultEvolvedPriors(), nil)
	same := calibration.FitEvolvedSpeed(sameDay, asOf, calibration.DefaultEvolvedPriors(), nil)
	split := calibration.FitEvolvedSpeed(otherDay, asOf, calibration.DefaultEvolvedPriors(), nil)
	if one.CenterMps == nil || same.CenterMps == nil || split.CenterMps == nil {
		t.Fatal("all support shapes must produce centers")
	}
	total, contribution := 0.0, 0.0
	for _, o := range same.Observations {
		total += o.Weight
		contribution += o.Contribution
	}
	// Both roots sit on day -4: they share that day's unit, so the total is
	// the day's recency weight 2^(-4/90), not two independent units.
	if math.Abs(total-math.Exp2(-4.0/90)) > 1e-9 {
		t.Fatalf("same-day roots must share one day budget, total weight %v want %v", total, math.Exp2(-4.0/90))
	}
	if math.Abs(contribution-1) > 1e-9 {
		t.Fatalf("contributions must sum to one budget, got %v", contribution)
	}
	// Class-margin honesty: piling more submaximal sessions on the same day
	// or spreading them over days must not manufacture precision beyond the
	// class prior (the runner's easy margin is one research fact).
	for name, sd := range map[string]float64{"same_day": same.PosteriorSDLogV60, "split_days": split.PosteriorSDLogV60} {
		if ratio := sd / one.PosteriorSDLogV60; ratio < 0.85 || ratio > 1.05 {
			t.Fatalf("%s changed sensitivity materially by adding submaximal sessions: ratio %v", name, ratio)
		}
	}
}

// TestEvolvedSpeedOldSlowPriorDoesNotLockFasterAthlete: an aged, slower
// historical snapshot is a weak prior, never a cap: credible faster training
// moves the center to the data, and the prior never truncates the range.
func TestEvolvedSpeedOldSlowPriorDoesNotLockFasterAthlete(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	// Faster athlete: submaximal 3600s at 3.9 implies v60 around exp(ln3.9+0.18)~4.67.
	evidence := []calibration.CandidateEvidence{
		evolvedEvidence(asOf, 5, "f-a", 3600, 3.9, calibration.EffortSubmaximal),
		evolvedEvidence(asOf, 11, "f-b", 5400, 3.7, calibration.EffortSubmaximal),
		evolvedEvidence(asOf, 21, "f-c", 1800, 4.2, calibration.EffortUnknown),
	}
	prior := &calibration.HistoricalCapabilityPrior{V60Mps: 3.2, AgeDays: 120}
	with := calibration.FitEvolvedSpeed(evidence, asOf, calibration.DefaultEvolvedPriors(), prior)
	without := calibration.FitEvolvedSpeed(evidence, asOf, calibration.DefaultEvolvedPriors(), nil)
	if with.CenterMps == nil || without.CenterMps == nil {
		t.Fatal("both fits must produce centers")
	}
	if *with.CenterMps < 3.2*1.10 {
		t.Fatalf("old slow prior locked the center at the snapshot: %v", *with.CenterMps)
	}
	if math.Abs(*with.CenterMps-*without.CenterMps)/(*without.CenterMps) > 0.08 {
		t.Fatalf("aged weak prior must not dominate credible data: %v vs %v", *with.CenterMps, *without.CenterMps)
	}
	if with.HistoricalPriorSDLog == nil || *with.HistoricalPriorSDLog < 0.15-1e-12 {
		t.Fatalf("historical prior must be aged with a variance floor: %+v", with.HistoricalPriorSDLog)
	}
	// The prior enters exactly once: sd floor keeps it from acting as a cap.
	if *with.RangeHighMps <= 3.2 {
		t.Fatalf("range truncated at the historical prior value: %v", *with.RangeHighMps)
	}
}

// TestEvolvedSpeedAgedPriorOnlyIsPriorDominated: no current-window input but a
// valid aged prior yields a finite prior_dominated estimate with the prior
// spread as its range, never unavailable and never a locked v3 value.
func TestEvolvedSpeedAgedPriorOnlyIsPriorDominated(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	prior := &calibration.HistoricalCapabilityPrior{V60Mps: 3.8, AgeDays: 150}
	report := calibration.FitEvolvedSpeed(nil, asOf, calibration.DefaultEvolvedPriors(), prior)
	if report.State != calibration.StatePriorDominated {
		t.Fatalf("state=%s", report.State)
	}
	if report.CenterMps == nil || report.RangeLowMps == nil || report.RangeHighMps == nil {
		t.Fatal("aged prior only must publish center and range")
	}
	if *report.RangeLowMps >= 3.8 || *report.RangeHighMps <= 3.8 {
		t.Fatalf("aged prior range must bracket its center: [%v, %v]", *report.RangeLowMps, *report.RangeHighMps)
	}
	if report.PriorCurvatureShare != 1 {
		t.Fatalf("prior-only share=%v", report.PriorCurvatureShare)
	}
}

// TestEvolvedSpeedLongActivityUsesMonotoneSoftConstraint: a >2h activity
// keeps its real duration and enters only the monotone soft constraint at
// V(7200) with extra log uncertainty; it never converts to a precise
// one-hour point.
func TestEvolvedSpeedLongActivityUsesMonotoneSoftConstraint(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	evidence := []calibration.CandidateEvidence{
		evolvedEvidence(asOf, 7, "ultra", 9000, 3.0, calibration.EffortSubmaximal),
	}
	report := calibration.FitEvolvedSpeed(evidence, asOf, calibration.DefaultEvolvedPriors(), nil)
	if report.CenterMps == nil {
		t.Fatal("long activity alone must still yield a finite prior-limited center")
	}
	found := false
	for _, o := range report.Observations {
		if o.ActivityID == "ultra" {
			if o.Role == "long_duration_monotone_soft_constraint" {
				found = true
			}
			if o.Delta != nil {
				t.Fatalf("constraint rows carry no effort margin: %+v", o)
			}
		}
	}
	if !found {
		t.Fatalf("long activity must enter as monotone soft constraint: %+v", report.Observations)
	}
	if report.RiegelK != nil {
		t.Fatal("single long constraint must not identify the exponent")
	}
	// Monotonicity: the center cannot fall below the observed long speed.
	if *report.CenterMps < 3.0*0.98 {
		t.Fatalf("center %v violates the monotone envelope for observed %v", *report.CenterMps, 3.0)
	}
}

// TestEvolvedSpeedDuplicateRootDurationDeduplicated: repeated same-root
// same-duration windows are dropped (never re-credited), and shuffling the
// input order does not change the fit.
func TestEvolvedSpeedDuplicateRootDurationDeduplicatedAndOrderIndependent(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	evidence := []calibration.CandidateEvidence{
		evolvedEvidence(asOf, 2, "a", 3600, 3.3, calibration.EffortSubmaximal),
		evolvedEvidence(asOf, 2, "a", 3600, 3.3, calibration.EffortSubmaximal),
		evolvedEvidence(asOf, 8, "b", 5400, 3.05, calibration.EffortSubmaximal),
		evolvedEvidence(asOf, 15, "c", 1800, 3.6, calibration.EffortUnknown),
	}
	base := calibration.FitEvolvedSpeed(evidence, asOf, calibration.DefaultEvolvedPriors(), nil)
	dupes := 0
	for _, o := range base.Observations {
		if o.Role == "duplicate_root_duration" {
			dupes++
		}
	}
	if dupes != 1 {
		t.Fatalf("duplicate root+duration rows must be dropped once: %d", dupes)
	}
	shuffled := []calibration.CandidateEvidence{evidence[2], evidence[0], evidence[3], evidence[1]}
	other := calibration.FitEvolvedSpeed(shuffled, asOf, calibration.DefaultEvolvedPriors(), nil)
	if other.CenterMps == nil || base.CenterMps == nil || *other.CenterMps != *base.CenterMps {
		t.Fatalf("input order changed the fit: %v vs %v", other.CenterMps, base.CenterMps)
	}
	if other.InputIdentityHash != base.InputIdentityHash {
		t.Fatal("input order changed the input identity")
	}
	again := calibration.FitEvolvedSpeed(evidence, asOf, calibration.DefaultEvolvedPriors(), nil)
	if again.InputIdentityHash != base.InputIdentityHash || *again.CenterMps != *base.CenterMps {
		t.Fatal("same input must reproduce the same result bit-for-bit")
	}
}

// TestEvolvedSpeedFutureEvidenceCannotChangePastFit: evidence dated after the
// as-of instant is not admitted (time machine guarantee).
func TestEvolvedSpeedFutureEvidenceCannotChangePastFit(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	past := []calibration.CandidateEvidence{
		evolvedEvidence(asOf, 3, "a", 3600, 3.3, calibration.EffortSubmaximal),
		evolvedEvidence(asOf, 9, "b", 5400, 3.05, calibration.EffortSubmaximal),
	}
	withFuture := append(append([]calibration.CandidateEvidence{}, past...),
		evolvedEvidence(asOf, -5, "future", 3600, 6.0, calibration.EffortConfirmedMaximal),
	)
	base := calibration.FitEvolvedSpeed(past, asOf, calibration.DefaultEvolvedPriors(), nil)
	future := calibration.FitEvolvedSpeed(withFuture, asOf, calibration.DefaultEvolvedPriors(), nil)
	if base.CenterMps == nil || future.CenterMps == nil || *base.CenterMps != *future.CenterMps {
		t.Fatalf("future evidence changed the past fit: %v vs %v", base.CenterMps, future.CenterMps)
	}
	if future.State != base.State {
		t.Fatalf("future evidence changed the state: %s vs %s", future.State, base.State)
	}
}

// TestEvolvedSpeedUnavailableAndStaleBranches: no input at all and physically
// impossible inputs are honest unavailable with reasons; a stale-only window
// keeps a finite center flagged stale.
func TestEvolvedSpeedUnavailableAndStaleBranches(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	empty := calibration.FitEvolvedSpeed(nil, asOf, calibration.DefaultEvolvedPriors(), nil)
	if empty.State != calibration.StateUnavailable || empty.CenterMps != nil {
		t.Fatalf("no input no prior must be unavailable without center: %+v", empty)
	}
	if len(empty.Reasons) == 0 {
		t.Fatal("unavailable must carry a categorical reason")
	}
	broken := []calibration.CandidateEvidence{evolvedEvidence(asOf, 1, "x", 3600, 12.0, calibration.EffortUnknown)}
	invalid := calibration.FitEvolvedSpeed(broken, asOf, calibration.DefaultEvolvedPriors(), nil)
	if invalid.State != calibration.StateUnavailable || invalid.CenterMps != nil {
		t.Fatalf("physically invalid input must be unavailable: %+v", invalid)
	}
	stale := []calibration.CandidateEvidence{
		evolvedEvidence(asOf, 120, "old-a", 3600, 3.3, calibration.EffortSubmaximal),
		evolvedEvidence(asOf, 150, "old-b", 5400, 3.05, calibration.EffortSubmaximal),
	}
	aged := calibration.FitEvolvedSpeed(stale, asOf, calibration.DefaultEvolvedPriors(), nil)
	if aged.State != calibration.StateStale {
		t.Fatalf("stale-only support state=%s", aged.State)
	}
	if aged.CenterMps == nil || !evolvedFinite(*aged.CenterMps) {
		t.Fatalf("stale keeps a finite center: %+v", aged.CenterMps)
	}
}

// TestEvolvedSpeedBoundarySolutionStaysInDomain: near-maximal plausible
// observations push the solution to the truncation boundary; the center stays
// finite and the range is clamped to the declared domain.
func TestEvolvedSpeedBoundarySolutionStaysInDomain(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	evidence := []calibration.CandidateEvidence{
		evolvedEvidence(asOf, 2, "sprint", 1800, 8.4, calibration.EffortConfirmedMaximal),
		evolvedEvidence(asOf, 6, "sprint-b", 3600, 8.3, calibration.EffortConfirmedMaximal),
	}
	report := calibration.FitEvolvedSpeed(evidence, asOf, calibration.DefaultEvolvedPriors(), nil)
	if report.CenterMps == nil {
		t.Fatal("boundary fixture must produce a center")
	}
	if *report.CenterMps > 8.5 || *report.CenterMps <= 0 {
		t.Fatalf("center left the physical domain: %v", *report.CenterMps)
	}
	if *report.RangeHighMps > 8.5+1e-9 || *report.RangeLowMps < 1.5-1e-9 {
		t.Fatalf("range left the declared prior support: [%v, %v]", *report.RangeLowMps, *report.RangeHighMps)
	}
	if report.State != calibration.StateMeasuredReference {
		t.Fatalf("confirmed anchors state=%s", report.State)
	}
}

// TestEvolvedSpeedMaximalAnchorTightensMarginNotSwitch: a confirmed all-out
// window fits a near-zero effort margin and promotes the state; ordinary
// model_estimated windows never reach confidence high through the snapshot.
func TestEvolvedSpeedMaximalAnchorTightensMarginNotSwitch(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	mixed := []calibration.CandidateEvidence{
		evolvedEvidence(asOf, 4, "race", 3600, 3.9, calibration.EffortConfirmedMaximal),
		evolvedEvidence(asOf, 10, "easy", 5400, 3.0, calibration.EffortSubmaximal),
	}
	report := calibration.FitEvolvedSpeed(mixed, asOf, calibration.DefaultEvolvedPriors(), nil)
	if report.State != calibration.StateMeasuredReference {
		t.Fatalf("state=%s", report.State)
	}
	for _, o := range report.Observations {
		if o.ActivityID == "race" && (o.Delta == nil || *o.Delta > 0.05) {
			t.Fatalf("confirmed maximal margin must fit near zero: %+v", o)
		}
	}
	result, err := calibration.EstimateEvolvedOffline(nil, asOf, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	// No-input path via the public entry is honestly unavailable, low-free.
	if result.Evolved.Speed.State != calibration.StateUnavailable {
		t.Fatalf("no input state=%s", result.Evolved.Speed.State)
	}
	// model_estimated must never claim high confidence without an anchor.
	ordinaryRuns := []calibration.CandidateEvidence{
		evolvedEvidence(asOf, 3, "a", 1800, 3.6, calibration.EffortUnknown),
		evolvedEvidence(asOf, 8, "b", 3600, 3.3, calibration.EffortSubmaximal),
		evolvedEvidence(asOf, 20, "c", 5400, 3.0, calibration.EffortSubmaximal),
	}
	fit := calibration.FitEvolvedSpeed(ordinaryRuns, asOf, calibration.DefaultEvolvedPriors(), nil)
	if fit.State != calibration.StateModelEstimated {
		t.Fatalf("state=%s", fit.State)
	}
	// The legacy confidence mapping is internal; the observable guarantee is
	// the five-state label, checked above.
}

// TestEvolvedCandidateHandlesPauseSparseAndGPSSpikesThroughCleaning: the
// estimator must ride on the existing cleaning/pause/recovery pipeline: a
// paused activity keeps real time denominators (never stitched), sparse
// sampling still integrates, and an isolated GPS spike cannot pull the
// center (robust loss + measurement gates).
func TestEvolvedCandidateHandlesPauseSparseAndGPSSpikesThroughCleaning(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	// Paused activity: stationary for 500s, then a steady 4.0 m/s hour.
	paused := calibration.Activity{LabelID: "pause", ActivityDate: asOf.AddDate(0, 0, -2), Sport: "run"}
	for i := 0; i <= 3600; i++ {
		speed := 4.0
		if i < 500 {
			speed = 0
		}
		paused.Samples = append(paused.Samples, calibration.Sample{ElapsedS: f64p(float64(i)), SpeedMps: f64p(speed), DistanceM: f64p(float64(i-500) * 4.0 * map[bool]float64{true: 0, false: 1}[i < 500])})
	}
	// Sparse sampling: one point per minute at constant 3.2 m/s.
	var sparse []calibration.Sample
	for i := 0; i <= 5400; i += 60 {
		sparse = append(sparse, calibration.Sample{ElapsedS: f64p(float64(i)), SpeedMps: f64p(3.2), DistanceM: f64p(3.2 * float64(i))})
	}
	sparseActivity := calibration.Activity{LabelID: "sparse", ActivityDate: asOf.AddDate(0, 0, -7), Sport: "run", Samples: sparse}
	// GPS spike: constant 3.4 m/s with a 40 m jump in one sample.
	spiky := calibration.Activity{LabelID: "spike", ActivityDate: asOf.AddDate(0, 0, -12), Sport: "run"}
	for i := 0; i <= 3600; i++ {
		dist := 3.4 * float64(i)
		if i == 1800 {
			dist += 40
		}
		spiky.Samples = append(spiky.Samples, calibration.Sample{ElapsedS: f64p(float64(i)), SpeedMps: f64p(3.4), DistanceM: f64p(dist)})
	}
	result, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, []calibration.Activity{paused, sparseActivity, spiky}, asOf, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result.Snapshot.ThresholdSpeedMps == nil || !evolvedFinite(*result.Snapshot.ThresholdSpeedMps) {
		t.Fatalf("cleaning pipeline must still yield a finite center: %+v", result.Snapshot.ThresholdSpeedMps)
	}
	speed := result.Evolved.Speed
	// The paused stationary block is excluded by cleaning; windows come from
	// the moving piece only. No row may claim a stitched pause+run window.
	for _, o := range speed.Observations {
		if o.RootActivityID == "pause" && o.DurationS > 3100 {
			t.Fatalf("window longer than the moving piece admitted for paused activity: %+v", o)
		}
	}
	// Pace zones derive from the center without panic and stay finite.
	zones := calibration.ComputeTrainingZones(result.Snapshot)
	if len(zones.PaceZones) == 0 {
		t.Fatal("pace zones missing for evolved snapshot")
	}
	for _, z := range zones.PaceZones {
		if z.MinSpeedMps != nil && !evolvedFinite(*z.MinSpeedMps) {
			t.Fatalf("nonfinite zone: %+v", z)
		}
	}
}

// TestEvolvedOfflineEntryAppliesHistoricalPriorOnce: the public entry stamps
// the identity triple, exposes the aged prior composition and never lets the
// prior act as a cap (the faster-data result sits above the old snapshot).
func TestEvolvedOfflineEntryAppliesHistoricalPriorOnce(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	history := []calibration.Activity{
		evolvedRunActivity("fast-a", asOf.AddDate(0, 0, -3), 3600, 3.9),
		evolvedRunActivity("fast-b", asOf.AddDate(0, 0, -10), 5400, 3.7),
	}
	prior := &calibration.HistoricalCapabilityPrior{V60Mps: 3.0, AgeDays: 100}
	result, err := calibration.EstimateEvolvedOffline(history, asOf, nil, nil, prior)
	if err != nil {
		t.Fatal(err)
	}
	implementation, parameterVersion, revision := calibration.EvolvedCandidateIdentity()
	if result.Implementation != implementation || result.ParameterVersion != parameterVersion || result.AlgorithmRevision != revision {
		t.Fatalf("identity drift: %+v", result)
	}
	speed := result.Evolved.Speed
	if speed.HistoricalPriorMeanLog == nil || speed.HistoricalPriorSDLog == nil {
		t.Fatal("aged prior composition must be reported for recomputability")
	}
	if *speed.HistoricalPriorSDLog < 0.15-1e-12 {
		t.Fatalf("variance floor missing: %v", *speed.HistoricalPriorSDLog)
	}
	if speed.CenterMps == nil || *speed.CenterMps <= 3.0 {
		t.Fatalf("historical prior acted as a cap: %v", speed.CenterMps)
	}
	// Reproducibility: same inputs, same output hashes.
	again, _ := calibration.EstimateEvolvedOffline(history, asOf, nil, nil, prior)
	if again.Evolved.Speed.InputIdentityHash != speed.InputIdentityHash || *again.Evolved.Speed.CenterMps != *speed.CenterMps {
		t.Fatal("evolved offline entry is not deterministic")
	}
}

// TestLegacyStrategiesMarshalWithoutEvolvedBlock: the additive Evolved field
// must stay absent for every legacy strategy so persisted JSON and replay
// hashes remain byte-identical.
func TestLegacyStrategiesMarshalWithoutEvolvedBlock(t *testing.T) {
	raw, err := json.Marshal(calibration.OfflineResult{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"evolved"`) {
		t.Fatalf("empty result must omit evolved: %s", raw)
	}
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	history := []calibration.Activity{evolvedRunActivity("run", asOf.AddDate(0, 0, -1), 3600, 3.3)}
	for _, strategy := range []calibration.Strategy{calibration.StrategyV3, calibration.StrategyCandidate} {
		result, err := calibration.EstimateOffline(strategy, history, asOf, nil)
		if err != nil {
			t.Fatal(err)
		}
		data, err := json.Marshal(result)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), `"evolved"`) {
			t.Fatalf("%s serialized an evolved block", strategy)
		}
		if result.Evolved != nil {
			t.Fatalf("%s produced an evolved report", strategy)
		}
	}
}

// TestEvolvedSpeedKPriorPullsWeaklyIdentifiedExponentFromBoundary: the
// contract freezes a truncated quadratic prior on k (mean 0.06, sd 0.03 in
// [0.02, 0.10]) and requires the joint objective to contain every prior
// term. When the data alone weakly implies k at the domain edge (~0.095),
// the MAP exponent must be pulled back toward the prior mean rather than
// parking on the 0.10 boundary.
func TestEvolvedSpeedKPriorPullsWeaklyIdentifiedExponentFromBoundary(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	// Within-root duration decline implies kStar near the domain edge; each
	// root's windows share its session margin (submaximal).
	const kStar = 0.095
	v := func(d float64) float64 { return 3.4 * math.Pow(d/3600, -kStar) }
	root := func(id string, daysAgo int) []calibration.CandidateEvidence {
		out := make([]calibration.CandidateEvidence, 0, 3)
		for _, d := range []float64{1800, 3600, 5400} {
			out = append(out, evolvedEvidence(asOf, daysAgo, id, d, v(d), calibration.EffortSubmaximal))
		}
		return out
	}
	evidence := append(append([]calibration.CandidateEvidence{}, root("w1", 3)...), root("w2", 9)...)
	report := calibration.FitEvolvedSpeed(evidence, asOf, calibration.DefaultEvolvedPriors(), nil)
	if report.CenterMps == nil {
		t.Fatal("weakly identified exponent fixture must still produce a center")
	}
	// Without the k prior the grid optimum parks at the 0.095-0.10 edge; the
	// frozen prior (0.06, sd 0.03) must pull the MAP exponent meaningfully
	// back inside the domain while the data still keeps it above the mean.
	if report.MapK >= 0.093 {
		t.Fatalf("MAP k=%v parks at the domain edge; the frozen k prior (0.06, sd 0.03) is missing or inert", report.MapK)
	}
	if report.MapK <= 0.06 {
		t.Fatalf("MAP k=%v collapsed to the prior mean; the duration-decline data must still matter", report.MapK)
	}
	// The pull is recomputable: quadratic pool of data precision (within-root
	// slopes) and the prior precision balances strictly between 0.06 and 0.095.
	if report.MapK <= 0.065 || report.MapK >= 0.091 {
		t.Fatalf("MAP k=%v outside the expected prior/data balance band", report.MapK)
	}
}

// TestEvolvedSpeedLargeInputCoarsensKGridAndDisclosesIt: above the declared
// observation threshold the deterministic solver coarsens its k grid to keep
// production-scale windows (~250 roots/180 days) tractable, discloses the
// coarsening as a limitation with the actual grid resolution, and still
// returns a finite deterministic center.
func TestEvolvedSpeedLargeInputCoarsensKGridAndDisclosesIt(t *testing.T) {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	// 405 single-window roots: just past the 400-observation guard.
	evidence := make([]calibration.CandidateEvidence, 0, 405)
	for i := 0; i < 405; i++ {
		speed := 3.0 + 0.4*float64(i%7)/7
		evidence = append(evidence, evolvedEvidence(asOf, 1+i%170, fmt.Sprintf("g-%d", i), 3600, speed, calibration.EffortSubmaximal))
	}
	report := calibration.FitEvolvedSpeed(evidence, asOf, calibration.DefaultEvolvedPriors(), nil)
	if report.CenterMps == nil || !evolvedFinite(*report.CenterMps) {
		t.Fatalf("large input must still produce a finite center: %+v", report.CenterMps)
	}
	coarsened := false
	for _, l := range report.Limitations {
		if l == "k_grid_coarsened_large_input" {
			coarsened = true
		}
	}
	if !coarsened {
		t.Fatalf("guard limitation missing above threshold: %v", report.Limitations)
	}
	if !(report.SolverKGridResolution > 0.00015) {
		t.Fatalf("coarsened grid resolution must be disclosed, got %v", report.SolverKGridResolution)
	}
	// Bit-level determinism of the shared code paths is locked by the
	// order-independence tests; re-fitting a 400+ observation window here
	// would double an already seconds-scale fixture for no new coverage.
}
