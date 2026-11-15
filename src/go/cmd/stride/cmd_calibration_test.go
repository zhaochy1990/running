package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
)

func executeCalibration(args ...string) (string, error) {
	root := newRootCmd()
	var output bytes.Buffer
	root.SetOut(&output)
	root.SetErr(&output)
	root.SetArgs(append([]string{"calibration", "replay"}, args...))
	err := root.Execute()
	return output.String(), err
}

func TestCalibrationCommandRejectsDuplicateSourceActivity(t *testing.T) {
	data, err := os.ReadFile("../../internal/compute/calibration/testdata/replay-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest calibration.ReplayManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	duplicate := manifest.Activities[0]
	duplicate.ID = "duplicate-record"
	manifest.Activities = append(manifest.Activities, duplicate)
	data, err = json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "duplicate.json")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	output, err := executeCalibration("--manifest", path, "--code-version", "test")
	var status interface{ ExitCode() int }
	if err == nil || errors.As(err, &status) || !strings.Contains(err.Error(), "duplicate source activity") {
		t.Fatalf("expected input error (exit 1), got %v", err)
	}
	if strings.Contains(output, `"schema_version"`) {
		t.Fatal("invalid manifest generated a replay report")
	}
}

func TestCalibrationCommandRejectsInvalidInputAndDoesNotClaimAccuracy(t *testing.T) {
	bad := filepath.Join(t.TempDir(), "bad.json")
	if err := os.WriteFile(bad, []byte(`{"schema_version":1,"unrecognized":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := executeCalibration("--manifest", bad, "--code-version", "test"); err == nil {
		t.Fatal("invalid input accepted")
	}
	args := []string{"--manifest", "../../internal/compute/calibration/testdata/replay-v1.json", "--code-version", "test"}
	first, err := executeCalibration(args...)
	var status interface{ ExitCode() int }
	if !errors.As(err, &status) || status.ExitCode() != 2 {
		t.Fatalf("insufficient evidence status=%v", err)
	}
	second, err := executeCalibration(args...)
	if !errors.As(err, &status) || status.ExitCode() != 2 || first != second {
		t.Fatal("fixed CLI replay is not repeatable")
	}
}
