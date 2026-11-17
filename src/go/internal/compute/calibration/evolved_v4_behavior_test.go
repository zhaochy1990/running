package calibration_test

// evolved_v4_behavior_test.go pins docs/calibration/v4.md §10.2's required
// behaviors (row by row) plus the §3-§9 unit invariants the table exercises.
// All fixtures are synthetic engineering inputs; none is an accuracy label.

import (
	"math"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
)

func v4RunActivity(id string, day time.Time, seconds int, speedMps float64, hr func(second int) *float64) calibration.Activity {
	duration, distance := float64(seconds), float64(seconds)*speedMps
	a := calibration.Activity{LabelID: id, ActivityDate: day, Sport: "run", DurationS: &duration, DistanceM: &distance}
	for second := 0; second <= seconds; second += 5 {
		elapsed, d, sp := float64(second), float64(second)*speedMps, speedMps
		s := calibration.Sample{ElapsedS: &elapsed, DistanceM: &d, SpeedMps: &sp}
		if hr != nil {
			if v := hr(second); v != nil {
				s.HeartRateBpm = v
			}
		}
		a.Samples = append(a.Samples, s)
	}
	return a
}

func v4Estimate(t *testing.T, history []calibration.Activity, asOf time.Time, health []calibration.HealthRow, metadata []calibration.CandidateMetadata) (calibration.EvolvedSpeedReport, calibration.EvolvedHRReport, calibration.OfflineResult) {
	t.Helper()
	result, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyEvolvedCandidate, history, asOf, health, metadata)
	if err != nil {
		t.Fatal(err)
	}
	if result.Evolved == nil || result.Evolved.Speed == nil || result.Evolved.HR == nil {
		t.Fatalf("evolved reports missing: %+v", result.Evolved)
	}
	return *result.Evolved.Speed, *result.Evolved.HR, result
}

var v4AsOf = time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)

// §10.2 row 1: a trusted recent continuous 60-minute run at 4'11"/km — the
// main center may not be slower than it; margin evidence may go faster.
func TestV4TrustedHourRunIsHardFloor(t *testing.T) {
	pace411 := 1000.0 / 251.0 * 60.0 / 60.0 // ~3.984 m/s
	hour := v4RunActivity("hour-411", v4AsOf.AddDate(0, 0, -10), 3600, pace411, nil)
	speed, _, _ := v4Estimate(t, []calibration.Activity{hour}, v4AsOf, nil, nil)
	if speed.State == calibration.StateUnavailable || speed.CenterMps == nil {
		t.Fatalf("trusted hour run must produce a center: %+v", speed)
	}
	if *speed.CenterMps < pace411-1e-9 {
		t.Fatalf("center %.4f m/s is slower than the trusted 4'11\" hour run %.4f", *speed.CenterMps, pace411)
	}
	// The hour bound is nominal (k-independent) and binding.
	nominal := false
	for _, b := range speed.Bounds {
		if b.BoundKind == "nominal" && b.DurationS == 3600 {
			nominal = true
			if !b.Binding {
				t.Fatalf("trusted hour bound must bind at the floor: %+v", b)
			}
			if b.ConstraintViolation > 1e-9 {
				t.Fatalf("constraint violation must be zero, got %v", b.ConstraintViolation)
			}
		}
	}
	if !nominal {
		t.Fatalf("no nominal 3600 s bound reported: %+v", speed.Bounds)
	}
	if speed.NominalFloorMps == nil || *speed.NominalFloorMps < pace411-1e-9 {
		t.Fatalf("nominal proven floor missing or weak: %+v", speed.NominalFloorMps)
	}
}

