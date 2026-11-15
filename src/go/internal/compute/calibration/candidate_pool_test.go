package calibration_test

import (
	"reflect"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
)

func evidenceActivity(id string, day time.Time, duration int, speed float64) calibration.Activity {
	a := calibration.Activity{LabelID: id, ActivityDate: day, Sport: "run", DurationS: floatPointer(float64(duration)), DistanceM: floatPointer(float64(duration) * speed)}
	for i := 0; i <= duration; i += 5 {
		a.Samples = append(a.Samples, segmentSample(float64(i), float64(i)*speed, speed))
	}
	return a
}
func TestCandidateQualityIsIndependentOfMaximalEffort(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	a := evidenceActivity("test", day, 3600, 4)
	b := evidenceActivity("longrun", day, 3600, 4)
	metadata := []calibration.CandidateMetadata{
		{ActivityID: "test", SourceVersion: "audited-v1", EvidenceRef: "protocol-1", Protocol: "continuous_maximal_test_v1", ProtocolVerified: true, DurationS: 3600, StartS: floatPointer(0), EndS: floatPointer(3600)},
		{ActivityID: "longrun", SourceVersion: "feedback-v1", Submaximal: true},
	}
	report := calibration.BuildCandidateEvidence([]calibration.Activity{a, b}, metadata, day)
	var maximal, submax bool
	for _, c := range report.Candidates {
		if c.DurationS != 3600 {
			continue
		}
		if c.MeasurementQuality != calibration.ConfidenceHigh {
			t.Fatalf("quality=%s", c.MeasurementQuality)
		}
		if c.ActivityID == "test" {
			maximal = c.EffortSupport == calibration.EffortConfirmedMaximal
		}
		if c.ActivityID == "longrun" {
			submax = c.EffortSupport == calibration.EffortSubmaximal
			if c.ObservedLowerBoundMps != 3.6 {
				t.Fatalf("lower bound=%v", c.ObservedLowerBoundMps)
			}
		}
	}
	if !maximal || !submax {
		t.Fatalf("effort not separated: %+v", report)
	}
}

func TestCandidatePoolKeepsRecentIndependentLongEvidenceWithoutDuplicateSupport(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	history := []calibration.Activity{evidenceActivity("old-pb", day.AddDate(0, 0, -170), 9000, 5)}
	for i, id := range []string{"recent-1", "recent-2", "recent-3"} {
		history = append(history, evidenceActivity(id, day.AddDate(0, 0, -i), 9000, 4))
	}
	report := calibration.BuildCandidateEvidence(history, nil, day)
	duplicate := calibration.BuildCandidateEvidence(append(history, history...), nil, day)
	if duplicate.IndependentActivities != report.IndependentActivities || duplicate.TotalContribution != report.TotalContribution {
		t.Fatal("duplicates inflate independent support")
	}
	durations := map[float64]bool{}
	for _, c := range report.Candidates {
		durations[c.DurationS] = true
		if c.Selected && c.ActivityID == "old-pb" {
			t.Fatal("old PB displaced recent candidates before ageing")
		}
		if c.FullActivity && c.DurationS != 9000 {
			t.Fatal("complete activity duration lost")
		}
	}
	for _, d := range []float64{4500, 5400, 7200, 9000} {
		if !durations[d] {
			t.Fatalf("missing long duration %v", d)
		}
	}
	if report.IndependentActivities != 3 || report.TotalContribution > 3.000001 {
		t.Fatalf("support=%+v", report)
	}
}

func TestCandidateRecoveryAndShortEffortsCannotBecomeContinuousHourEvidence(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	a := evidenceActivity("repetitions", day, 3600, 4)
	for i := range a.Samples {
		if i >= 120 && i <= 126 {
			*a.Samples[i].SpeedMps = 0
		}
	}
	report := calibration.BuildCandidateEvidence([]calibration.Activity{a}, []calibration.CandidateMetadata{{ActivityID: a.LabelID, SourceVersion: "name-only", AthleteReportedMaximal: true, FeelPresent: true}}, day)
	var full, short bool
	for _, c := range report.Candidates {
		if c.EffortSupport != calibration.EffortUnknown {
			t.Fatal("single report/feel became maximal")
		}
		if c.DurationS == 3600 {
			full = true
			if c.Continuous || c.Selected || c.ObservedLowerBoundMps != 0 {
				t.Fatal("recovery stitched into an hour constraint")
			}
		}
		if c.DurationS == 180 {
			short = true
			if c.ObservedLowerBoundMps != 3.6 {
				t.Fatal("short constraint lost original duration")
			}
		}
	}
	if !full || !short {
		t.Fatal("complete elapsed or short observations lost")
	}
}

