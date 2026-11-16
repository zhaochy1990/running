package calibration_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
)

// T7 #1001: the protocol v2 scoring engine. It executes the three frozen
// comparison identities (v3, historical v4 candidate, evolved v4 rev2) on a
// schema-2 manifest with the same cutoff discipline as v1 replay, and reduces
// the frozen v2 gates. These tests pin the public seam ReplayV2 only.

// v2SyntheticManifest builds a small schema-2 manifest: one athlete, three
// ordinary training roots (train), one v4-v1-used sample (known_regression)
// and one strict prediction case with no target (all-inputs coverage shape).
func v2SyntheticManifest() calibration.ReplayManifest {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	m := calibration.ReplayManifest{SchemaVersion: 2, AsOf: asOf, SourceVersion: "v2-synthetic"}
	mk := func(id, root, split string, daysAgo int, durationS int, speedMps float64) calibration.ReplayActivity {
		a := calibration.ReplayActivity{ID: id, User: "athlete-a", RootActivityID: root, Split: split, EventTime: asOf.AddDate(0, 0, -daysAgo), Device: "synthetic"}
		availableAt := a.EventTime
		a.AvailableAt = &availableAt
		a.AvailabilityEvidence = "fixture-upload-receipt"
		activity := calibration.Activity{LabelID: id, ActivityDate: a.EventTime, Sport: "run", DurationS: f64p(float64(durationS)), DistanceM: f64p(float64(durationS) * speedMps)}
		for t := 0; t <= durationS; t++ {
			activity.Samples = append(activity.Samples, calibration.Sample{
				ElapsedS:     f64p(float64(t)),
				SpeedMps:     f64p(speedMps),
				DistanceM:    f64p(float64(t) * speedMps),
				HeartRateBpm: f64p(120 + float64(t%300)/10),
			})
		}
		a.Activity = activity
		a.ContentSHA256 = calibration.ReplayContentHash(activity)
		return a
	}
	m.Activities = []calibration.ReplayActivity{
		mk("train-1", "r1", "train", 40, 5400, 3.0),
		mk("train-2", "r2", "train", 9, 3600, 3.3),
		mk("train-3", "r3", "train", 2, 1800, 3.6),
		mk("reg-1", "r9", "known_regression", 35, 3600, 3.2),
	}
	m.Cases = []calibration.ReplayCase{{ID: "c1", User: "athlete-a", PredictionAsOf: asOf.AddDate(0, 0, -1), Mode: "strict"}}
	return m
}

// TestReplayV2RunsFrozenStrategyTrio is the tracer bullet: the engine runs the
// frozen comparison trio per case with the evolved revision marker, refuses
// schema drift, and pins the v2 protocol identity hashes.
func TestReplayV2RunsFrozenStrategyTrio(t *testing.T) {
	m := v2SyntheticManifest()
	report, err := calibration.ReplayV2(m, "test-code")
	if err != nil {
		t.Fatalf("valid v2 manifest rejected: %v", err)
	}
	if len(report.Cases) != 1 {
		t.Fatalf("case count=%d", len(report.Cases))
	}
	caseResult := report.Cases[0]
	if len(caseResult.Failures) != 0 {
		t.Fatalf("unexpected failures: %v", caseResult.Failures)
	}
	want := map[calibration.Strategy]string{
		calibration.StrategyV3:               "",
		calibration.StrategyCandidate:        "",
		calibration.StrategyEvolvedCandidate: calibration.EvolvedCandidateAlgorithmRevision,
	}
	if len(caseResult.Versions) != 3 {
		t.Fatalf("expected the frozen trio, got %d versions", len(caseResult.Versions))
	}
	for _, v := range caseResult.Versions {
		if revision, ok := want[v.Strategy]; !ok {
			t.Fatalf("unexpected strategy %q in v2 result", v.Strategy)
		} else if v.AlgorithmRevision != revision {
			t.Fatalf("strategy %q revision=%q want %q", v.Strategy, v.AlgorithmRevision, revision)
		}
	}
	// Identity pins: the report carries the frozen protocol v2 hash (not v1)
	// and the frozen v3 source hash.
	if report.ProtocolV2SHA256 != calibration.EvaluationProtocolV2SHA256() {
		t.Fatalf("protocol v2 hash %q", report.ProtocolV2SHA256)
	}
	if report.V3SourceSHA256 != calibration.FrozenV3SourceSHA256() {
		t.Fatalf("v3 source hash %q", report.V3SourceSHA256)
	}
	if report.SchemaVersion != 2 || report.CodeVersion != "test-code" {
		t.Fatalf("schema/code identity drift: %d %q", report.SchemaVersion, report.CodeVersion)
	}
	// A v1-schema manifest is not scoreable by the v2 engine.
	v1 := v2SyntheticManifest()
	v1.SchemaVersion = 1
	if _, err := calibration.ReplayV2(v1, "test-code"); err == nil {
		t.Fatal("v2 engine accepted a schema-1 manifest")
	}
}

// TestReplayV2SyntheticSourcesNeverPassAccuracy: a synthetic-only manifest
// must reduce to insufficient with the real-reference provenance gate.
func TestReplayV2SyntheticSourcesNeverPassAccuracy(t *testing.T) {
	report, err := calibration.ReplayV2(v2SyntheticManifest(), "test-code")
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != "insufficient" {
		t.Fatalf("synthetic manifest status=%q want insufficient", report.Status)
	}
	found := false
	for _, g := range report.Gates {
		if g.ID == "real_reference_provenance" {
			found = true
			if g.Status != "insufficient" {
				t.Fatalf("provenance gate status=%q", g.Status)
			}
		}
	}
	if !found {
		t.Fatal("real_reference_provenance gate missing")
	}
}