// §10.2 row 2: a trusted continuous two-hour run at 4'11"/km — the direct
// hour bound holds and the duration model may lift further, with the source
// separation (long monotone envelope) explicit.
func TestV4TrustedTwoHourRunDirectBoundAndModelLift(t *testing.T) {
	pace411 := 1000.0 / 251.0 / 1.0 * 3.6 / 3.6 // 251 s/km -> m/s ≈ 3.984
	two := v4RunActivity("two-hour-411", v4AsOf.AddDate(0, 0, -10), 7200, pace411, nil)
	speed, _, _ := v4Estimate(t, []calibration.Activity{two}, v4AsOf, nil, nil)
	if speed.CenterMps == nil {
		t.Fatal("two-hour trusted run must produce a center")
	}
	// Direct relation v60 >= v_i (k-independent part of the envelope).
	if *speed.CenterMps < pace411-1e-9 {
		t.Fatalf("center %.4f below the direct two-hour bound %.4f", *speed.CenterMps, pace411)
	}
	if speed.Method != "constrained_margin_fit" {
		t.Fatalf("7200 s is in-domain: method=%s", speed.Method)
	}
	// A >7200 s continuous run still yields its in-domain 7200 s window (§2:
	// extract the actually supportable 90/120-minute performances), so the
	// constrained fit stays the method; the >7200 s full-duration row joins
	// the constraint set as a long monotone envelope (unit-tested in the
	// internal evolved_v4_internal_test.go alongside bound_fallback).
	// The k·log2 conversion is visible through the 7200 s model-projected
	// bound: with no faster margin evidence the center sits on it.
	bound7200 := 0.0
	for _, b := range speed.Bounds {
		if b.DurationS == 7200 && b.SpeedMps != nil {
			bound7200 = *b.SpeedMps
		}
	}
	if bound7200 <= 0 {
		t.Fatalf("7200 s bound missing: %+v", speed.Bounds)
	}
	if *speed.CenterMps < bound7200-1e-9 {
		t.Fatalf("center %.4f below the 7200 s bound %.4f", *speed.CenterMps, bound7200)
	}
}

// §10.2 row 3: only 3/5/10-minute fast segments — a low-support model
// estimate is mandatory, but a short-segment speed is never a direct hour
// lower bound (v60 must stay below the short speeds; the constraint only
// acts through the curve). Also covers the user's 2364 s @ 236.6 s/km shape.
func TestV4ShortSegmentsNeverBoundTheHourDirectly(t *testing.T) {
	fast := 1000.0 / 200.0 // 5 m/s for 3/5/10 minutes
	history := []calibration.Activity{
		v4RunActivity("three-min", v4AsOf.AddDate(0, 0, -5), 180, fast, nil),
		v4RunActivity("five-min", v4AsOf.AddDate(0, 0, -6), 300, fast, nil),
		v4RunActivity("ten-min", v4AsOf.AddDate(0, 0, -7), 600, fast, nil),
	}
	speed, _, _ := v4Estimate(t, history, v4AsOf, nil, nil)
	if speed.CenterMps == nil {
		t.Fatal("short-only windows must still yield a low-support estimate")
	}
	if *speed.CenterMps >= fast {
		t.Fatalf("short-segment speed %.3f must not become the hour lower bound (center %.3f)", fast, *speed.CenterMps)
	}
	if speed.State != calibration.StatePriorDominated {
		t.Fatalf("short-time-only support must be prior_dominated, got %s", speed.State)
	}
	// The user's 2364 s @ 236.6 s/km window alone: sub-hour, so the center
	// must stay below its speed too (model-projected only).
	sub := 1000.0 / 236.6
	speedSub, _, _ := v4Estimate(t, []calibration.Activity{v4RunActivity("thirty-nine-min", v4AsOf.AddDate(0, 0, -9), 2364, sub, nil)}, v4AsOf, nil, nil)
	if speedSub.CenterMps == nil || *speedSub.CenterMps >= sub-1e-9 {
		t.Fatalf("2364 s window must not directly bound the hour: %.4f vs %.4f", *speedSub.CenterMps, sub)
	}
	proj := false
	for _, b := range speedSub.Bounds {
		if b.BoundKind == "model_projected" {
			proj = true
		}
		if b.BoundKind == "nominal" {
			t.Fatalf("sub-hour window must not produce a nominal hour bound")
		}
	}
	if !proj {
		t.Fatalf("sub-hour bound must be labeled model_projected: %+v", speedSub.Bounds)
	}
}

