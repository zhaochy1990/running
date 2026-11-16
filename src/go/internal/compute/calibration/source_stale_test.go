package calibration_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
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

func TestSourceSummaryKeepsStaleDateSeparateFromRecentQualityRejection(t *testing.T) {
	old, oldMetadata, day := hrProtocolFixture()
	old.ActivityDate = day.AddDate(0, 0, -61)
	old.LabelID = "synthetic-old-field"
	oldMetadata.ActivityID = old.LabelID
	recent, recentMetadata, _ := hrProtocolFixture()
	recent.ActivityDate = day.AddDate(0, 0, -1)
	recent.LabelID = "synthetic-recent-quality-rejected"
	recentMetadata.ActivityID = recent.LabelID
	for i := range recent.Samples {
		if *recent.Samples[i].ElapsedS >= 900 && *recent.Samples[i].ElapsedS <= 905 {
			recent.Samples[i].HeartRateBpm = floatPointer(220)
		}
	}
	r, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{old, recent}, day, nil, []calibration.CandidateMetadata{oldMetadata, recentMetadata})
	if err != nil {
		t.Fatal(err)
	}
	source := calibration.SummarizeSource(r)
	raw, _ := json.Marshal(source)
	text := string(raw)
	source = calibration.ParseSource(&text)
	raw, _ = json.Marshal(source.HR)
	if r.Snapshot.ThresholdHR != nil || source.HR.Support != "none" || source.HR.EvidenceCount != 0 || source.HR.EvidenceDate != "" {
		t.Fatal("rejected protocol became support")
	}
	if source.HR.LatestRejectedEvidenceDate != "2026-11-14" || !strings.Contains(string(raw), `"latest_stale_evidence_date":"2026-09-15"`) {
		t.Fatalf("recent rejection hid the old protocol date: %s", raw)
	}
	if !strings.Contains(string(raw), "stale_HR_support") || !strings.Contains(string(raw), "HR_abrupt_spike_or_recovery") {
		t.Fatal("specific rejection reasons lost")
	}
}

func TestSelectedHRReasonsExcludeHistoricalRejectedProtocols(t *testing.T) {
	for _, kind := range []string{"stale", "quality"} {
		t.Run(kind, func(t *testing.T) {
			recent, rm, day := hrProtocolFixture()
			recent.LabelID = "new-valid"
			recent.ActivityDate = day.AddDate(0, 0, -1)
			rm.ActivityID = recent.LabelID
			rejected, bm, _ := hrProtocolFixture()
			rejected.LabelID = "old-rejected"
			bm.ActivityID = rejected.LabelID
			code := "stale_HR_support"
			if kind == "stale" {
				rejected.ActivityDate = day.AddDate(0, 0, -61)
			} else {
				code = "HR_abrupt_spike_or_recovery"
				for i := range rejected.Samples {
					if *rejected.Samples[i].ElapsedS == 900 {
						rejected.Samples[i].HeartRateBpm = floatPointer(220)
					}
				}
			}
			r, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{recent, rejected}, day, nil, []calibration.CandidateMetadata{rm, bm})
			if err != nil {
				t.Fatal(err)
			}
			s := calibration.SummarizeSource(r)
			raw, _ := json.Marshal(s)
			encoded := string(raw)
			s = calibration.ParseSource(&encoded)
			if r.Snapshot.ThresholdHR == nil || *r.Snapshot.ThresholdHR != 170 || s.HR.Support != "low" || s.HR.EvidenceDate != "2026-11-14" || s.HR.EvidenceCount != 1 {
				t.Fatalf("current supported fixture changed %+v", s.HR)
			}
			if strings.Contains(strings.Join(s.HR.Reasons, ","), code) {
				t.Fatalf("historical %s misclassified as current estimate reason: %v", code, s.HR.Reasons)
			}
			raw, _ = json.Marshal(s.HR)
			var fields map[string]json.RawMessage
			_ = json.Unmarshal(raw, &fields)
			if !strings.Contains(string(fields["rejected_reasons"]), code) {
				t.Fatalf("historical rejection lost: %s", raw)
			}
		})
	}
}