// TestReplayV2AllInputsCoverageCountsEveryCase: the all-inputs denominator is
// every strict case; the evolved strategy must cover ordinary label-free
// training (finite + physical + ranged) at 100% on this fixture, and the
// report must expose both denominators.
func TestReplayV2AllInputsCoverageCountsEveryCase(t *testing.T) {
	report, err := calibration.ReplayV2(v2SyntheticManifest(), "test-code")
	if err != nil {
		t.Fatal(err)
	}
	if report.AllInputs.Cases != 1 {
		t.Fatalf("all-inputs cases=%d", report.AllInputs.Cases)
	}
	covered := 0
	for _, v := range report.Cases[0].Versions {
		if v.Strategy != calibration.StrategyEvolvedCandidate {
			continue
		}
		if v.Evolved == nil || v.Evolved.Speed == nil {
			t.Fatal("evolved speed report missing")
		}
		s := v.Evolved.Speed
		if s.CenterMps != nil && s.RangeLowMps != nil && s.RangeHighMps != nil &&
			evolvedFinite(*s.CenterMps) && *s.CenterMps > 0 && *s.CenterMps <= 8.5 &&
			*s.RangeLowMps <= *s.CenterMps && *s.CenterMps <= *s.RangeHighMps {
			covered++
		}
	}
	if covered != 1 {
		t.Fatalf("evolved must cover the label-free window, covered=%d", covered)
	}
	if report.AllInputs.EvolvedCovered != 1 {
		t.Fatalf("all-inputs evolved covered=%d", report.AllInputs.EvolvedCovered)
	}
}

// v2HoldoutManifest builds a schema-2 manifest whose final_holdout root may
// carry a direct_60min reference. realFull toggles a fully audited real
// reference vs a synthetic one; eligible toggles the frozen speed eligibility
// rule (>=3 admitted training roots in the prediction window).
func v2HoldoutManifest(realFull, eligible bool) calibration.ReplayManifest {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	m := calibration.ReplayManifest{SchemaVersion: 2, AsOf: asOf, SourceVersion: "v2-synthetic"}
	mk := func(id, root, split string, daysAgo int, durationS int, speedMps float64) calibration.ReplayActivity {
		a := calibration.ReplayActivity{ID: id, User: "athlete-b", RootActivityID: root, Split: split, EventTime: asOf.AddDate(0, 0, -daysAgo), Device: "synthetic"}
		availableAt := a.EventTime
		a.AvailableAt = &availableAt
		a.AvailabilityEvidence = "fixture-upload-receipt"
		activity := calibration.Activity{LabelID: id, ActivityDate: a.EventTime, Sport: "run", DurationS: f64p(float64(durationS)), DistanceM: f64p(float64(durationS) * speedMps)}
		for t := 0; t <= durationS; t++ {
			activity.Samples = append(activity.Samples, calibration.Sample{
				ElapsedS:     f64p(float64(t)),
				SpeedMps:     f64p(speedMps),
				DistanceM:    f64p(float64(t) * speedMps),
				HeartRateBpm: f64p(150 + float64(t%300)/10),
			})
		}
		a.Activity = activity
		a.ContentSHA256 = calibration.ReplayContentHash(activity)
		return a
	}
	trains := []calibration.ReplayActivity{
		mk("train-1", "r1", "train", 40, 5400, 3.0),
		mk("train-2", "r2", "train", 20, 3600, 3.3),
		mk("train-3", "r3", "train", 10, 2700, 3.5),
	}
	if eligible {
		trains = append(trains, mk("train-4", "r4", "train", 5, 1800, 3.6))
	}
	hold := mk("hold-1", "r9", "final_holdout", 1, 3600, 4.0)
	ref := hold.Reference
	if ref == nil {
		ref = &calibration.ReplayReference{}
	}
	ref.Kind = "direct_60min"
	ref.DurationS = 3600
	ref.DistanceM = 14400 // 250 s/km independent reference
	ref.EffortSupport = "confirmed_maximal"
	ref.MeasurementQuality = "high"
	ref.Protocol = "continuous_60min_v1"
	ref.EvidenceRef = "worked-example-audit"
	ref.ContinuousVerified = boolPtr(true)
	if realFull {
		ref.Real = true
		availableAt := hold.EventTime.Add(time.Hour)
		ref.AvailableAt = &availableAt
	} else {
		ref.Real = false
	}
	hold.Reference = ref
	m.Activities = append(trains, hold)
	m.Cases = []calibration.ReplayCase{{ID: "c1", User: "athlete-b", PredictionAsOf: asOf.AddDate(0, 0, -2), Mode: "strict", TargetRootActivityID: "r9"}}
	return m
}

func boolPtr(v bool) *bool { return &v }

func findV2Family(report calibration.ReplayV2Report, split, mode, family string) *calibration.ReplayV2Family {
	for i := range report.Families {
		f := &report.Families[i]
		if f.Split == split && f.Mode == mode && f.Family == family {
			return f
		}
	}
	return nil
}

// TestReplayV2Direct60FamilyCountsDualDenominatorsAndRejections: a synthetic
// (non-real) reference is rejected with an explicit label, never silently
// dropped; the family carries both the eligible and all-inputs denominators.
func TestReplayV2Direct60FamilyCountsDualDenominatorsAndRejections(t *testing.T) {
	report, err := calibration.ReplayV2(v2HoldoutManifest(false, true), "test-code")
	if err != nil {
		t.Fatal(err)
	}
	f := findV2Family(report, "final_holdout", "strict", "direct_60min")
	if f == nil {
		t.Fatal("direct_60min family evaluation missing")
	}
	if f.EligibleActivities != 0 {
		t.Fatalf("non-real reference must not enter the eligible denominator, got %d", f.EligibleActivities)
	}
	if f.RejectedLabels["non_real_reference"] != 1 {
		t.Fatalf("rejection labels=%v", f.RejectedLabels)
	}
	if f.AllInputsCases != 1 {
		t.Fatalf("family all-inputs cases=%d", f.AllInputsCases)
	}
	if f.Status != "insufficient" {
		t.Fatalf("family status=%q", f.Status)
	}
}

