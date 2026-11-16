package calibration_test

import (
	"encoding/json"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"math"
	"reflect"
	"strings"
	"testing"
	"time"
)

func hrProtocolFixture() (calibration.Activity, calibration.CandidateMetadata, time.Time) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	a := evidenceActivity("field", day, 1800, 4)
	for i := range a.Samples {
		hr := 170.0
		if *a.Samples[i].ElapsedS < 600 {
			hr = 140
		}
		a.Samples[i].HeartRateBpm = floatPointer(hr)
	}
	m := calibration.CandidateMetadata{ActivityID: a.LabelID, SourceVersion: "audited-v1", EvidenceRef: "audit-field", Protocol: "continuous_maximal_test_v1", ProtocolVerified: true, DurationS: 1800, StartS: floatPointer(0), EndS: floatPointer(1800), HR: &calibration.CandidateHRMetadata{Protocol: "field_30min_last20_v1", Verified: true, Sensor: "chest_strap"}}
	return a, m, day
}
func TestCandidateHRExtractsFieldLast20WithoutPaceCenter(t *testing.T) {
	a, m, day := hrProtocolFixture()
	got, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{a}, day, nil, []calibration.CandidateMetadata{m})
	if err != nil {
		t.Fatal(err)
	}
	if got.Snapshot.ThresholdSpeedMps != nil || got.Snapshot.ThresholdHR == nil || math.Abs(*got.Snapshot.ThresholdHR-170) > .01 {
		t.Fatalf("independent field HR unavailable: %+v", got.Snapshot)
	}
	if got.Evidence.HR.ReferenceTier != "field_hr_proxy" || got.Evidence.HR.Confidence != calibration.ConfidenceLow || got.Evidence.HR.DependsOnPace {
		t.Fatalf("protocol overstated: %+v", got.Evidence.HR)
	}
}

func TestCandidateHRRejectsPoorProtocolQuality(t *testing.T) {
	for _, kind := range []string{"dropout", "spike", "recovery", "drift", "clock_reset", "interrupted", "missing_effort", "wrist", "late", "submaximal"} {
		t.Run(kind, func(t *testing.T) {
			a, m, day := hrProtocolFixture()
			switch kind {
			case "dropout":
				for i := range a.Samples {
					if *a.Samples[i].ElapsedS >= 900 && *a.Samples[i].ElapsedS <= 960 {
						a.Samples[i].HeartRateBpm = nil
					}
				}
			case "spike":
				a.Samples[200].HeartRateBpm = floatPointer(220)
			case "recovery":
				for i := range a.Samples {
					if *a.Samples[i].ElapsedS >= 900 && *a.Samples[i].ElapsedS <= 1000 {
						a.Samples[i].HeartRateBpm = floatPointer(140)
					}
				}
			case "drift":
				for i := range a.Samples {
					sec := *a.Samples[i].ElapsedS
					if sec >= 600 {
						a.Samples[i].HeartRateBpm = floatPointer(155 + (sec-600)/40)
					}
				}
			case "clock_reset":
				a.Samples[200].ElapsedS = floatPointer(0)
			case "interrupted":
				m.Interrupted = true
			case "missing_effort":
				m.ProtocolVerified = false
			case "wrist":
				m.HR.Sensor = "optical_wrist"
			case "late":
				future := day.Add(time.Hour)
				m.AvailableAt = &future
			case "submaximal":
				m.Submaximal = true
			}
			got, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{a}, day, nil, []calibration.CandidateMetadata{m})
			if err != nil {
				t.Fatal(err)
			}
			if got.Snapshot.ThresholdHR != nil || got.Snapshot.ThresholdHRConfidence != calibration.ConfidenceNone {
				t.Fatalf("bad HR promoted (%s): %+v", kind, got.Snapshot)
			}
		})
	}
}

