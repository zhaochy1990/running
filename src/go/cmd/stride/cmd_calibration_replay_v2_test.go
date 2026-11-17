package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
)

func executeCalibrationV2(args ...string) (string, error) {
	root := newRootCmd()
	var output bytes.Buffer
	root.SetOut(&output)
	root.SetErr(&output)
	root.SetArgs(append([]string{"calibration", "replay-v2"}, args...))
	err := root.Execute()
	return output.String(), err
}

func writeV2Manifest(t *testing.T, mutate func(*calibration.ReplayManifest)) string {
	t.Helper()
	asOf := time.Date(2026, 11, 16, 0, 0, 0, 0, time.UTC)
	m := calibration.ReplayManifest{SchemaVersion: 2, AsOf: asOf, SourceVersion: "v2-cli-synthetic"}
	f64 := func(v float64) *float64 { return &v }
	mk := func(id, root, split string, daysAgo int) calibration.ReplayActivity {
		a := calibration.ReplayActivity{ID: id, User: "cli-user", RootActivityID: root, Split: split, EventTime: asOf.AddDate(0, 0, -daysAgo), Device: "synthetic"}
		availableAt := a.EventTime
		a.AvailableAt = &availableAt
		a.AvailabilityEvidence = "cli-fixture"
		activity := calibration.Activity{LabelID: id, ActivityDate: a.EventTime, Sport: "run", DurationS: f64(3600), DistanceM: f64(12000)}
		for t := 0; t <= 3600; t += 5 {
			activity.Samples = append(activity.Samples, calibration.Sample{ElapsedS: f64(float64(t)), SpeedMps: f64(3.3), DistanceM: f64(float64(t) * 3.3), HeartRateBpm: f64(150)})
		}
		a.Activity = activity
		a.ContentSHA256 = calibration.ReplayContentHash(activity)
		return a
	}
	m.Activities = []calibration.ReplayActivity{
		mk("train-1", "r1", "train", 30),
		mk("train-2", "r2", "train", 20),
		mk("train-3", "r3", "train", 10),
	}
	m.Cases = []calibration.ReplayCase{{ID: "c1", User: "cli-user", PredictionAsOf: asOf.AddDate(0, 0, -5), Mode: "strict"}}
	if mutate != nil {
		mutate(&m)
	}
	data, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "manifest-v2.json")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCalibrationReplayV2CLIReportsAndExitsInsufficientOnSynthetic(t *testing.T) {
	path := writeV2Manifest(t, nil)
	output, err := executeCalibrationV2("--manifest", path, "--code-version", "cli-test")
	var status interface{ ExitCode() int }
	if err == nil || !errors.As(err, &status) || status.ExitCode() != 2 {
		t.Fatalf("synthetic manifest must exit 2 (insufficient), got %v", err)
	}
	var decoded calibration.ReplayV2Report
	if err := json.Unmarshal([]byte(output), &decoded); err != nil {
		t.Fatalf("output is not a v2 report: %v", err)
	}
	if decoded.SchemaVersion != 2 || decoded.CodeVersion != "cli-test" {
		t.Fatalf("schema/code identity drift: %d %q", decoded.SchemaVersion, decoded.CodeVersion)
	}
	if decoded.Status != "insufficient" {
		t.Fatalf("status=%q", decoded.Status)
	}
}

func TestCalibrationReplayV2CLIRejectsSchemaOneAndUnknownFiles(t *testing.T) {
	path := writeV2Manifest(t, func(m *calibration.ReplayManifest) { m.SchemaVersion = 1 })
	_, err := executeCalibrationV2("--manifest", path, "--code-version", "cli-test")
	var status interface{ ExitCode() int }
	if err == nil || errors.As(err, &status) || !strings.Contains(err.Error(), "schema_version=2") {
		t.Fatalf("schema-1 manifest must fail with an input error (exit 1), got %v", err)
	}
	// Missing flags never open files.
	if _, err := executeCalibrationV2("--code-version", "cli-test"); err == nil || !strings.Contains(err.Error(), "required") {
		t.Fatalf("missing manifest flag must fail fast, got %v", err)
	}
}
