// Package onboardingcompute implements the onboarding_compute job handler: one
// merged compute pass over a user's synced watch data that derives the athlete
// baselines (calibration + personal bests), then training load, then ability,
// persisting the results to MySQL (ADR 0013). It is the second step of the
// onboarding pipeline (full_sync -> onboarding_compute).
//
// The compute is ported from Python stride_core and grows in dependency-ordered
// slices; each stage is reconcile-gated on its own. Stage 1 (calibration + zones)
// is wired; training load and ability follow.
package onboardingcompute

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/compute/calibrationsource"
	"github.com/zhaochy1990/stride/internal/compute/pb"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
)

// JobType is the catalog/handler name. Keep in sync with internal/catalog.
const JobType = "onboarding_compute"

// calibrationLookbackDays matches the Python onboarding calibration window.
const calibrationLookbackDays = 180

// Heartbeat percent bands for the three compute stages (ADR 0013). The terminal
// 100 is set by the dispatcher's finishDone on success.
const (
	pctCalibration  = 33
	pctTrainingLoad = 66
	pctAbility      = 99
)

// Store is the persistence + read surface the handler needs. *storage.Store
// satisfies it. It grows as later stages land.
type Store interface {
	calibrationsource.Reader
	UpsertRunningCalibrationSnapshot(ctx context.Context, snap *storage.RunningCalibrationSnapshot) (uint64, error)
	ReplaceCalibrationZones(ctx context.Context, userID string, snapshotID uint64, zones []storage.RunningCalibrationZone) error
	AllRunningActivities(ctx context.Context, userID string) ([]storage.Activity, error)
	ReplacePersonalBests(ctx context.Context, userID string, pbs []storage.PersonalBest) error
}

// result is the ResultJSON payload summarising what the pass wrote.
type result struct {
	User                string `json:"user"`
	Status              string `json:"status"`
	CalibrationSnapshot uint64 `json:"calibration_snapshot_id"`
	Activities          int    `json:"activities"`
	PersonalBests       int    `json:"personal_bests"`
}

// New builds the onboarding_compute handler. j.PartitionKey is the user UUID.
func New(store Store) job.Handler {
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		user := j.PartitionKey
		if _, err := uuid.Parse(user); err != nil {
			return "", job.NewPermanentError("bad_partition",
				fmt.Errorf("onboarding_compute: partition key must be a user UUID: %w", err))
		}
		asOf := shanghaiToday()

		// Stage 1 — calibration baselines + zones + personal bests.
		snapID, activities, err := runCalibration(ctx, store, user, asOf)
		if err != nil {
			return "", err // infra fault -> retryable (resumes)
		}
		pbCount, err := runPersonalBests(ctx, store, user)
		if err != nil {
			return "", err
		}
		_ = hb("calibration", pctCalibration)

		// Stage 2 — per-activity dose + daily CTL/ATL/Form. (training-load slice)
		_ = hb("training_load", pctTrainingLoad)

		// Stage 3 — L2/L3/L4 ability + race estimates. (ability slice)
		_ = hb("ability", pctAbility)

		out, _ := json.Marshal(result{
			User:                user,
			Status:              "calibration",
			CalibrationSnapshot: snapID,
			Activities:          activities,
			PersonalBests:       pbCount,
		})
		return string(out), nil
	}
}

// runCalibration loads the athlete's running history + RHR, computes the
// calibration snapshot + zones, and persists both. Returns (snapshot id,
// running-activity count).
func runCalibration(ctx context.Context, store Store, user string, asOf time.Time) (uint64, int, error) {
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
	if err := store.ReplaceCalibrationZones(ctx, user, snapID, toStorageZones(zones)); err != nil {
		return 0, 0, err
	}
	return snapID, len(history), nil
}

// runPersonalBests scans all running activities chronologically, detects
// achieved-time PBs (segment-first, activity fallback), and persists them.
func runPersonalBests(ctx context.Context, store Store, user string) (int, error) {
	acts, err := store.AllRunningActivities(ctx, user)
	if err != nil {
		return 0, err
	}
	pbActs := make([]pb.Activity, len(acts))
	for i, a := range acts {
		pbActs[i] = pb.Activity{
			LabelID:   a.LabelID,
			Name:      a.Name,
			Date:      a.Date,
			DistanceM: a.DistanceM,
			DurationS: a.DurationS,
			Pauses:    a.Pauses,
			SportType: a.SportType,
		}
	}
	fetch := func(labelID string) ([]pb.TSPoint, error) {
		ts, err := store.ActivityTimeseries(ctx, user, labelID)
		if err != nil {
			return nil, err
		}
		out := make([]pb.TSPoint, len(ts))
		for i, p := range ts {
			out[i] = pb.TSPoint{Timestamp: p.Timestamp, Distance: p.Distance}
		}
		return out, nil
	}
	entries, err := pb.DetectPersonalBests(pbActs, fetch)
	if err != nil {
		return 0, err
	}
	rows := make([]storage.PersonalBest, 0, len(entries))
	for _, e := range entries {
		achievedAt := e.AchievedAt
		source := e.Source
		var achievedPtr, sourcePtr *string
		if achievedAt != "" {
			achievedPtr = &achievedAt
		}
		if source != "" {
			sourcePtr = &source
		}
		rows = append(rows, storage.PersonalBest{
			Distance:   e.Distance,
			PBTimeSec:  e.PBTimeSec,
			AchievedAt: achievedPtr,
			Source:     sourcePtr,
			EntryJSON:  pb.EntryJSON(e),
		})
	}
	if err := store.ReplacePersonalBests(ctx, user, rows); err != nil {
		return 0, err
	}
	return len(rows), nil
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

func toStorageZones(zs calibration.ZoneSet) []storage.RunningCalibrationZone {
	out := make([]storage.RunningCalibrationZone, 0, len(zs.PaceZones)+len(zs.HeartRateZones))
	for _, z := range zs.PaceZones {
		out = append(out, storage.RunningCalibrationZone{
			ZoneKind:    "pace",
			Name:        z.Name,
			MinValue:    z.MinPaceSPerKm,
			MaxValue:    z.MaxPaceSPerKm,
			MinSpeedMps: z.MinSpeedMps,
			MaxSpeedMps: z.MaxSpeedMps,
			Confidence:  string(z.Confidence),
		})
	}
	for _, z := range zs.HeartRateZones {
		out = append(out, storage.RunningCalibrationZone{
			ZoneKind:   "heart_rate",
			Name:       z.Name,
			MinValue:   z.MinBpm,
			MaxValue:   z.MaxBpm,
			Confidence: string(z.Confidence),
		})
	}
	return out
}

// shanghaiToday returns the Shanghai (UTC+8) civil day as a UTC-midnight time,
// matching the reader's activity-date representation.
func shanghaiToday() time.Time {
	sh := time.Now().UTC().Add(8 * time.Hour)
	return time.Date(sh.Year(), sh.Month(), sh.Day(), 0, 0, 0, 0, time.UTC)
}
