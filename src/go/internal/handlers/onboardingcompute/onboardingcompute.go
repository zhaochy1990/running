// Package onboardingcompute implements the onboarding_compute job handler: one
// merged compute pass over a user's synced watch data that derives the athlete
// baselines (calibration + personal bests), then training load, then ability,
// persisting the results to MySQL (ADR 0015). It is the second step of the
// onboarding pipeline (full_sync -> onboarding_compute).
//
// The compute is ported from Python stride_core and grows in dependency-ordered
// slices; each stage is reconcile-gated on its own. Stages 1 (calibration +
// zones + PBs) and 2 (training load) are wired; ability follows.
package onboardingcompute

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/compute/calibrationsource"
	"github.com/zhaochy1990/stride/internal/compute/pb"
	"github.com/zhaochy1990/stride/internal/compute/trainingload"
	"github.com/zhaochy1990/stride/internal/compute/trainingloadsource"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
)

// JobType is the catalog/handler name. Keep in sync with internal/catalog.
const JobType = "onboarding_compute"

const (
	calibrationLookbackDays  = 180
	trainingLoadLookbackDays = 365
)

// Heartbeat percent bands for the three compute stages (ADR 0015).
const (
	pctCalibration  = 33
	pctTrainingLoad = 66
	pctAbility      = 99
)

// Store is the persistence + read surface the handler needs. *storage.Store
// satisfies it.
type Store interface {
	calibrationsource.Reader
	UpsertRunningCalibrationSnapshot(ctx context.Context, snap *storage.RunningCalibrationSnapshot) (uint64, error)
	ReplaceCalibrationZones(ctx context.Context, userID string, snapshotID uint64, zones []storage.RunningCalibrationZone) error
	AllRunningActivities(ctx context.Context, userID string) ([]storage.Activity, error)
	ReplacePersonalBests(ctx context.Context, userID string, pbs []storage.PersonalBest) error
	ReplaceActivityTrainingLoad(ctx context.Context, userID string, rows []storage.ActivityTrainingLoad) error
	ReplaceDailyTrainingLoad(ctx context.Context, userID string, rows []storage.DailyTrainingLoad) error
	AllDailyHealth(ctx context.Context, userID string) ([]storage.DailyHealth, error)
	AllDailyHRV(ctx context.Context, userID string) ([]storage.DailyHRV, error)
}

// result is the ResultJSON payload summarising what the pass wrote.
type result struct {
	User                string `json:"user"`
	Status              string `json:"status"`
	CalibrationSnapshot uint64 `json:"calibration_snapshot_id"`
	Activities          int    `json:"activities"`
	PersonalBests       int    `json:"personal_bests"`
	DailyLoadRows       int    `json:"daily_load_rows"`
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
		snapID, snap, activities, err := runCalibration(ctx, store, user, asOf)
		if err != nil {
			return "", err // infra fault -> retryable (resumes)
		}
		pbCount, err := runPersonalBests(ctx, store, user)
		if err != nil {
			return "", err
		}
		_ = hb("calibration", pctCalibration)

		// Stage 2 — per-activity dose + daily CTL/ATL/Form.
		dailyRows, err := runTrainingLoad(ctx, store, user, asOf, snap, snapID)
		if err != nil {
			return "", err
		}
		_ = hb("training_load", pctTrainingLoad)

		// Stage 3 — L2/L3/L4 ability + race estimates. (ability slice)
		_ = hb("ability", pctAbility)

		out, _ := json.Marshal(result{
			User:                user,
			Status:              "training_load",
			CalibrationSnapshot: snapID,
			Activities:          activities,
			PersonalBests:       pbCount,
			DailyLoadRows:       dailyRows,
		})
		return string(out), nil
	}
}

func runCalibration(ctx context.Context, store Store, user string, asOf time.Time) (uint64, calibration.Snapshot, int, error) {
	history, health, err := calibrationsource.Load(ctx, store, user, "", asOf, calibrationLookbackDays)
	if err != nil {
		return 0, calibration.Snapshot{}, 0, err
	}
	snap := calibration.EstimateRunningCalibration(history, asOf, health)
	snapID, err := store.UpsertRunningCalibrationSnapshot(ctx, toStorageSnapshot(user, snap))
	if err != nil {
		return 0, calibration.Snapshot{}, 0, err
	}
	zones := calibration.ComputeTrainingZones(snap)
	if err := store.ReplaceCalibrationZones(ctx, user, snapID, toStorageZones(zones)); err != nil {
		return 0, calibration.Snapshot{}, 0, err
	}
	return snapID, snap, len(history), nil
}