func TestCandidateAliasesCannotIncreaseRootOrDaySupport(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	a := evidenceActivity("watch-a", day, 3600, 4)
	b := evidenceActivity("watch-b", day, 3600, 4)
	report := calibration.BuildCandidateEvidence([]calibration.Activity{a, b}, []calibration.CandidateMetadata{{ActivityID: a.LabelID, RootActivityID: "same-run", SourceVersion: "link-v1"}, {ActivityID: b.LabelID, RootActivityID: "same-run", SourceVersion: "link-v1"}}, day)
	if report.IndependentActivities != 1 || report.IndependentDays != 1 || report.TotalContribution > 1.000001 {
		t.Fatal("linked duplicates inflate support")
	}
}

func TestOfflineCandidateUsesEvidenceWhileSegmentsOnlyAndProductionStayFrozen(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	a := evidenceActivity("unknown-hour", day, 3600, 4)
	clean, err := calibration.EstimateOffline(calibration.StrategySegmentsOnly, []calibration.Activity{a}, day, nil)
	if err != nil {
		t.Fatal(err)
	}
	candidate, err := calibration.EstimateOfflineWithEvidence(calibration.StrategyCandidate, []calibration.Activity{a}, day, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if candidate.Evidence == nil || candidate.Snapshot.ThresholdSpeedConfidence != calibration.ConfidenceLow {
		t.Fatal("unknown evidence still high confidence")
	}
	if clean.Evidence != nil || clean.Snapshot.ThresholdSpeedConfidence != calibration.ConfidenceHigh {
		t.Fatal("T2 baseline changed")
	}
	active := calibration.EstimateRunningCalibration([]calibration.Activity{a}, day, nil)
	if active.AlgorithmVersion != 3 || active.ThresholdSpeedConfidence != calibration.ConfidenceHigh {
		t.Fatal("production escaped v3")
	}
}

func TestCandidateCompleteFractionalDurationIsPreservedAndProtocolDoesNotSpread(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	a := evidenceActivity("full", day, 9000, 4)
	a.DurationS = floatPointer(9000.5)
	a.DistanceM = floatPointer(36002)
	a.Samples = append(a.Samples, segmentSample(9000.5, 36002, 4))
	metadata := []calibration.CandidateMetadata{{ActivityID: "full", SourceVersion: "test-v1", EvidenceRef: "observed-full", Protocol: "continuous_maximal_test_v1", ProtocolVerified: true, DurationS: 9000.5, StartS: floatPointer(0), EndS: floatPointer(9000.5)}}
	report := calibration.BuildCandidateEvidence([]calibration.Activity{a}, metadata, day)
	found := false
	for _, c := range report.Candidates {
		if c.FullActivity {
			found = true
			if c.DurationS != 9000.5 || c.EffortSupport != calibration.EffortConfirmedMaximal {
				t.Fatal("full duration/protocol lost")
			}
		} else if c.EffortSupport != calibration.EffortUnknown {
			t.Fatal("whole-run protocol spread to unrelated windows")
		}
	}
	if !found {
		t.Fatal("missing complete fractional elapsed")
	}
}

func TestCandidateRaceAndConflictingSubjectiveClaimsStayConservative(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	a := evidenceActivity("race", day, 3600, 4)
	for _, tc := range []struct {
		meta calibration.CandidateMetadata
		want calibration.EffortSupport
	}{
		{calibration.CandidateMetadata{RaceIdentity: true}, calibration.EffortUnknown},
		{calibration.CandidateMetadata{RaceIdentity: true, AthleteReportedMaximal: true, SustainedEffortCorroborated: true}, calibration.EffortProbableMaximal},
		{calibration.CandidateMetadata{RaceIdentity: true, AthleteReportedMaximal: true, SustainedEffortCorroborated: true, Submaximal: true}, calibration.EffortSubmaximal},
	} {
		tc.meta.ActivityID = a.LabelID
		tc.meta.SourceVersion = "admitted-v1"
		report := calibration.BuildCandidateEvidence([]calibration.Activity{a}, []calibration.CandidateMetadata{tc.meta}, day)
		for _, c := range report.Candidates {
			if c.FullActivity && c.EffortSupport != tc.want {
				t.Fatalf("effort=%s want %s", c.EffortSupport, tc.want)
			}
		}
	}
}

func TestCandidateTruncatedRecordingRetainsWholeActivityElapsedAsNoncontinuous(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	a := evidenceActivity("truncated-long-run", day, 3600, 4)
	a.DurationS = floatPointer(9000)
	a.DistanceM = floatPointer(30000)
	report := calibration.BuildCandidateEvidence([]calibration.Activity{a}, nil, day)
	found := false
	for _, c := range report.Candidates {
		if c.FullActivity {
			found = true
			if c.DurationS != 9000 || c.Continuous || c.Selected {
				t.Fatalf("truncated stream masquerades as full activity: %+v", c)
			}
		}
	}
	if !found {
		t.Fatal("30km complete 9000s elapsed was discarded")
	}
}

func TestOfflineEvidenceCannotAlterComparisonControls(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	history := []calibration.Activity{evidenceActivity("hour", day, 3600, 4)}
	metadata := []calibration.CandidateMetadata{{ActivityID: "hour", SourceVersion: "counter-v1", Submaximal: true, Interrupted: true}}
	for _, strategy := range []calibration.Strategy{calibration.StrategyV3, calibration.StrategySegmentsOnly} {
		baseline, err := calibration.EstimateOffline(strategy, history, day, nil)
		if err != nil {
			t.Fatal(err)
		}
		withEvidence, err := calibration.EstimateOfflineWithEvidence(strategy, history, day, nil, metadata)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(baseline, withEvidence) {
			t.Fatalf("metadata altered frozen comparison %s", strategy)
		}
	}
}

func TestCandidateRetainsVerifiedWindowBeforeChoosingFasterUnknownObservation(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	a := evidenceActivity("offset-protocol", day, 3900, 4)
	for i := range a.Samples {
		t := *a.Samples[i].ElapsedS
		if t <= 300 {
			*a.Samples[i].DistanceM = t * 5
			*a.Samples[i].SpeedMps = 5
		} else {
			*a.Samples[i].DistanceM = 1500 + (t-300)*4
		}
	}
	a.DistanceM = floatPointer(15900)
	meta := []calibration.CandidateMetadata{{ActivityID: a.LabelID, SourceVersion: "protocol-v1", EvidenceRef: "verified-window", Protocol: "continuous_maximal_test_v1", ProtocolVerified: true, DurationS: 3600, StartS: floatPointer(300), EndS: floatPointer(3900)}}
	report := calibration.BuildCandidateEvidence([]calibration.Activity{a}, meta, day)
	var verified, unknown bool
	for _, c := range report.Candidates {
		if c.DurationS == 3600 {
			if c.StartS != nil && *c.StartS == 300 && *c.EndS == 3900 {
				verified = c.EffortSupport == calibration.EffortConfirmedMaximal && c.Selected && c.AvgSpeedMps == 4
			}
			if c.StartS != nil && *c.StartS == 0 {
				unknown = c.EffortSupport == calibration.EffortUnknown && !c.Selected
			}
		}
	}
	if !verified || !unknown {
		t.Fatal("fastest unknown window replaced the verified protocol window before evidence selection")
	}
	clean, err := calibration.EstimateOffline(calibration.StrategySegmentsOnly, []calibration.Activity{a}, day, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range clean.Segments.Candidates {
		if c.DurationS == 3600 && (c.StartS == nil || *c.StartS != 0) {
			t.Fatal("protocol support changed T2 fastest-window control")
		}
	}
}

func TestCandidateVerifiedWindowUsesMeasuredOffGridEndpoints(t *testing.T) {
	day := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	a := evidenceActivity("fractional-protocol", day, 3900, 4)
	report := calibration.BuildCandidateEvidence([]calibration.Activity{a}, []calibration.CandidateMetadata{{ActivityID: a.LabelID, SourceVersion: "protocol-v1", EvidenceRef: "fractional-window", Protocol: "continuous_maximal_test_v1", ProtocolVerified: true, DurationS: 3595, StartS: floatPointer(302.5), EndS: floatPointer(3897.5)}}, day)
	found := false
	for _, c := range report.Candidates {
		if c.DurationS == 3595 {
			found = true
			if c.AvgSpeedMps != 4 || *c.StartS != 302.5 || *c.EndS != 3897.5 || c.EffortSupport != calibration.EffortConfirmedMaximal || !c.Selected {
				t.Fatalf("off-grid protocol measured inconsistently: %+v", c)
			}
		}
	}
	if !found {
		t.Fatal("exact protocol observation absent")
	}
}
