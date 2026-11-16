package api

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/apifmt"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
)

// Synthetic inputs exercise the actual candidate and metadata publisher. They
// establish no accuracy label and never read production or evaluation holdouts.
func clientProducerResult(t *testing.T, lab bool, cutoffOverride ...time.Time) calibration.OfflineResult {
	t.Helper()
	day := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	cutoff := time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC)
	if len(cutoffOverride) > 0 {
		cutoff = cutoffOverride[0]
	}
	if len(cutoffOverride) > 1 {
		day = cutoffOverride[1]
	}
	activity := func(id string, seconds int, hr float64) calibration.Activity {
		duration, distance := float64(seconds), float64(seconds)*4.5
		a := calibration.Activity{LabelID: id, ActivityDate: day, Sport: "run", DurationS: &duration, DistanceM: &distance}
		for second := 0; second <= seconds; second++ {
			elapsed, d := float64(second), float64(second)*4.5
			h := hr
			if second < 600 {
				h = 140
			}
			a.Samples = append(a.Samples, calibration.Sample{ElapsedS: fptr(elapsed), DistanceM: fptr(d), SpeedMps: fptr(4.5), HeartRateBpm: fptr(h)})
		}
		return a
	}
	hour := activity("synthetic-probable-hour", 3600, 166.5)
	field := activity("synthetic-hr-protocol", 1800, 166.5)
	metadata := []calibration.CandidateMetadata{
		{ActivityID: hour.LabelID, SourceVersion: "synthetic-engineering-v3", EvidenceRef: "synthetic-race-evidence", RaceIdentity: true, AthleteReportedMaximal: true, SustainedEffortCorroborated: true},
		{ActivityID: field.LabelID, SourceVersion: "synthetic-engineering-v3", EvidenceRef: "synthetic-hr-evidence", Protocol: "continuous_maximal_test_v1", ProtocolVerified: true, DurationS: 1800, StartS: fptr(0), EndS: fptr(1800), HR: &calibration.CandidateHRMetadata{Protocol: "field_30min_last20_v1", Verified: true, Sensor: "chest_strap"}},
	}
	if lab {
		metadata[1].HR = &calibration.CandidateHRMetadata{Protocol: "lab_lthr_report_v1", Verified: true, LabHRBpm: fptr(168.5), LabMethod: "lactate_turnpoint", LabInstrument: "synthetic-analyzer", LabReportDate: day}
	}
	result, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{hour, field}, cutoff, nil, metadata)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func clientProducerSource(t *testing.T, lab bool) (calibration.Snapshot, calibration.SourceSummary) {
	result := clientProducerResult(t, lab)
	source := calibration.SummarizeSource(result)
	// Explicit wire boundary only, not algorithm-generated HR uncertainty.
	source.HR.RangeLow = fptr(166.5)
	source.HR.RangeHigh = fptr(168.5)
	source.HR.RangeMeaning = "synthetic_wire_rounding_boundary_not_model_uncertainty"
	return result.Snapshot, source
}

func TestCalibrationClientProducerVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../../docs/calibration/fixtures/client-display-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			Name     string              `json:"name"`
			Response strideZonesResponse `json:"response"`
		} `json:"cases"`
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	var vectors []map[string]any
	for _, lab := range []bool{false, true} {
		snapshot, source := clientProducerSource(t, lab)
		method, hr, name := "field_30min_last20_v1", 166.5, "producer-field-half"
		if lab {
			method, hr, name = "lab_lthr_report_v1", 168.5, "producer-lab-half"
		}
		if snapshot.ThresholdHR == nil || *snapshot.ThresholdHR != hr || source.HR.Method != method {
			t.Fatalf("actual producer HR/protocol mismatch: %+v", source.HR)
		}
		if source.Speed == nil || source.Speed.EffortSupport != string(calibration.EffortProbableMaximal) {
			t.Fatalf("actual producer did not retain probable effort: %+v", source.Speed)
		}
		found := false
		for _, c := range fixture.Cases {
			if c.Name == name {
				found = true
				if c.Response.Threshold == nil || !reflect.DeepEqual(c.Response.Threshold.Source, &source) || c.Response.Threshold.HRBpm == nil || *c.Response.Threshold.HRBpm != hr {
					t.Fatalf("shared frozen vector differs from real producer: %s", name)
				}
			}
		}
		if !found {
			t.Fatalf("missing shared producer vector: %s", name)
		}
		vectors = append(vectors, map[string]any{"name": name, "source": source, "hr_bpm": snapshot.ThresholdHR, "speed_mps": snapshot.ThresholdSpeedMps, "pace_per_km_sec": apifmt.PacePerKmSec(snapshot.ThresholdSpeedMps)})
	}
	if output := os.Getenv("STRIDE_990_PRODUCER_OUTPUT"); output != "" {
		raw, _ := json.MarshalIndent(vectors, "", "  ")
		if err := os.WriteFile(output, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

// This producer-to-wire fixture is synthetic engineering evidence, never an
// accuracy label. Old protocol dates explain rejection without reviving HR.
func TestCalibrationStaleClientProducerVector(t *testing.T) {
	result := clientProducerResult(t, false, time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC), time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC))
	source := calibration.SummarizeSource(result)
	if result.Snapshot.ThresholdHR != nil || source.HR.Support != "none" || source.HR.EvidenceCount != 0 || source.HR.EvidenceDate != "" || source.HR.LatestRejectedEvidenceDate != "2026-09-14" {
		t.Fatalf("stale protocol revived or lost date: %+v", source.HR)
	}
	found := false
	for _, r := range source.HR.RejectedReasons {
		if r == "stale_HR_support" {
			found = true
		}
	}
	if !found {
		t.Fatal("stale reason lost")
	}
	// Encode then parse exactly the bounded source that the storage reader serves.
	persisted, _ := json.Marshal(source)
	encoded := string(persisted)
	source = calibration.ParseSource(&encoded)
	if output := os.Getenv("STRIDE_990_STALE_PRODUCER_OUTPUT"); output != "" {
		raw, _ := json.MarshalIndent(source, "", "  ")
		if err := os.WriteFile(output, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile("../../../../docs/calibration/fixtures/client-display-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			Name     string              `json:"name"`
			Response strideZonesResponse `json:"response"`
		} `json:"cases"`
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, c := range fixture.Cases {
		if c.Name == "producer-stale-hr" {
			if c.Response.Threshold == nil || !reflect.DeepEqual(c.Response.Threshold.Source, &source) || c.Response.Threshold.HRBpm != nil {
				t.Fatal("shared stale vector differs from persisted producer")
			}
			return
		}
	}
	t.Fatal("missing actual stale producer vector")
}

func clientMixedStaleProducerResult(t *testing.T) calibration.OfflineResult {
	t.Helper()
	cutoff := time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC)
	var history []calibration.Activity
	var metadata []calibration.CandidateMetadata
	for i, day := range []time.Time{time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC), time.Date(2026, 11, 13, 0, 0, 0, 0, time.UTC)} {
		id := []string{"synthetic-old-HR-protocol", "synthetic-recent-HR-quality-rejected"}[i]
		dur := 1800.
		a := calibration.Activity{LabelID: id, ActivityDate: day, Sport: "run", DurationS: &dur}
		// HR-only measurements deliberately provide no pace/independent speed anchor.
		for second := 0; second <= 1800; second += 5 {
			sec := float64(second)
			hr := 165.
			if i == 1 && second == 900 {
				hr = 220
			}
			a.Samples = append(a.Samples, calibration.Sample{ElapsedS: &sec, HeartRateBpm: &hr})
		}
		history = append(history, a)
		metadata = append(metadata, calibration.CandidateMetadata{ActivityID: id, RootActivityID: id, SourceVersion: "SYNTHETIC-mixed-HR-v1", EvidenceRef: "SYNTHETIC-not-accuracy", Protocol: "continuous_maximal_test_v1", ProtocolVerified: true, DurationS: 1800, StartS: fptr(0), EndS: fptr(1800), HR: &calibration.CandidateHRMetadata{Protocol: "field_30min_last20_v1", Verified: true, Sensor: "chest_strap"}})
	}
	r, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, history, cutoff, nil, metadata)
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func TestCalibrationMixedStaleClientProducerVector(t *testing.T) {
	r := clientMixedStaleProducerResult(t)
	source := calibration.SummarizeSource(r)
	raw, _ := json.Marshal(source)
	encoded := string(raw)
	source = calibration.ParseSource(&encoded)
	if r.Snapshot.ThresholdHR != nil || r.Snapshot.ThresholdSpeedMps != nil || source.HR.Support != "none" || source.HR.EvidenceCount != 0 || source.HR.EvidenceDate != "" || source.HR.LatestStaleEvidenceDate != "2026-09-14" || source.HR.LatestRejectedEvidenceDate != "2026-11-13" {
		t.Fatalf("mixed rejection/source dates conflated: %+v", source.HR)
	}
	if output := os.Getenv("STRIDE_990_MIXED_PRODUCER_OUTPUT"); output != "" {
		raw, _ := json.MarshalIndent(source, "", "  ")
		if err := os.WriteFile(output, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile("../../../../docs/calibration/fixtures/client-display-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			Name     string              `json:"name"`
			Response strideZonesResponse `json:"response"`
		} `json:"cases"`
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, c := range fixture.Cases {
		if c.Name == "producer-stale-hr-mixed" {
			if c.Response.Threshold == nil || !reflect.DeepEqual(c.Response.Threshold.Source, &source) || c.Response.Threshold.HRBpm != nil {
				t.Fatal("mixed vector differs from persisted producer")
			}
			return
		}
	}
	t.Fatal("missing actual mixed producer vector")
}

func clientCurrentHRWithRejectedResult(t *testing.T, kind string) calibration.OfflineResult {
	t.Helper()
	cutoff := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	var activities []calibration.Activity
	var metadata []calibration.CandidateMetadata
	for i := 0; i < 2; i++ {
		id := "synthetic-current-valid"
		day := cutoff.AddDate(0, 0, -1)
		if i == 1 {
			id = "synthetic-history-rejected"
			day = cutoff.AddDate(0, 0, -61)
			if kind == "quality" {
				day = cutoff
			}
		}
		duration := 1800.
		a := calibration.Activity{LabelID: id, ActivityDate: day, Sport: "run", DurationS: &duration}
		for second := 0; second <= 1800; second += 5 {
			sec := float64(second)
			hr := 170.
			if i == 1 && kind == "quality" && second == 900 {
				hr = 220
			}
			a.Samples = append(a.Samples, calibration.Sample{ElapsedS: &sec, HeartRateBpm: &hr})
		}
		activities = append(activities, a)
		metadata = append(metadata, calibration.CandidateMetadata{ActivityID: id, RootActivityID: id, SourceVersion: "SYNTHETIC-current-with-rejection-v1", EvidenceRef: "SYNTHETIC-not-accuracy", Protocol: "continuous_maximal_test_v1", ProtocolVerified: true, DurationS: 1800, StartS: fptr(0), EndS: fptr(1800), HR: &calibration.CandidateHRMetadata{Protocol: "field_30min_last20_v1", Verified: true, Sensor: "chest_strap"}})
	}
	r, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, activities, cutoff, nil, metadata)
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func TestCalibrationCurrentHRRejectionProducerVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../../docs/calibration/fixtures/client-display-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Cases []struct {
			Name     string              `json:"name"`
			Response strideZonesResponse `json:"response"`
		} `json:"cases"`
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	var exports []map[string]any
	for _, kind := range []string{"stale", "quality"} {
		r := clientCurrentHRWithRejectedResult(t, kind)
		source := calibration.SummarizeSource(r)
		encoded, _ := json.Marshal(source)
		text := string(encoded)
		source = calibration.ParseSource(&text)
		if r.Snapshot.ThresholdHR == nil || *r.Snapshot.ThresholdHR != 170 || source.HR.Support != "low" || source.HR.EvidenceDate != "2026-11-14" || source.HR.EvidenceCount != 1 {
			t.Fatalf("current HR changed %+v", source.HR)
		}
		for _, reason := range source.HR.Reasons {
			if reason == "stale_HR_support" || reason == "HR_abrupt_spike_or_recovery" {
				t.Fatal("historical rejection contaminated current reasons")
			}
		}
		name := "producer-current-hr-with-" + kind
		exports = append(exports, map[string]any{"name": name, "source": source})
	}
	if output := os.Getenv("STRIDE_990_CURRENT_HR_PRODUCER_OUTPUT"); output != "" {
		raw, _ := json.MarshalIndent(exports, "", "  ")
		if err := os.WriteFile(output, raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, item := range exports {
		found := false
		for _, c := range fixture.Cases {
			if c.Name == item["name"] {
				found = true
				source := item["source"].(calibration.SourceSummary)
				if c.Response.Threshold == nil || c.Response.Threshold.HRBpm == nil || *c.Response.Threshold.HRBpm != 170 || !reflect.DeepEqual(c.Response.Threshold.Source, &source) {
					t.Fatal("current/rejected shared vector differs from actual producer")
				}
			}
		}
		if !found {
			t.Fatal("missing current/rejected producer vector", item["name"])
		}
	}
}
