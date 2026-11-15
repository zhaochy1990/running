package calibration_test

import (
	"encoding/json"
	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

func replayFixture(t *testing.T) calibration.ReplayManifest {
	t.Helper()
	cutoff := time.Date(2026, 11, 10, 0, 0, 0, 0, time.UTC)
	duration, distance := 3600.0, 14400.0
	a := calibration.Activity{LabelID: "train", ActivityDate: cutoff.AddDate(0, 0, -1), Sport: "run", DurationS: &duration, DistanceM: &distance}
	available := cutoff.Add(-time.Hour)
	r := calibration.ReplayActivity{ID: "train", User: "athlete-a", RootActivityID: "train", Split: "train", EventTime: cutoff.AddDate(0, 0, -1), AvailableAt: &available, AvailabilityEvidence: "immutable-export:a", Device: "synthetic", Scenarios: []string{"continuous"}, Activity: a}
	r.ContentSHA256 = calibration.ReplayContentHash(a)
	return calibration.ReplayManifest{SchemaVersion: 1, AsOf: cutoff.AddDate(0, 0, 3), SourceVersion: "synthetic-v1", Activities: []calibration.ReplayActivity{r}, Cases: []calibration.ReplayCase{{ID: "prediction", User: "athlete-a", PredictionAsOf: cutoff, Mode: "strict", TargetRootActivityID: "heldout"}}}
}

func TestReplayExcludesFutureLateUnknownAndHeldoutActivityDerivatives(t *testing.T) {
	m := replayFixture(t)
	baseline, err := calibration.Replay(m, "test-commit")
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"future", "late", "unknown", "heldout"} {
		modified := replayFixture(t)
		a := modified.Activities[0]
		a.ID = kind
		a.RootActivityID = kind
		a.Activity.LabelID = kind
		a.Activity.DistanceM = nil
		switch kind {
		case "future":
			a.EventTime = m.AsOf.AddDate(0, 0, 1)
			a.Activity.ActivityDate = time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC)
			at := a.EventTime.Add(time.Hour)
			a.AvailableAt = &at
		case "late":
			late := m.AsOf.AddDate(0, 0, 1)
			a.AvailableAt = &late
		case "unknown":
			a.AvailableAt = nil
			a.AvailabilityEvidence = ""
		case "heldout":
			a.RootActivityID = "heldout"
			a.Split = "final_holdout"
			a.EventTime = m.Cases[0].PredictionAsOf.Add(time.Hour)
			a.Activity.ActivityDate = m.Cases[0].PredictionAsOf
			at := a.EventTime.Add(time.Hour)
			a.AvailableAt = &at
		}
		a.ContentSHA256 = calibration.ReplayContentHash(a.Activity)
		modified.Activities = append(modified.Activities, a)
		got, err := calibration.Replay(modified, "test-commit")
		if err != nil {
			t.Fatalf("%s: %v", kind, err)
		}
		before, _ := json.Marshal(baseline.Cases[0].Versions)
		after, _ := json.Marshal(got.Cases[0].Versions)
		if string(before) != string(after) || got.Cases[0].InputSHA256 != baseline.Cases[0].InputSHA256 {
			t.Fatalf("%s leaked into fixed-as-of estimate", kind)
		}
	}
	if baseline.Status != "insufficient" {
		t.Fatal("synthetic alias claimed accuracy")
	}
	again, _ := calibration.Replay(m, "test-commit")
	one, _ := json.Marshal(baseline)
	two, _ := json.Marshal(again)
	if string(one) != string(two) {
		t.Fatal("replay is nondeterministic")
	}
}

func TestReplayRejectsSplitLeakageAndTamperedContent(t *testing.T) {
	m := replayFixture(t)
	duplicate := m.Activities[0]
	duplicate.ID = "derived-lap"
	duplicate.Split = "final_holdout"
	m.Activities = append(m.Activities, duplicate)
	if _, err := calibration.Replay(m, "test-commit"); err == nil || !strings.Contains(err.Error(), "split") {
		t.Fatalf("split leak accepted: %v", err)
	}
	m = replayFixture(t)
	m.Activities[0].ContentSHA256 = "tampered"
	if _, err := calibration.Replay(m, "test-commit"); err == nil {
		t.Fatal("tampered fixture accepted")
	}
}

func TestProductionAndOfflineV3MatchPreChangeGoldenHistories(t *testing.T) {
	data, err := os.ReadFile("testdata/replay-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest calibration.ReplayManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	data, err = os.ReadFile("testdata/v3-golden.json")
	if err != nil {
		t.Fatal(err)
	}
	var expected map[string]calibration.Snapshot
	if err := json.Unmarshal(data, &expected); err != nil {
		t.Fatal(err)
	}
	report, err := calibration.Replay(manifest, "test")
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range report.Cases {
		want, ok := expected[r.ID]
		if !ok {
			t.Fatalf("no pre-change golden for %s", r.ID)
		}
		if !reflect.DeepEqual(r.Versions[0].Snapshot, want) {
			t.Fatalf("frozen %s changed: got %+v want %+v", r.ID, r.Versions[0].Snapshot, want)
		}
		var history []calibration.Activity
		for _, a := range manifest.Activities {
			if a.User == r.User {
				history = append(history, a.Activity)
			}
		}
		got := calibration.EstimateRunningCalibration(history, want.AsOfDate, nil)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("production %s diverges from pre-change v3", r.ID)
		}
	}
}

