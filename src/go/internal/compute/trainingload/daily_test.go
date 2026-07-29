package trainingload

import (
	"math"
	"testing"
	"time"
)

func TestComputeDailyLoadSeriesEWMA(t *testing.T) {
	dose := 100.0
	d1 := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	acts := []ActivityLoadResult{
		{ActivityDate: d1, TrainingDose: &dose, CoverageStatus: CoverageComplete},
		{ActivityDate: d1.AddDate(0, 0, 2), TrainingDose: &dose, CoverageStatus: CoverageComplete},
	}
	// Health rows every day so rest days are REST_CONFIRMED (EWMA decays).
	var health []HealthRow
	for i := 0; i < 5; i++ {
		health = append(health, HealthRow{Date: d1.AddDate(0, 0, i)})
	}
	series := ComputeDailyLoadSeries(acts, health, nil, nil, d1, d1.AddDate(0, 0, 4), nil, nil)
	if len(series) != 5 {
		t.Fatalf("series len = %d, want 5", len(series))
	}
	kA := 1.0 - math.Exp(-1.0/7.0)
	wantA := round4(kA * 100.0)
	if math.Abs(series[0].AcuteLoad-wantA) > 1e-6 {
		t.Errorf("day1 acute = %v, want %v", series[0].AcuteLoad, wantA)
	}
	if series[0].TrainingDose != 100 {
		t.Errorf("day1 dose = %v, want 100", series[0].TrainingDose)
	}
	if series[1].CoverageStatus != CoverageRestConfirmed {
		t.Errorf("day2 coverage = %v, want rest_confirmed", series[1].CoverageStatus)
	}
	if series[1].AcuteLoad >= series[0].AcuteLoad {
		t.Errorf("rest day should decay acute: day1=%v day2=%v", series[0].AcuteLoad, series[1].AcuteLoad)
	}
	if series[0].Form >= 0 {
		t.Errorf("day1 form = %v, want negative (acute>chronic)", series[0].Form)
	}
}