func TestCandidateHRCadenceLockCannotBecomeFieldSupport(t *testing.T) {
	a, m, day := hrProtocolFixture()
	for _, s := range a.Samples {
		m.HR.Cadence = append(m.HR.Cadence, calibration.CandidateCadenceSample{TimeS: *s.ElapsedS, StepsPerMinute: 170})
	}
	got, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{a}, day, nil, []calibration.CandidateMetadata{m})
	if err != nil {
		t.Fatal(err)
	}
	if got.Snapshot.ThresholdHR != nil {
		t.Fatal("cadence-locked HR promoted")
	}
	found := false
	for _, reason := range got.Evidence.HR.Observations[0].Quality.Reasons {
		if reason == "suspected_HR_cadence_lock" {
			found = true
		}
	}
	if !found {
		t.Fatal("cadence-lock reason absent")
	}
}

func TestCandidateHRLabReferenceNeedsAuditedMethodAndDoesNotMixMethods(t *testing.T) {
	a, m, day := hrProtocolFixture()
	a.Samples = nil
	m.HR = &calibration.CandidateHRMetadata{Protocol: "lab_lthr_report_v1", Verified: true, LabHRBpm: floatPointer(174), LabMethod: "lactate_turnpoint", LabInstrument: "analyzer-v1", LabReportDate: day}
	run := func() calibration.OfflineResult {
		got, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{a}, day, nil, []calibration.CandidateMetadata{m})
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	got := run()
	if got.Snapshot.ThresholdHR == nil || *got.Snapshot.ThresholdHR != 174 || got.Evidence.HR.ReferenceTier != "lab_lthr" || got.Evidence.HR.LabMethod != "lactate_turnpoint" {
		t.Fatalf("audited lab report missing: %+v", got.Evidence.HR)
	}
	m.HR.LabMethod = ""
	if run().Snapshot.ThresholdHR != nil {
		t.Fatal("lab without interpretation method accepted")
	}
}

func TestCandidateHRIndependentRootsDaysAndConflictsControlSupport(t *testing.T) {
	a, m, day := hrProtocolFixture()
	b, n := a, m
	b.LabelID = "second"
	b.ActivityDate = day.AddDate(0, 0, -1)
	n.ActivityID = b.LabelID
	got, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{a, b}, day, nil, []calibration.CandidateMetadata{m, n})
	if err != nil {
		t.Fatal(err)
	}
	if got.Evidence.HR.Confidence != calibration.ConfidenceMedium || got.Evidence.HR.IndependentActivities != 2 || got.Evidence.HR.IndependentDays != 2 {
		t.Fatalf("independent protocols not counted: %+v", got.Evidence.HR)
	}
	n.RootActivityID = a.LabelID
	conflict, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{a, b}, day, nil, []calibration.CandidateMetadata{m, n})
	if err != nil {
		t.Fatal(err)
	}
	if conflict.Snapshot.ThresholdHR != nil || conflict.Evidence.HR.IndependentActivities != 0 {
		t.Fatal("cross-day aliases manufactured HR support")
	}
	b.ActivityDate = day
	duplicate, _ := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{a, b}, day, nil, []calibration.CandidateMetadata{m, n})
	if duplicate.Evidence.HR.IndependentActivities != 1 || duplicate.Evidence.HR.Confidence != calibration.ConfidenceLow {
		t.Fatal("same root inflated support")
	}
	n.RootActivityID = "second"
	sameDay, _ := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{a, b}, day, nil, []calibration.CandidateMetadata{m, n})
	if sameDay.Evidence.HR.Confidence != calibration.ConfidenceLow {
		t.Fatal("same day inflated support")
	}
}