// TestReplayV2Direct60ErrorMathWorkedExample: one fully audited real reference
// (250 s/km) with an eligible window pins the error aggregation: median=P90=|err|,
// signed bias=err, per-strategy availability, and range coverage for the evolved
// revision. A second ineligible user (1 training root) stays out of the eligible
// denominator with an explicit label.
func TestReplayV2Direct60ErrorMathWorkedExample(t *testing.T) {
	m := v2HoldoutManifest(true, true)
	// Second user with a single training root: real reference but ineligible window.
	asOf := m.AsOf
	single := calibration.ReplayActivity{ID: "thin-1", User: "athlete-c", RootActivityID: "rc1", Split: "train", EventTime: asOf.AddDate(0, 0, -30), Device: "synthetic"}
	availableAt := single.EventTime
	single.AvailableAt = &availableAt
	single.AvailabilityEvidence = "fixture-upload-receipt"
	activity := calibration.Activity{LabelID: "thin-1", ActivityDate: single.EventTime, Sport: "run", DurationS: f64p(3600), DistanceM: f64p(12600)}
	single.Activity = activity
	single.ContentSHA256 = calibration.ReplayContentHash(activity)
	hold := calibration.ReplayActivity{ID: "thin-hold", User: "athlete-c", RootActivityID: "rc9", Split: "final_holdout", EventTime: asOf.AddDate(0, 0, -1), Device: "synthetic"}
	holdAvailable := hold.EventTime
	hold.AvailableAt = &holdAvailable
	hold.AvailabilityEvidence = "fixture-upload-receipt"
	holdActivity := calibration.Activity{LabelID: "thin-hold", ActivityDate: hold.EventTime, Sport: "run", DurationS: f64p(3600), DistanceM: f64p(14000)}
	hold.Activity = holdActivity
	hold.ContentSHA256 = calibration.ReplayContentHash(holdActivity)
	ref := &calibration.ReplayReference{Kind: "direct_60min", Real: true, DurationS: 3600, DistanceM: 14400, EffortSupport: "confirmed_maximal", MeasurementQuality: "high", Protocol: "continuous_60min_v1", EvidenceRef: "worked-example-audit", ContinuousVerified: boolPtr(true)}
	refAvailable := hold.EventTime.Add(time.Hour)
	ref.AvailableAt = &refAvailable
	hold.Reference = ref
	m.Activities = append(m.Activities, single, hold)
	m.Cases = append(m.Cases, calibration.ReplayCase{ID: "c2", User: "athlete-c", PredictionAsOf: asOf.AddDate(0, 0, -2), Mode: "strict", TargetRootActivityID: "rc9"})

	report, err := calibration.ReplayV2(m, "test-code")
	if err != nil {
		t.Fatal(err)
	}
	f := findV2Family(report, "final_holdout", "strict", "direct_60min")
	if f == nil {
		t.Fatal("family missing")
	}
	if f.EligibleActivities != 1 || f.EligibleUsers != 1 {
		t.Fatalf("eligible=%d/%d want 1/1 (ineligible window must stay out)", f.EligibleActivities, f.EligibleUsers)
	}
	if f.RejectedLabels["window_below_frozen_eligibility"] != 1 {
		t.Fatalf("ineligible rejection label missing: %v", f.RejectedLabels)
	}
	caseByID := map[string]calibration.ReplayV2CaseResult{}
	for _, c := range report.Cases {
		caseByID[c.ID] = c
	}
	main := caseByID["c1"]
	for _, v := range main.Versions {
		metrics := v2MetricsFor(f, v.Strategy)
		if metrics == nil {
			t.Fatalf("metrics missing for %q", v.Strategy)
		}
		if v.Snapshot.ThresholdSpeedMps == nil || !evolvedFinite(*v.Snapshot.ThresholdSpeedMps) {
			if metrics.Available != 0 {
				t.Fatalf("strategy %q without finite center counted available", v.Strategy)
			}
			continue
		}
		if metrics.Available != 1 {
			t.Fatalf("strategy %q available=%d", v.Strategy, metrics.Available)
		}
		expected := 1000 / *v.Snapshot.ThresholdSpeedMps - 250.0
		if metrics.MedianAbsError == nil || diffFloat(*metrics.MedianAbsError, absF(expected)) > 1e-9 {
			t.Fatalf("strategy %q median=%v want %v", v.Strategy, metrics.MedianAbsError, absF(expected))
		}
		if metrics.P90AbsError == nil || diffFloat(*metrics.P90AbsError, absF(expected)) > 1e-9 {
			t.Fatalf("strategy %q p90=%v want %v", v.Strategy, metrics.P90AbsError, absF(expected))
		}
		if metrics.SignedBias == nil || diffFloat(*metrics.SignedBias, expected) > 1e-9 {
			t.Fatalf("strategy %q bias=%v want %v", v.Strategy, metrics.SignedBias, expected)
		}
	}
	// Evolved range coverage: the 250 s/km reference pace either falls inside
	// the reported sensitivity range (coverage 1) or outside (0), computed from
	// the report's own bounds converted to pace space.
	for _, v := range main.Versions {
		if v.Strategy != calibration.StrategyEvolvedCandidate || v.Evolved == nil || v.Evolved.Speed == nil {
			continue
		}
		metrics := v2MetricsFor(f, v.Strategy)
		s := v.Evolved.Speed
		if s.RangeLowMps == nil || s.RangeHighMps == nil || metrics.RangeCoverage == nil {
			t.Fatal("range coverage metric missing")
		}
		inside := 1000 / *s.RangeHighMps <= 250+1e-9 && 250 <= 1000 / *s.RangeLowMps + 1e-9
		want := 0.0
		if inside {
			want = 1
		}
		if *metrics.RangeCoverage != want {
			t.Fatalf("range coverage=%v want %v", *metrics.RangeCoverage, want)
		}
	}
}

