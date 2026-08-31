package compute

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/compute/pb"
	"github.com/zhaochy1990/stride/internal/compute/trainingload"
	"github.com/zhaochy1990/stride/internal/compute/trainingloadsource"
	"github.com/zhaochy1990/stride/internal/compute/watchmap"
	"github.com/zhaochy1990/stride/internal/compute/zones"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/provider"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// ComputeJobType is the registered job_type for the compute handler.
const ComputeJobType = "compute"

const trainingLoadLookbackDays = 365

// Heartbeat percent bands for the compute stages.
const (
	pctTrainingLoad  = 66
	pctActivityZones = 83
	pctPersonalBests = 99
)

// ComputeStore is the read+write surface the compute job needs. It READS the
// latest calibration snapshot (the calibration job owns writes) and reads the
// activity/health inputs; it writes per-activity load, STRIDE-calibrated zones,
// daily PMC and PBs.
type ComputeStore interface {
	// LatestRunningCalibrationSnapshot supplies the baseline the load model needs.
	LatestRunningCalibrationSnapshot(ctx context.Context, userID string) (*storage.RunningCalibrationSnapshot, error)
	// LatestRunningCalibrationSnapshotForVersion supplies the as-of snapshot for
	// per-activity STRIDE zone boundaries.
	LatestRunningCalibrationSnapshotForVersion(ctx context.Context, userID string, algorithmVersion int, asOf string) (*storage.RunningCalibrationSnapshot, error)
	// trainingloadsource.Reader = ActivitiesInWindow + ActivityTimeseries.
	trainingloadsource.Reader
	AllRunningActivities(ctx context.Context, userID string) ([]storage.Activity, error)
	ReplaceActivityTrainingLoad(ctx context.Context, userID string, rows []storage.ActivityTrainingLoad) error
	ReplaceActivityZones(ctx context.Context, userID, labelID string, rows []storage.ActivityZone) error
	ReplaceDailyTrainingLoad(ctx context.Context, userID string, rows []storage.DailyTrainingLoad) error
	DailyTrainingLoadBefore(ctx context.Context, userID, date string) (*storage.DailyTrainingLoad, error)
	AllDailyHealth(ctx context.Context, userID string) ([]storage.DailyHealth, error)
	AllDailyHRV(ctx context.Context, userID string) ([]storage.DailyHRV, error)
	PersonalBests(ctx context.Context, userID string) ([]storage.PersonalBest, error)
	UpsertPersonalBests(ctx context.Context, userID string, pbs []storage.PersonalBest) error
	ReplacePersonalBests(ctx context.Context, userID string, pbs []storage.PersonalBest) error
}

// computeInput is the compute step's InputJSON: the sync mode (threaded from the
// pipeline run), plus the activity labels and Shanghai health dates produced by
// the upstream watch_sync step.
type computeInput struct {
	Mode        string   `json:"mode"`
	LabelIDs    []string `json:"label_ids"`
	HealthDates []string `json:"health_dates"`
}

type computeResult struct {
	User          string `json:"user"`
	Status        string `json:"status"`
	Mode          string `json:"mode"`
	Activities    int    `json:"activities"`
	PersonalBests int    `json:"personal_bests"`
	DailyLoadRows int    `json:"daily_load_rows"`
}

// NewCompute builds the mode-aware compute handler. It reads the latest
// calibration snapshot as the baseline, then derives per-activity load, daily PMC
// and PBs — full over the window, or incrementally over only this sync's new
// activities. j.UserID is the subject athlete UUID.
func NewCompute(store ComputeStore) job.Handler {
	return func(ctx context.Context, j *job.Job, hb job.Heartbeat) (string, error) {
		user := j.UserID
		if _, err := uuid.Parse(user); err != nil {
			return "", job.NewPermanentError("bad_partition",
				fmt.Errorf("compute: partition key must be a user UUID: %w", err))
		}
		var in computeInput
		if strings.TrimSpace(j.InputJSON) != "" {
			if err := json.Unmarshal([]byte(j.InputJSON), &in); err != nil {
				return "", job.NewPermanentError("bad_payload", fmt.Errorf("compute: parse input: %w", err))
			}
		}

		snapRow, err := store.LatestRunningCalibrationSnapshot(ctx, user)
		if err != nil {
			return "", err
		}
		if snapRow == nil {
			// The load model needs a baseline; onboarding runs calibration before
			// compute, so a missing snapshot is a wiring fault, not retryable.
			return "", job.NewPermanentError("no_calibration",
				fmt.Errorf("compute: no calibration snapshot for %s; run calibration first", user))
		}
		cal := toTrainingLoadCalibration(snapRow)
		asOf := timefmt.ShanghaiToday()

		if in.Mode == string(provider.SyncIncremental) {
			return runIncremental(ctx, store, user, in.LabelIDs, in.HealthDates, cal, asOf, hb)
		}
		return runFull(ctx, store, user, cal, asOf, hb)
	}
}

