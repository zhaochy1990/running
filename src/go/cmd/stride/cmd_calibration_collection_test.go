package main

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
)

func TestCalibrationCollectionKeepsBaseImmutableAndWritesPrivateVersionedReports(t *testing.T) {
	dir := t.TempDir()
	raw, err := os.ReadFile("../../internal/compute/calibration/testdata/replay-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var base calibration.ReplayManifest
	if err := json.Unmarshal(raw, &base); err != nil {
		t.Fatal(err)
	}
	base.Activities = base.Activities[:1]
	base.Cases = base.Cases[:1]
	base.Cases[0].ID = "holdout-01"
	base.Cases[0].Mode = "event_date_retrospective"
	uid, targetLabel := "synthetic-storage-user", "synthetic-target-label"
	rootHash := fileSHA256([]byte(uid + "/" + targetLabel))
	base.Activities[0].RootActivityID = fileSHA256([]byte(uid + "/" + base.Activities[0].Activity.LabelID))
	base.Activities[0].ID = base.Activities[0].RootActivityID
	base.Cases[0].TargetRootActivityID = rootHash
	base.AsOf = base.Cases[0].PredictionAsOf
	base.SourceVersion = "synthetic;readonly-storage-watchmap-tsstore:source-code;frozen-split-sha256:frozen-split"
	event := base.AsOf.Add(time.Hour)
	observed := event.Add(time.Hour)
	reportTime := observed.Add(time.Hour)
	files := map[string]string{}
	write := func(name string, value any) {
		t.Helper()
		path := filepath.Join(dir, name)
		if err := writeCollectionJSON(path, value); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		files[name] = fileSHA256(data)
	}
	write("holdout-01-replay-manifest.json.gz", base)
	originalHash := files["holdout-01-replay-manifest.json.gz"]
	write("collection-summary.json.gz", map[string]any{"completed_at": observed, "source_sha": "source-code", "split_sha256": "frozen-split", "other_frozen_summary_fields": true})
	write("plans-and-independent-outcomes.json.gz", map[string]any{"source_sha": "source-code", "split_sha256": "frozen-split", "outcome_scope": "independent race actual distance/time", "available_at": nil, "mode": "event_date_retrospective", "plans": []any{map[string]any{"case_id": "holdout-01", "window_start": event.AddDate(0, 0, -180), "prediction_as_of": base.AsOf, "target": map[string]any{"user_id": uid, "label_id": targetLabel, "user": base.Cases[0].User, "root_activity_id": rootHash, "split": "final_holdout", "effort_support": "probable_maximal", "event_at": event, "duration_s": 2400, "distance_m": 10000}}}})
	index, err := json.Marshal(map[string]any{"format": "sha256-file-inventory/v1", "files": files})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "artifact-sha256.json"), index, 0600); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(dir, "new-report-v1")
	root := newRootCmd()
	var stdout bytes.Buffer
	root.SetOut(&stdout)
	root.SetErr(&stdout)
	root.SetArgs([]string{"calibration", "replay-collection", "--collection-dir", dir, "--output-dir", output, "--code-version", "fixed-engine", "--report-as-of", reportTime.Format(time.RFC3339Nano), "--outcome-observed-at", observed.Format(time.RFC3339Nano), "--expected-inventory-sha256", fileSHA256(index), "--expected-split-sha256", "frozen-split", "--expected-source-sha", "source-code", "--expected-cases", "1"})
	err = root.Execute()
	var exit interface{ ExitCode() int }
	if !errors.As(err, &exit) || exit.ExitCode() != 2 {
		t.Fatalf("synthetic collection status: %v %s", err, stdout.String())
	}
	after, err := os.ReadFile(filepath.Join(dir, "holdout-01-replay-manifest.json.gz"))
	if err != nil || fileSHA256(after) != originalHash {
		t.Fatal("base overwritten")
	}
	info, err := os.Stat(filepath.Join(output, "aggregate-report.json.gz"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("report not private")
	}
	file, err := os.Open(filepath.Join(output, "aggregate-report.json.gz"))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	z, err := gzip.NewReader(file)
	if err != nil {
		t.Fatal(err)
	}
	defer z.Close()
	var envelope struct {
		Report calibration.ReplayReport   `json:"report"`
		Cases  []collectionCaseProvenance `json:"case_provenance"`
	}
	if err := json.NewDecoder(z).Decode(&envelope); err != nil {
		t.Fatal(err)
	}
	if len(envelope.Cases) != 1 || envelope.Report.Evaluation.EligibleActivities != 0 || envelope.Report.ReleaseReady || envelope.Cases[0].BaseManifestSHA256 != calibration.ReplayContentHash(base) {
		t.Fatal("view provenance/mode lost")
	}
	if err := root.Execute(); err == nil {
		t.Fatal("existing versioned directory overwritten")
	}
	base.SourceVersion = "synthetic;readonly-storage-watchmap-tsstore:source-codeevil;frozen-split-sha256:frozen-split"
	if err := os.Remove(filepath.Join(dir, "holdout-01-replay-manifest.json.gz")); err != nil {
		t.Fatal(err)
	}
	write("holdout-01-replay-manifest.json.gz", base)
	index, err = json.Marshal(map[string]any{"format": "sha256-file-inventory/v1", "files": files})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "artifact-sha256.json"), index, 0600); err != nil {
		t.Fatal(err)
	}
	badRoot := newRootCmd()
	badRoot.SetOut(&stdout)
	badRoot.SetErr(&stdout)
	badRoot.SetArgs([]string{"calibration", "replay-collection", "--collection-dir", dir, "--output-dir", filepath.Join(dir, "invalid-source-v2"), "--code-version", "fixed-engine", "--report-as-of", reportTime.Format(time.RFC3339Nano), "--outcome-observed-at", observed.Format(time.RFC3339Nano), "--expected-inventory-sha256", fileSHA256(index), "--expected-split-sha256", "frozen-split", "--expected-source-sha", "source-code", "--expected-cases", "1"})
	badErr := badRoot.Execute()
	if badErr == nil || errors.As(badErr, &exit) {
		t.Fatalf("source token prefix accepted: %v", badErr)
	}
}