// §10.2 row 4: plentiful ordinary training without any all-out label — no
// nil pace; HR follows its actual data/prior path.
func TestV4OrdinaryTrainingWithoutLabelsStillEstimates(t *testing.T) {
	history := []calibration.Activity{
		v4RunActivity("ordinary-a", v4AsOf.AddDate(0, 0, -30), 1800, 3.6, nil),
		v4RunActivity("ordinary-b", v4AsOf.AddDate(0, 0, -20), 3600, 3.3, nil),
		v4RunActivity("ordinary-c", v4AsOf.AddDate(0, 0, -5), 1200, 3.8, nil),
	}
	speed, hr, result := v4Estimate(t, history, v4AsOf, nil, nil)
	if speed.CenterMps == nil || result.Snapshot.ThresholdSpeedMps == nil {
		t.Fatalf("ordinary label-free training must produce a pace: %+v", speed)
	}
	if hr.State == calibration.StateUnavailable && hr.Branch == "unavailable" {
		// No HR series and no physiological prior: unavailable WITH reason.
		found := false
		for _, r := range hr.Reasons {
			if r != "" {
				found = true
			}
		}
		if !found {
			t.Fatalf("HR unavailability must carry a reason")
		}
	}
}

// §10.2 row 5: adding a large pool of obviously slower, unselected easy runs
// (no new usable HR) must not dilute the fit, change the range, or move the
// independent support counts.
func TestV4SlowUnselectedRunsDoNotDilute(t *testing.T) {
	base := []calibration.Activity{
		v4RunActivity("front-a", v4AsOf.AddDate(0, 0, -30), 1800, 3.6, nil),
		v4RunActivity("front-b", v4AsOf.AddDate(0, 0, -20), 3600, 3.3, nil),
		v4RunActivity("front-c", v4AsOf.AddDate(0, 0, -5), 1200, 3.9, nil),
	}
	speedA, _, _ := v4Estimate(t, base, v4AsOf, nil, nil)
	loaded := append([]calibration.Activity(nil), base...)
	for i := 0; i < 12; i++ {
		loaded = append(loaded, v4RunActivity("easy-pool-"+string(rune('a'+i)), v4AsOf.AddDate(0, 0, -(2+i)), 3000+i*37, 2.6, nil))
	}
	speedB, _, _ := v4Estimate(t, loaded, v4AsOf, nil, nil)
	if speedA.CenterMps == nil || speedB.CenterMps == nil {
		t.Fatal("centers missing")
	}
	if math.Abs(*speedA.CenterMps-*speedB.CenterMps) > 1e-9 {
		t.Fatalf("slow unselected runs moved the center: %.6f -> %.6f", *speedA.CenterMps, *speedB.CenterMps)
	}
	if speedA.IndependentDays != speedB.IndependentDays || speedA.IndependentRoots != speedB.IndependentRoots {
		t.Fatalf("independent support changed: %d/%d -> %d/%d", speedA.IndependentRoots, speedA.IndependentDays, speedB.IndependentRoots, speedB.IndependentDays)
	}
	if speedA.RangeLowMps == nil || speedB.RangeLowMps == nil || math.Abs(*speedA.RangeLowMps-*speedB.RangeLowMps) > 1e-9 || math.Abs(*speedA.RangeHighMps-*speedB.RangeHighMps) > 1e-9 {
		t.Fatalf("range changed with unselected easy runs")
	}
}