func v2SnapshotCenter(t *testing.T, c calibration.ReplayV2CaseResult) float64 {
	t.Helper()
	for _, v := range c.Versions {
		if v.Strategy == calibration.StrategyEvolvedCandidate && v.Snapshot.ThresholdSpeedMps != nil {
			return *v.Snapshot.ThresholdSpeedMps
		}
	}
	t.Fatal("evolved snapshot center missing")
	return 0
}

func v2EvolvedSpeedOf(t *testing.T, c calibration.ReplayV2CaseResult) *calibration.EvolvedSpeedReport {
	t.Helper()
	for _, v := range c.Versions {
		if v.Strategy == calibration.StrategyEvolvedCandidate && v.Evolved != nil && v.Evolved.Speed != nil {
			return v.Evolved.Speed
		}
	}
	t.Fatal("evolved speed report missing")
	return nil
}

func v2MetricsFor(f *calibration.ReplayV2Family, s calibration.Strategy) *calibration.ReplayV2VersionMetrics {
	for i := range f.Versions {
		if f.Versions[i].Strategy == s {
			return &f.Versions[i]
		}
	}
	return nil
}

func absF(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}

func diffFloat(a, b float64) float64 { return absF(a - b) }

// TestReplayV2IsDeterministicByteForByte: the same manifest scores to a
// byte-identical report JSON (no wall clock, no unseeded randomness).
func TestReplayV2IsDeterministicByteForByte(t *testing.T) {
	m := v2SyntheticManifest()
	first, err := calibration.ReplayV2(m, "det-code")
	if err != nil {
		t.Fatal(err)
	}
	second, err := calibration.ReplayV2(m, "det-code")
	if err != nil {
		t.Fatal(err)
	}
	a, _ := json.Marshal(first)
	b, _ := json.Marshal(second)
	if !bytes.Equal(a, b) {
		t.Fatal("same-input ReplayV2 runs differ byte-for-byte")
	}
}

// TestReplayV2KnownRegressionStaysOutOfGates: known_regression references are
// reported in their own descriptive column and never gate the report.
func TestReplayV2KnownRegressionStaysOutOfGates(t *testing.T) {
	m := v2SyntheticManifest()
	// Add an early case whose cutoff precedes the known_regression sample so
	// the seen-sample column actually evaluates a prediction-before-seen pair.
	asOf := m.AsOf
	mkEarly := func(id, root string, daysAgo, durationS int, speedMps float64) calibration.ReplayActivity {
		a := calibration.ReplayActivity{ID: id, User: "athlete-a", RootActivityID: root, Split: "train", EventTime: asOf.AddDate(0, 0, -daysAgo), Device: "synthetic"}
		availableAt := a.EventTime
		a.AvailableAt = &availableAt
		a.AvailabilityEvidence = "fixture-upload-receipt"
		activity := calibration.Activity{LabelID: id, ActivityDate: a.EventTime, Sport: "run", DurationS: f64p(float64(durationS)), DistanceM: f64p(float64(durationS) * speedMps)}
		for t := 0; t <= durationS; t += 5 {
			activity.Samples = append(activity.Samples, calibration.Sample{ElapsedS: f64p(float64(t)), SpeedMps: f64p(speedMps), DistanceM: f64p(float64(t) * speedMps), HeartRateBpm: f64p(150)})
		}
		a.Activity = activity
		a.ContentSHA256 = calibration.ReplayContentHash(activity)
		return a
	}
	m.Activities = append(m.Activities, mkEarly("train-early-1", "re1", 55, 3600, 3.1), mkEarly("train-early-2", "re2", 48, 3600, 3.2), mkEarly("train-early-3", "re3", 44, 3600, 3.25))
	m.Cases = append(m.Cases, calibration.ReplayCase{ID: "c0", User: "athlete-a", PredictionAsOf: asOf.AddDate(0, 0, -41), Mode: "strict"})
	// Give the known_regression root a fully audited real direct_60min ref.
	for i := range m.Activities {
		if m.Activities[i].Split != "known_regression" {
			continue
		}
		a := &m.Activities[i]
		ref := &calibration.ReplayReference{Kind: "direct_60min", Real: true, DurationS: 3600, DistanceM: 14000, EffortSupport: "confirmed_maximal", MeasurementQuality: "high", Protocol: "continuous_60min_v1", EvidenceRef: "regression-audit", ContinuousVerified: boolPtr(true)}
		available := a.EventTime.Add(time.Hour)
		ref.AvailableAt = &available
		a.Reference = ref
	}
	report, err := calibration.ReplayV2(m, "test-code")
	if err != nil {
		t.Fatal(err)
	}
	if len(report.KnownRegression) == 0 {
		t.Fatal("known_regression column missing")
	}
	reported := 0
	for _, f := range report.KnownRegression {
		if f.EligibleActivities == 0 {
			continue
		}
		reported++
		if len(f.Gates) != 0 {
			t.Fatalf("known_regression family %s carries gates", f.Family)
		}
		if f.Status != "reported" {
			t.Fatalf("known_regression status=%q", f.Status)
		}
	}
	if reported == 0 {
		t.Fatal("no known_regression family evaluated a seen sample")
	}
	for _, g := range report.Gates {
		if strings.Contains(g.ID, "known_regression") {
			t.Fatalf("known_regression leaked into report gates: %s", g.ID)
		}
	}
}

