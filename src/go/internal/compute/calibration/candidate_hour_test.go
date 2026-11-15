package calibration_test

import (
	"math"
	"reflect"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
)

func hourEvidence(id string, day time.Time, duration, speed float64, effort calibration.EffortSupport) calibration.CandidateEvidence {
	return calibration.CandidateEvidence{ActivityID: id, RootActivityID: id, ActivityDate: day, DurationS: duration, AvgSpeedMps: speed, Continuous: true, Selected: true, MeasurementQuality: calibration.ConfidenceHigh, EffortSupport: effort, ObservedLowerBoundMps: speed * .9}
}

func TestHourDirectMaximalIsNotCappedOrDilutedByEasyHour(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	anchor := hourEvidence("test", day, 3600, 4.5, calibration.EffortConfirmedMaximal)
	base := calibration.FitHourCapability([]calibration.CandidateEvidence{anchor}, day)
	withEasy := calibration.FitHourCapability([]calibration.CandidateEvidence{anchor, hourEvidence("easy", day, 3600, 3.5, calibration.EffortSubmaximal)}, day)
	if base.CenterMps == nil || math.Abs(*base.CenterMps-4.5) > .001 || withEasy.CenterMps == nil || *base.CenterMps != *withEasy.CenterMps {
		t.Fatalf("direct effort capped: %+v / %+v", base, withEasy)
	}
	if base.Method != "direct_60min_maximal" || base.Confidence == calibration.ConfidenceHigh || base.RangeLowMps == nil || base.RangeHighMps == nil {
		t.Fatalf("single test support overstated: %+v", base)
	}
	if *withEasy.RangeLowMps != *base.RangeLowMps || *withEasy.RangeHighMps != *base.RangeHighMps || withEasy.AnchorContribution != base.AnchorContribution {
		t.Fatal("nonbinding easy diluted actual anchor")
	}
}

func TestHourInfersAcrossIndependentMaximalDurationsAndKeepsBoundsAtOriginalDuration(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	// Independently worked Riegel example: 5.0m/s at 15min and
	// 4.600938m/s at 60min (k=.06). A 3min observed 5.1m/s is nonbinding
	// at its original duration; treating it as a 60min bound would be wrong.
	anchors := []calibration.CandidateEvidence{hourEvidence("short", day.AddDate(0, 0, -2), 900, 5, calibration.EffortConfirmedMaximal), hourEvidence("long", day.AddDate(0, 0, -1), 5400, 4.490357, calibration.EffortConfirmedMaximal)}
	base := calibration.FitHourCapability(anchors, day)
	got := calibration.FitHourCapability(append(anchors, hourEvidence("fast3", day, 180, 5.1, calibration.EffortUnknown)), day)
	if base.CenterMps == nil || math.Abs(*base.CenterMps-4.600938) > .01 || got.CenterMps == nil || *got.CenterMps != *base.CenterMps || *got.CenterMps >= 5.1 {
		t.Fatalf("bad inference/bound: %+v / %+v", base, got)
	}
	if got.Method != "speed_duration_inference" || got.RiegelK == nil || math.Abs(*got.RiegelK-.06) > .002 || got.AnchorActivities != 2 || got.Confidence == calibration.ConfidenceHigh {
		t.Fatalf("model support=%+v", got)
	}
}

func TestOfflineHourUsesMaximalAnchorWithoutLegacyCeiling(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	history := []calibration.Activity{evidenceActivity("test", day.AddDate(0, 0, -1), 3600, 4.5), evidenceActivity("easy", day, 3600, 3.5)}
	meta := []calibration.CandidateMetadata{{ActivityID: "test", SourceVersion: "protocol-v1", EvidenceRef: "audit", Protocol: "continuous_maximal_test_v1", ProtocolVerified: true, DurationS: 3600, StartS: floatPointer(0), EndS: floatPointer(3600)}}
	got, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, history, day, nil, meta)
	if err != nil {
		t.Fatal(err)
	}
	if got.Snapshot.ThresholdSpeedMps == nil || math.Abs(*got.Snapshot.ThresholdSpeedMps-4.5) > .001 || got.Evidence.Hour == nil || got.Evidence.Hour.Method != "direct_60min_maximal" {
		t.Fatalf("legacy ceiling survived: %+v", got)
	}
}

