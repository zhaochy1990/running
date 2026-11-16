package calibration_test

import (
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"math"
	"testing"
)

func TestOfflineRacePredictionUsesIdentifiedSnapshotModelOnly(t *testing.T) {
	v, k := 5.0, .1
	s := calibration.Snapshot{ThresholdSpeedMps: &v, RiegelK: &k}
	for _, seconds := range []float64{180, 3600, 7200} {
		distance := 18000 * math.Pow(seconds/3600, .9)
		got := calibration.PredictOfflineRaceTime(s, distance)
		if got.State != "available" || got.DurationS == nil || math.Abs(*got.DurationS-seconds) > 1e-8 {
			t.Fatalf("%g: %+v", seconds, got)
		}
	}
	for _, seconds := range []float64{179.999, 7200.001} {
		if got := calibration.PredictOfflineRaceTime(s, 18000*math.Pow(seconds/3600, .9)); got.State != "unsupported" {
			t.Fatalf("domain: %+v", got)
		}
	}
	s.RiegelK = nil
	if got := calibration.PredictOfflineRaceTime(s, 18000); got.State != "missing" {
		t.Fatal(got)
	}
	s.RiegelK = &k
	v = math.NaN()
	if got := calibration.PredictOfflineRaceTime(s, 18000); got.State != "failed" {
		t.Fatal(got)
	}
	v = 5
	k = .11
	if got := calibration.PredictOfflineRaceTime(s, 18000); got.State != "failed" {
		t.Fatal(got)
	}
}
