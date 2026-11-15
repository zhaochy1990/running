package compute

import (
	"context"
	"errors"
	"fmt"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
)

// ActiveCalibrationOptions is an explicit constructor capability for a future
// authorised active-v4 recomputation. Production constructors leave it off.
// It never authorises candidate/shadow payloads to use active derived tables.
type ActiveCalibrationOptions struct{ AllowActiveCandidate bool }

var errActiveCalibrationIncomplete = errors.New("active candidate baseline incomplete")

type activeCalibrationWriteKey struct{}

func withActiveCalibrationOptions(ctx context.Context, options ActiveCalibrationOptions) context.Context {
	return context.WithValue(ctx, activeCalibrationWriteKey{}, options.AllowActiveCandidate)
}
func checkActiveCalibrationWrite(ctx context.Context, b storage.CalibrationBundle) error {
	allowed, _ := ctx.Value(activeCalibrationWriteKey{}).(bool)
	if b.Snapshot != nil && b.Snapshot.AlgorithmVersion == calibration.CandidateVersion && !allowed {
		return job.NewPermanentError("candidate_derived_write_forbidden", fmt.Errorf("active v4 requires explicit constructor opt-in; shadow must use read-only preview"))
	}
	if b.Snapshot != nil && b.Snapshot.AlgorithmVersion == calibration.CandidateVersion {
		s := b.Snapshot
		// Active derived rows have no per-channel candidate namespace. Preserve
		// existing values until both independent centers and baseline inputs exist.
		if s.ThresholdSpeedMps == nil || s.ThresholdHR == nil || s.HRMaxEstimate == nil || s.RHRBaseline == nil {
			return errActiveCalibrationIncomplete
		}
	}
	return nil
}
