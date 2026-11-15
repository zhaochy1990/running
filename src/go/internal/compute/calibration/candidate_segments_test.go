package calibration_test

import (
	"math"
	"testing"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
)

func segmentActivity(samples []calibration.Sample) calibration.Activity {
	return calibration.Activity{LabelID: "synthetic", Sport: "run", Samples: samples}
}
func segmentSample(at, distance, speed float64) calibration.Sample {
	return calibration.Sample{ElapsedS: floatPointer(at), DistanceM: floatPointer(distance), SpeedMps: floatPointer(speed)}
}
func TestCandidateRecoversAfterOpeningDistanceSpike(t *testing.T) {
	a := segmentActivity([]calibration.Sample{segmentSample(0, 0, 4), segmentSample(1, 1000, 4), segmentSample(2, 8, 4), segmentSample(3, 12, 4), segmentSample(4, 16, 4)})
	got := calibration.BuildCandidateSegments([]calibration.Activity{a}, []int{3})
	if len(got.Candidates) != 1 {
		t.Fatalf("opening spike lost valid effort: %+v", got)
	}
	c := got.Candidates[0]
	if math.Abs(c.AvgSpeedMps-4) > 1e-9 {
		t.Fatalf("same endpoints should measure 12m/3s, got %+v", c)
	}
	if c.Quality.TimeBasis != "elapsed" || !hasReason(c.Quality.Reasons, "distance_spike") {
		t.Fatalf("missing measurement provenance: %+v", c.Quality)
	}
}
func hasReason(reasons []string, want string) bool {
	for _, r := range reasons {
		if r == want {
			return true
		}
	}
	return false
}

func TestCandidateSpeedIntegralKeepsZeroAndUnequalElapsedIntervals(t *testing.T) {
	samples := []calibration.Sample{segmentSample(0, 0, 4), segmentSample(1, 0, 4), segmentSample(9, 0, 0), segmentSample(10, 0, 0)}
	for i := range samples {
		samples[i].DistanceM = nil
	}
	got := calibration.BuildCandidateSegments([]calibration.Activity{segmentActivity(samples)}, []int{10})
	if len(got.Candidates) != 1 {
		t.Fatalf("valid zero speed was treated as missing: %+v", got)
	}
	c := got.Candidates[0]
	// Trapezoidal speed-time area: 4m + 16m + 0m over all 10 seconds.
	if math.Abs(c.AvgSpeedMps-2) > 1e-9 || c.Quality.SpeedCoverage != 1 {
		t.Fatalf("time integral dropped slow time: %+v", c)
	}
	if c.Confidence == calibration.ConfidenceHigh || !hasReason(c.Quality.Reasons, "speed_integral_fallback") {
		t.Fatalf("fallback lacks quality downgrade: %+v", c)
	}
}

func TestCandidateRecoversLocallyAfterDistanceAndClockDiscontinuities(t *testing.T) {
	cases := []struct {
		name    string
		samples []calibration.Sample
		reason  string
	}{
		{"repeated spikes", []calibration.Sample{segmentSample(0, 0, 4), segmentSample(1, 1000, 4), segmentSample(2, 2000, 4), segmentSample(3, 12, 4), segmentSample(4, 16, 4), segmentSample(5, 20, 4)}, "distance_spike"},
		{"distance reset", []calibration.Sample{segmentSample(0, 400, 4), segmentSample(1, 404, 4), segmentSample(2, 0, 4), segmentSample(3, 4, 4), segmentSample(4, 8, 4), segmentSample(5, 12, 4)}, "distance_reset"},
		{"duplicate clock", []calibration.Sample{segmentSample(0, 0, 4), segmentSample(1, 4, 4), segmentSample(1, 1000, 4), segmentSample(2, 8, 4), segmentSample(3, 12, 4), segmentSample(4, 16, 4), segmentSample(5, 20, 4)}, "non_increasing_time"},
		{"clock restart", []calibration.Sample{segmentSample(100, 0, 4), segmentSample(101, 4, 4), segmentSample(0, 0, 4), segmentSample(1, 4, 4), segmentSample(2, 8, 4), segmentSample(3, 12, 4)}, "non_increasing_time"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := calibration.BuildCandidateSegments([]calibration.Activity{segmentActivity(tc.samples)}, []int{3})
			if len(got.Candidates) != 1 || math.Abs(got.Candidates[0].AvgSpeedMps-4) > 1e-9 {
				t.Fatalf("did not recover: %+v", got)
			}
			if !hasReason(got.Diagnostics[0].Reasons, tc.reason) {
				t.Fatalf("reason absent: %+v", got)
			}
		})
	}
}

