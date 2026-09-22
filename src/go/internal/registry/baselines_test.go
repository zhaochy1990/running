package registry

import (
	"context"
	"errors"
	"testing"

	"github.com/zhaochy1990/stride/internal/storage"
)

type fakeCalibration struct {
	snap *storage.RunningCalibrationSnapshot
	err  error
}

func (f fakeCalibration) LatestRunningCalibrationSnapshotForVersion(context.Context, string, int, string) (*storage.RunningCalibrationSnapshot, error) {
	return f.snap, f.err
}

func f64ptr(v float64) *float64 { return &v }

func TestLoadBaselines_MapsSnapshot(t *testing.T) {
	snap := &storage.RunningCalibrationSnapshot{
		ThresholdHR:       f64ptr(168),
		ThresholdSpeedMps: f64ptr(3.333333), // → 300 s/km
		HRMaxEstimate:     f64ptr(190),
		RHRBaseline:       f64ptr(48),
	}
	b, err := LoadBaselines(context.Background(), fakeCalibration{snap: snap}, testUID)
	if err != nil {
		t.Fatalf("LoadBaselines: %v", err)
	}
	if b.LTHRBPM == nil || *b.LTHRBPM != 168 {
		t.Errorf("LTHRBPM = %v, want 168", b.LTHRBPM)
	}
	if b.LTPaceSKM == nil || *b.LTPaceSKM < 299.9 || *b.LTPaceSKM > 300.1 {
		t.Errorf("LTPaceSKM = %v, want ~300 (from 3.333 m/s)", b.LTPaceSKM)
	}
	if b.HRMaxBPM == nil || *b.HRMaxBPM != 190 {
		t.Errorf("HRMaxBPM = %v, want 190", b.HRMaxBPM)
	}
	if b.RHRBPM == nil || *b.RHRBPM != 48 {
		t.Errorf("RHRBPM = %v, want 48", b.RHRBPM)
	}
}

func TestLoadBaselines_ObservedMaxHRFallback(t *testing.T) {
	snap := &storage.RunningCalibrationSnapshot{ObservedMaxHR: f64ptr(188)}
	b, err := LoadBaselines(context.Background(), fakeCalibration{snap: snap}, testUID)
	if err != nil {
		t.Fatalf("LoadBaselines: %v", err)
	}
	if b.HRMaxBPM == nil || *b.HRMaxBPM != 188 {
		t.Errorf("HRMaxBPM = %v, want observed-max fallback 188", b.HRMaxBPM)
	}
}

func TestLoadBaselines_NoSnapshotYieldsZeroBaselines(t *testing.T) {
	b, err := LoadBaselines(context.Background(), fakeCalibration{}, testUID)
	if err != nil {
		t.Fatalf("LoadBaselines: %v", err)
	}
	if b.LTPaceSKM != nil || b.LTHRBPM != nil || b.HRMaxBPM != nil || b.RHRBPM != nil {
		t.Errorf("baselines = %+v, want zero when no snapshot", b)
	}
}

func TestLoadBaselines_PropagatesReadError(t *testing.T) {
	wantErr := errors.New("db down")
	_, err := LoadBaselines(context.Background(), fakeCalibration{err: wantErr}, testUID)
	if !errors.Is(err, wantErr) {
		t.Fatalf("err = %v, want wrapped read error", err)
	}
}