func TestCandidateHRTrainingHourIsNotLTHRAndPaceDoesNotCreateSupport(t *testing.T) {
	a, m, day := hrProtocolFixture()
	a = evidenceActivity(a.LabelID, day, 3600, 3)
	for i := range a.Samples {
		a.Samples[i].HeartRateBpm = floatPointer(158)
	}
	m.DurationS = 3600
	m.EndS = floatPointer(3600)
	m.HR = nil
	slow, _ := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{a}, day, nil, []calibration.CandidateMetadata{m})
	for i := range a.Samples {
		a.Samples[i].DistanceM = floatPointer(*a.Samples[i].ElapsedS * 5)
		a.Samples[i].SpeedMps = floatPointer(5)
	}
	a.DistanceM = floatPointer(18000)
	fast, _ := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{a}, day, nil, []calibration.CandidateMetadata{m})
	if slow.Snapshot.ThresholdHR != nil || fast.Snapshot.ThresholdHR != nil || !reflect.DeepEqual(slow.Evidence.HR, fast.Evidence.HR) {
		t.Fatal("pace created independent HR support")
	}
	if slow.Snapshot.ThresholdSpeedMps == nil || fast.Snapshot.ThresholdSpeedMps == nil || *slow.Snapshot.ThresholdSpeedMps == *fast.Snapshot.ThresholdSpeedMps {
		t.Fatal("fixture did not change pace independently")
	}
	if slow.Evidence.HR.Observations[0].ReferenceTier != "training_hr" || slow.Evidence.HR.Observations[0].ValueBpm == nil || *slow.Evidence.HR.Observations[0].ValueBpm != 158 {
		t.Fatal("training HR not retained separately")
	}
}
func TestCandidateHRDoesNotAlterFrozenControlsOrOtherBaselinesAndZones(t *testing.T) {
	a, m, day := hrProtocolFixture()
	health := []calibration.HealthRow{}
	for i := 0; i < 20; i++ {
		health = append(health, calibration.HealthRow{Date: day.AddDate(0, 0, -i), RHR: floatPointer(50)})
	}
	for _, strategy := range []calibration.Strategy{calibration.StrategyV3, calibration.StrategySegmentsOnly} {
		before, _ := calibration.EstimateOffline(strategy, []calibration.Activity{a}, day, health)
		after, _ := calibration.EstimateOfflineWithEvidence(strategy, []calibration.Activity{a}, day, health, []calibration.CandidateMetadata{m})
		if !reflect.DeepEqual(before, after) {
			t.Fatalf("HR metadata leaked into %s", strategy)
		}
	}
	active := calibration.EstimateRunningCalibration([]calibration.Activity{a}, day, health)
	candidate, _ := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{a}, day, health, []calibration.CandidateMetadata{m})
	if !reflect.DeepEqual(active.RHRBaseline, candidate.Snapshot.RHRBaseline) || !reflect.DeepEqual(active.HRMaxEstimate, candidate.Snapshot.HRMaxEstimate) || active.HRMaxConfidence != candidate.Snapshot.HRMaxConfidence {
		t.Fatal("unrelated baseline rewritten")
	}
	snap := candidate.Snapshot
	snap.HRMaxEstimate = nil
	snap.RHRBaseline = nil
	zones := calibration.ComputeTrainingZones(snap)
	if len(zones.PaceZones) != 0 || len(zones.HeartRateZones) != 6 || zones.HeartRateZones[0].Confidence != calibration.ConfidenceLow {
		t.Fatal("independent HR zones incorrectly require pace/HRmax/RHR")
	}
	snap.ThresholdHR = nil
	snap.ThresholdHRConfidence = calibration.ConfidenceNone
	if len(calibration.ComputeTrainingZones(snap).HeartRateZones) != 0 {
		t.Fatal("missing HR baseline manufactured zones")
	}
	snap.RHRBaseline = floatPointer(50)
	snap.HRMaxEstimate = floatPointer(190)
	fallback := calibration.ComputeTrainingZones(snap)
	if len(fallback.HeartRateZones) != 6 || fallback.HeartRateZones[0].Confidence != calibration.ConfidenceLow {
		t.Fatal("HRR fallback lost explicit low support")
	}
	snap.RHRBaseline = nil
	if len(calibration.ComputeTrainingZones(snap).HeartRateZones) != 0 {
		t.Fatal("HRR zones manufactured missing RHR")
	}
	raw, _ := json.Marshal(candidate.Evidence.HR)
	if strings.Contains(string(raw), "steps_per_minute") || strings.Contains(string(raw), "Samples") {
		t.Fatal("raw HR/cadence leaked into report")
	}
}

