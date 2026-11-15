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

func TestSourceFreshnessUsesActualMaximalAnchor(t *testing.T) {
	old := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	today := old.AddDate(0, 0, 30)
	center := 4.0
	result := calibration.OfflineResult{Strategy: calibration.StrategyCandidate, Snapshot: calibration.Snapshot{AsOfDate: today}, Evidence: &calibration.CandidateEvidenceReport{
		Hour:       &calibration.HourCapabilityReport{Method: "direct_60min_maximal", CenterMps: &center, AnchorActivities: 1, AnchorDays: 1, Observations: []calibration.HourModelObservation{{ActivityID: "anchor", RootActivityID: "root", DurationS: 3600, Role: "maximal_anchor", Weight: 1}, {ActivityID: "easy", RootActivityID: "easy", DurationS: 3600, Role: "original_duration_soft_lower_constraint", Weight: 0}}},
		Candidates: []calibration.CandidateEvidence{{ActivityID: "anchor", RootActivityID: "root", ActivityDate: old, DurationS: 3600, Selected: true, EffortSupport: calibration.EffortConfirmedMaximal, MeasurementQuality: calibration.ConfidenceMedium}, {ActivityID: "easy", RootActivityID: "easy", ActivityDate: today, DurationS: 3600, Selected: true, EffortSupport: calibration.EffortUnknown, MeasurementQuality: calibration.ConfidenceHigh}},
	}}
	got := calibration.SummarizeSource(result).Speed
	if got.EvidenceDate != "2026-10-01" || got.EvidenceCount != 1 || got.IndependentActivities != 1 || got.MeasurementQuality != "medium" {
		t.Fatalf("ordinary run refreshed maximal support %+v", got)
	}
}
