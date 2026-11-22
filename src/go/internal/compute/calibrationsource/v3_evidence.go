package calibrationsource

import (
	"context"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/compute/watchmap"
	"github.com/zhaochy1990/stride/internal/storage"
)

type V3WindowStore interface {
	VisitV3CalibrationWindow(context.Context, string, time.Time, time.Time, int, storage.V3EvidenceVisitor) ([]storage.DailyHealth, error)
}

func EstimateIncrementalV3(ctx context.Context, store V3WindowStore, user string, day time.Time, lookback int) (calibration.OfflineResult, int, error) {
	var evidence []calibration.V3ActivityEvidence
	health, err := store.VisitV3CalibrationWindow(ctx, user, day.AddDate(0, 0, -lookback), day, calibration.V3EvidenceVersion, storage.V3EvidenceVisitor{
		Running: func(a storage.Activity) bool {
			return watchmap.IsRunningSport(watchmap.SportFromRow(a.Sport, a.SportType))
		},
		Reuse: func(raw []byte) bool {
			e, err := calibration.DecodeV3Evidence(raw)
			if err != nil {
				return false
			}
			evidence = append(evidence, e)
			return true
		},
		Build: func(a storage.Activity, ts []storage.TimeseriesPoint, laps []storage.Lap) ([]byte, error) {
			// The sync calibration reads across providers, using the same distance
			// normalization as Load(..., provider="").
			e := calibration.ExtractV3Evidence(mapActivity(a, watchmap.SportFromRow(a.Sport, a.SportType), "", ts, laps))
			evidence = append(evidence, e)
			return e.Marshal()
		},
	})
	if err != nil {
		return calibration.OfflineResult{}, 0, err
	}
	return calibration.EstimateV3Evidence(evidence, day, mapHealth(health)), len(evidence), nil
}