// runFull recomputes per-activity load over the trailing year, the daily PMC from
// a zero EWMA seed, and the full personal-bests set (replace-all).
func runFull(ctx context.Context, store ComputeStore, user string, cal trainingload.CalibrationSnapshot, asOf time.Time, hb job.Heartbeat) (string, error) {
	start := asOf.AddDate(0, 0, -trainingLoadLookbackDays)
	results, acts, err := loadAndComputeActivity(ctx, store, user, start, asOf, cal)
	if err != nil {
		return "", err
	}
	if err := store.ReplaceActivityTrainingLoad(ctx, user, mapActivityRows(user, results)); err != nil {
		return "", err
	}
	if err := computeActivityZonesFor(ctx, store, user, acts); err != nil {
		return "", err
	}
	_ = hb("activity_zones", pctActivityZones)
	daily, err := computeDaily(ctx, store, user, results, start, asOf, nil)
	if err != nil {
		return "", err
	}
	if err := store.ReplaceDailyTrainingLoad(ctx, user, mapDailyRows(user, daily)); err != nil {
		return "", err
	}
	_ = hb("training_load", pctTrainingLoad)

	pbCount, err := runPersonalBestsFull(ctx, store, user)
	if err != nil {
		return "", err
	}
	_ = hb("personal_bests", pctPersonalBests)

	out, _ := json.Marshal(computeResult{User: user, Status: "full", Mode: "full", Activities: len(results), PersonalBests: pbCount, DailyLoadRows: len(daily)})
	return string(out), nil
}

// runIncremental computes load for this sync's new activity or health dates,
// extends the daily PMC from prior state over [earliest-changed-day, today], and
// upserts only the PBs a new activity improved.
func runIncremental(ctx context.Context, store ComputeStore, user string, labelIDs, healthDates []string, cal trainingload.CalibrationSnapshot, asOf time.Time, hb job.Heartbeat) (string, error) {
	if len(labelIDs) == 0 && len(healthDates) == 0 {
		out, _ := json.Marshal(computeResult{User: user, Status: "noop", Mode: "incremental"})
		return string(out), nil
	}
	// Locate the new activities among the user's running activities and the
	// earliest Shanghai day they touch — the recompute window start.
	all, err := store.AllRunningActivities(ctx, user)
	if err != nil {
		return "", err
	}
	newSet := make(map[string]bool, len(labelIDs))
	for _, id := range labelIDs {
		newSet[id] = true
	}
	var newActs []storage.Activity
	var minDay time.Time
	haveMin := false
	for _, a := range all {
		if !newSet[a.LabelID] {
			continue
		}
		newActs = append(newActs, a)
		d := timefmt.ShanghaiDay(a.Date)
		if !haveMin || d.Before(minDay) {
			minDay, haveMin = d, true
		}
	}
	// A health-only sync has no activity label but still proves that the watch
	// covered that Shanghai day. Include those dates so a zero-dose
	// rest_confirmed row is computed and the PMC reaches today.
	for _, raw := range healthDates {
		d, ok := parseDay(raw)
		if !ok || d.After(asOf) {
			continue
		}
		if !haveMin || d.Before(minDay) {
			minDay, haveMin = d, true
		}
	}
	if !haveMin {
		// The new labels were not running activities and no valid health date
		// reached this step, so there is no daily window to recompute.
		out, _ := json.Marshal(computeResult{User: user, Status: "noop_no_running", Mode: "incremental"})
		return string(out), nil
	}

	// Per-activity load over [minDay, asOf] (new + any recent existing) — upserted
	// by (user, label_id), leaving older rows untouched.
	results, acts, err := loadAndComputeActivity(ctx, store, user, minDay, asOf, cal)
	if err != nil {
		return "", err
	}
	if err := store.ReplaceActivityTrainingLoad(ctx, user, mapActivityRows(user, results)); err != nil {
		return "", err
	}
	if err := computeActivityZonesFor(ctx, store, user, acts); err != nil {
		return "", err
	}
	_ = hb("activity_zones", pctActivityZones)

	// Daily PMC: seed from the last computed day before minDay so the EWMA
	// continues, then recompute only [minDay, asOf] and upsert that tail.
	prior, err := priorLoadState(ctx, store, user, minDay)
	if err != nil {
		return "", err
	}
	daily, err := computeDaily(ctx, store, user, results, minDay, asOf, prior)
	if err != nil {
		return "", err
	}
	if err := store.ReplaceDailyTrainingLoad(ctx, user, mapDailyRows(user, daily)); err != nil {
		return "", err
	}
	_ = hb("training_load", pctTrainingLoad)

	// PBs: compare only the new activities against the existing bests.
	pbCount, err := runPersonalBestsIncremental(ctx, store, user, newActs)
	if err != nil {
		return "", err
	}
	_ = hb("personal_bests", pctPersonalBests)

	out, _ := json.Marshal(computeResult{User: user, Status: "incremental", Mode: "incremental", Activities: len(results), PersonalBests: pbCount, DailyLoadRows: len(daily)})
	return string(out), nil
}