func TestCandidateCannotJoinEffortsAcrossPauseOrLongGap(t *testing.T) {
	cases := []struct {
		name    string
		samples []calibration.Sample
		reason  string
	}{
		{"long gap", []calibration.Sample{segmentSample(0, 0, 4), segmentSample(1, 4, 4), segmentSample(50, 200, 4), segmentSample(51, 204, 4)}, "long_gap"},
		{"stationary pause", []calibration.Sample{segmentSample(0, 0, 4), segmentSample(5, 20, 0), segmentSample(10, 20, 0), segmentSample(15, 20, 0), segmentSample(20, 40, 4)}, "stationary_pause"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := segmentActivity(tc.samples)
			a.DurationS = floatPointer(60)
			a.DistanceM = floatPointer(240)
			got := calibration.BuildCandidateSegments([]calibration.Activity{a}, []int{20})
			if len(got.Candidates) != 0 || !hasReason(got.Diagnostics[0].Reasons, tc.reason) {
				t.Fatalf("interruption was bridged or hidden: %+v", got)
			}
		})
	}
}

func TestCandidateRetainsConflictingMeasurementSpeedsAndDowngrades(t *testing.T) {
	a := segmentActivity([]calibration.Sample{segmentSample(0, 0, 5), segmentSample(5, 20, 5), segmentSample(10, 40, 5)})
	a.DurationS = floatPointer(10)
	a.DistanceM = floatPointer(50)
	got := calibration.BuildCandidateSegments([]calibration.Activity{a}, []int{10})
	if len(got.Candidates) != 1 {
		t.Fatalf("conflict not auditable: %+v", got)
	}
	c := got.Candidates[0]
	if c.AvgSpeedMps != 4 || c.Confidence != calibration.ConfidenceLow || !hasReason(c.Quality.Reasons, "distance_speed_conflict") || !hasReason(c.Quality.Reasons, "summary_distance_conflict") {
		t.Fatalf("conflict cherry-picked or concealed: %+v", c)
	}
	if c.Quality.DistanceSpeedMps == nil || *c.Quality.DistanceSpeedMps != 4 || c.Quality.IntegralSpeedMps == nil || *c.Quality.IntegralSpeedMps != 5 {
		t.Fatalf("lost conflicting sources: %+v", c.Quality)
	}
}

func TestCandidateMissingChannelsAreNotZeroAndLongMissingDistanceIsNotInterpolated(t *testing.T) {
	samples := make([]calibration.Sample, 21)
	for i := range samples {
		samples[i] = segmentSample(float64(i), float64(i)*4, 4)
		samples[i].SpeedMps = nil
		if i > 0 && i < 20 {
			samples[i].DistanceM = nil
		}
	}
	got := calibration.BuildCandidateSegments([]calibration.Activity{segmentActivity(samples)}, []int{20})
	if len(got.Candidates) != 0 || !hasReason(got.Diagnostics[0].Reasons, "distance_missing") || !hasReason(got.Diagnostics[0].Reasons, "speed_missing") {
		t.Fatalf("missing interval invented as known distance or zero: %+v", got)
	}
}

func TestCandidateWalkRecoveryKeepsFullDenominator(t *testing.T) {
	a := segmentActivity(nil)
	for i := 0; i <= 20; i++ {
		speed := 1.0
		d := float64(i)
		if i > 10 {
			speed = 4
			d = 10 + float64(i-10)*4
		}
		a.Samples = append(a.Samples, segmentSample(float64(i), d, speed))
	}
	got := calibration.BuildCandidateSegments([]calibration.Activity{a}, []int{20})
	if len(got.Candidates) != 1 || got.Candidates[0].AvgSpeedMps != 2.5 {
		t.Fatalf("walk recovery disappeared: %+v", got)
	}
	clean := segmentActivity([]calibration.Sample{segmentSample(0, 0, 4), segmentSample(10, 40, 4), segmentSample(20, 80, 4)})
	other := calibration.BuildCandidateSegments([]calibration.Activity{clean}, []int{20})
	if len(other.Candidates) != 1 || other.Candidates[0].AvgSpeedMps != 4 || got.Candidates[0].AvgSpeedMps > other.Candidates[0].AvgSpeedMps {
		t.Fatal("adding recovery increased continuous speed")
	}
}

