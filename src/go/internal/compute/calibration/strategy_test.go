package calibration_test

import (
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"reflect"
	"testing"
	"time"
)

func TestProductionRemainsV3WhileOfflineVariantsAreExplicitAliases(t *testing.T) {
	asOf := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	duration, distance := 3600.0, 14400.0
	history := []calibration.Activity{{LabelID: "steady", ActivityDate: asOf.AddDate(0, 0, -1), Sport: "run", DurationS: &duration, DistanceM: &distance}}
	active := calibration.EstimateRunningCalibration(history, asOf, nil)
	for _, strategy := range []calibration.Strategy{calibration.StrategyV3, calibration.StrategySegmentsOnly, calibration.StrategyCandidate} {
		result, err := calibration.EstimateOffline(strategy, history, asOf, nil)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(active, result.Snapshot) {
			t.Fatalf("%s changes frozen v3", strategy)
		}
		if result.Snapshot.AlgorithmVersion != 3 {
			t.Fatal("active version changed")
		}
		want := "v3"
		if strategy != calibration.StrategyV3 {
			want = "v3_alias"
		}
		if result.Implementation != want {
			t.Fatalf("%s implementation=%s", strategy, result.Implementation)
		}
	}
	if _, err := calibration.EstimateOffline("typo", history, asOf, nil); err == nil {
		t.Fatal("unknown strategy silently accepted")
	}
}