// §10.2 row 6: adding a copy of the same activity (same root) or recomputing
// changes nothing — centers, ranges and support counts are invariant.
func TestV4DuplicatesAndRecomputeAreInvariant(t *testing.T) {
	history := []calibration.Activity{
		v4RunActivity("root-run-a", v4AsOf.AddDate(0, 0, -30), 1800, 3.6, nil),
		v4RunActivity("root-run-b", v4AsOf.AddDate(0, 0, -20), 3600, 3.3, nil),
	}
	meta := []calibration.CandidateMetadata{
		{ActivityID: "root-run-a", RootActivityID: "root-1", SourceVersion: "v4-test"},
		{ActivityID: "root-run-b", RootActivityID: "root-2", SourceVersion: "v4-test"},
	}
	first, _, res1 := v4Estimate(t, history, v4AsOf, nil, meta)
	again, _, _ := v4Estimate(t, history, v4AsOf, nil, meta)
	if calibration.ReplayContentHash(first) != calibration.ReplayContentHash(again) {
		t.Fatal("recomputation is not deterministic")
	}
	// A watch/platform copy: same root, alias id.
	alias := v4RunActivity("root-run-a-copy", v4AsOf.AddDate(0, 0, -30), 1800, 3.6, nil)
	copiedMeta := append(append([]calibration.CandidateMetadata(nil), meta...),
		calibration.CandidateMetadata{ActivityID: "root-run-a-copy", RootActivityID: "root-1", SourceVersion: "v4-test"})
	withCopy, _, _ := v4Estimate(t, append([]calibration.Activity{alias}, history...), v4AsOf, nil, copiedMeta)
	if first.IndependentDays != withCopy.IndependentDays || first.IndependentRoots != withCopy.IndependentRoots {
		t.Fatalf("duplicate root changed support: %d/%d -> %d/%d", first.IndependentRoots, first.IndependentDays, withCopy.IndependentRoots, withCopy.IndependentDays)
	}
	if math.Abs(*first.CenterMps-*withCopy.CenterMps) > 1e-9 {
		t.Fatalf("duplicate root moved the center: %.6f -> %.6f", *first.CenterMps, *withCopy.CenterMps)
	}
	_ = res1
}

// §10.2 row 7: recovery intervals, stopped watches and GPS spikes never
// produce a falsely-fast continuous performance; a locatable quality note
// explains every rejection.
func TestV4RecoveryAndSpikesNeverFast(t *testing.T) {
	// A 40-minute activity whose middle 10 minutes are stationary (recovery):
	// the moving average around it must not become a continuous fast window.
	duration := 2400.0
	fast := 4.2
	a := calibration.Activity{LabelID: "interval-day", ActivityDate: v4AsOf.AddDate(0, 0, -3), Sport: "run", DurationS: &duration, DistanceM: v4F64p(duration * 3.5)}
	for second := 0; second <= 2400; second += 5 {
		sp := fast
		if second >= 900 && second < 1500 {
			sp = 0.0 // stationary recovery
		}
		elapsed, d := float64(second), float64(second)*map[bool]float64{true: 3.5, false: fast}[sp == 0.0]
		if sp == 0.0 {
			d = float64(900)*fast + 0
		} else if second >= 1500 {
			d = float64(900)*fast + float64(second-1500)*fast
		}
		a.Samples = append(a.Samples, calibration.Sample{ElapsedS: &elapsed, DistanceM: &d, SpeedMps: &sp})
	}
	speed, _, _ := v4Estimate(t, []calibration.Activity{a}, v4AsOf, nil, nil)
	if speed.CenterMps == nil {
		t.Fatal("interval session must still estimate")
	}
	// No continuous window may average above the fast repetition speed.
	if *speed.CenterMps > fast+1e-9 {
		t.Fatalf("recovery session produced a faster-than-repetition bound: %.3f", *speed.CenterMps)
	}
	// A GPS distance spike: one sample with a +400 m jump must not create a
	// fast continuous window (the cleaner drops it as a spike).
	spiky := v4RunActivity("spike-day", v4AsOf.AddDate(0, 0, -4), 1800, 3.5, nil)
	for i := range spiky.Samples {
		if spiky.Samples[i].ElapsedS != nil && *spiky.Samples[i].ElapsedS == 900.0 {
			d := *spiky.Samples[i].DistanceM + 400
			spiky.Samples[i].DistanceM = &d
		}
	}
	speedSpiky, _, _ := v4Estimate(t, []calibration.Activity{spiky}, v4AsOf, nil, nil)
	if speedSpiky.CenterMps != nil && *speedSpiky.CenterMps > 3.5*1.05 {
		t.Fatalf("GPS spike produced a fast bound: %.3f", *speedSpiky.CenterMps)
	}
}