func TestCandidateUsesWallClockAndDoesNotInventMissingTimes(t *testing.T) {
	a := segmentActivity([]calibration.Sample{segmentSample(0, 0, 4), segmentSample(10, 40, 4), segmentSample(20, 80, 4)})
	for i := range a.Samples {
		a.Samples[i].TimestampS = floatPointer([]float64{1000, 1010, 1130}[i])
	}
	got := calibration.BuildCandidateSegments([]calibration.Activity{a}, []int{20})
	if len(got.Candidates) != 0 || !hasReason(got.Diagnostics[0].Reasons, "long_gap") {
		t.Fatalf("moving clock compressed a wall-clock pause: %+v", got)
	}
	for i := range a.Samples {
		a.Samples[i].ElapsedS = nil
		a.Samples[i].TimestampS = nil
	}
	got = calibration.BuildCandidateSegments([]calibration.Activity{a}, []int{2})
	if len(got.Candidates) != 0 || !hasReason(got.Diagnostics[0].Reasons, "missing_time") {
		t.Fatalf("sample index became elapsed time: %+v", got)
	}
}

func TestCandidateRejectsNonfiniteChannelsAndNeverMutatesInput(t *testing.T) {
	a := segmentActivity([]calibration.Sample{segmentSample(0, 0, 4), segmentSample(1, math.NaN(), math.Inf(1)), segmentSample(2, 8, 4), segmentSample(3, 12, 4)})
	got := calibration.BuildCandidateSegments([]calibration.Activity{a}, []int{3})
	if len(got.Candidates) != 1 || !math.IsNaN(*a.Samples[1].DistanceM) || !math.IsInf(*a.Samples[1].SpeedMps, 1) {
		t.Fatalf("invalid point poisoned recovery or input mutated: %+v", got)
	}
	if math.IsNaN(got.Candidates[0].AvgSpeedMps) || math.IsInf(got.Candidates[0].AvgSpeedMps, 0) {
		t.Fatal("nonfinite estimate escaped")
	}
}

func TestCandidateOldLongWindowStabilityRuleSeesRecoveryTime(t *testing.T) {
	a := segmentActivity(nil)
	for i := 0; i <= 1200; i++ {
		speed := 1.0
		d := float64(i)
		if i > 600 {
			speed = 4
			d = 600 + float64(i-600)*4
		}
		a.Samples = append(a.Samples, segmentSample(float64(i), d, speed))
	}
	got := calibration.BuildCandidateSegments([]calibration.Activity{a}, []int{1200})
	if len(got.Candidates) != 0 {
		t.Fatalf("old 12%% stability rule silently excluded slow recovery: %+v", got.Candidates[0].Quality)
	}
}

func TestCandidateChecksLapsAgainstTimeseriesWithoutSummary(t *testing.T) {
	a := segmentActivity([]calibration.Sample{segmentSample(0, 0, 4), segmentSample(5, 20, 4), segmentSample(10, 40, 4)})
	a.Laps = []calibration.Lap{{LapIndex: 1, DurationS: floatPointer(10), DistanceM: floatPointer(60)}}
	got := calibration.BuildCandidateSegments([]calibration.Activity{a}, []int{10})
	if len(got.Candidates) != 1 || got.Candidates[0].Confidence != calibration.ConfidenceLow || !hasReason(got.Diagnostics[0].Reasons, "laps_timeseries_conflict") {
		t.Fatalf("lap mismatch disappeared without summary: %+v", got)
	}
}

func TestCandidateInterpolatesExactWindowBoundaryInTimeIntegral(t *testing.T) {
	samples := []calibration.Sample{segmentSample(0, 0, 0), segmentSample(4, 0, 4), segmentSample(10, 0, 4)}
	for i := range samples {
		samples[i].DistanceM = nil
	}
	got := calibration.BuildCandidateSegments([]calibration.Activity{segmentActivity(samples)}, []int{8})
	if len(got.Candidates) != 1 || math.Abs(got.Candidates[0].AvgSpeedMps-3.75) > 1e-9 || *got.Candidates[0].StartS != 2 {
		t.Fatalf("partial interval lost its speed-time area: %+v", got)
	}
}

func TestCandidateCleanConstantSpeedAgreesAcrossDenseAndSparseSampling(t *testing.T) {
	for _, step := range []int{1, 7, 10} {
		a := segmentActivity(nil)
		for i := 0; i <= 210; i += step {
			a.Samples = append(a.Samples, segmentSample(float64(i), float64(i)*4, 4))
		}
		got := calibration.BuildCandidateSegments([]calibration.Activity{a}, []int{180})
		if len(got.Candidates) != 1 || math.Abs(got.Candidates[0].AvgSpeedMps-4) > 1e-9 || got.Candidates[0].Confidence != calibration.ConfidenceHigh {
			t.Fatalf("clean sampling step %d changed: %+v", step, got)
		}
	}
}
