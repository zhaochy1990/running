package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"
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