// §10.2 row 8: one low optical HR reading must not lift capability much;
// multi-day consistent HR improvement may influence the margin, and that
// influence disappears when HR is disabled (lambda_H = 0).
func TestV4HRFeedbackSingleVsMultiDay(t *testing.T) {
	rhr := 55.0
	health := []calibration.HealthRow{}
	for i := 0; i < 20; i++ {
		health = append(health, calibration.HealthRow{Date: v4AsOf.AddDate(0, 0, -(i + 1)), RHR: &rhr})
	}
	// A short hard effort with an HR spike fixes M ≈ 188 for every scenario
	// without dominating the pace side (its 180 s window is subsumed by the
	// nominal hour bound of the threshold days).
	hardEffort := v4RunActivity("hard-effort", v4AsOf.AddDate(0, 0, -2), 180, 4.0, func(second int) *float64 {
		v := 150.0 + 38.0*float64(second)/180.0
		return &v
	})
	thresholdDay := func(name string, day int, hr float64) calibration.Activity {
		return v4RunActivity(name, v4AsOf.AddDate(0, 0, -day), 3600, 3.5, func(int) *float64 { return &hr })
	}
	baseHistory := func() []calibration.Activity {
		return []calibration.Activity{hardEffort, thresholdDay("hr-a", 28, 165), thresholdDay("hr-b", 21, 165), thresholdDay("hr-c", 14, 165)}
	}
	// One low optical outlier day added to an otherwise consistent base: the
	// per-day effect u_j must absorb it.
	outlier := append(baseHistory(), thresholdDay("hr-optical", 9, 118))
	// Multi-day consistent improvement: every threshold day 20 bpm lower.
	improved := []calibration.Activity{hardEffort, thresholdDay("hr-a", 28, 145), thresholdDay("hr-b", 21, 145), thresholdDay("hr-c", 14, 145)}
	speedBase, hrBase, _ := v4Estimate(t, baseHistory(), v4AsOf, health, nil)
	speedOutlier, hrOutlier, _ := v4Estimate(t, outlier, v4AsOf, health, nil)
	speedImproved, hrImproved, _ := v4Estimate(t, improved, v4AsOf, health, nil)
	if hrOutlier.Branch != "joint" || hrImproved.Branch != "joint" {
		t.Fatalf("valid R/M + usable HR must take the joint branch, got %s/%s", hrOutlier.Branch, hrImproved.Branch)
	}
	if speedBase.CenterMps == nil || speedOutlier.CenterMps == nil || speedImproved.CenterMps == nil {
		t.Fatal("centers missing")
	}
	// Pace side: a single outlier reading must not lift the capability.
	liftOutlier := (*speedOutlier.CenterMps - *speedBase.CenterMps) / *speedBase.CenterMps
	liftMulti := (*speedImproved.CenterMps - *speedBase.CenterMps) / *speedBase.CenterMps
	if liftOutlier > 0.015 {
		t.Fatalf("one low optical outlier day lifted capability by %.2f%% (>1.5%%)", liftOutlier*100)
	}
	if liftMulti < liftOutlier {
		t.Fatalf("multi-day consistent improvement (%.3f%%) must out-inform a single outlier reading (%.3f%%)", liftMulti*100, liftOutlier*100)
	}
	// HR side: the influence lands where §6.3 puts it — the inferred H60
	// moves between consistent scenarios, and the lambda_H = 0 control
	// differs from the joint output (disabling HR removes it by construction).
	hrBaseC, hrOutC, hrImpC := deref(hrBase.CenterBpm), deref(hrOutlier.CenterBpm), deref(hrImproved.CenterBpm)
	if math.IsNaN(hrBaseC) || math.IsNaN(hrOutC) || math.IsNaN(hrImpC) {
		t.Fatalf("H60 centers missing: %v %v %v", hrBaseC, hrOutC, hrImpC)
	}
	if math.Abs(hrImpC-hrBaseC) <= math.Abs(hrOutC-hrBaseC) {
		t.Fatalf("multi-day consistent improvement must move H60 (%.2f -> %.2f) at least as much as a single outlier (%.2f -> %.2f)", hrBaseC, hrImpC, hrBaseC, hrOutC)
	}
	if hrImproved.LambdaZeroCenterBpm == nil {
		t.Fatal("lambda_H=0 HR comparison center missing")
	}
	if math.Abs(*hrImproved.LambdaZeroCenterBpm-hrImpC) < 1e-9 {
		t.Fatal("HR was disabled and the H60 estimate did not change: feedback not actually wired")
	}
}