// runTrainingLoad computes per-activity load over the last year and the daily
// PMC (CTL/ATL/Form), persisting both. prior_state is nil (a fresh onboarding
// warms the EWMA from zero).
func runTrainingLoad(ctx context.Context, store Store, user string, asOf time.Time, snap calibration.Snapshot, snapID uint64) (int, error) {
	start := asOf.AddDate(0, 0, -trainingLoadLookbackDays)
	acts, err := trainingloadsource.Load(ctx, store, user, "", start, asOf)
	if err != nil {
		return 0, err
	}
	calID := int(snapID)
	cal := trainingload.CalibrationSnapshot{
		RHRBaseline:       snap.RHRBaseline,
		HRMaxEstimate:     snap.HRMaxEstimate,
		ThresholdHR:       snap.ThresholdHR,
		ThresholdSpeedMps: snap.ThresholdSpeedMps,
		CriticalPowerW:    snap.CriticalPowerW,
		ID:                &calID,
		AlgorithmVersion:  trainingload.ModelVersion,
	}
	results := make([]trainingload.ActivityLoadResult, len(acts))
	activityRows := make([]storage.ActivityTrainingLoad, len(acts))
	for i, a := range acts {
		results[i] = trainingload.ComputeActivityLoad(a, cal)
		activityRows[i] = toStorageActivityLoad(user, results[i])
	}
	if err := store.ReplaceActivityTrainingLoad(ctx, user, activityRows); err != nil {
		return 0, err
	}

	health, err := store.AllDailyHealth(ctx, user)
	if err != nil {
		return 0, err
	}
	hrv, err := store.AllDailyHRV(ctx, user)
	if err != nil {
		return 0, err
	}
	daily := trainingload.ComputeDailyLoadSeries(results, toLoadHealth(health), toLoadHRV(hrv), nil, start, asOf, nil, nil)
	dailyRows := make([]storage.DailyTrainingLoad, len(daily))
	for i, d := range daily {
		dailyRows[i] = toStorageDailyLoad(user, d)
	}
	if err := store.ReplaceDailyTrainingLoad(ctx, user, dailyRows); err != nil {
		return 0, err
	}
	return len(dailyRows), nil
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

func toStorageActivityLoad(user string, r trainingload.ActivityLoadResult) storage.ActivityTrainingLoad {
	sport := r.Sport
	session := string(r.SessionClass)
	source := r.TrainingDoseSource
	conf := string(r.LoadConfidence)
	reasons := jsonStrings(r.Reasons)
	return storage.ActivityTrainingLoad{
		UserID:                 user,
		LabelID:                r.LabelID,
		ActivityDate:           r.ActivityDate.Format("2006-01-02"),
		Sport:                  strPtr(sport),
		SessionClass:           strPtr(session),
		AlgorithmVersion:       r.AlgorithmVersion,
		CalibrationID:          r.CalibrationID,
		CardioLoadRaw:          r.CardioLoadRaw,
		CardioTSS:              r.CardioTSS,
		ExternalTSS:            r.ExternalTSS,
		HighIntensityTSS:       r.HighIntensityTSS,
		MechanicalLoad:         r.MechanicalLoad,
		SubjectiveInternalLoad: r.SubjectiveInternalLoad,
		TrainingDose:           r.TrainingDose,
		TrainingDoseSource:     source,
		CardioCoverage:         r.CardioCoverage,
		ExternalCoverage:       r.ExternalCoverage,
		HighIntensityCoverage:  r.HighIntensityCoverage,
		CoverageStatus:         string(r.CoverageStatus),
		LoadConfidence:         strPtr(conf),
		ExcludedFromPMC:        r.ExcludedFromPMC,
		ReasonsJSON:            reasons,
	}
}

func toStorageDailyLoad(user string, d trainingload.DailyLoadResult) storage.DailyTrainingLoad {
	gate := d.ReadinessGate
	return storage.DailyTrainingLoad{
		UserID:               user,
		Date:                 d.Date.Format("2006-01-02"),
		AlgorithmVersion:     d.AlgorithmVersion,
		CalibrationID:        d.CalibrationID,
		TrainingDose:         d.TrainingDose,
		AcuteLoad:            d.AcuteLoad,
		ChronicLoad:          d.ChronicLoad,
		Form:                 d.Form,
		LoadRatio:            d.LoadRatio,
		CoverageStatus:       string(d.CoverageStatus),
		ReadinessGate:        strPtr(gate),
		ReadinessReasonsJSON: jsonStrings(d.ReadinessReasons),
	}
}

func toLoadHealth(rows []storage.DailyHealth) []trainingload.HealthRow {
	out := make([]trainingload.HealthRow, 0, len(rows))
	for _, r := range rows {
		d, ok := parseDay(r.Date)
		if !ok {
			continue
		}
		out = append(out, trainingload.HealthRow{
			Date:        d,
			RHR:         intToFloat(r.RHR),
			SleepTotalS: intToFloat(r.SleepTotalS),
			SleepScore:  intToFloat(r.SleepScore),
		})
	}
	return out
}

func toLoadHRV(rows []storage.DailyHRV) []trainingload.HrvRow {
	out := make([]trainingload.HrvRow, 0, len(rows))
	for _, r := range rows {
		d, ok := parseDay(r.Date)
		if !ok {
			continue
		}
		out = append(out, trainingload.HrvRow{
			Date:         d,
			LastNightAvg: intToFloat(r.LastNightAvg),
			Status:       r.Status,
		})
	}
	return out
}

func jsonStrings(ss []string) *string {
	if len(ss) == 0 {
		return nil
	}
	b, _ := json.Marshal(ss)
	s := string(b)
	return &s
}

func intToFloat(v *int) *float64 {
	if v == nil {
		return nil
	}
	f := float64(*v)
	return &f
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func parseDay(s string) (time.Time, bool) {
	s = strings.ReplaceAll(strings.TrimSpace(s), "-", "")
	if len(s) < 8 {
		return time.Time{}, false
	}
	t, err := time.Parse("20060102", s[:8])
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}

// shanghaiToday returns the Shanghai (UTC+8) civil day as a UTC-midnight time,
// matching the reader's activity-date representation.
func shanghaiToday() time.Time {
	sh := time.Now().UTC().Add(8 * time.Hour)
	return time.Date(sh.Year(), sh.Month(), sh.Day(), 0, 0, 0, 0, time.UTC)
}