// loadAndComputeActivity loads every activity in [start, end] (with timeseries),
// computes its training load, and returns both the results and the loaded inputs
// (the caller reuses the samples for the STRIDE zone step, so the heavy
// timeseries fetch is not duplicated).
func loadAndComputeActivity(ctx context.Context, store ComputeStore, user string, start, end time.Time, cal trainingload.CalibrationSnapshot) ([]trainingload.ActivityLoadResult, []trainingload.ActivityInput, error) {
	acts, err := trainingloadsource.Load(ctx, store, user, "", start, end)
	if err != nil {
		return nil, nil, err
	}
	results := make([]trainingload.ActivityLoadResult, len(acts))
	for i, a := range acts {
		results[i] = trainingload.ComputeActivityLoad(a, cal)
	}
	return results, acts, nil
}

// computeActivityZonesFor writes STRIDE-calibrated zone rows (ADR 0019) for each
// running activity in acts, mirroring the Python post-sync ActivityZonesHandler:
// zone boundaries come from the calibration snapshot as-of the activity's
// Shanghai day, classified over the activity's timeseries samples. Non-running
// activities, activities with no samples, and activities with no as-of snapshot
// are skipped without error.
func computeActivityZonesFor(ctx context.Context, store ComputeStore, user string, acts []trainingload.ActivityInput) error {
	for i := range acts {
		a := &acts[i]
		if !watchmap.IsRunningSport(a.Sport) || len(a.Samples) == 0 {
			continue
		}
		snap, err := store.LatestRunningCalibrationSnapshotForVersion(ctx, user, calibration.ModelVersion, timefmt.ShanghaiDayStr(a.ActivityDate))
		if err != nil {
			return err
		}
		if snap == nil {
			continue
		}
		zs := calibration.ComputeTrainingZones(toCalibrationSnapshot(snap))
		if len(zs.PaceZones) == 0 && len(zs.HeartRateZones) == 0 {
			continue
		}
		rows := toStorageActivityZones(user, zones.ComputeActivityTimeInZone(toZoneSamples(a.Samples), zs.PaceZones, zs.HeartRateZones))
		if err := store.ReplaceActivityZones(ctx, user, a.LabelID, rows); err != nil {
			return err
		}
	}
	return nil
}

// toCalibrationSnapshot maps a persisted snapshot row onto the pure-compute
// calibration.Snapshot the zone math needs.
func toCalibrationSnapshot(s *storage.RunningCalibrationSnapshot) calibration.Snapshot {
	return calibration.Snapshot{
		ThresholdHR:              s.ThresholdHR,
		ThresholdSpeedMps:        s.ThresholdSpeedMps,
		ThresholdHRConfidence:    calibration.Confidence(s.ThresholdHRConfidence),
		ThresholdSpeedConfidence: calibration.Confidence(s.ThresholdSpeedConfidence),
		RHRBaseline:              s.RHRBaseline,
		ObservedMaxHR:            s.ObservedMaxHR,
		HRMaxEstimate:            s.HRMaxEstimate,
		HRMaxConfidence:          calibration.Confidence(s.HRMaxConfidence),
		HighHRReference:          s.HighHRReference,
		CriticalPowerW:           s.CriticalPowerW,
		CriticalSpeedMps:         s.CriticalSpeedMps,
		DPrimeM:                  s.DPrimeM,
		RiegelK:                  s.RiegelK,
		EnduranceIndex:           s.EnduranceIndex,
		SpeedIndex:               s.SpeedIndex,
		SpeedDurationConfidence:  calibration.Confidence(s.SpeedDurationConfidence),
		AlgorithmVersion:         s.AlgorithmVersion,
	}
}

