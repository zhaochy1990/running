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
func clientProducerResult(t *testing.T, lab bool) calibration.OfflineResult {
	t.Helper()
	day := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	cutoff := time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC)
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
