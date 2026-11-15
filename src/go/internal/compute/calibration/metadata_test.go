package calibration_test

import (
	"encoding/json"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"testing"
	"time"
)

func TestSourceSummaryPreservesMissingAndLegacySemantics(t *testing.T) {
	day := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	r, err := calibration.EstimateOffline(calibration.StrategyCandidate, nil, day, nil)
	if err != nil {
		t.Fatal(err)
	}
	source := calibration.SummarizeSource(r)
	if source.Speed.Method != "constraints_only" || source.HR.TargetType != "unavailable" || source.Speed.IndependentActivities != 0 {
		t.Fatalf("invented support %+v", source)
	}
	raw, err := json.Marshal(source)
	if err != nil {
		t.Fatal(err)
	}
	text := string(raw)
	if got := calibration.ParseSource(&text); got.State != "available" {
		t.Fatal(got)
	}
	bad := "{"
	if got := calibration.ParseSource(&bad); got.State != "source_unavailable" {
		t.Fatal(got)
	}
	v3, _ := calibration.EstimateOffline(calibration.StrategyV3, nil, day, nil)
	if got := calibration.SummarizeSource(v3); got.HR.TargetType != "legacy_training_estimate_not_independent_LTHR" {
		t.Fatal(got)
	}
}