// toZoneSamples maps trainingload samples (which carry watchmap-normalized
// elapsed / speed / HR) onto the zone-classifier sample shape, computing dwell
// from the elapsed seconds first.
func toZoneSamples(samples []trainingload.Sample) []zones.Sample {
	out := make([]zones.Sample, len(samples))
	if len(samples) == 0 {
		return out
	}
	elapsed := make([]*float64, len(samples))
	for i, s := range samples {
		elapsed[i] = s.ElapsedS
	}
	dwell := zones.DwellSeconds(elapsed)
	for i, s := range samples {
		out[i] = zones.Sample{DwellS: dwell[i], SpeedMps: s.SpeedMps, HRBpm: s.HeartRateBpm}
	}
	return out
}

// toStorageActivityZones stamps the tenant key on the compute rows (LabelID is
// stamped by ReplaceActivityZones).
func toStorageActivityZones(user string, rows []zones.Zone) []storage.ActivityZone {
	out := make([]storage.ActivityZone, len(rows))
	for i, z := range rows {
		out[i] = storage.ActivityZone{
			UserID:    user,
			ZoneType:  z.ZoneType,
			ZoneIndex: z.ZoneIndex,
			RangeMin:  z.RangeMin,
			RangeMax:  z.RangeMax,
			RangeUnit: z.RangeUnit,
			DurationS: z.DurationS,
			Percent:   z.Percent,
		}
	}
	return out
}

// computeDaily builds the daily PMC series for [start, end] from the given
// per-activity results and the user's health/HRV rows, seeded by priorState.
func computeDaily(ctx context.Context, store ComputeStore, user string, results []trainingload.ActivityLoadResult, start, end time.Time, prior *trainingload.PriorLoadState) ([]trainingload.DailyLoadResult, error) {
	health, err := store.AllDailyHealth(ctx, user)
	if err != nil {
		return nil, err
	}
	hrv, err := store.AllDailyHRV(ctx, user)
	if err != nil {
		return nil, err
	}
	return trainingload.ComputeDailyLoadSeries(results, toLoadHealth(health), toLoadHRV(hrv), nil, start, end, prior, nil), nil
}

// priorLoadState reads the last daily row strictly before minDay as the EWMA seed
// for an incremental recompute (nil when there is none, e.g. before onboarding).
func priorLoadState(ctx context.Context, store ComputeStore, user string, minDay time.Time) (*trainingload.PriorLoadState, error) {
	row, err := store.DailyTrainingLoadBefore(ctx, user, minDay.Format("2006-01-02"))
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, nil
	}
	return &trainingload.PriorLoadState{AcuteLoad: row.AcuteLoad, ChronicLoad: row.ChronicLoad}, nil
}

// runPersonalBestsFull scans all running activities and replaces the PB set.
func runPersonalBestsFull(ctx context.Context, store ComputeStore, user string) (int, error) {
	acts, err := store.AllRunningActivities(ctx, user)
	if err != nil {
		return 0, err
	}
	entries, err := pb.DetectPersonalBests(toPBActivities(acts), makeFetch(ctx, store, user))
	if err != nil {
		return 0, err
	}
	rows := make([]storage.PersonalBest, 0, len(entries))
	for _, e := range entries {
		rows = append(rows, toStoragePB(e))
	}
	if err := store.ReplacePersonalBests(ctx, user, rows); err != nil {
		return 0, err
	}
	return len(rows), nil
}

// runPersonalBestsIncremental detects PBs among only the new activities and
// upserts the distances that beat (or newly set) an existing best.
func runPersonalBestsIncremental(ctx context.Context, store ComputeStore, user string, newActs []storage.Activity) (int, error) {
	if len(newActs) == 0 {
		return 0, nil
	}
	existing, err := store.PersonalBests(ctx, user)
	if err != nil {
		return 0, err
	}
	bestByDistance := make(map[string]float64, len(existing))
	for _, e := range existing {
		bestByDistance[e.Distance] = e.PBTimeSec
	}
	entries, err := pb.DetectPersonalBests(toPBActivities(newActs), makeFetch(ctx, store, user))
	if err != nil {
		return 0, err
	}
	var changed []storage.PersonalBest
	for _, e := range entries {
		prev, ok := bestByDistance[e.Distance]
		if !ok || e.PBTimeSec < prev {
			changed = append(changed, toStoragePB(e))
		}
	}
	if err := store.UpsertPersonalBests(ctx, user, changed); err != nil {
		return 0, err
	}
	return len(changed), nil
}