func TestHourPoorMeasurementCannotBecomeHighSupportFromProtocolAlone(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	input := []calibration.CandidateEvidence{}
	for i, id := range []string{"a", "b", "c"} {
		e := hourEvidence(id, day.AddDate(0, 0, -i), 3600, 4.5, calibration.EffortConfirmedMaximal)
		e.MeasurementQuality = calibration.ConfidenceLow
		input = append(input, e)
	}
	got := calibration.FitHourCapability(input, day)
	if got.Confidence != calibration.ConfidenceLow {
		t.Fatalf("protocol erased measurement uncertainty: %+v", got)
	}
}

func TestHourSameDayEvidenceAndOldDaysCannotManufactureFreshHighSupport(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	input := []calibration.CandidateEvidence{}
	for _, id := range []string{"a", "b", "c"} {
		input = append(input, hourEvidence(id, day, 3600, 4.5, calibration.EffortConfirmedMaximal))
	}
	input = append(input, hourEvidence("old1", day.AddDate(0, 0, -120), 3600, 4.5, calibration.EffortConfirmedMaximal), hourEvidence("old2", day.AddDate(0, 0, -121), 3600, 4.5, calibration.EffortConfirmedMaximal))
	got := calibration.FitHourCapability(input, day)
	if got.Confidence != calibration.ConfidenceLow {
		t.Fatalf("same-day roots inflated support: %+v", got)
	}
}

func TestHourNonbindingConstraintsDoNotDiluteBindingEvidence(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	anchor := hourEvidence("test", day.AddDate(0, 0, -1), 3600, 4, calibration.EffortConfirmedMaximal)
	binding := hourEvidence("faster-training", day, 3600, 4.8, calibration.EffortSubmaximal)
	base := calibration.FitHourCapability([]calibration.CandidateEvidence{anchor, binding}, day)
	input := []calibration.CandidateEvidence{anchor, binding}
	for _, id := range []string{"easy-a", "easy-b", "easy-c"} {
		input = append(input, hourEvidence(id, day, 3600, 3, calibration.EffortUnknown))
	}
	got := calibration.FitHourCapability(input, day)
	if base.CenterMps == nil || got.CenterMps == nil || *got.CenterMps != *base.CenterMps || got.Confidence != base.Confidence {
		t.Fatalf("nonbinding constraints changed fit: %+v / %+v", base, got)
	}
}

func TestHourActualFitContributionsShareRootAndDayBudget(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	anchor := hourEvidence("test", day, 3600, 4, calibration.EffortConfirmedMaximal)
	bound := hourEvidence("test", day, 180, 7, calibration.EffortUnknown)
	got := calibration.FitHourCapability([]calibration.CandidateEvidence{anchor, bound}, day)
	total := 0.0
	for _, o := range got.Observations {
		total += o.Weight
	}
	if total > 1.000001 || got.AnchorActivities != 1 || got.Confidence == calibration.ConfidenceHigh {
		t.Fatalf("one root contributed multiple budgets: %+v", got)
	}
}

func TestHourInsufficientInputsKeepOriginalDurationWithoutInventingCenter(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name  string
		input []calibration.CandidateEvidence
	}{
		{"unknown3min", []calibration.CandidateEvidence{hourEvidence("short", day, 180, 7, calibration.EffortUnknown)}},
		{"submax30km", []calibration.CandidateEvidence{hourEvidence("30km", day, 9000, 30000.0/9000, calibration.EffortSubmaximal)}},
		{"single_short_maximal", []calibration.CandidateEvidence{hourEvidence("test", day, 180, 7, calibration.EffortConfirmedMaximal)}},
		{"single_long_maximal", []calibration.CandidateEvidence{hourEvidence("test", day, 5400, 4.4, calibration.EffortConfirmedMaximal)}},
		{"stale_maximal", []calibration.CandidateEvidence{hourEvidence("old", day.AddDate(0, 0, -150), 3600, 5, calibration.EffortConfirmedMaximal)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := calibration.FitHourCapability(tc.input, day)
			if got.CenterMps != nil || got.RangeHighMps != nil || got.Confidence != calibration.ConfidenceNone || len(got.Observations) != 1 || got.Observations[0].DurationS != tc.input[0].DurationS {
				t.Fatalf("unsupported hour: %+v", got)
			}
		})
	}
	paused := hourEvidence("paused", day, 3600, 5, calibration.EffortConfirmedMaximal)
	paused.Continuous = false
	if got := calibration.FitHourCapability([]calibration.CandidateEvidence{paused}, day); got.CenterMps != nil || got.Observations[0].Weight != 0 {
		t.Fatal("paused effort constrained continuous model")
	}
}

