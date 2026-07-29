package trainingload

import (
	"math"
	"testing"
)

func steadyRunAtSpeed(seconds int, speed float64, hr *float64) []Sample {
	var s []Sample
	sp := speed
	for i := 0; i <= seconds; i++ {
		el := float64(i)
		smp := Sample{ElapsedS: &el, SpeedMps: &sp}
		if hr != nil {
			smp.HeartRateBpm = hr
		}
		s = append(s, smp)
	}
	return s
}

func TestExternalTSSOneHourAtThreshold(t *testing.T) {
	ths := 4.0
	cal := CalibrationSnapshot{ThresholdSpeedMps: &ths}
	dur := 3600.0
	a := ActivityInput{Sport: "run_outdoor", DurationS: &dur, Samples: steadyRunAtSpeed(3600, 4.0, nil)}
	res := computeExternalTSS(a, cal)
	if res.tss == nil {
		t.Fatalf("expected external TSS, reasons=%v", res.reasons)
	}
	if math.Abs(*res.tss-100.0) > 0.5 {
		t.Errorf("external TSS = %v, want ~100 for 1h at threshold speed", *res.tss)
	}
}

func TestExternalNotSupportedForNonRunning(t *testing.T) {
	ths := 4.0
	res := computeExternalTSS(ActivityInput{Sport: "bike", Samples: []Sample{{SpeedMps: &ths}}},
		CalibrationSnapshot{ThresholdSpeedMps: &ths})
	if res.tss != nil {
		t.Error("external TSS should be nil for non-running")
	}
}

func TestMechanicalLoad(t *testing.T) {
	dist := 10000.0
	asc := 100.0
	nif := 0.9
	a := ActivityInput{DistanceM: &dist, AscentM: &asc}
	got := computeMechanicalLoad(a, &nif)
	if got == nil {
		t.Fatal("expected mechanical load")
	}
	// distance_km=10, ascent/km=10, grade=1+0.006*10=1.06, descent=1.0,
	// intensity=1+0.5*(0.9-0.85)^2=1.00125 -> 10*1.06*1.0*1.00125
	want := 10.0 * 1.06 * 1.0 * (1.0 + 0.5*math.Pow(0.05, 2))
	if math.Abs(*got-want) > 1e-3 {
		t.Errorf("mechanical = %v, want ~%v", *got, want)
	}
}

func TestComputeActivityLoadConservativeFusion(t *testing.T) {
	rhr, hrmax, thr, ths := 47.0, 184.0, 169.0, 4.0
	cal := CalibrationSnapshot{RHRBaseline: &rhr, HRMaxEstimate: &hrmax, ThresholdHR: &thr, ThresholdSpeedMps: &ths}
	dur := 3600.0
	// Steady 1h at threshold speed + steady HR at threshold -> both channels ~100.
	a := ActivityInput{Sport: "run_outdoor", DurationS: &dur, Samples: steadyRunAtSpeed(3600, 4.0, &thr)}
	res := ComputeActivityLoad(a, cal)
	if res.TrainingDose == nil {
		t.Fatalf("expected training dose, reasons=%v", res.Reasons)
	}
	if res.TrainingDoseSource == nil || *res.TrainingDoseSource != "conservative_fusion" {
		t.Errorf("dose source = %v, want conservative_fusion", res.TrainingDoseSource)
	}
	// Fusion is min(cardio, external); both ~100.
	if *res.TrainingDose < 95 || *res.TrainingDose > 105 {
		t.Errorf("training dose = %v, want ~100", *res.TrainingDose)
	}
	if res.ExcludedFromPMC {
		t.Error("a full-coverage run should not be excluded from PMC")
	}
}