func makeFetch(ctx context.Context, store ComputeStore, user string) func(string) ([]pb.TSPoint, error) {
	return func(labelID string) ([]pb.TSPoint, error) {
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
}

func toPBActivities(acts []storage.Activity) []pb.Activity {
	out := make([]pb.Activity, len(acts))
	for i, a := range acts {
		out[i] = pb.Activity{
			LabelID:   a.LabelID,
			Name:      a.Name,
			Date:      a.Date,
			DistanceM: a.DistanceM,
			DurationS: a.DurationS,
			Pauses:    a.Pauses,
			SportType: a.SportType,
		}
	}
	return out
}

func toStoragePB(e pb.Entry) storage.PersonalBest {
	achievedAt := e.AchievedAt
	source := e.Source
	var achievedPtr, sourcePtr *string
	if achievedAt != "" {
		achievedPtr = &achievedAt
	}
	if source != "" {
		sourcePtr = &source
	}
	return storage.PersonalBest{
		Distance:   e.Distance,
		PBTimeSec:  e.PBTimeSec,
		AchievedAt: achievedPtr,
		Source:     sourcePtr,
		EntryJSON:  pb.EntryJSON(e),
	}
}

func toTrainingLoadCalibration(s *storage.RunningCalibrationSnapshot) trainingload.CalibrationSnapshot {
	calID := int(s.ID)
	return trainingload.CalibrationSnapshot{
		RHRBaseline:       s.RHRBaseline,
		HRMaxEstimate:     s.HRMaxEstimate,
		ThresholdHR:       s.ThresholdHR,
		ThresholdSpeedMps: s.ThresholdSpeedMps,
		CriticalPowerW:    s.CriticalPowerW,
		ID:                &calID,
		AlgorithmVersion:  trainingload.ModelVersion,
	}
}

func mapActivityRows(user string, results []trainingload.ActivityLoadResult) []storage.ActivityTrainingLoad {
	rows := make([]storage.ActivityTrainingLoad, len(results))
	for i, r := range results {
		rows[i] = toStorageActivityLoad(user, r)
	}
	return rows
}

func mapDailyRows(user string, daily []trainingload.DailyLoadResult) []storage.DailyTrainingLoad {
	rows := make([]storage.DailyTrainingLoad, len(daily))
	for i, d := range daily {
		rows[i] = toStorageDailyLoad(user, d)
	}
	return rows
}

func toStorageActivityLoad(user string, r trainingload.ActivityLoadResult) storage.ActivityTrainingLoad {
	return storage.ActivityTrainingLoad{
		UserID:                 user,
		LabelID:                r.LabelID,
		ActivityDate:           r.ActivityDate.Format("2006-01-02"),
		Sport:                  strPtr(r.Sport),
		SessionClass:           strPtr(string(r.SessionClass)),
		AlgorithmVersion:       r.AlgorithmVersion,
		CalibrationID:          r.CalibrationID,
		CardioLoadRaw:          r.CardioLoadRaw,
		CardioTSS:              r.CardioTSS,
		ExternalTSS:            r.ExternalTSS,
		HighIntensityTSS:       r.HighIntensityTSS,
		MechanicalLoad:         r.MechanicalLoad,
		SubjectiveInternalLoad: r.SubjectiveInternalLoad,
		TrainingDose:           r.TrainingDose,
		TrainingDoseSource:     r.TrainingDoseSource,
		CardioCoverage:         r.CardioCoverage,
		ExternalCoverage:       r.ExternalCoverage,
		HighIntensityCoverage:  r.HighIntensityCoverage,
		CoverageStatus:         string(r.CoverageStatus),
		LoadConfidence:         strPtr(string(r.LoadConfidence)),
		ExcludedFromPMC:        r.ExcludedFromPMC,
		ReasonsJSON:            jsonStrings(r.Reasons),
	}
}

func toStorageDailyLoad(user string, d trainingload.DailyLoadResult) storage.DailyTrainingLoad {
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
		ReadinessGate:        strPtr(d.ReadinessGate),
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
