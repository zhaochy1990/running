package compute

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/compute/calibrationsource"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// CalibrationJobType is the registered job_type for the calibration handler.
const CalibrationJobType = "calibration"

const calibrationLookbackDays = 180

// CalibrationStore is the read+write surface the calibration job needs: the
// calibration inputs (activities-in-window + timeseries/laps + daily RHR) and
// the snapshot/zone writes.
type CalibrationStore interface {
	calibrationsource.Reader
	UpsertRunningCalibrationSnapshot(ctx context.Context, snap *storage.RunningCalibrationSnapshot) (uint64, error)
	ReplaceCalibrationZones(ctx context.Context, userID string, snapshotID uint64, paceZones []storage.RunningCalibrationPaceZone, hrZones []storage.RunningCalibrationHRZone) error
}

type calibrationResult struct {
	User                string `json:"user"`
	Status              string `json:"status"`
	CalibrationSnapshot uint64 `json:"calibration_snapshot_id"`
	Activities          int    `json:"activities"`
}

// NewCalibration builds the calibration job handler. It estimates the athlete
// baseline over the trailing 180-day window and upserts the snapshot + zones.
// j.UserID is the subject athlete UUID.
func NewCalibration(store CalibrationStore) job.Handler {
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		user := j.UserID
		if _, err := uuid.Parse(user); err != nil {
			return "", job.NewPermanentError("bad_partition",
				fmt.Errorf("calibration: partition key must be a user UUID: %w", err))
		}
		asOf := timefmt.ShanghaiToday()
		snapID, activities, err := runCalibration(ctx, store, user, asOf)
		if err != nil {
			return "", err // infra fault -> retryable
		}
		_ = hb("calibration", 100)
		out, _ := json.Marshal(calibrationResult{User: user, Status: "ok", CalibrationSnapshot: snapID, Activities: activities})
		return string(out), nil
	}
}

func runCalibration(ctx context.Context, store CalibrationStore, user string, asOf time.Time) (uint64, int, error) {
	history, health, err := calibrationsource.Load(ctx, store, user, "", asOf, calibrationLookbackDays)
	if err != nil {
		return 0, 0, err
	}
	snap := calibration.EstimateRunningCalibration(history, asOf, health)
	snapID, err := store.UpsertRunningCalibrationSnapshot(ctx, toStorageSnapshot(user, snap))
	if err != nil {
		return 0, 0, err
	}
	zones := calibration.ComputeTrainingZones(snap)
	paceZones, hrZones := toStorageZones(zones)
	if err := store.ReplaceCalibrationZones(ctx, user, snapID, paceZones, hrZones); err != nil {
		return 0, 0, err
	}
	return snapID, len(history), nil
}

func toStorageSnapshot(user string, s calibration.Snapshot) *storage.RunningCalibrationSnapshot {
	return &storage.RunningCalibrationSnapshot{
		UserID:                   user,
		AsOfDate:                 s.AsOfDate.Format("2006-01-02"),
		AlgorithmVersion:         s.AlgorithmVersion,
		ThresholdHR:              s.ThresholdHR,
		ThresholdSpeedMps:        s.ThresholdSpeedMps,
		ThresholdHRConfidence:    string(s.ThresholdHRConfidence),
		ThresholdSpeedConfidence: string(s.ThresholdSpeedConfidence),
		RHRBaseline:              s.RHRBaseline,
		ObservedMaxHR:            s.ObservedMaxHR,
		HRMaxEstimate:            s.HRMaxEstimate,
		HRMaxConfidence:          string(s.HRMaxConfidence),
		HighHRReference:          s.HighHRReference,
		CriticalPowerW:           s.CriticalPowerW,
		CriticalSpeedMps:         s.CriticalSpeedMps,
		DPrimeM:                  s.DPrimeM,
		RiegelK:                  s.RiegelK,
		EnduranceIndex:           s.EnduranceIndex,
		SpeedIndex:               s.SpeedIndex,
		SpeedDurationConfidence:  string(s.SpeedDurationConfidence),
	}
}

// toStorageZones flattens the computed zone set into the two split storage
// tables: pace zones keep their pace/speed columns, HR zones keep their bpm
// columns.
func toStorageZones(zs calibration.ZoneSet) ([]storage.RunningCalibrationPaceZone, []storage.RunningCalibrationHRZone) {
	pace := make([]storage.RunningCalibrationPaceZone, 0, len(zs.PaceZones))
	for _, z := range zs.PaceZones {
		pace = append(pace, storage.RunningCalibrationPaceZone{
			Name:          z.Name,
			MinPaceSPerKm: z.MinPaceSPerKm,
			MaxPaceSPerKm: z.MaxPaceSPerKm,
			MinSpeedMps:   z.MinSpeedMps,
			MaxSpeedMps:   z.MaxSpeedMps,
			Confidence:    string(z.Confidence),
		})
	}
	hr := make([]storage.RunningCalibrationHRZone, 0, len(zs.HeartRateZones))
	for _, z := range zs.HeartRateZones {
		hr = append(hr, storage.RunningCalibrationHRZone{
			Name:       z.Name,
			MinBpm:     z.MinBpm,
			MaxBpm:     z.MaxBpm,
			Confidence: string(z.Confidence),
		})
	}
	return pace, hr
}
