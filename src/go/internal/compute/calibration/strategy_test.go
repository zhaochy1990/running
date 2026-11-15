package calibration_test

import (
	"encoding/json"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestProductionRemainsV3WhileOfflineSegmentsAreExplicitImplementations(t *testing.T) {
	asOf := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	duration, distance := 3600.0, 14400.0
	history := []calibration.Activity{{LabelID: "steady", ActivityDate: asOf.AddDate(0, 0, -1), Sport: "run", DurationS: &duration, DistanceM: &distance}}
	active := calibration.EstimateRunningCalibration(history, asOf, nil)
	for _, strategy := range []calibration.Strategy{calibration.StrategyV3} {
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
		if result.Implementation != want {
			t.Fatalf("%s implementation=%s", strategy, result.Implementation)
		}
	}
	if _, err := calibration.EstimateOffline("typo", history, asOf, nil); err == nil {
		t.Fatal("unknown strategy silently accepted")
	}
}

func TestOfflineSegmentsOnlyRemainsT2ControlAgainstEvidenceCandidate(t *testing.T) {
	asOf := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	var samples []calibration.Sample
	for i := 0; i <= 3600; i++ {
		speed := 4.0
		if i < 500 {
			speed = 0
		}
		samples = append(samples, calibration.Sample{ElapsedS: floatPointer(float64(i)), SpeedMps: floatPointer(speed)})
	}
	a := calibration.Activity{LabelID: "pause", ActivityDate: asOf, Sport: "run", Samples: samples}
	active := calibration.EstimateRunningCalibration([]calibration.Activity{a}, asOf, nil)
	baseline, _ := calibration.EstimateOffline(calibration.StrategyV3, []calibration.Activity{a}, asOf, nil)
	clean, err := calibration.EstimateOffline(calibration.StrategySegmentsOnly, []calibration.Activity{a}, asOf, nil)
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := calibration.EstimateOffline(calibration.StrategyCandidate, []calibration.Activity{a}, asOf, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(active, baseline.Snapshot) {
		t.Fatal("production escaped frozen v3")
	}
	if clean.Implementation == "v3_alias" || clean.ParameterVersion == "v3-frozen" || clean.Snapshot.AlgorithmVersion == 3 {
		t.Fatalf("fixed measurement implementation misidentified: %+v", clean)
	}
	if reflect.DeepEqual(clean.Snapshot, active) {
		t.Fatal("stationary gap still reaches frozen estimator")
	}
	if clean.Implementation == candidate.Implementation || candidate.Evidence == nil {
		t.Fatal("T3 must identify its evidence implementation independently of T2")
	}
}

func TestOfflineEvidenceProjectsWindowsWithoutRawActivities(t *testing.T) {
	asOf := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	a := calibration.Activity{LabelID: "window-source", ActivityDate: asOf, Sport: "run"}
	for i := 0; i <= 180; i++ {
		a.Samples = append(a.Samples, segmentSample(float64(i), float64(i)*4, 4))
	}
	result, err := calibration.EstimateOffline(calibration.StrategySegmentsOnly, []calibration.Activity{a}, asOf, nil)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"activity_id":"window-source"`) || !strings.Contains(string(data), `"quality"`) {
		t.Fatalf("no auditable projection: %s", data)
	}
	if strings.Contains(string(data), `"Samples"`) || strings.Contains(string(data), `"Laps"`) || strings.Contains(string(data), `"ActivityDate"`) {
		t.Fatal("raw activity leaked through each measurement")
	}
}