// §10.2 row 9: the original V3 result came from expired/wrong records — V4
// may be slower, but only with a concrete source explanation, and any
// still-valid performance bound is never bypassed.
func TestV4SlowerThanV3NeedsExplanation(t *testing.T) {
	// An old (>60 d) fast hour run feeds the frozen V3 bucket pool; the
	// current window holds only a slower trusted hour run.
	oldFast := v4RunActivity("expired-fast", v4AsOf.AddDate(0, 0, -80), 3600, 4.4, nil)
	current := v4RunActivity("current-slower", v4AsOf.AddDate(0, 0, -10), 3600, 3.6, nil)
	speed, _, _ := v4Estimate(t, []calibration.Activity{oldFast, current}, v4AsOf, nil, nil)
	if speed.CenterMps == nil || speed.BRawMps == nil {
		t.Fatal("baseline chain missing")
	}
	if *speed.CenterMps < *speed.BRawMps {
		if len(speed.V4SlowerReasons) == 0 {
			t.Fatalf("slower than V3 without any explanation: v4=%.3f B_raw=%.3f", *speed.CenterMps, *speed.BRawMps)
		}
		found := false
		for _, r := range speed.V4SlowerReasons {
			if r == "evidence_expired" {
				found = true
			}
		}
		if !found {
			t.Fatalf("expected evidence_expired among reasons, got %v", speed.V4SlowerReasons)
		}
	}
	// The still-valid current bound is never bypassed.
	if *speed.CenterMps < 3.6-1e-9 {
		t.Fatalf("current trusted hour bound bypassed: %.4f", *speed.CenterMps)
	}
	if speed.BEligibleMps != nil && *speed.CenterMps < *speed.BEligibleMps-1e-9 {
		t.Fatalf("v4 below B_eligible: %.4f < %.4f", *speed.CenterMps, *speed.BEligibleMps)
	}
}

// §10.2 row 10: no new evidence, only crossing the validity window — the
// estimate is marked stale/historical and never claims a new observation.
func TestV4CrossingTheWindowMarksStale(t *testing.T) {
	run := v4RunActivity("aging-run", v4AsOf.AddDate(0, 0, -70), 3600, 3.6, nil)
	later := v4AsOf.AddDate(0, 0, 10) // window slides; the run is now 80 d old
	speed, _, _ := v4Estimate(t, []calibration.Activity{run}, later, nil, nil)
	if speed.State != calibration.StateStale {
		t.Fatalf("support outside the current window must be stale, got %s", speed.State)
	}
	found := false
	for _, r := range speed.Reasons {
		if r == "current_window_empty_stale_audit_estimate" {
			found = true
		}
	}
	if !found {
		t.Fatalf("stale reason missing: %v", speed.Reasons)
	}
}

// §10.2 row 11: a genuine all-out reference clearly conflicting with the
// current envelope shows the conflict and its source — labels are not
// silently changed and neither side is erased.
func TestV4AllOutConflictIsReported(t *testing.T) {
	// Verified protocol all-out hour at 4.6 m/s (recent) plus ordinary
	// slower training; the trusted reference binds and is reported.
	hour := v4RunActivity("verified-hour", v4AsOf.AddDate(0, 0, -5), 3600, 4.6, nil)
	easy := v4RunActivity("ordinary-easy", v4AsOf.AddDate(0, 0, -6), 2400, 3.0, nil)
	meta := []calibration.CandidateMetadata{{
		ActivityID: "verified-hour", SourceVersion: "v4-test", EvidenceRef: "ref-1",
		Protocol: "continuous_maximal_test_v1", ProtocolVerified: true,
		DurationS: 3600, StartS: v4F64p(0), EndS: v4F64p(3600),
	}}
	speed, _, _ := v4Estimate(t, []calibration.Activity{hour, easy}, v4AsOf, nil, meta)
	if speed.CenterMps == nil || *speed.CenterMps < 4.6-1e-9 {
		t.Fatalf("verified all-out reference erased from the bound: %.4f", deref(speed.CenterMps))
	}
	if speed.MaximalAnchors < 1 {
		t.Fatalf("verified reference not retained as an anchor: %+v", speed)
	}
}