func TestHourGPSOutlierIsRobustAndCannotProduceHighSupport(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	input := []calibration.CandidateEvidence{}
	for i, id := range []string{"a", "b", "c"} {
		input = append(input, hourEvidence(id, day.AddDate(0, 0, -i), 3600, 4.5, calibration.EffortConfirmedMaximal))
	}
	input = append(input, hourEvidence("gps-outlier", day.AddDate(0, 0, -3), 3600, 7, calibration.EffortConfirmedMaximal))
	got := calibration.FitHourCapability(input, day)
	if got.CenterMps == nil || math.Abs(*got.CenterMps-4.5) > .1 || got.Confidence == calibration.ConfidenceHigh || got.RangeHighMps == nil || math.IsInf(*got.RangeHighMps, 0) || *got.RangeHighMps > 10 {
		t.Fatalf("outlier destabilized model: %+v", got)
	}
}

func TestHourDuplicateRootsAndInputOrderCannotImproveSupport(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	a := hourEvidence("a", day, 3600, 4.5, calibration.EffortConfirmedMaximal)
	b := hourEvidence("alias", day, 3600, 4.5, calibration.EffortConfirmedMaximal)
	b.RootActivityID = "a"
	base := calibration.FitHourCapability([]calibration.CandidateEvidence{a}, day)
	duplicate := calibration.FitHourCapability([]calibration.CandidateEvidence{b, a, a}, day)
	if duplicate.CenterMps == nil || *duplicate.CenterMps != *base.CenterMps || duplicate.AnchorActivities != 1 || duplicate.AnchorContribution != base.AnchorContribution || duplicate.Confidence != base.Confidence {
		t.Fatal("duplicate inflated fit")
	}
}

func TestHourKeepsWholeLongRunAsSoftMonotoneModelConstraint(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	anchor := hourEvidence("test", day.AddDate(0, 0, -1), 3600, 4, calibration.EffortConfirmedMaximal)
	long := hourEvidence("30km", day, 9000, 30000.0/9000, calibration.EffortSubmaximal)
	got := calibration.FitHourCapability([]calibration.CandidateEvidence{anchor, long}, day)
	found := false
	for _, o := range got.Observations {
		if o.ActivityID == "30km" {
			found = o.DurationS == 9000 && o.Role == "long_duration_monotone_model_constraint" && o.LogError >= .15
		}
	}
	if !found || got.CenterMps == nil || math.Abs(*got.CenterMps-4) > .001 {
		t.Fatalf("long duration was truncated, ignored, or treated as maximal: %+v", got)
	}
}

func TestHourLongObservationCanBindOnlyThroughUncertainModelInference(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	anchor := hourEvidence("test", day.AddDate(0, 0, -1), 3600, 4, calibration.EffortConfirmedMaximal)
	long := hourEvidence("long", day, 9000, 5, calibration.EffortUnknown)
	got := calibration.FitHourCapability([]calibration.CandidateEvidence{anchor, long}, day)
	if got.CenterMps == nil || *got.CenterMps <= 4 || got.Method != "speed_duration_inference" || got.Confidence == calibration.ConfidenceHigh {
		t.Fatalf("long observation not modeled as uncertain one-sided evidence: %+v", got)
	}
	active := false
	for _, o := range got.Observations {
		if o.ActivityID == "long" {
			active = o.Weight > 0 && o.DurationS == 9000 && o.ModelDurationS == 7200
		}
	}
	if !active || got.RangeLowMps == nil || *got.RangeLowMps > 4 {
		t.Fatal("binding long evidence lost its original duration or conflicting anchor range")
	}
	only := calibration.FitHourCapability([]calibration.CandidateEvidence{long}, day)
	if only.CenterMps != nil || only.RangeHighMps != nil {
		t.Fatal("long-only invented hour capability")
	}
}

func TestHourEqualEffortWeightsStillResolveAliasesDeterministically(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	anchor := hourEvidence("anchor", day, 3600, 4.5, calibration.EffortConfirmedMaximal)
	a := hourEvidence("a", day, 180, 4, calibration.EffortUnknown)
	a.RootActivityID = "same"
	b := hourEvidence("b", day, 180, 7, calibration.EffortSubmaximal)
	b.RootActivityID = "same"
	b.MeasurementQuality = calibration.ConfidenceLow
	one := calibration.FitHourCapability([]calibration.CandidateEvidence{anchor, a, b}, day)
	two := calibration.FitHourCapability([]calibration.CandidateEvidence{b, a, anchor}, day)
	if !reflect.DeepEqual(one, two) {
		t.Fatal("equal effort rank made alias selection/input order nondeterministic")
	}
}
