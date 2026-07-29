package calibration

import (
	"testing"
	"time"
)

func day(y int, m time.Month, d int) time.Time {
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

func TestPyRoundHalfToEven(t *testing.T) {
	cases := map[float64]int{
		1.3: 1, 1.4: 1, 1.5: 2, 1.6: 2,
		2.5: 2, 0.5: 0, 3.5: 4, 24.5: 24,
	}
	for in, want := range cases {
		if got := pyRound(in); got != want {
			t.Errorf("pyRound(%v) = %d, want %d", in, got, want)
		}
	}
}

func TestMedianFloat(t *testing.T) {
	if got := medianFloat([]float64{3, 1, 2}); got != 2 {
		t.Errorf("odd median = %v, want 2", got)
	}
	if got := medianFloat([]float64{4, 1, 3, 2}); got != 2.5 {
		t.Errorf("even median = %v, want 2.5", got)
	}
}

func TestEstimateRHRBaselineP10(t *testing.T) {
	asOf := day(2026, 1, 30)
	var rows []HealthRow
	// 20 valid samples 40..59 inside the 90d window.
	for i := 0; i < 20; i++ {
		v := float64(40 + i)
		rows = append(rows, HealthRow{Date: asOf.AddDate(0, 0, -i-1), RHR: &v})
	}
	// Noise that must be filtered: zero, nil, and out-of-window.
	zero := 0.0
	rows = append(rows, HealthRow{Date: asOf, RHR: &zero})
	rows = append(rows, HealthRow{Date: asOf, RHR: nil})
	old := 30.0
	rows = append(rows, HealthRow{Date: asOf.AddDate(0, 0, -200), RHR: &old})

	got := EstimateRHRBaseline(rows, asOf)
	if got == nil {
		t.Fatal("expected a baseline, got nil")
	}
	// sorted 40..59, idx = round(19*0.10) = round(1.9) = 2 -> 42.
	if *got != 42 {
		t.Errorf("rhr baseline = %v, want 42", *got)
	}
}

func TestEstimateRHRBaselineTooFewSamples(t *testing.T) {
	asOf := day(2026, 1, 30)
	var rows []HealthRow
	for i := 0; i < 13; i++ { // < 14
		v := float64(50)
		rows = append(rows, HealthRow{Date: asOf.AddDate(0, 0, -i), RHR: &v})
	}
	if got := EstimateRHRBaseline(rows, asOf); got != nil {
		t.Errorf("expected nil for <14 samples, got %v", *got)
	}
}

func TestEstimateCriticalPowerMedian(t *testing.T) {
	asOf := day(2026, 1, 30)
	inWindow := asOf.AddDate(0, 0, -10)
	history := []Activity{
		{
			LabelID: "a1", ActivityDate: inWindow, Sport: "run",
			AvgPowerW: f64(200),
			Samples: []Sample{
				{PowerW: f64(210)},
				{PowerW: f64(40)}, // invalid (<50) -> dropped
				{PowerW: f64(220)},
			},
		},
		{LabelID: "a2", ActivityDate: inWindow, Sport: "running", Samples: []Sample{{PowerW: nil}}},
		{LabelID: "bike", ActivityDate: inWindow, Sport: "bike", AvgPowerW: f64(300)}, // not running
		{LabelID: "old", ActivityDate: asOf.AddDate(0, 0, -300), Sport: "run", AvgPowerW: f64(999)},
	}
	got, n := EstimateCriticalPower(history, asOf)
	if got == nil {
		t.Fatal("expected a value")
	}
	if *got != 210 || n != 3 { // median(200,210,220)=210
		t.Errorf("critical power = %v (n=%d), want 210 (n=3)", *got, n)
	}
}

func TestEstimateHRMaxProfileEmpty(t *testing.T) {
	p := EstimateHRMaxProfile(nil)
	if p.Confidence != ConfidenceNone || p.ObservedMaxHR != nil || p.SampleCount != 0 {
		t.Errorf("empty profile = %+v, want NONE/nil/0", p)
	}
}

func TestEstimateHRMaxProfileMedium(t *testing.T) {
	// A smooth 25-sample ramp 150..174 (each neighbor within 5 -> all supported)
	// plus a supported activity max of 174.
	var samples []Sample
	for i := 0; i < 25; i++ {
		samples = append(samples, Sample{HeartRateBpm: f64(float64(150 + i))})
	}
	a := Activity{LabelID: "x", ActivityDate: day(2026, 1, 20), Sport: "run", MaxHR: f64(174), Samples: samples}

	p := EstimateHRMaxProfile([]Activity{a})
	if p.ObservedMaxHR == nil || *p.ObservedMaxHR != 174 {
		t.Fatalf("observed max = %v, want 174", p.ObservedMaxHR)
	}
	if p.EstimatedHRMax == nil || *p.EstimatedHRMax != 174 {
		t.Errorf("estimated hrmax = %v, want 174", p.EstimatedHRMax)
	}
	if p.SampleCount != 26 { // 25 timeseries + 1 activity max
		t.Errorf("sample count = %d, want 26", p.SampleCount)
	}
	if p.Confidence != ConfidenceMedium {
		t.Errorf("confidence = %q, want medium", p.Confidence)
	}
	if p.HighHRReference == nil || *p.HighHRReference < 173 || *p.HighHRReference > 174 {
		t.Errorf("high hr ref = %v, want within [173,174]", p.HighHRReference)
	}
}