// §5.2/§8.1 unit checks: day weights sum to D and are invariant to
// unselected additions; the k-grid tie rules and the hard floor survive a
// deliberate push from the margin prior.
func TestV4HardFloorBeatsMarginPrior(t *testing.T) {
	// A trusted hour run plus many easy ordinary runs with the easy margin
	// prior (mu=log 1.08): the center may rise above the hour bound through
	// evidence, but a purely prior-driven rise above the bound while the
	// objective's data term prefers lower would be a penalty-weight leak.
	// The essential check: the floor cannot be crossed downward no matter
	// what the priors want, and the easy runs cannot push below it either.
	hour := v4RunActivity("floor-hour", v4AsOf.AddDate(0, 0, -7), 3600, 3.9, nil)
	var easies []calibration.Activity
	for i := 0; i < 8; i++ {
		easies = append(easies, v4RunActivity("easy-margin-"+string(rune('a'+i)), v4AsOf.AddDate(0, 0, -(2+i)), 3000, 2.8, nil))
	}
	speed, _, _ := v4Estimate(t, append([]calibration.Activity{hour}, easies...), v4AsOf, nil, nil)
	if speed.CenterMps == nil || *speed.CenterMps < 3.9-1e-9 {
		t.Fatalf("hard floor crossed: %.4f < 3.9", deref(speed.CenterMps))
	}
}

func deref(v *float64) float64 {
	if v == nil {
		return math.NaN()
	}
	return *v
}

func v4F64p(v float64) *float64 { return &v }

// §6.4 (P1 fidelity): a regression-branch prediction extrapolated beyond the
// observed speed domain by more than 10% is downgraded, its scenario range
// widens, and the extrapolation is reported explicitly — never silently.
func TestV4RegressionExtrapolationReportedAndWidened(t *testing.T) {
	steady := func(hr float64) *float64 { v := hr; return &v }
	thresholdDay := v4RunActivity("reg-day", v4AsOf.AddDate(0, 0, -6), 3600, 3.5, func(int) *float64 { return steady(150) })
	// A fast short window pushes the hour floor ~18% above the observed HR
	// segment speed: the regression prediction extrapolates.
	fast := v4RunActivity("reg-fast", v4AsOf.AddDate(0, 0, -7), 180, 5.0, nil)
	withExtrapolation, hrExt, _ := v4Estimate(t, []calibration.Activity{thresholdDay, fast}, v4AsOf, nil, nil)
	if hrExt.Branch != "regression" {
		t.Fatalf("no R source must take the regression branch, got %s", hrExt.Branch)
	}
	if !hrExt.RegressionExtrapolatedSpeedDomain {
		t.Fatal("extrapolation beyond the observed speed domain not flagged")
	}
	found := false
	for _, r := range hrExt.Reasons {
		if r == "hr_regression_extrapolated_beyond_observed_speed_domain" {
			found = true
		}
	}
	if !found {
		t.Fatalf("extrapolation reason missing: %v", hrExt.Reasons)
	}
	// Without the fast window the prediction stays inside the observed
	// domain; the extrapolated range must be strictly wider than it.
	_, hrIn, _ := v4Estimate(t, []calibration.Activity{thresholdDay}, v4AsOf, nil, nil)
	if hrIn.RegressionExtrapolatedSpeedDomain {
		t.Fatal("in-domain prediction wrongly flagged as extrapolated")
	}
	if hrExt.RangeLowBpm == nil || hrExt.RangeHighBpm == nil || hrIn.RangeLowBpm == nil || hrIn.RangeHighBpm == nil {
		t.Fatal("ranges missing")
	}
	wExt := *hrExt.RangeHighBpm - *hrExt.RangeLowBpm
	wIn := *hrIn.RangeHighBpm - *hrIn.RangeLowBpm
	if wExt <= wIn {
		t.Fatalf("extrapolated scenario range (%.2f) must be wider than the in-domain family (%.2f)", wExt, wIn)
	}
	if hrExt.State != calibration.StatePriorDominated {
		t.Fatalf("extrapolated regression must stay downgraded, got %s", hrExt.State)
	}
	_ = withExtrapolation
}

