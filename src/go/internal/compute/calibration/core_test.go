package calibration

import (
	"math"
	"testing"
)

func TestBisectLeft(t *testing.T) {
	a := []float64{0, 1, 2, 3, 4}
	cases := []struct {
		x        float64
		lo, hi   int
		want     int
	}{
		{2, 0, 5, 2},
		{2.5, 0, 5, 3},
		{-1, 0, 5, 0},
		{10, 0, 5, 5},
		{2, 0, 2, 2}, // hi bound
	}
	for _, c := range cases {
		if got := bisectLeft(a, c.x, c.lo, c.hi); got != c.want {
			t.Errorf("bisectLeft(%v,%d,%d) = %d, want %d", c.x, c.lo, c.hi, got, c.want)
		}
	}
}

func TestWeightedMedian(t *testing.T) {
	// Equal weights -> the value where cumulative weight first reaches half.
	got := weightedMedian([][2]float64{{1, 1}, {2, 1}, {3, 1}})
	if got == nil || *got != 2 {
		t.Fatalf("weightedMedian = %v, want 2", got)
	}
	// Heavy tail pulls the median up.
	got = weightedMedian([][2]float64{{1, 1}, {2, 1}, {3, 10}})
	if got == nil || *got != 3 {
		t.Fatalf("weighted median = %v, want 3", got)
	}
	// Zero total weight -> plain median.
	got = weightedMedian([][2]float64{{1, 0}, {5, 0}})
	if got == nil || *got != 3 {
		t.Fatalf("zero-weight median = %v, want 3", got)
	}
}

func TestMonotoneEnvelope(t *testing.T) {
	// Longest->shortest, keep only strictly faster (by >0.5%) efforts.
	pts := []wpoint{
		{d: 600, v: 4.0, w: 1},
		{d: 300, v: 4.5, w: 1},
		{d: 180, v: 4.51, w: 1}, // only 0.25% faster than 4.5 -> dropped
		{d: 1200, v: 3.8, w: 1},
	}
	kept := monotoneEnvelope(pts)
	// Sorted longest->shortest: 1200(3.8) keep, 600(4.0) keep, 300(4.5) keep, 180(4.51) drop.
	if len(kept) != 3 {
		t.Fatalf("kept %d, want 3: %+v", len(kept), kept)
	}
	if kept[0].d != 1200 || kept[1].d != 600 || kept[2].d != 300 {
		t.Errorf("envelope order wrong: %+v", kept)
	}
}

func TestRiegelThresholdProjection(t *testing.T) {
	c := SpeedCandidate{DurationS: 30 * 60, AvgSpeedMps: 4.0}
	// 4.0 * (1800/3600)^0.06 = 4.0 * 0.5^0.06
	want := 4.0 * math.Pow(0.5, 0.06)
	if got := riegelThresholdProjection(c, 0.06); math.Abs(got-want) > 1e-12 {
		t.Errorf("projection = %v, want %v", got, want)
	}
}

func TestNearestBucket(t *testing.T) {
	if got := nearestBucket(1700); got != 1800 {
		t.Errorf("nearestBucket(1700) = %v, want 1800", got)
	}
	if got := nearestBucket(200); got != 180 {
		t.Errorf("nearestBucket(200) = %v, want 180", got)
	}
}

// TestEstimateRunningCalibrationSynthetic builds a tiny synthetic history with a
// clean 20-minute steady effort and asserts the assembly produces a plausible,
// non-nil threshold snapshot (parity with Python is validated separately against
// the real athlete DB).
func TestEstimateRunningCalibrationSynthetic(t *testing.T) {
	asOf := day(2026, 7, 29)
	// One 20-min run at ~4.0 m/s with steady HR ~165, plus HR ramp to 184 max.
	var samples []Sample
	for i := 0; i < 1200; i++ {
		el := float64(i)
		dist := 4.0 * el
		hr := 165.0
		samples = append(samples, Sample{
			ElapsedS:     &el,
			DistanceM:    &dist,
			SpeedMps:     f64(4.0),
			HeartRateBpm: &hr,
		})
	}
	act := Activity{
		LabelID:      "s1",
		ActivityDate: day(2026, 7, 20),
		Sport:        "run",
		DurationS:    f64(1200),
		DistanceM:    f64(4800),
		AvgHR:        f64(165),
		MaxHR:        f64(184),
		Samples:      samples,
	}
	// A few daily RHR rows so the baseline is emitted.
	var health []HealthRow
	for i := 0; i < 20; i++ {
		health = append(health, HealthRow{Date: asOf.AddDate(0, 0, -i-1), RHR: f64(48)})
	}

	snap := EstimateRunningCalibration([]Activity{act}, asOf, health)
	if snap.AlgorithmVersion != ModelVersion {
		t.Errorf("algorithm version = %d, want %d", snap.AlgorithmVersion, ModelVersion)
	}
	if snap.ThresholdSpeedMps == nil {
		t.Error("expected a threshold speed from a clean 20-min effort")
	}
	if snap.RHRBaseline == nil || *snap.RHRBaseline != 48 {
		t.Errorf("rhr baseline = %v, want 48", snap.RHRBaseline)
	}
	if snap.ObservedMaxHR == nil || *snap.ObservedMaxHR != 184 {
		t.Errorf("observed max hr = %v, want 184", snap.ObservedMaxHR)
	}
}