func TestCandidateHRTargetDateAndLabMethodRemainExplicit(t *testing.T) {
	a, m, day := hrProtocolFixture()
	a.Samples = nil
	m.HR = &calibration.CandidateHRMetadata{Protocol: "lab_lthr_report_v1", Verified: true, LabHRBpm: floatPointer(174), LabMethod: "method_a", LabInstrument: "analyzer-v1", LabReportDate: day}
	b, n := a, m
	b.LabelID = "older-method"
	b.ActivityDate = day.AddDate(0, 0, -1)
	n.ActivityID = b.LabelID
	copyHR := *m.HR
	n.HR = &copyHR
	n.HR.LabMethod = "method_b"
	n.HR.LabHRBpm = floatPointer(184)
	n.HR.LabReportDate = b.ActivityDate
	got, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{a, b}, day, nil, []calibration.CandidateMetadata{m, n})
	if err != nil {
		t.Fatal(err)
	}
	hr := got.Evidence.HR
	if hr.ValueBpm == nil || *hr.ValueBpm != 174 || hr.LabMethod != "method_a" || hr.IndependentActivities != 1 || hr.EvidenceDate == nil || !hr.EvidenceDate.Equal(day) || hr.Protocol != "lab_lthr_report_v1" || hr.TargetType != "lab_method_specific_LTHR" {
		t.Fatalf("mixed lab methods or lost target: %+v", hr)
	}
	stale, _ := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{a}, day.AddDate(0, 0, 61), nil, []calibration.CandidateMetadata{m})
	if stale.Snapshot.ThresholdHR != nil || len(stale.Evidence.HR.Observations[0].Reasons) == 0 {
		t.Fatal("stale lab report silently used")
	}
}

func TestCandidateHRVerifiedFieldCannotOverrideMeasuredRecovery(t *testing.T) {
	for _, kind := range []string{"stationary_with_lagging_HR", "smooth_HR_recovery"} {
		t.Run(kind, func(t *testing.T) {
			a, m, day := hrProtocolFixture()
			for i := range a.Samples {
				sec := *a.Samples[i].ElapsedS
				if kind == "stationary_with_lagging_HR" && sec >= 900 && sec <= 960 {
					a.Samples[i].SpeedMps = floatPointer(0)
				}
				if kind == "smooth_HR_recovery" && sec >= 900 && sec <= 1200 {
					a.Samples[i].HeartRateBpm = floatPointer(155 + math.Abs(sec-1050)/10)
				}
			}
			got, _ := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{a}, day, nil, []calibration.CandidateMetadata{m})
			if got.Snapshot.ThresholdHR != nil {
				t.Fatalf("recovery promoted: %+v", got.Evidence.HR)
			}
		})
	}
}

func TestCandidateHRUsesElapsedTimeAndProtocolWindowNotSampleCount(t *testing.T) {
	a, m, day := hrProtocolFixture()
	a.Samples = nil
	for sec := 0; sec <= 1800; {
		hr := 140.0
		if sec >= 600 {
			hr = 160 + float64(sec-600)/150
		}
		a.Samples = append(a.Samples, calibration.Sample{ElapsedS: floatPointer(float64(sec)), HeartRateBpm: floatPointer(hr)})
		if sec < 1200 {
			sec++
		} else {
			sec += 5
		}
	}
	got, _ := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{a}, day, nil, []calibration.CandidateMetadata{m})
	if got.Snapshot.ThresholdHR == nil || math.Abs(*got.Snapshot.ThresholdHR-164) > .0001 {
		t.Fatalf("HR point count biased proxy: %+v", got.Evidence.HR)
	}
}
func TestCandidateHRMetadataConflictsOrMissingAuditCannotManufactureSupport(t *testing.T) {
	for _, kind := range []string{"missing_source", "missing_ref", "conflicting_metadata", "unverified_HR", "missing_end", "stale"} {
		t.Run(kind, func(t *testing.T) {
			a, m, day := hrProtocolFixture()
			metadata := []calibration.CandidateMetadata{m}
			switch kind {
			case "missing_source":
				metadata[0].SourceVersion = ""
			case "missing_ref":
				metadata[0].EvidenceRef = ""
			case "conflicting_metadata":
				copy := m
				copy.Submaximal = true
				metadata = append(metadata, copy)
			case "unverified_HR":
				m.HR.Verified = false
			case "missing_end":
				metadata[0].EndS = nil
			case "stale":
				day = day.AddDate(0, 0, 61)
			}
			got, _ := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{a}, day, nil, metadata)
			if got.Snapshot.ThresholdHR != nil {
				t.Fatalf("%s metadata manufactured support", kind)
			}
		})
	}
}

