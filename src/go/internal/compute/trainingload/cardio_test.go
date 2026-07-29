package trainingload

import (
	"math"
	"testing"
)

func fp(v float64) *float64 { return &v }

func TestClampAndRound(t *testing.T) {
	if clamp(1.2, 0, 1.05) != 1.05 {
		t.Error("clamp high")
	}
	if clamp(-1, 0, 1) != 0 {
		t.Error("clamp low")
	}
	if round4(1.234567) != 1.2346 {
		t.Errorf("round4 = %v", round4(1.234567))
	}
}

func TestCleanHRDropsLoneSpike(t *testing.T) {
	s := []Sample{
		{HeartRateBpm: fp(150)},
		{HeartRateBpm: fp(200)}, // spike: >12 from both neighbours, neighbours agree
		{HeartRateBpm: fp(151)},
	}
	clean := cleanHRValues(s)
	if clean[1] != nil {
		t.Errorf("expected lone spike dropped, got %v", *clean[1])
	}
	if clean[0] == nil || clean[2] == nil {
		t.Error("neighbours should be kept")
	}
}

func TestCleanHRDropsOutOfBand(t *testing.T) {
	s := []Sample{{HeartRateBpm: fp(20)}, {HeartRateBpm: fp(150)}, {HeartRateBpm: fp(240)}}
	clean := cleanHRValues(s)
	if clean[0] != nil || clean[2] != nil {
		t.Error("out-of-band HR should be nil")
	}
	if clean[1] == nil || *clean[1] != 150 {
		t.Error("in-band HR kept")
	}
}

func TestBanisterTrimp(t *testing.T) {
	// minutes * hrr * exp(4*hrr)
	want := 60.0 * 0.5 * math.Exp(4.0*0.5)
	if got := banisterTrimp(0.5, 60); math.Abs(got-want) > 1e-9 {
		t.Errorf("banister = %v, want %v", got, want)
	}
}

func TestComputeCardioLoadOneHourAtThreshold(t *testing.T) {
	// One hour of steady HR exactly at threshold -> cardio TSS ~100.
	rhr, hrmax, thr := 47.0, 184.0, 169.0
	cal := CalibrationSnapshot{RHRBaseline: &rhr, HRMaxEstimate: &hrmax, ThresholdHR: &thr}
	// 3601 samples 1s apart, all HR = threshold.
	var samples []Sample
	for i := 0; i <= 3600; i++ {
		el := float64(i)
		samples = append(samples, Sample{ElapsedS: &el, HeartRateBpm: &thr})
	}
	dur := 3600.0
	res := computeCardioLoad(ActivityInput{Sport: "run_outdoor", DurationS: &dur, Samples: samples}, cal)
	if res.tss == nil {
		t.Fatalf("expected cardio TSS, reasons=%v", res.reasons)
	}
	if math.Abs(*res.tss-100.0) > 0.5 {
		t.Errorf("cardio TSS = %v, want ~100 for 1h at LTHR", *res.tss)
	}
	if res.confidence != ConfidenceHigh {
		t.Errorf("confidence = %v, want high", res.confidence)
	}
}

func TestComputeCardioLoadMissingCalibration(t *testing.T) {
	res := computeCardioLoad(ActivityInput{Samples: []Sample{{HeartRateBpm: fp(150)}}}, CalibrationSnapshot{})
	if res.tss != nil || res.raw != nil {
		t.Error("expected no load without calibration")
	}
	if len(res.reasons) == 0 || res.reasons[0] != "hr_calibration_missing" {
		t.Errorf("reasons = %v", res.reasons)
	}
}
