// baselines.go wires the athlete's calibration snapshot into the
// provider-agnostic baselines that relative/zone workout targets resolve
// against (ADR 0037). It lives in the composition root so the adapters never
// read calibration storage themselves.
package registry

import (
	"context"
	"fmt"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
)

// CalibrationBaselineStore is the calibration read surface LoadBaselines needs.
// *storage.Store satisfies it. It reads the same current-version snapshot the
// /stride/zones endpoint uses, so push-time resolution and the app's displayed
// thresholds agree.
type CalibrationBaselineStore interface {
	LatestRunningCalibrationSnapshotForVersion(ctx context.Context, userID string, algorithmVersion int, asOf string) (*storage.RunningCalibrationSnapshot, error)
}

// LoadBaselines maps the athlete's current calibration snapshot into the
// provider-agnostic baselines relative/zone targets resolve against. A missing
// snapshot (or a missing individual estimate) yields zero baselines rather than
// an error: relative targets then fail loudly at resolution with their own
// "baseline is not available" message, while absolute targets push unchanged.
func LoadBaselines(ctx context.Context, store CalibrationBaselineStore, user string) (provider.Baselines, error) {
	snap, err := store.LatestRunningCalibrationSnapshotForVersion(ctx, user, calibration.ModelVersion, "")
	if err != nil {
		return provider.Baselines{}, fmt.Errorf("registry: load calibration baselines for %s: %w", user, err)
	}
	if snap == nil {
		return provider.Baselines{}, nil
	}

	var b provider.Baselines
	b.LTHRBPM = snap.ThresholdHR
	b.HRMaxBPM = snap.HRMaxEstimate
	if b.HRMaxBPM == nil {
		b.HRMaxBPM = snap.ObservedMaxHR
	}
	b.RHRBPM = snap.RHRBaseline
	// ThresholdSpeedMps is m/s; provider baselines carry pace as seconds/km.
	if snap.ThresholdSpeedMps != nil && *snap.ThresholdSpeedMps > 0 {
		pace := 1000 / *snap.ThresholdSpeedMps
		b.LTPaceSKM = &pace
	}
	return b, nil
}