func TestCandidateHRDoesNotChooseArbitraryLabMethodOnTiedLatestDay(t *testing.T) {
	a, m, day := hrProtocolFixture()
	a.Samples = nil
	m.HR = &calibration.CandidateHRMetadata{Protocol: "lab_lthr_report_v1", Verified: true, LabHRBpm: floatPointer(174), LabMethod: "method_a", LabInstrument: "analyzer-v1", LabReportDate: day}
	b, n := a, m
	b.LabelID = "other-method"
	n.ActivityID = b.LabelID
	copyHR := *m.HR
	n.HR = &copyHR
	n.HR.LabMethod = "method_b"
	n.HR.LabHRBpm = floatPointer(184)
	got, _ := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{a, b}, day, nil, []calibration.CandidateMetadata{m, n})
	if got.Snapshot.ThresholdHR != nil || got.Evidence.HR.IndependentActivities != 0 {
		t.Fatal("civil-date tie arbitrarily selected a physiological method")
	}
}

func TestCandidateHRConflictingAdmittedAliasesAreRejectedBeforeDeduplication(t *testing.T) {
	for _, kind := range []string{"value", "lab_method", "lab_instrument", "reference_tier"} {
		t.Run(kind, func(t *testing.T) {
			a, m, day := hrProtocolFixture()
			a.LabelID = "a-low"
			m.ActivityID = a.LabelID
			m.RootActivityID = "same-root"
			b, n := a, m
			b.LabelID = "z-high"
			n.ActivityID = b.LabelID
			copyHR := *m.HR
			n.HR = &copyHR
			c, o, _ := hrProtocolFixture()
			c.LabelID = "independent"
			c.ActivityDate = day.AddDate(0, 0, -1)
			o.ActivityID = c.LabelID
			lab := func(value float64) *calibration.CandidateHRMetadata {
				return &calibration.CandidateHRMetadata{Protocol: "lab_lthr_report_v1", Verified: true, LabHRBpm: floatPointer(value), LabMethod: "method_a", LabInstrument: "instrument_a", LabReportDate: day}
			}
			switch kind {
			case "value":
				b.Samples = append([]calibration.Sample(nil), a.Samples...)
				for i := range b.Samples {
					if *b.Samples[i].ElapsedS >= 600 {
						b.Samples[i].HeartRateBpm = floatPointer(190)
					}
				}
			case "lab_method":
				m.HR = lab(174)
				n.HR = lab(174)
				n.HR.LabMethod = "method_b"
			case "lab_instrument":
				m.HR = lab(174)
				n.HR = lab(174)
				n.HR.LabInstrument = "instrument_b"
			case "reference_tier":
				n.HR = lab(174)
			}
			for _, swapIDs := range []bool{false, true} {
				aa, bb, mm, nn := a, b, m, n
				if swapIDs {
					aa.LabelID, bb.LabelID = bb.LabelID, aa.LabelID
					mm.ActivityID = aa.LabelID
					nn.ActivityID = bb.LabelID
				}
				got, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{bb, c, aa}, day, nil, []calibration.CandidateMetadata{o, nn, mm})
				if err != nil {
					t.Fatal(err)
				}
				if got.Snapshot.ThresholdHR == nil || *got.Snapshot.ThresholdHR != 170 || got.Evidence.HR.Confidence != calibration.ConfidenceLow || got.Evidence.HR.IndependentActivities != 1 || got.Evidence.HR.IndependentDays != 1 {
					t.Fatalf("%s conflict hidden by ID order %v: %+v", kind, swapIDs, got.Evidence.HR)
				}
				rejected := 0
				for _, obs := range got.Evidence.HR.Observations {
					if obs.RootActivityID != "same-root" {
						continue
					}
					if obs.Selected {
						t.Fatal("conflicting alias selected")
					}
					for _, reason := range obs.Reasons {
						if reason == "root_HR_alias_conflict" {
							rejected++
						}
					}
				}
				if rejected != 2 {
					t.Fatal("alias conflict missing from audit")
				}
			}
		})
	}
}

