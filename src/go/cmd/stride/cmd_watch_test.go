package main

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/provider"
)

type watchBindingStub struct {
	name  string
	found bool
}

func TestRunDerivedComputations_IncrementalOnlyComputesChangedLabels(t *testing.T) {
	var calibrationCalls, computeCalls int
	var computeInput struct {
		Mode     string   `json:"mode"`
		LabelIDs []string `json:"label_ids"`
	}
	calibration := func(context.Context, *job.Job, job.Heartbeat) (string, error) {
		calibrationCalls++
		return "", nil
	}
	calculation := func(_ context.Context, j *job.Job, _ job.Heartbeat) (string, error) {
		computeCalls++
		if err := json.Unmarshal([]byte(j.InputJSON), &computeInput); err != nil {
			t.Fatal(err)
		}
		return "", nil
	}

	if err := runDerivedComputations(context.Background(), "athlete", provider.SyncIncremental, []string{"new-1"}, calibration, calculation); err != nil {
		t.Fatalf("run derived computations: %v", err)
	}
	if calibrationCalls != 0 || computeCalls != 1 {
		t.Fatalf("calls calibration=%d compute=%d, want 0/1", calibrationCalls, computeCalls)
	}
	if computeInput.Mode != "incremental" || len(computeInput.LabelIDs) != 1 || computeInput.LabelIDs[0] != "new-1" {
		t.Fatalf("compute input = %+v", computeInput)
	}
}

func TestRunDerivedComputations_FullCalibratesBeforeFullCompute(t *testing.T) {
	var order []string
	var mode string
	calibration := func(context.Context, *job.Job, job.Heartbeat) (string, error) {
		order = append(order, "calibration")
		return "", nil
	}
	calculation := func(_ context.Context, j *job.Job, _ job.Heartbeat) (string, error) {
		order = append(order, "compute")
		var input struct {
			Mode string `json:"mode"`
		}
		if err := json.Unmarshal([]byte(j.InputJSON), &input); err != nil {
			t.Fatal(err)
		}
		mode = input.Mode
		return "", nil
	}

	if err := runDerivedComputations(context.Background(), "athlete", provider.SyncFull, nil, calibration, calculation); err != nil {
		t.Fatalf("run derived computations: %v", err)
	}
	if len(order) != 2 || order[0] != "calibration" || order[1] != "compute" || mode != "full" {
		t.Fatalf("order=%v mode=%q", order, mode)
	}
}

func TestRunDerivedComputations_StopsWhenCalibrationFails(t *testing.T) {
	computeCalled := false
	calibration := func(context.Context, *job.Job, job.Heartbeat) (string, error) {
		return "", errors.New("no source data")
	}
	calculation := func(context.Context, *job.Job, job.Heartbeat) (string, error) {
		computeCalled = true
		return "", nil
	}

	err := runDerivedComputations(context.Background(), "athlete", provider.SyncFull, nil, calibration, calculation)
	if err == nil || !strings.Contains(err.Error(), "calibration: no source data") {
		t.Fatalf("error = %v", err)
	}
	if computeCalled {
		t.Fatal("compute ran after calibration failed")
	}
}

func TestRunDerivedComputations_WrapsComputeFailure(t *testing.T) {
	calculation := func(context.Context, *job.Job, job.Heartbeat) (string, error) {
		return "", errors.New("missing baseline")
	}
	err := runDerivedComputations(context.Background(), "athlete", provider.SyncIncremental, nil, nil, calculation)
	if err == nil || !strings.Contains(err.Error(), "compute: missing baseline") {
		t.Fatalf("error = %v", err)
	}
}

func (s watchBindingStub) ProviderForUser(context.Context, string) (string, bool, error) {
	return s.name, s.found, nil
}

func TestResolveWatchProviderNamePrefersStoreBinding(t *testing.T) {
	name, err := resolveWatchProviderName(context.Background(), watchBindingStub{name: "garmin", found: true}, t.TempDir(), "user")
	if err != nil {
		t.Fatalf("resolve provider: %v", err)
	}
	if name != "garmin" {
		t.Fatalf("provider = %q, want garmin", name)
	}
}