// TestReplayV2WalkForwardStabilityAndPriorSensitivity: two strict cases of
// one user at different cutoffs exercise the walk-forward prior chain, the
// time-stability jumps and the prior-sensitivity double run.
func TestReplayV2WalkForwardStabilityAndPriorSensitivity(t *testing.T) {
	m := v2SyntheticManifest()
	m.Cases = append(m.Cases, calibration.ReplayCase{ID: "c2", User: "athlete-a", PredictionAsOf: m.AsOf, Mode: "strict"})
	report, err := calibration.ReplayV2(m, "test-code")
	if err != nil {
		t.Fatal(err)
	}
	byID := map[string]calibration.ReplayV2CaseResult{}
	for _, c := range report.Cases {
		byID[c.ID] = c
	}
	// c1 (earlier cutoff) has no prior; c2 chains from c1's evolved center.
	if byID["c1"].PriorChainApplied {
		t.Fatal("first case must not consume a chained prior")
	}
	if !byID["c2"].PriorChainApplied {
		t.Fatal("second case must consume the chained prior")
	}
	if byID["c2"].PriorFreeEvolved == nil {
		t.Fatal("prior-free evolved rerun missing")
	}
	// Review P0-2 wiring proof: the chained run must actually consume the
	// previous snapshot as a historical prior (report-level lineage), while
	// the prior-free rerun must not carry one.
	chained := v2EvolvedSpeedOf(t, byID["c2"])
	free := byID["c2"].PriorFreeEvolved.Evolved.Speed
	if chained.HistoricalPriorMeanLog == nil {
		t.Fatal("chained evolved run carries no historical prior lineage (chain not wired)")
	}
	if free.HistoricalPriorMeanLog != nil {
		t.Fatal("prior-free rerun unexpectedly carries a historical prior")
	}
	firstCenter := v2SnapshotCenter(t, byID["c1"])
	if chained.CenterMps == nil {
		t.Fatal("centers missing")
	}
	// The chain carries the previous case's persisted snapshot center (the
	// round4 production row shape, mirroring T5's prior-from-snapshot path).
	if math.Abs(*chained.HistoricalPriorMeanLog-math.Log(firstCenter)) > 1e-9 {
		t.Fatalf("chained prior mean %v does not match the previous snapshot center log %v", *chained.HistoricalPriorMeanLog, math.Log(firstCenter))
	}
	if report.TimeStability == nil || report.TimeStability.AdjacentPairs < 1 {
		t.Fatalf("time stability diagnostics missing: %+v", report.TimeStability)
	}
	if report.TimeStability.JumpMedianSPerKm == nil || *report.TimeStability.JumpMedianSPerKm < 0 {
		t.Fatalf("jump median invalid: %+v", report.TimeStability)
	}
	if report.PriorSensitivity == nil || report.PriorSensitivity.CasesCompared < 1 {
		t.Fatalf("prior sensitivity missing: %+v", report.PriorSensitivity)
	}
}

// TestReplayV2BootstrapFrozenSeedAndSyntheticSkip: the user-cluster bootstrap
// runs only on real references with >=2 paired users, with the frozen v2 seed.
func TestReplayV2BootstrapFrozenSeedAndSyntheticSkip(t *testing.T) {
	// Synthetic manifest: no uncertainty.
	report, err := calibration.ReplayV2(v2HoldoutManifest(true, true), "test-code")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range report.Families {
		if f.Uncertainty != nil {
			t.Fatalf("synthetic family must not bootstrap: %s", f.Family)
		}
	}
	// Two real-referenced eligible users: bootstrap present, seed frozen.
	m := v2TwoUserRealManifest()
	report, err = calibration.ReplayV2(m, "test-code")
	if err != nil {
		t.Fatal(err)
	}
	f := findV2Family(report, "final_holdout", "strict", "direct_60min")
	if f == nil {
		t.Fatal("family missing")
	}
	if f.Uncertainty == nil {
		t.Fatal("bootstrap uncertainty missing for real paired users")
	}
	if f.Uncertainty.Seed != 993994 || f.Uncertainty.Resamples != 2000 {
		t.Fatalf("frozen bootstrap parameters drifted: %+v", f.Uncertainty)
	}
	// Determinism of the bootstrap: identical rerun.
	again, err := calibration.ReplayV2(m, "test-code")
	if err != nil {
		t.Fatal(err)
	}
	f2 := findV2Family(again, "final_holdout", "strict", "direct_60min")
	if f2.Uncertainty == nil || *f2.Uncertainty != *f.Uncertainty {
		t.Fatal("bootstrap not reproducible")
	}
}

// v2TwoUserRealManifest: two users with eligible windows and fully audited
// real direct_60min references (different reference paces).
func v2TwoUserRealManifest() calibration.ReplayManifest {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	m := calibration.ReplayManifest{SchemaVersion: 2, AsOf: asOf, SourceVersion: "v2-real-shaped"}
	build := func(user, suffix string, refDistance float64) {
		mk := func(id, root, split string, daysAgo, durationS int, speedMps float64) calibration.ReplayActivity {
			a := calibration.ReplayActivity{ID: id + suffix, User: user, RootActivityID: root + suffix, Split: split, EventTime: asOf.AddDate(0, 0, -daysAgo), Device: "synthetic"}
			availableAt := a.EventTime
			a.AvailableAt = &availableAt
			a.AvailabilityEvidence = "fixture-upload-receipt"
			activity := calibration.Activity{LabelID: id + suffix, ActivityDate: a.EventTime, Sport: "run", DurationS: f64p(float64(durationS)), DistanceM: f64p(float64(durationS) * speedMps)}
			for t := 0; t <= durationS; t += 5 {
				activity.Samples = append(activity.Samples, calibration.Sample{
					ElapsedS:     f64p(float64(t)),
					SpeedMps:     f64p(speedMps),
					DistanceM:    f64p(float64(t) * speedMps),
					HeartRateBpm: f64p(150 + float64(t%300)/10),
				})
			}
			a.Activity = activity
			a.ContentSHA256 = calibration.ReplayContentHash(activity)
			return a
		}
		m.Activities = append(m.Activities,
			mk("train-1", "r1", "train", 40, 5400, 3.0),
			mk("train-2", "r2", "train", 20, 3600, 3.3),
			mk("train-3", "r3", "train", 10, 2700, 3.5),
			mk("train-4", "r4", "train", 5, 1800, 3.6))
		hold := mk("hold-1", "r9", "final_holdout", 1, 3600, 4.0)
		hold.Reference = &calibration.ReplayReference{Kind: "direct_60min", Real: true, DurationS: 3600, DistanceM: refDistance, EffortSupport: "confirmed_maximal", MeasurementQuality: "high", Protocol: "continuous_60min_v1", EvidenceRef: "audit-" + user, ContinuousVerified: boolPtr(true)}
		available := hold.EventTime.Add(time.Hour)
		hold.Reference.AvailableAt = &available
		m.Activities = append(m.Activities, hold)
		m.Cases = append(m.Cases, calibration.ReplayCase{ID: "c-" + user, User: user, PredictionAsOf: asOf.AddDate(0, 0, -2), Mode: "strict", TargetRootActivityID: "r9" + suffix})
	}
	build("athlete-d", "-d", 14400)
	build("athlete-e", "-e", 15000)
	return m
}