func TestCandidateHRInvalidOrUnavailableAliasDoesNotCreateValueConflict(t *testing.T) {
	for _, kind := range []string{"bad_quality", "unverified", "late", "invalid_lab_instrument"} {
		t.Run(kind, func(t *testing.T) {
			a, m, day := hrProtocolFixture()
			m.RootActivityID = "same-root"
			b, n := a, m
			b.LabelID = "a-invalid"
			n.ActivityID = b.LabelID
			b.Samples = append([]calibration.Sample(nil), a.Samples...)
			copyHR := *m.HR
			n.HR = &copyHR
			for i := range b.Samples {
				if *b.Samples[i].ElapsedS >= 600 {
					b.Samples[i].HeartRateBpm = floatPointer(190)
				}
			}
			switch kind {
			case "bad_quality":
				for i := range b.Samples {
					if *b.Samples[i].ElapsedS >= 900 && *b.Samples[i].ElapsedS <= 960 {
						b.Samples[i].HeartRateBpm = nil
					}
				}
			case "unverified":
				n.HR.Verified = false
			case "late":
				at := day.Add(time.Hour)
				n.AvailableAt = &at
			case "invalid_lab_instrument":
				n.HR = &calibration.CandidateHRMetadata{Protocol: "lab_lthr_report_v1", Verified: true, LabHRBpm: floatPointer(190), LabMethod: "method_a", LabReportDate: day}
			}
			c, o, _ := hrProtocolFixture()
			c.LabelID = "independent"
			c.ActivityDate = day.AddDate(0, 0, -1)
			o.ActivityID = c.LabelID
			got, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{b, c, a}, day, nil, []calibration.CandidateMetadata{n, o, m})
			if err != nil {
				t.Fatal(err)
			}
			if got.Snapshot.ThresholdHR == nil || *got.Snapshot.ThresholdHR != 170 || got.Evidence.HR.Confidence != calibration.ConfidenceMedium || got.Evidence.HR.IndependentActivities != 2 {
				t.Fatalf("invalid alias poisoned valid HR support: %+v", got.Evidence.HR)
			}
		})
	}
}

func TestCandidateHRAgreeingAliasesUsePublishedPrecisionIndependentOfID(t *testing.T) {
	a, m, day := hrProtocolFixture()
	a.LabelID = "a-first"
	m.ActivityID = a.LabelID
	m.RootActivityID = "same-root"
	b, n := a, m
	b.LabelID = "z-second"
	n.ActivityID = b.LabelID
	c, o, _ := hrProtocolFixture()
	c.LabelID = "independent"
	c.ActivityDate = day.AddDate(0, 0, -1)
	o.ActivityID = c.LabelID
	setHR := func(a *calibration.Activity, hr float64) {
		a.Samples = append([]calibration.Sample(nil), a.Samples...)
		for i := range a.Samples {
			if *a.Samples[i].ElapsedS >= 600 {
				a.Samples[i].HeartRateBpm = floatPointer(hr)
			}
		}
	}
	setHR(&a, 170.000041)
	setHR(&b, 170.000049)
	setHR(&c, 176.000049)
	for _, swap := range []bool{false, true} {
		aa, bb, mm, nn := a, b, m, n
		if swap {
			aa.LabelID, bb.LabelID = bb.LabelID, aa.LabelID
			mm.ActivityID = aa.LabelID
			nn.ActivityID = bb.LabelID
		}
		got, _ := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{aa, bb, c}, day, nil, []calibration.CandidateMetadata{mm, nn, o})
		if got.Snapshot.ThresholdHR == nil || *got.Snapshot.ThresholdHR != 173 || got.Evidence.HR.Confidence != calibration.ConfidenceMedium || got.Evidence.HR.IndependentActivities != 2 {
			t.Fatalf("rounding-equivalent aliases changed support: %+v", got.Evidence.HR)
		}
	}
}
