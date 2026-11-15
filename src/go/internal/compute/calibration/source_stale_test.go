package calibration_test

import (
	"encoding/json"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"strings"
	"testing"
)

func TestSpecSourceSummaryPreservesStaleHRReason(t *testing.T) {
	a, m, day := hrProtocolFixture()
	result, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{a}, day.AddDate(0, 0, 61), nil, []calibration.CandidateMetadata{m})
	if err != nil {
		t.Fatal(err)
	}
	observed, _ := json.Marshal(result.Evidence.HR.Observations)
	if !strings.Contains(string(observed), "stale_HR_support") {
		t.Fatal("fixture failed to produce stale support")
	}
	source := calibration.SummarizeSource(result)
	if result.Snapshot.ThresholdHR != nil || source.HR.EvidenceCount != 0 || source.HR.EvidenceDate != "" || source.HR.Support != "none" || source.HR.LatestRejectedEvidenceDate != day.Format("2006-01-02") {
		t.Fatalf("stale evidence was revived or its date lost: %+v", source.HR)
	}
	persisted, _ := json.Marshal(source)
	encoded := string(persisted)
	source = calibration.ParseSource(&encoded)
	raw, _ := json.Marshal(source.HR)
	t.Logf("hr_summary=%s", raw)
	if !strings.Contains(string(raw), "stale_HR_support") {
		t.Error("persisted summary loses reason: verified HR evidence is stale, not absent")
	}
}