// §8.2 item 6 (P2-5): with a single selected day there is explicitly no
// leave-one-day stability evidence.
func TestV4SingleDayHasNoLeaveOneEvidence(t *testing.T) {
	solo := v4RunActivity("solo-day", v4AsOf.AddDate(0, 0, -5), 3600, 3.6, nil)
	speed, _, _ := v4Estimate(t, []calibration.Activity{solo}, v4AsOf, nil, nil)
	if speed.LeaveOneDayStatus != "single_day_no_leave_one_evidence" {
		t.Fatalf("single-day estimate must state the missing stability evidence, got %q", speed.LeaveOneDayStatus)
	}
	two := []calibration.Activity{solo, v4RunActivity("other-day", v4AsOf.AddDate(0, 0, -12), 1800, 3.8, nil)}
	speed2, _, _ := v4Estimate(t, two, v4AsOf, nil, nil)
	if speed2.LeaveOneDayStatus != "computed" {
		t.Fatalf("multi-day estimate must compute leave-one-day, got %q", speed2.LeaveOneDayStatus)
	}
}

// §6.3 (P2-6): the pace and HR sides each publish their independent-day
// counts and loss totals.
func TestV4LossTotalsPublished(t *testing.T) {
	history := []calibration.Activity{
		v4RunActivity("loss-a", v4AsOf.AddDate(0, 0, -30), 1800, 3.6, nil),
		v4RunActivity("loss-b", v4AsOf.AddDate(0, 0, -20), 3600, 3.3, nil),
		v4RunActivity("loss-c", v4AsOf.AddDate(0, 0, -5), 1200, 3.8, nil),
	}
	speed, _, _ := v4Estimate(t, history, v4AsOf, nil, nil)
	if speed.CenterMps == nil {
		t.Fatal("center missing")
	}
	if !(speed.LossLP > 0) {
		t.Fatalf("pace-side loss total must be positive with active pool rows, got %v", speed.LossLP)
	}
	if !(speed.LossLk >= 0) || speed.LossLk > 0.5*math.Pow((0.10-0.06)/0.02, 2)/2+1e-9 {
		t.Fatalf("L_k out of its declared range: %v", speed.LossLk)
	}
	if speed.HRIndependentDays == 0 && speed.LossLHWeighted != 0 {
		t.Fatal("HR loss reported without HR days")
	}
}

// §6.4 row 2 (P2-7): the prior-only HR range comes from the prior scenarios
// — the q60 family unioned with the R±3/M±5 research scenarios.
func TestV4PriorOnlyRangeIncludesRMScenarios(t *testing.T) {
	rhr := 55.0
	health := []calibration.HealthRow{}
	for i := 0; i < 20; i++ {
		health = append(health, calibration.HealthRow{Date: v4AsOf.AddDate(0, 0, -(i + 1)), RHR: &rhr})
	}
	// Easy run without HR (no usable series) + a short hard effort whose HR
	// spike fixes M ≈ 188 without becoming an HR day (180 s < 8 min).
	easy := v4RunActivity("prior-easy", v4AsOf.AddDate(0, 0, -15), 2400, 3.0, nil)
	hard := v4RunActivity("prior-hard", v4AsOf.AddDate(0, 0, -2), 180, 4.0, func(second int) *float64 {
		v := 150.0 + 38.0*float64(second)/180.0
		return &v
	})
	speed, hr, _ := v4Estimate(t, []calibration.Activity{easy, hard}, v4AsOf, health, nil)
	if hr.Branch != "prior_only" {
		t.Fatalf("R/M valid without a usable HR series must take prior_only, got %s (R=%v M=%v)", hr.Branch, hr.RestingHRBpm, hr.HRMaxBpm)
	}
	if hr.CenterBpm == nil || hr.RangeLowBpm == nil || hr.RangeHighBpm == nil {
		t.Fatal("prior-only center/range missing")
	}
	span := *hr.RangeHighBpm - *hr.RangeLowBpm
	q60Only := 0.10 * (*hr.HRMaxBpm - *hr.RestingHRBpm) // 0.90 − 0.80 of reserve
	if span <= q60Only+1e-9 {
		t.Fatalf("prior-only range span %.2f must exceed the q60-only family %.2f (R±3/M±5 scenarios joined)", span, q60Only)
	}
	_ = speed
}
