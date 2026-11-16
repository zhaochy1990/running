package calibrationsource_test

import (
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/compute/calibrationsource"
	"testing"
)

func TestPublicFitRecPreservesSparseMissingMeasurements(t *testing.T) {
	raw := []byte(`{"id":1,"userId":7,"sport":"run","timestamp":[1704067200,1704067211,1704067203],"heart_rate":[140,249,null]}` + "\n")
	report, err := calibrationsource.InspectPublicData("fitrec-jsonl", raw, nil, calibration.StrategyV3, "test")
	if err != nil {
		t.Fatal(err)
	}
	if report.ReleaseReady || report.Status != "insufficient" || len(report.Records) != 1 {
		t.Fatalf("unsafe report: %+v", report)
	}
	r := report.Records[0]
	if r.SampleCount != 3 || r.MaxGapS != 8 || r.TimeOrderRegressions != 1 || r.MissingHR != 1 || r.MissingSpeed != 3 || r.MissingDistance != 3 || r.HRAbove220 != 1 {
		t.Fatalf("lost source quality: %+v", r)
	}
	if r.Estimate == nil || r.Estimate.Implementation != "v3" || r.Estimate.Snapshot.ThresholdSpeedMps != nil {
		t.Fatalf("invented speed: %+v", r.Estimate)
	}
}

func TestPublicOSFKeepsObservedClockAndDistanceAnomalies(t *testing.T) {
	raw := []byte("participant,source_elapsed_s,distance_m,speed_mps,five_min_bin\nP1,12,106,3,5\nP1,10,100,3,5\nP1,13,105,3,5\nP1,13,,3,5\n")
	report, err := calibrationsource.InspectPublicData("osf-60min-csv", raw, nil, calibration.StrategyV3, "test")
	if err != nil {
		t.Fatal(err)
	}
	r := report.Records[0]
	if r.SampleCount != 4 || *r.SourceStartS != 10 || *r.DurationS != 3 || r.MaxGapS != 2 || r.TimeOrderRegressions != 1 || r.DuplicateTimes != 1 || r.DistanceRegressions != 1 || r.MissingHR != 4 || r.MissingDistance != 1 {
		t.Fatalf("altered measurements: %+v", r)
	}
	if r.Estimate != nil || r.EstimateOmitted == "" || r.LabelKind != "near_maximal_test_protocol_not_independent_holdout" {
		t.Fatalf("invented history: %+v", r)
	}
}

func TestPublicTrinityDoesNotInflateStageMeansOrPromoteLabels(t *testing.T) {
	raw := []byte("test_id,stage_index,speed_kmh,hr_bpm,vo2_ml_kg_min,lactate_mmol_l,duration_s,hr_aggregation,lactate_sample_offset_s,duration_source\nA1,0,0,70,5,0.8,180,last_minute_stage_mean,120,published_protocol_not_recorded_sample_times\nA1,1,12,140,30,1.2,180,last_minute_stage_mean,120,published_protocol_not_recorded_sample_times\n")
	labels := []byte(`[{"test_id":"A1","label_type":"lab_lactate_breakpoint_segmented_regression","speed_kmh":"13","hr_bpm":"150","source_test_sha256":"abc","not_60min_ground_truth":true},{"test_id":"A2","label_type":"lab_lactate_breakpoint_segmented_regression","speed_kmh":"14","hr_bpm":"160","source_test_sha256":"def","not_60min_ground_truth":true}]`)
	report, err := calibrationsource.InspectPublicData("trinity-stage-csv", raw, labels, calibration.StrategyV3, "test")
	if err != nil {
		t.Fatal(err)
	}
	r := report.Records[0]
	if r.SampleCount != 2 || r.DurationS != nil || r.Estimate != nil || r.LabelKind != "lab_lactate_breakpoint_not_lthr_lt2_mlss_or_60min" || report.LabelCount != 2 || report.MatchedLabels != 1 || report.LabelsSHA256 == "" {
		t.Fatalf("stage or label promoted: %+v %+v", r, report)
	}
}

func TestPublicDataRejectsMalformedOrAmbiguousMeasurements(t *testing.T) {
	cases := []struct{ format, raw string }{
		{"fitrec-jsonl", `{"id":1,"userId":1,"sport":"run","timestamp":[1704067200,1704067203],"heart_rate":[140]}`},
		{"fitrec-jsonl", `{"id":1,"userId":1,"sport":"ride","timestamp":[1704067200],"heart_rate":[140]}`},
		{"osf-60min-csv", "participant,source_elapsed_s,distance_m,speed_mps,five_min_bin\nP1,NaN,100,3,5\n"},
		{"osf-60min-csv", "participant,source_elapsed_s,distance_m,speed_mps,five_min_bin\nP1,10,100,Inf,5\n"},
		{"osf-60min-csv", "participant,source_elapsed_s,distance_m,speed_mps,five_min_bin\nP1,,100,3,5\n"},
		{"osf-60min-csv", "participant,source_elapsed_s,distance_m,speed_mps,five_min_bin\nP1,10,100,3\n"},
	}
	for _, c := range cases {
		if _, err := calibrationsource.InspectPublicData(c.format, []byte(c.raw), nil, calibration.StrategyV3, "test"); err == nil {
			t.Fatalf("accepted malformed %s: %s", c.format, c.raw)
		}
	}
}