// TestReplayV2RetrospectiveModeNeverGates: event_date_retrospective families
// are reported but their gates never enter the report-level gate list.
func TestReplayV2RetrospectiveModeNeverGates(t *testing.T) {
	m := v2HoldoutManifest(true, true)
	m.Cases[0].Mode = "event_date_retrospective"
	report, err := calibration.ReplayV2(m, "test-code")
	if err != nil {
		t.Fatal(err)
	}
	f := findV2Family(report, "final_holdout", "event_date_retrospective", "direct_60min")
	if f == nil {
		t.Fatal("retrospective family missing")
	}
	if f.EligibleActivities != 1 {
		t.Fatalf("retrospective eligible=%d (real reference counts, mode is separate)", f.EligibleActivities)
	}
	for _, g := range report.Gates {
		if strings.Contains(g.ID, "event_date_retrospective") {
			t.Fatalf("retrospective gate leaked into report gates: %s", g.ID)
		}
	}
}

// TestReplayV2InputOrderIndependence: permuting manifest activity/case order
// yields identical per-case inputs and version outputs.
func TestReplayV2InputOrderIndependence(t *testing.T) {
	m := v2SyntheticManifest()
	baseline, err := calibration.ReplayV2(m, "order-code")
	if err != nil {
		t.Fatal(err)
	}
	shuffled := m
	shuffled.Activities = append([]calibration.ReplayActivity(nil), m.Activities...)
	shuffled.Activities[0], shuffled.Activities[len(shuffled.Activities)-1] = shuffled.Activities[len(shuffled.Activities)-1], shuffled.Activities[0]
	shuffled.Cases = append([]calibration.ReplayCase(nil), m.Cases...)
	shuffled.Health = append([]calibration.ReplayHealth(nil), m.Health...)
	permuted, err := calibration.ReplayV2(shuffled, "order-code")
	if err != nil {
		t.Fatal(err)
	}
	if len(permuted.Cases) != len(baseline.Cases) {
		t.Fatal("case count changed under permutation")
	}
	for i := range baseline.Cases {
		a, b := baseline.Cases[i], permuted.Cases[i]
		if a.ID != b.ID || a.InputSHA256 != b.InputSHA256 {
			t.Fatalf("case identity/input hash changed: %s vs %s", a.ID, b.ID)
		}
		x, _ := json.Marshal(a.Versions)
		y, _ := json.Marshal(b.Versions)
		if !bytes.Equal(x, y) {
			t.Fatalf("case %s version outputs differ under permutation", a.ID)
		}
	}
}

