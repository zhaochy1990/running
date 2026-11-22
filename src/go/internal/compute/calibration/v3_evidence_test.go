package calibration

import (
	"reflect"
	"testing"
	"time"
)

// Run in ordinary CI without private fixtures. Refit against changing speeds
// after serialization, including exact-score ties, optical spikes, missing
// power/HR, lap and activity fallbacks, and an expiring former winner.
func TestV3EvidenceDailyParity(t *testing.T) {
	origin := day(2026, 1, 1)
	var activities []Activity
	for j, pace := range []float64{4.5, 3.8, 4.1, 3.9} {
		a := Activity{LabelID: string(rune('a' + j)), Sport: "run", ActivityDate: origin.AddDate(0, 0, j*35), DurationS: f64(3600), DistanceM: f64(pace * 3600), AvgHR: f64(173), MaxHR: f64(200), AvgPowerW: f64(246.5)}
		if j != 2 {
			for i := 0; i <= 360; i++ {
				sec := float64(i * 10)
				hr := float64(157 + i/15)
				if i == 210 {
					hr = 201
				}
				s := Sample{ElapsedS: f64(sec), SpeedMps: f64(pace), DistanceM: f64(sec * pace), HeartRateBpm: f64(hr), PowerW: f64(float64(200 + i%90))}
				if i%13 == 0 {
					s.HeartRateBpm = nil
				}
				a.Samples = append(a.Samples, s)
			}
		} else {
			a.Laps = []Lap{{DurationS: f64(1800), DistanceM: f64(pace * 1800)}}
		}
		activities = append(activities, a)
	}
	var health []HealthRow
	for i := 0; i < 205; i++ {
		health = append(health, HealthRow{Date: origin.AddDate(0, 0, i), RHR: f64(float64(45 + i%11))})
	}
	var cached []V3ActivityEvidence
	for _, a := range activities {
		e := ExtractV3Evidence(a)
		raw, err := e.Marshal()
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := DecodeV3Evidence(raw)
		if err != nil {
			t.Fatal(err)
		}
		for _, speed := range []float64{3.5, 3.8, 4, 4.2, 4.5, 5} {
			candidates := StableThresholdHrCandidates([]Activity{a}, speed)
			got := decoded.thresholdHR(speed)
			if len(candidates) == 0 {
				if got != nil {
					t.Fatal("unexpected candidate")
				}
				continue
			}
			want := candidates[0]
			if got == nil || got.DurationS != want.DurationS || got.AvgHR != want.AvgHR || got.AvgSpeedMps != want.AvgSpeedMps || got.Confidence != want.Confidence {
				t.Fatalf("different HR candidate at %.2f", speed)
			}
		}
		cached = append(cached, decoded)
	}
	for i := -1; i <= 205; i++ {
		d := origin.AddDate(0, 0, i)
		var in []V3ActivityEvidence
		for j, a := range activities {
			if inClosedRange(a.ActivityDate, d.AddDate(0, 0, -180), d) {
				in = append(in, cached[j])
			}
		}
		got := EstimateV3Evidence(in, d, health)
		want, err := EstimateOffline(StrategyV3, activities, d, health)
		if err != nil || !reflect.DeepEqual(want, got) || !reflect.DeepEqual(ComputeTrainingZones(want.Snapshot), ComputeTrainingZones(got.Snapshot)) {
			t.Fatalf("%s parity failed, err=%v", d.Format(time.DateOnly), err)
		}
	}
}
