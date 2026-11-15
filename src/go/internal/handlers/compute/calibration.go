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
	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// CalibrationJobType is the registered job_type for the calibration handler.
const CalibrationJobType = "calibration"

const calibrationLookbackDays = 180

// CalibrationStore is the read+write surface the calibration job needs: the
// calibration inputs (activities-in-window + timeseries/laps + daily RHR), the
// snapshot/zone writes, and the same-day snapshot read that gates empty runs.
type CalibrationStore interface {
	calibrationsource.Reader
	storage.CalibrationReader
	CalibrationPolicy(context.Context) (storage.RunningCalibrationPolicy, error)
	PublishRunningCalibration(context.Context, *storage.RunningCalibrationSnapshot, []storage.RunningCalibrationPaceZone, []storage.RunningCalibrationHRZone) (uint64, error)
	LatestRunningCalibrationSnapshotForVersion(context.Context, string, int, string) (*storage.RunningCalibrationSnapshot, error)
}

type calibrationInput struct {
	SelectionMode string   `json:"selection_mode"`
	Mode          string   `json:"mode"`
	LabelIDs      []string `json:"label_ids"`
	HealthDates   []string `json:"health_dates"`
}

type calibrationResult struct {
	User                string `json:"user"`
	Status              string `json:"status"`
	CalibrationSnapshot uint64 `json:"calibration_snapshot_id"`
	Activities          int    `json:"activities"`
	AlgorithmVersion    int    `json:"algorithm_version"`
	CandidateOnly       bool   `json:"candidate_only,omitempty"`
	// Echoes the sync's label_ids/health_dates so downstream steps
	// (compute → … → ability) keep seeing which batches this sync produced.
	// Since devops#921 the calibration step also sits in data_sync, where the
	// echo is load-bearing: incremental compute turns health_dates into
	// rest_confirmed rows and extends the PMC, and would noop without them.
	LabelIDs    []string `json:"label_ids,omitempty"`
	HealthDates []string `json:"health_dates,omitempty"`
}

// NewCalibration builds the calibration job handler. It estimates the athlete
// baseline over the trailing 180-day window and upserts the snapshot + zones.
// j.UserID is the subject athlete UUID.
func NewCalibration(store CalibrationStore) job.Handler {
	return NewCalibrationWithOptions(store, CalibrationOptions{})
}

// Candidate persistence requires an explicitly isolated caller. Production wiring
// always uses NewCalibration; this option does not change the active selector.
type CalibrationOptions struct{ AllowCandidatePersistence bool }

func NewCalibrationWithOptions(store CalibrationStore, options CalibrationOptions) job.Handler {
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		user := j.UserID
		if _, err := uuid.Parse(user); err != nil {
			return "", job.NewPermanentError("bad_partition",
				fmt.Errorf("calibration: partition key must be a user UUID: %w", err))
		}
		var in calibrationInput
		if j.InputJSON != "" {
			if err := json.Unmarshal([]byte(j.InputJSON), &in); err != nil {
				return "", job.NewPermanentError("bad_payload", fmt.Errorf("calibration: parse input: %w", err))
			}
		}
		policy, err := store.CalibrationPolicy(ctx)
		if err != nil {
			return "", err
		}
		version := policy.ActiveVersion
		if in.SelectionMode != "" && in.SelectionMode != "active" && in.SelectionMode != "candidate" {
			return "", job.NewPermanentError("bad_payload", fmt.Errorf("invalid calibration selection"))
		}
		candidateOnly := in.SelectionMode == "candidate"
		if candidateOnly {
			if !options.AllowCandidatePersistence {
				return "", job.NewPermanentError("candidate_persistence_disabled", fmt.Errorf("candidate mode requires isolated explicit opt-in"))
			}
			if policy.CandidateVersion == nil {
				return "", job.NewPermanentError("candidate_not_configured", fmt.Errorf("candidate not configured"))
			}
			version = *policy.CandidateVersion
			if version == policy.ActiveVersion || version == policy.FallbackVersion {
				return "", job.NewPermanentError("candidate_aliases_active_snapshot", fmt.Errorf("candidate persistence requires a distinct version from active and fallback"))
			}
		}
		if version != calibration.ModelVersion && !options.AllowCandidatePersistence {
			return "", job.NewPermanentError("candidate_persistence_disabled", fmt.Errorf("candidate persistence requires isolated explicit opt-in"))
		}
		asOf := timefmt.ShanghaiToday()
		// Empty-run gate (devops#931): an incremental sync that produced no new
		// activity pays the 180-day full-window recompute at most once per
		// Shanghai day. Keyed on label_ids only — provider health pulls re-write
		// the whole daily_health window on every sync (COROS re-delivers ~92
		// days each pull), so health_dates carries no new-data signal. The RHR
		// baseline is a smoothed window metric; same-day re-pulls add nothing
		// the once-per-day recompute misses. Full mode (explicit recompute
		// semantics) and standalone runs without a mode (the force-recalibrate
		// path) always recompute.
		day := asOf.Format("2006-01-02")
		if in.Mode == string(provider.SyncIncremental) && len(in.LabelIDs) == 0 {
			snap, err := store.LatestRunningCalibrationSnapshotForVersion(ctx, user, version, day)
			if err != nil {
				return "", err // infra fault -> retryable
			}
			if snap != nil && snap.AsOfDate == day {
				_ = hb("calibration", 100)
				out, _ := json.Marshal(calibrationResult{User: user, Status: "skipped_no_new_data", CalibrationSnapshot: snap.ID, AlgorithmVersion: version, CandidateOnly: candidateOnly, LabelIDs: in.LabelIDs, HealthDates: in.HealthDates})
				return string(out), nil
			}
		}
		snapID, activities, err := runCalibrationVersion(ctx, store, user, asOf, version)
		if err != nil {
			return "", err // infra fault -> retryable
		}
		_ = hb("calibration", 100)
		out, _ := json.Marshal(calibrationResult{User: user, Status: "ok", CalibrationSnapshot: snapID, Activities: activities, AlgorithmVersion: version, CandidateOnly: candidateOnly, LabelIDs: in.LabelIDs, HealthDates: in.HealthDates})
		return string(out), nil
	}
}

func runCalibration(ctx context.Context, store CalibrationStore, user string, asOf time.Time) (uint64, int, error) {
	return runCalibrationVersion(ctx, store, user, asOf, calibration.ModelVersion)
}
func runCalibrationVersion(ctx context.Context, store CalibrationStore, user string, asOf time.Time, version int) (uint64, int, error) {
	history, health, err := calibrationsource.Load(ctx, store, user, "", asOf, calibrationLookbackDays)
	if err != nil {
		return 0, 0, err
	}
	strategy := calibration.StrategyV3
	if version == calibration.CandidateVersion {
		strategy = calibration.StrategyCandidate
	}
	result, err := calibration.EstimateOffline(strategy, history, asOf, health)
	if err != nil {
		return 0, 0, err
	}
	snap := result.Snapshot
	row := toStorageSnapshot(user, snap)
	source := calibration.SummarizeSource(result)
	raw, err := json.Marshal(source)
	if err != nil {
		return 0, 0, err
	}
	text := string(raw)
	row.SourceJSON = &text
	paceZones, hrZones := toStorageZones(calibration.ComputeTrainingZones(snap))
	snapID, err := store.PublishRunningCalibration(ctx, row, paceZones, hrZones)
	if err != nil {
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