func TestReplaySeparatesRetrospectiveAndIgnoresLateHealthAndLabels(t *testing.T) {
	m := replayFixture(t)
	cutoff := m.Cases[0].PredictionAsOf
	old := cutoff.AddDate(0, 0, -1)
	h := calibration.ReplayHealth{ID: "health", User: "athlete-a", EventTime: old, Row: calibration.HealthRow{Date: old, RHR: floatPointer(42)}}
	h.ContentSHA256 = calibration.ReplayContentHash(h.Row)
	m.Health = []calibration.ReplayHealth{h}
	baseline, err := calibration.Replay(m, "test")
	if err != nil {
		t.Fatal(err)
	}
	// A daily value that was only backfilled after the prediction is also excluded.
	late := m.AsOf.Add(time.Hour)
	m.Health[0].AvailableAt = &late
	m.Health[0].AvailabilityEvidence = "immutable-late-health"
	got, err := calibration.Replay(m, "test")
	if err != nil {
		t.Fatal(err)
	}
	if got.Cases[0].InputSHA256 != baseline.Cases[0].InputSHA256 {
		t.Fatal("late health leaked")
	}
	// Unknown-time inputs are usable only in the explicitly separate retrospective cohort.
	m.Health[0].AvailableAt = nil
	m.Health[0].AvailabilityEvidence = ""
	m.Cases[0].Mode = "event_date_retrospective"
	retrospective, err := calibration.Replay(m, "test")
	if err != nil {
		t.Fatal(err)
	}
	if retrospective.Cases[0].InputSHA256 == baseline.Cases[0].InputSHA256 || retrospective.Evaluation.PairedActivities != 0 {
		t.Fatal("retrospective cohort not separated")
	}
	// Independent labels score only when available by report as_of; they never fit.
	m = replayFixture(t)
	a := m.Activities[0]
	a.ID = "target"
	a.RootActivityID = "heldout"
	a.Split = "final_holdout"
	a.Activity.LabelID = "target"
	a.EventTime = cutoff.Add(time.Hour)
	a.Activity.ActivityDate = cutoff
	at := a.EventTime.Add(time.Hour)
	a.AvailableAt = &at
	a.Reference = &calibration.ReplayReference{Kind: "direct_60min", Real: true, EffortSupport: "confirmed_maximal", MeasurementQuality: "high", EvidenceRef: "audited-reference", Protocol: "continuous_60min_v1", AvailableAt: &late, DurationS: 3600, DistanceM: 14400}
	a.ContentSHA256 = calibration.ReplayContentHash(a.Activity)
	m.Activities = append(m.Activities, a)
	lateReport, err := calibration.Replay(m, "test")
	if err != nil {
		t.Fatal(err)
	}
	if lateReport.Evaluation.EligibleActivities != 0 {
		t.Fatal("future backfilled label scored")
	}
	m.Activities[1].Reference.AvailableAt = &at
	scored, err := calibration.Replay(m, "test")
	if err != nil {
		t.Fatal(err)
	}
	if scored.Evaluation.PairedActivities != 1 || scored.Status != "insufficient" {
		t.Fatal("one real label incorrectly released or not scored")
	}
	if scored.Cases[0].InputSHA256 != lateReport.Cases[0].InputSHA256 {
		t.Fatal("reference label entered fitting input")
	}
}

func floatPointer(v float64) *float64 { return &v }

func TestOfflineReplayIdentifiesFrozenV3AndProtocol(t *testing.T) {
	expected, err := os.ReadFile("testdata/v3-source.sha256")
	if err != nil {
		t.Fatal(err)
	}
	if calibration.FrozenV3SourceSHA256() != strings.TrimSpace(string(expected)) {
		t.Fatal("frozen production v3 source changed; candidate must evolve in separate files")
	}
	protocol, err := os.ReadFile("../../../../../docs/calibration/evaluation-protocol-v1.md")
	if err != nil {
		t.Fatal(err)
	}
	embedded, err := os.ReadFile("evaluation-protocol-v1.md")
	if err != nil {
		t.Fatal(err)
	}
	if string(protocol) != string(embedded) {
		t.Fatal("embedded frozen protocol differs from canonical document")
	}
}

func TestReplayCannotRelabelHeldoutActivityToEvadeRootSplit(t *testing.T) {
	m := replayFixture(t)
	a := m.Activities[0]
	a.ID = "lap-derived"
	a.RootActivityID = "different-root"
	a.Split = "final_holdout"
	a.EventTime = a.EventTime.Add(time.Hour)
	at := a.EventTime.Add(time.Hour)
	a.AvailableAt = &at
	m.Activities = append(m.Activities, a)
	if _, err := calibration.Replay(m, "test"); err == nil {
		t.Fatal("same source activity relabelled across split")
	}
}