// buildV2CommittedFixture assembles the committed schema-2 backtest fixture:
// the eight v1-phase synthetic scenarios migrate to known_regression (they
// were seen by the v4 v1 phase and can never again be independent evidence),
// plus fresh synthetic ordinary-training users that exercise the all-inputs
// coverage denominator and a non-real synthetic holdout target.
func buildV2CommittedFixture(t *testing.T) calibration.ReplayManifest {
	t.Helper()
	raw, err := os.ReadFile("testdata/replay-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var v1 calibration.ReplayManifest
	if err := json.Unmarshal(raw, &v1); err != nil {
		t.Fatal(err)
	}
	m := calibration.ReplayManifest{SchemaVersion: 2, AsOf: v1.AsOf, SourceVersion: "v2-synthetic-regression-fixture"}
	for _, a := range v1.Activities {
		migrated := a
		migrated.Split = "known_regression"
		m.Activities = append(m.Activities, migrated)
	}
	m.Cases = append(m.Cases, v1.Cases...)
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	mk := func(user, id, root, split string, daysAgo, durationS int, speedMps float64) calibration.ReplayActivity {
		a := calibration.ReplayActivity{ID: id, User: user, RootActivityID: root, Split: split, EventTime: asOf.AddDate(0, 0, -daysAgo), Device: "synthetic"}
		availableAt := a.EventTime
		a.AvailableAt = &availableAt
		a.AvailabilityEvidence = "fixture-upload-receipt"
		activity := calibration.Activity{LabelID: id, ActivityDate: a.EventTime, Sport: "run", DurationS: f64p(float64(durationS)), DistanceM: f64p(float64(durationS) * speedMps)}
		for t := 0; t <= durationS; t += 10 {
			hr := 135.0
			if speedMps > 3.4 {
				hr = 155.0
			}
			activity.Samples = append(activity.Samples, calibration.Sample{ElapsedS: f64p(float64(t)), SpeedMps: f64p(speedMps), DistanceM: f64p(float64(t) * speedMps), HeartRateBpm: f64p(hr)})
		}
		a.Activity = activity
		a.ContentSHA256 = calibration.ReplayContentHash(activity)
		return a
	}
	// Fresh ordinary-training user A: three roots, mixed paces.
	m.Activities = append(m.Activities,
		mk("fresh_ordinary_a", "fa-1", "far-1", "train", 30, 5400, 3.0),
		mk("fresh_ordinary_a", "fa-2", "far-2", "train", 12, 3600, 3.3),
		mk("fresh_ordinary_a", "fa-3", "far-3", "train", 3, 2400, 3.55))
	m.Cases = append(m.Cases, calibration.ReplayCase{ID: "fresh-a-case", User: "fresh_ordinary_a", PredictionAsOf: asOf.AddDate(0, 0, -1), Mode: "strict"})
	// Fresh easy-only user B: prior-dominated coverage shape.
	m.Activities = append(m.Activities,
		mk("fresh_easy_b", "fb-1", "fbr-1", "train", 25, 5400, 2.9),
		mk("fresh_easy_b", "fb-2", "fbr-2", "train", 14, 4800, 2.95),
		mk("fresh_easy_b", "fb-3", "fbr-3", "train", 4, 4200, 2.9))
	m.Cases = append(m.Cases, calibration.ReplayCase{ID: "fresh-b-case", User: "fresh_easy_b", PredictionAsOf: asOf.AddDate(0, 0, -1), Mode: "strict"})
	// Fresh holdout user C: synthetic (non-real) final_holdout reference.
	m.Activities = append(m.Activities,
		mk("fresh_hold_c", "fc-1", "fcr-1", "train", 28, 5400, 3.1),
		mk("fresh_hold_c", "fc-2", "fcr-2", "train", 15, 3600, 3.4),
		mk("fresh_hold_c", "fc-3", "fcr-3", "train", 6, 1800, 3.6))
	hold := mk("fresh_hold_c", "fc-hold", "fcr-9", "final_holdout", 1, 3600, 4.0)
	hold.Reference = &calibration.ReplayReference{Kind: "direct_60min", Real: false, DurationS: 3600, DistanceM: 14400, EffortSupport: "confirmed_maximal", MeasurementQuality: "high", Protocol: "continuous_60min_v1", EvidenceRef: "synthetic-only"}
	m.Activities = append(m.Activities, hold)
	m.Cases = append(m.Cases, calibration.ReplayCase{ID: "fresh-c-case", User: "fresh_hold_c", PredictionAsOf: asOf.AddDate(0, 0, -2), Mode: "strict", TargetRootActivityID: "fcr-9"})
	if err := calibration.ValidateReplayManifestV2(m); err != nil {
		t.Fatalf("committed fixture manifest invalid: %v", err)
	}
	return m
}

// TestReplayV2GenerateCommittedFixture regenerates testdata/replay-v2.json
// (env-guarded, STRIDE_989_FIXTURE_OUTPUT pattern).
func TestReplayV2GenerateCommittedFixture(t *testing.T) {
	out := os.Getenv("STRIDE_T7_FIXTURE_OUTPUT")
	if out == "" {
		t.Skip("set STRIDE_T7_FIXTURE_OUTPUT to regenerate the committed v2 fixture")
	}
	m := buildV2CommittedFixture(t)
	data, err := json.MarshalIndent(m, "", " ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(out, data, 0644); err != nil {
		t.Fatal(err)
	}
}

// TestReplayV2CommittedFixtureBacktest locks the committed fixture's scored
// shape: eight migrated v1 scenarios stay known_regression-only inputs, the
// fresh users cover the all-inputs denominator, the synthetic holdout is
// rejected as non-real, and the report stays insufficient.
func TestReplayV2CommittedFixtureBacktest(t *testing.T) {
	raw, err := os.ReadFile("testdata/replay-v2.json")
	if err != nil {
		t.Fatal(err)
	}
	var m calibration.ReplayManifest
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	report, err := calibration.ReplayV2(m, "committed-fixture")
	if err != nil {
		t.Fatal(err)
	}
	if report.Status != "insufficient" {
		t.Fatalf("committed fixture status=%q", report.Status)
	}
	if report.AllInputs.Cases != 3 || report.AllInputs.EvolvedCovered != 3 {
		t.Fatalf("all-inputs=%+v want 3/3", report.AllInputs)
	}
	f := findV2Family(report, "final_holdout", "strict", "direct_60min")
	if f == nil || f.RejectedLabels["non_real_reference"] != 1 {
		t.Fatalf("synthetic holdout rejection missing: %+v", f)
	}
	// The eight migrated scenarios still produce sealed trio predictions.
	caseCount := 0
	for _, c := range report.Cases {
		if len(c.Versions) == 3 && c.Activities == 0 {
			caseCount++
		}
	}
	if caseCount != 8 {
		t.Fatalf("migrated v1 scenario predictions=%d want 8", caseCount)
	}
}

// v2MultiObservationManifest: four users, each with an eligible training
// window and three fully audited real direct_60min references at different
// cutoffs — enough observations that floating-point summation order matters.
func v2MultiObservationManifest() calibration.ReplayManifest {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	m := calibration.ReplayManifest{SchemaVersion: 2, AsOf: asOf, SourceVersion: "v2-real-shaped"}
	build := func(user, suffix string, refPaces ...float64) {
		mk := func(id, root, split string, daysAgo, durationS int, speedMps float64) calibration.ReplayActivity {
			a := calibration.ReplayActivity{ID: id + suffix, User: user, RootActivityID: root + suffix, Split: split, EventTime: asOf.AddDate(0, 0, -daysAgo), Device: "synthetic"}
			availableAt := a.EventTime
			a.AvailableAt = &availableAt
			a.AvailabilityEvidence = "fixture-upload-receipt"
			activity := calibration.Activity{LabelID: id + suffix, ActivityDate: a.EventTime, Sport: "run", DurationS: f64p(float64(durationS)), DistanceM: f64p(float64(durationS) * speedMps)}
			for t := 0; t <= durationS; t += 10 {
				activity.Samples = append(activity.Samples, calibration.Sample{
					ElapsedS:     f64p(float64(t)),
					SpeedMps:     f64p(speedMps),
					DistanceM:    f64p(float64(t) * speedMps),
					HeartRateBpm: f64p(150 + float64(t%300)/10),
				})
			}
			a.Activity = activity
			a.ContentSHA256 = calibration.ReplayContentHash(activity)
			return a
		}
		m.Activities = append(m.Activities,
			mk("train-1", "r1", "train", 60, 5400, 3.0),
			mk("train-2", "r2", "train", 40, 3600, 3.3),
			mk("train-3", "r3", "train", 25, 2700, 3.5),
			mk("train-4", "r4", "train", 12, 1800, 3.6))
		for i, pace := range refPaces {
			hold := mk(fmt.Sprintf("hold-%d", i+1), fmt.Sprintf("r9%d", i+1), "final_holdout", 10-i*3, 3600, 4.0)
			hold.Reference = &calibration.ReplayReference{Kind: "direct_60min", Real: true, DurationS: 3600, DistanceM: 3600000 / pace, EffortSupport: "confirmed_maximal", MeasurementQuality: "high", Protocol: "continuous_60min_v1", EvidenceRef: "multi-obs-audit", ContinuousVerified: boolPtr(true)}
			available := hold.EventTime.Add(time.Hour)
			hold.Reference.AvailableAt = &available
			m.Activities = append(m.Activities, hold)
			m.Cases = append(m.Cases, calibration.ReplayCase{ID: fmt.Sprintf("c-%s-%d", user, i+1), User: user, PredictionAsOf: asOf.AddDate(0, 0, -(11 - i*3)), Mode: "strict", TargetRootActivityID: fmt.Sprintf("r9%d%s", i+1, suffix)})
		}
	}
	build("athlete-p", "-p", 245.0, 251.0, 248.0)
	build("athlete-q", "-q", 258.0, 262.0, 255.0)
	build("athlete-r", "-r", 233.0, 239.0, 230.0)
	build("athlete-s", "-s", 271.0, 266.0, 274.0)
	return m
}

// TestReplayV2MultiObservationDeterminism (review P0-1): with twelve scored
// observations across four users, repeated runs must stay byte-identical —
// map iteration order and naive floating-point summation must not leak ulps
// into the report.
func TestReplayV2MultiObservationDeterminism(t *testing.T) {
	m := v2MultiObservationManifest()
	baseline, err := calibration.ReplayV2(m, "det-code")
	if err != nil {
		t.Fatal(err)
	}
	f := findV2Family(baseline, "final_holdout", "strict", "direct_60min")
	if f == nil || f.EligibleActivities != 12 {
		t.Fatalf("fixture must score 12 eligible observations, got %+v", f)
	}
	first, _ := json.Marshal(baseline)
	for i := 0; i < 40; i++ {
		report, err := calibration.ReplayV2(m, "det-code")
		if err != nil {
			t.Fatal(err)
		}
		again, _ := json.Marshal(report)
		if !bytes.Equal(first, again) {
			t.Fatalf("run %d differs byte-for-byte from the baseline (map-order or summation nondeterminism)", i)
		}
	}
}

// TestReplayV2FailureRateGateIsMachineReduced (review P1-1): the protocol's
// "计算失败率 ≤ 1%" must be a real gate on the rev2 strategy inside the
// strict final_holdout direct_60min family, scored only with real references.
func TestReplayV2FailureRateGateIsMachineReduced(t *testing.T) {
	report, err := calibration.ReplayV2(v2TwoUserRealManifest(), "test-code")
	if err != nil {
		t.Fatal(err)
	}
	f := findV2Family(report, "final_holdout", "strict", "direct_60min")
	if f == nil {
		t.Fatal("family missing")
	}
	found := false
	for _, g := range f.Gates {
		if g.ID != "direct_60min.final_holdout.strict.failure_rate" {
			continue
		}
		found = true
		if g.Status != "pass" {
			t.Fatalf("zero-failure family must pass the failure-rate gate: %+v", g)
		}
	}
	if !found {
		t.Fatal("failure-rate gate missing from the strict final_holdout direct_60min family")
	}
	// Synthetic references never score the gate.
	synthetic, err := calibration.ReplayV2(v2HoldoutManifest(false, true), "test-code")
	if err != nil {
		t.Fatal(err)
	}
	sf := findV2Family(synthetic, "final_holdout", "strict", "direct_60min")
	for _, g := range sf.Gates {
		if g.ID == "direct_60min.final_holdout.strict.failure_rate" && g.Status == "pass" {
			t.Fatal("synthetic manifest must not pass the failure-rate gate")
		}
	}
	// A real-named source with zero eligible activities cannot pass either:
	// an empty denominator must never print "pass".
	empty := v2HoldoutManifest(false, true)
	empty.SourceVersion = "personal-shaped-no-references"
	emptyReport, err := calibration.ReplayV2(empty, "test-code")
	if err != nil {
		t.Fatal(err)
	}
	ef := findV2Family(emptyReport, "final_holdout", "strict", "direct_60min")
	for _, g := range ef.Gates {
		if g.ID == "direct_60min.final_holdout.strict.failure_rate" && g.Status != "insufficient" {
			t.Fatalf("empty family failure-rate gate must stay insufficient: %+v", g)
		}
	}
}

// TestReplayV2LagDiagnosticsComputed (review P1-2): users with >=2 referenced
// strict direct_60min predictions get the half-window signed-drift lag proxy;
// a manifest without repeated references leaves it nil.
func TestReplayV2LagDiagnosticsComputed(t *testing.T) {
	// v2MultiObservationManifest: 4 users x 3 referenced strict predictions.
	report, err := calibration.ReplayV2(v2MultiObservationManifest(), "test-code")
	if err != nil {
		t.Fatal(err)
	}
	if report.TimeStability == nil || report.TimeStability.LagDiagnostics == nil {
		t.Fatalf("lag diagnostics missing: %+v", report.TimeStability)
	}
	lag := report.TimeStability.LagDiagnostics
	if lag.Users != 4 {
		t.Fatalf("lag users=%d want 4", lag.Users)
	}
	if lag.DriftSPerKm == nil {
		t.Fatal("lag drift missing")
	}
	// Single-reference users (v2TwoUserRealManifest) cannot support a lag
	// estimate; the diagnostics must stay nil rather than fabricate one.
	single, err := calibration.ReplayV2(v2TwoUserRealManifest(), "test-code")
	if err != nil {
		t.Fatal(err)
	}
	if single.TimeStability.LagDiagnostics != nil {
		t.Fatalf("lag diagnostics fabricated without repeated references: %+v", single.TimeStability.LagDiagnostics)
	}
}
