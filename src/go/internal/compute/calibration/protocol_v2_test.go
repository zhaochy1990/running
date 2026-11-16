package calibration_test

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
)

func TestEvaluationProtocolV2FrozenHashAndCopies(t *testing.T) {
	golden, err := os.ReadFile("testdata/evaluation-protocol-v2.sha256")
	if err != nil {
		t.Fatal(err)
	}
	if calibration.EvaluationProtocolV2SHA256() != strings.TrimSpace(string(golden)) {
		t.Fatal("frozen v2 evaluation protocol changed; freeze a new protocol version instead")
	}
	canonical, err := os.ReadFile("../../../../../docs/calibration/evaluation-protocol-v2.md")
	if err != nil {
		t.Fatal(err)
	}
	embedded, err := os.ReadFile("evaluation-protocol-v2.md")
	if err != nil {
		t.Fatal(err)
	}
	if string(canonical) != string(embedded) {
		t.Fatal("embedded v2 protocol differs from canonical document")
	}
}

func v2ManifestFixture() calibration.ReplayManifest {
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	m := calibration.ReplayManifest{SchemaVersion: 2, AsOf: asOf, SourceVersion: "v2-export"}
	mk := func(id, root, split string, daysAgo int) calibration.ReplayActivity {
		a := calibration.ReplayActivity{ID: id, User: "athlete-a", RootActivityID: root, Split: split, EventTime: asOf.AddDate(0, 0, -daysAgo), Device: "synthetic"}
		a.Activity = calibration.Activity{LabelID: id, ActivityDate: a.EventTime, Sport: "run", DurationS: f64p(3600), DistanceM: f64p(12000)}
		a.ContentSHA256 = calibration.ReplayContentHash(a.Activity)
		return a
	}
	m.Activities = []calibration.ReplayActivity{
		mk("train-1", "r1", "train", 40),
		mk("train-2", "r2", "train", 30),
		mk("valid-1", "r3", "validation", 20),
		mk("hold-1", "r4", "final_holdout", 10),
		mk("reg-1", "r5", "known_regression", 35),
	}
	m.Cases = []calibration.ReplayCase{{ID: "c1", User: "athlete-a", PredictionAsOf: asOf.AddDate(0, 0, -25), Mode: "strict"}}
	return m
}

func TestProtocolV2ManifestValidation(t *testing.T) {
	m := v2ManifestFixture()
	if err := calibration.ValidateReplayManifestV2(m); err != nil {
		t.Fatalf("valid v2 manifest rejected: %v", err)
	}
	// v1 and v2 engines are isolated: the v1 replay refuses schema 2...
	if _, err := calibration.Replay(m, "test"); err == nil {
		t.Fatal("v1 replay accepted a v2 manifest")
	}
	// ...and the v2 validator refuses v1 manifests.
	v1 := m
	v1.SchemaVersion = 1
	if err := calibration.ValidateReplayManifestV2(v1); err == nil {
		t.Fatal("v2 validator accepted a v1 manifest")
	}
	// Unknown splits are rejected; known_regression is a first-class v2 split.
	bad := m
	bad.Activities = append([]calibration.ReplayActivity(nil), m.Activities...)
	bad.Activities[4].Split = "regression"
	if err := calibration.ValidateReplayManifestV2(bad); err == nil {
		t.Fatal("unknown split accepted")
	}
	// A root cannot cross splits.
	cross := m
	cross.Activities = append([]calibration.ReplayActivity(nil), m.Activities...)
	cross.Activities[4].RootActivityID = "r1"
	if err := calibration.ValidateReplayManifestV2(cross); err == nil {
		t.Fatal("root crossing splits accepted")
	}
	// Cases may only target final_holdout, never the regression bucket.
	target := m
	target.Cases = []calibration.ReplayCase{{ID: "c2", User: "athlete-a", PredictionAsOf: m.AsOf.AddDate(0, 0, -20), Mode: "strict", TargetRootActivityID: "r5"}}
	if err := calibration.ValidateReplayManifestV2(target); err == nil {
		t.Fatal("known_regression target accepted as scoreable holdout")
	}
}
