package compute

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/calibration"
	"github.com/zhaochy1990/stride/internal/compute/trainingload"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

const testUser = "f10bc353-01ab-4db1-af9f-d9305ea9a532"

// fakeStore satisfies both CalibrationStore and ComputeStore with in-memory data
// and records which write paths ran.
type fakeStore struct {
	policy    *storage.RunningCalibrationPolicy
	loadRows  []storage.ActivityTrainingLoad
	snapByDay map[string]*storage.RunningCalibrationSnapshot
	acts      []storage.Activity
	health    []storage.DailyHealth
	ts        []storage.TimeseriesPoint           // returned by ActivityTimeseries
	snap      *storage.RunningCalibrationSnapshot // returned by LatestRunningCalibrationSnapshot
	prior     *storage.DailyTrainingLoad          // returned by DailyTrainingLoadBefore
	pbs       []storage.PersonalBest              // existing PBs

	// recorded calls
	snapUpserted         bool
	zonesReplaced        bool
	activityUpserts      int
	dailyUpserts         int
	dailyRows            []storage.DailyTrainingLoad
	pbReplaced           bool
	pbUpserted           bool
	priorReadForDate     string
	priorReads           int
	activityZonesWritten []storage.ActivityZone
}

// --- calibration inputs (calibrationsource.Reader) ---
func (f *fakeStore) ActivitiesInWindow(_ context.Context, _, _ string, _, _ time.Time) ([]storage.Activity, error) {
	return f.acts, nil
}
func (f *fakeStore) ActivityTimeseries(_ context.Context, _, _ string) ([]storage.TimeseriesPoint, error) {
	return f.ts, nil
}
func (f *fakeStore) ActivityLaps(_ context.Context, _, _ string) ([]storage.Lap, error) {
	return nil, nil
}
func (f *fakeStore) DailyHealthWithRHR(_ context.Context, _ string) ([]storage.DailyHealth, error) {
	return f.health, nil
}

// --- calibration writes ---
func (f *fakeStore) UpsertRunningCalibrationSnapshot(_ context.Context, _ *storage.RunningCalibrationSnapshot) (uint64, error) {
	f.snapUpserted = true
	return 7, nil
}
func (f *fakeStore) ReplaceCalibrationZones(_ context.Context, _ string, _ uint64, _ []storage.RunningCalibrationPaceZone, _ []storage.RunningCalibrationHRZone) error {
	f.zonesReplaced = true
	return nil
}

// --- compute reads ---
func (f *fakeStore) LatestRunningCalibrationSnapshot(_ context.Context, _ string) (*storage.RunningCalibrationSnapshot, error) {
	return f.snap, nil
}
func (f *fakeStore) LatestRunningCalibrationSnapshotForVersion(_ context.Context, _ string, _ int, _ string) (*storage.RunningCalibrationSnapshot, error) {
	return f.snap, nil
}
func (f *fakeStore) AllRunningActivities(_ context.Context, _ string) ([]storage.Activity, error) {
	return f.acts, nil
}
func (f *fakeStore) DailyTrainingLoadBefore(_ context.Context, _, date string) (*storage.DailyTrainingLoad, error) {
	f.priorReadForDate = date
	f.priorReads++
	return f.prior, nil
}
func (f *fakeStore) AllDailyHealth(_ context.Context, _ string) ([]storage.DailyHealth, error) {
	return f.health, nil
}
func (f *fakeStore) AllDailyHRV(_ context.Context, _ string) ([]storage.DailyHRV, error) {
	return nil, nil
}
func (f *fakeStore) PersonalBests(_ context.Context, _ string) ([]storage.PersonalBest, error) {
	return f.pbs, nil
}

// --- compute writes ---
func (f *fakeStore) ReplaceActivityTrainingLoad(_ context.Context, _ string, rows []storage.ActivityTrainingLoad) error {
	f.activityUpserts++
	f.loadRows = rows
	return nil
}
func (f *fakeStore) ReplaceActivityZones(_ context.Context, _, _ string, rows []storage.ActivityZone) error {
	f.activityZonesWritten = append([]storage.ActivityZone(nil), rows...)
	return nil
}
func (f *fakeStore) ReplaceDailyTrainingLoad(_ context.Context, _ string, rows []storage.DailyTrainingLoad) error {
	f.dailyUpserts++
	f.dailyRows = append([]storage.DailyTrainingLoad(nil), rows...)
	return nil
}
func (f *fakeStore) ReplacePersonalBests(_ context.Context, _ string, _ []storage.PersonalBest) error {
	f.pbReplaced = true
	return nil
}
func (f *fakeStore) UpsertPersonalBests(_ context.Context, _ string, _ []storage.PersonalBest) error {
	f.pbUpserted = true
	return nil
}

func floatPtr(f float64) *float64 { return &f }
func intPtr(v int) *int           { return &v }
func int64Ptr(v int64) *int64     { return &v }

func runningActivity(label string, day time.Time) storage.Activity {
	return storage.Activity{
		LabelID:   label,
		SportType: 100, // running
		Date:      day,
		DistanceM: floatPtr(5000),
		DurationS: floatPtr(1500),
	}
}

func runJob(t *testing.T, h job.Handler, input string) (string, error) {
	t.Helper()
	return h(context.Background(), &job.Job{UserID: testUser, InputJSON: input}, func(string, int) error { return nil })
}

// --- calibration ---

func TestCalibration_BadPartition(t *testing.T) {
	_, err := NewCalibration(&fakeStore{})(context.Background(), &job.Job{UserID: "not-a-uuid"}, func(string, int) error { return nil })
	if pe, ok := job.AsPermanent(err); !ok || pe.Code != "bad_partition" {
		t.Fatalf("want permanent bad_partition, got %v", err)
	}
}

func TestCalibration_UpsertsSnapshotAndZones(t *testing.T) {
	f := &fakeStore{}
	if _, err := runJob(t, NewCalibration(f), ""); err != nil {
		t.Fatalf("calibration: %v", err)
	}
	if !f.snapUpserted || !f.zonesReplaced {
		t.Fatalf("expected snapshot+zones written, got snap=%v zones=%v", f.snapUpserted, f.zonesReplaced)
	}
}

// The calibration step sits between race detection and compute in data_sync
// (devops#921), so its result must thread both sync batches through: compute
// noops without them and health_dates drive rest_confirmed rows + the PMC.
func TestCalibration_EchoesSyncBatches(t *testing.T) {
	out, err := runJob(t, NewCalibration(&fakeStore{}), `{"label_ids":["a1","a2"],"health_dates":["2026-11-08"]}`)
	if err != nil {
		t.Fatalf("calibration: %v", err)
	}
	var res struct {
		LabelIDs    []string `json:"label_ids"`
		HealthDates []string `json:"health_dates"`
	}
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		t.Fatalf("parse result: %v", err)
	}
	if len(res.LabelIDs) != 2 || res.LabelIDs[0] != "a1" {
		t.Fatalf("label_ids echo = %v", res.LabelIDs)
	}
	if len(res.HealthDates) != 1 || res.HealthDates[0] != "2026-11-08" {
		t.Fatalf("health_dates echo = %v", res.HealthDates)
	}
}

// The empty-run gate (devops#931): an incremental sync with no new activity
// skips the 180-day recompute once today's snapshot exists; everything else
// (new labels, full mode, standalone/no mode, missing or stale snapshot)
// recomputes. health_dates re-delivery alone does NOT trigger a recompute —
// providers re-write the whole daily_health window on every pull, so it
// carries no new-data signal.
func TestCalibration_EmptyRunGate(t *testing.T) {
	// snapFor resolves "today"/"yesterday" lazily per case so a run straddling
	// the Shanghai midnight boundary cannot desync the fixture from the
	// handler's own ShanghaiToday() read.
	snapFor := func(day string) *storage.RunningCalibrationSnapshot {
		return &storage.RunningCalibrationSnapshot{ID: 77, UserID: testUser, AsOfDate: day}
	}
	todaySnap := func() *storage.RunningCalibrationSnapshot {
		return snapFor(timefmt.ShanghaiToday().Format("2006-01-02"))
	}
	yesterdaySnap := func() *storage.RunningCalibrationSnapshot {
		return snapFor(timefmt.ShanghaiToday().AddDate(0, 0, -1).Format("2006-01-02"))
	}
	cases := []struct {
		name     string
		input    string
		snap     func() *storage.RunningCalibrationSnapshot
		skipped  bool
		snapWant bool // snapshot write expected
	}{
		{"incremental no new labels + today snapshot skips", `{"mode":"incremental"}`, todaySnap, true, false},
		{"incremental no new labels + no snapshot recomputes", `{"mode":"incremental"}`, func() *storage.RunningCalibrationSnapshot { return nil }, false, true},
		{"incremental no new labels + yesterday snapshot recomputes", `{"mode":"incremental"}`, yesterdaySnap, false, true},
		{"incremental new labels recomputes", `{"mode":"incremental","label_ids":["a1"]}`, todaySnap, false, true},
		{"incremental health-only re-delivery skips (COROS full-window pull)", `{"mode":"incremental","health_dates":["2026-08-18","2026-11-09"]}`, todaySnap, true, false},
		{"full mode always recomputes", `{"mode":"full"}`, todaySnap, false, true},
		{"standalone no mode always recomputes", `{}`, todaySnap, false, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeStore{snap: tc.snap()}
			out, err := runJob(t, NewCalibration(f), tc.input)
			if err != nil {
				t.Fatalf("calibration: %v", err)
			}
			if f.snapUpserted != tc.snapWant {
				t.Fatalf("snapshot write = %v, want %v", f.snapUpserted, tc.snapWant)
			}
			var res struct {
				Status              string   `json:"status"`
				CalibrationSnapshot uint64   `json:"calibration_snapshot_id"`
				LabelIDs            []string `json:"label_ids"`
				HealthDates         []string `json:"health_dates"`
			}
			if err := json.Unmarshal([]byte(out), &res); err != nil {
				t.Fatalf("parse result: %v", err)
			}
			// Both paths must echo the input batches: on skip, a non-empty
			// health_dates echo is load-bearing — without it compute noops and a
			// health-only sync's rest_confirmed/PMC silently stops.
			var wantLabels, wantHealth []string
			_ = json.Unmarshal([]byte(tc.input), &struct {
				LabelIDs    *[]string `json:"label_ids"`
				HealthDates *[]string `json:"health_dates"`
			}{&wantLabels, &wantHealth})
			if !slices.Equal(res.LabelIDs, wantLabels) || !slices.Equal(res.HealthDates, wantHealth) {
				t.Fatalf("echo = %v/%v, want %v/%v", res.LabelIDs, res.HealthDates, wantLabels, wantHealth)
			}
			if tc.skipped {
				if res.Status != "skipped_no_new_data" {
					t.Fatalf("status = %q, want skipped_no_new_data", res.Status)
				}
				if res.CalibrationSnapshot != 77 {
					t.Fatalf("skipped result should point at the existing snapshot 77, got %d", res.CalibrationSnapshot)
				}
			} else if res.Status != "ok" {
				t.Fatalf("status = %q, want ok", res.Status)
			}
		})
	}
}

// --- compute ---

func TestCompute_NoCalibration_IsExplicitAndPreservesDerivedRows(t *testing.T) {
	f := &fakeStore{}
	out, err := runJob(t, NewCompute(f), `{"mode":"full"}`)
	if err != nil || !strings.Contains(out, "unavailable_historical_calibration") || f.activityUpserts != 0 || f.dailyUpserts != 0 {
		t.Fatalf("missing history: %s %v", out, err)
	}
}

func TestCompute_Full_ReplacesAll(t *testing.T) {
	f := &fakeStore{snap: &storage.RunningCalibrationSnapshot{ID: 7}}
	if _, err := runJob(t, NewCompute(f), `{"mode":"full"}`); err != nil {
		t.Fatalf("compute full: %v", err)
	}
	if f.activityUpserts != 1 || f.dailyUpserts != 1 || !f.pbReplaced {
		t.Fatalf("full should write load+daily+replace PBs, got %+v", f)
	}
	if f.pbUpserted {
		t.Fatal("full must not use the incremental PB upsert")
	}
}

func TestCompute_Incremental_OnlyNewAndUpsertsPBs(t *testing.T) {
	day := time.Date(2026, 3, 1, 6, 0, 0, 0, time.UTC)
	f := &fakeStore{
		snap: &storage.RunningCalibrationSnapshot{ID: 7},
		acts: []storage.Activity{runningActivity("new-1", day)},
	}
	if _, err := runJob(t, NewCompute(f), `{"mode":"incremental","label_ids":["new-1"]}`); err != nil {
		t.Fatalf("compute incremental: %v", err)
	}
	if f.activityUpserts != 1 || f.dailyUpserts != 1 {
		t.Fatalf("incremental should upsert load+daily, got %+v", f)
	}
	if !f.pbUpserted || f.pbReplaced {
		t.Fatalf("incremental must upsert PBs (not replace), got upsert=%v replace=%v", f.pbUpserted, f.pbReplaced)
	}
	// Prior-state read seeds the PMC from the day before the earliest new activity.
	if f.priorReadForDate != "2026-03-01" {
		t.Fatalf("prior-state read date = %q, want the new activity's Shanghai day", f.priorReadForDate)
	}
}

func TestCompute_Incremental_WritesStrideZones(t *testing.T) {
	day := time.Date(2026, 3, 1, 6, 0, 0, 0, time.UTC)
	thr, thrSpeed := 150.0, 3.7
	f := &fakeStore{
		snap: &storage.RunningCalibrationSnapshot{
			ID:                       7,
			ThresholdHR:              &thr,
			ThresholdSpeedMps:        &thrSpeed,
			ThresholdHRConfidence:    "high",
			ThresholdSpeedConfidence: "high",
		},
		acts: []storage.Activity{runningActivity("new-1", day)},
		// Timestamps are centiseconds; Speed is stored as s/km pace.
		ts: []storage.TimeseriesPoint{
			{Timestamp: int64Ptr(0), HeartRate: intPtr(125), Speed: floatPtr(345)},   // 2.90 m/s → easy; 125 bpm → easy
			{Timestamp: int64Ptr(100), HeartRate: intPtr(165), Speed: floatPtr(222)}, // 4.50 m/s → repetition; 165 bpm → repetition
		},
	}
	if _, err := runJob(t, NewCompute(f), `{"mode":"incremental","label_ids":["new-1"]}`); err != nil {
		t.Fatalf("compute incremental: %v", err)
	}
	if len(f.activityZonesWritten) == 0 {
		t.Fatal("expected STRIDE zone rows to be written for the running activity")
	}
	if len(f.activityZonesWritten) != 12 {
		t.Fatalf("zone rows = %d, want 12 (6 pace + 6 HR)", len(f.activityZonesWritten))
	}
	var pEasy, hEasy *storage.ActivityZone
	for i := range f.activityZonesWritten {
		z := &f.activityZonesWritten[i]
		if z.ZoneType == "pace" && z.ZoneIndex == 2 {
			pEasy = z
		}
		if z.ZoneType == "heartRate" && z.ZoneIndex == 2 {
			hEasy = z
		}
	}
	if pEasy == nil || hEasy == nil {
		t.Fatal("missing easy zone rows")
	}
	if pEasy.RangeUnit == nil || *pEasy.RangeUnit != "pace" || pEasy.DurationS == nil || *pEasy.DurationS != 1 {
		t.Errorf("pace easy = unit %v dur %v, want pace/1s", pEasy.RangeUnit, pEasy.DurationS)
	}
	if hEasy.RangeUnit == nil || *hEasy.RangeUnit != "bpm" || hEasy.DurationS == nil || *hEasy.DurationS != 1 {
		t.Errorf("hr easy = unit %v dur %v, want bpm/1s", hEasy.RangeUnit, hEasy.DurationS)
	}
	// One easy + one repetition sample → 50% each within pace and HR.
	if pEasy.Percent == nil || *pEasy.Percent != 50.0 {
		t.Errorf("pace easy percent = %v, want 50.0", pEasy.Percent)
	}
}

func TestCompute_Full_WritesStrideZones(t *testing.T) {
	// Full mode must also write STRIDE zones (backfill over the trailing-year
	// window), not just training load / daily PMC / PBs.
	day := time.Date(2026, 3, 1, 6, 0, 0, 0, time.UTC)
	thr, thrSpeed := 150.0, 3.7
	f := &fakeStore{
		snap: &storage.RunningCalibrationSnapshot{
			ID: 7, ThresholdHR: &thr, ThresholdSpeedMps: &thrSpeed,
			ThresholdHRConfidence: "high", ThresholdSpeedConfidence: "high",
		},
		acts: []storage.Activity{runningActivity("old-1", day)},
		ts: []storage.TimeseriesPoint{
			{Timestamp: int64Ptr(0), HeartRate: intPtr(125), Speed: floatPtr(345)},
			{Timestamp: int64Ptr(100), HeartRate: intPtr(165), Speed: floatPtr(222)},
		},
	}
	if _, err := runJob(t, NewCompute(f), `{"mode":"full"}`); err != nil {
		t.Fatalf("compute full: %v", err)
	}
	if len(f.activityZonesWritten) != 12 {
		t.Fatalf("full zone rows = %d, want 12 (6 pace + 6 HR)", len(f.activityZonesWritten))
	}
}

func TestCompute_Incremental_NoLabels_Noop(t *testing.T) {
	f := &fakeStore{snap: &storage.RunningCalibrationSnapshot{ID: 7}}
	if _, err := runJob(t, NewCompute(f), `{"mode":"incremental"}`); err != nil {
		t.Fatalf("compute incremental noop: %v", err)
	}
	if f.activityUpserts != 0 || f.dailyUpserts != 0 || f.pbUpserted {
		t.Fatalf("no activity or health dates should be a no-op, got %+v", f)
	}
}

func TestCompute_Incremental_HealthOnlySyncConfirmsRestThroughToday(t *testing.T) {
	today := timefmt.ShanghaiToday()
	f := &fakeStore{
		snap: &storage.RunningCalibrationSnapshot{ID: 7},
		prior: &storage.DailyTrainingLoad{
			AcuteLoad:   70,
			ChronicLoad: 50,
		},
		health: []storage.DailyHealth{{Date: today.Format("20060102")}},
	}
	input := `{"mode":"incremental","health_dates":["` + today.Format("2006-01-02") + `"]}`
	if _, err := runJob(t, NewCompute(f), input); err != nil {
		t.Fatalf("compute health-only incremental: %v", err)
	}
	if len(f.dailyRows) != 1 {
		t.Fatalf("daily rows = %d, want today's rest row", len(f.dailyRows))
	}
	row := f.dailyRows[0]
	if row.Date != today.Format("2006-01-02") {
		t.Fatalf("date = %q, want Shanghai today", row.Date)
	}
	if row.CoverageStatus != string(trainingload.CoverageRestConfirmed) {
		t.Fatalf("coverage = %q, want rest_confirmed", row.CoverageStatus)
	}
	if row.TrainingDose != 0 {
		t.Fatalf("training dose = %v, want 0", row.TrainingDose)
	}
	if row.AcuteLoad >= f.prior.AcuteLoad || row.ChronicLoad >= f.prior.ChronicLoad {
		t.Fatalf("rest day must decay ATL/CTL, got acute=%v chronic=%v", row.AcuteLoad, row.ChronicLoad)
	}
}

func TestComputeRefusesFutureBaselineWithoutOverwritingHistory(t *testing.T) {
	f := &fakeStore{snap: &storage.RunningCalibrationSnapshot{ID: 1, AsOfDate: "2099-01-01", AlgorithmVersion: 3}}
	out, err := NewCompute(f)(context.Background(), &job.Job{UserID: testUser, InputJSON: `{"mode":"full"}`}, func(string, int) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "unavailable_historical_calibration") {
		t.Fatalf("future calibration accepted: %s", out)
	}
}

func (f *fakeStore) CalibrationPolicy(context.Context) (storage.RunningCalibrationPolicy, error) {
	if f.policy != nil {
		return *f.policy, nil
	}
	return storage.DefaultCalibrationPolicy(), nil
}
func (f *fakeStore) PublishRunningCalibration(ctx context.Context, s *storage.RunningCalibrationSnapshot, p []storage.RunningCalibrationPaceZone, h []storage.RunningCalibrationHRZone) (uint64, error) {
	f.snapUpserted = true
	f.zonesReplaced = true
	return 7, nil
}
func (f *fakeStore) ReadEffectiveRunningCalibration(ctx context.Context, user, day string, mode storage.CalibrationMode) (storage.CalibrationBundle, error) {
	b := storage.CalibrationBundle{Snapshot: f.snap}
	if f.snapByDay != nil {
		b.Snapshot = f.snapByDay[day]
	}
	if b.Snapshot != nil && b.Snapshot.AsOfDate != "" && b.Snapshot.AsOfDate > day {
		b.Snapshot = nil
	}
	if b.Snapshot != nil {
		p, h := toStorageZones(calibration.ComputeTrainingZones(toCalibrationSnapshot(b.Snapshot)))
		b.PaceZones = p
		b.HRZones = h
	}
	return b, nil
}

func TestCandidatePipelineCannotWriteActiveDerivedTables(t *testing.T) {
	f := &fakeStore{snap: &storage.RunningCalibrationSnapshot{ID: 7}}
	for _, h := range []job.Handler{NewCompute(f), NewCalibration(f)} {
		_, err := runJob(t, h, `{"selection_mode":"candidate"}`)
		if err == nil {
			t.Fatal("candidate accepted by production writer")
		}
	}
	if f.activityUpserts != 0 || f.dailyUpserts != 0 || f.snapUpserted || f.zonesReplaced {
		t.Fatal("candidate polluted active writer")
	}
}

func TestComputeUsesEachActivityDayAndKeepsMissingHistory(t *testing.T) {
	today := timefmt.ShanghaiToday()
	past := today.AddDate(0, 0, -1)
	current := &storage.RunningCalibrationSnapshot{ID: 2, AsOfDate: today.Format("2006-01-02"), ThresholdSpeedMps: ptrF(5)}
	previous := &storage.RunningCalibrationSnapshot{ID: 1, AsOfDate: past.Format("2006-01-02"), ThresholdSpeedMps: ptrF(4)}
	f := &fakeStore{snap: current, acts: []storage.Activity{{LabelID: "old", Date: past.Add(12 * time.Hour), SportType: 100}, {LabelID: "new", Date: today.Add(12 * time.Hour), SportType: 100}}, snapByDay: map[string]*storage.RunningCalibrationSnapshot{today.Format("2006-01-02"): current, past.Format("2006-01-02"): previous}}
	if _, err := runJob(t, NewCompute(f), `{"mode":"full"}`); err != nil {
		t.Fatal(err)
	}
	if len(f.loadRows) != 2 || *f.loadRows[0].CalibrationID != 1 || *f.loadRows[1].CalibrationID != 2 {
		t.Fatalf("today baseline leaked into history %+v", f.loadRows)
	}
	delete(f.snapByDay, past.Format("2006-01-02"))
	f.activityUpserts = 0
	f.dailyUpserts = 0
	out, err := runJob(t, NewCompute(f), `{"mode":"full"}`)
	if err != nil || !strings.Contains(out, "unavailable_historical_calibration") || f.activityUpserts != 0 || f.dailyUpserts != 0 {
		t.Fatalf("missing history overwrote active rows %s %v", out, err)
	}
}

func TestCandidatePolicyCannotWriteUnnamespacedActiveLoad(t *testing.T) {
	f := &fakeStore{snap: &storage.RunningCalibrationSnapshot{ID: 7, AlgorithmVersion: calibration.CandidateVersion}}
	_, err := runJob(t, NewCompute(f), `{"mode":"full"}`)
	if pe, ok := job.AsPermanent(err); !ok || pe.Code != "candidate_derived_write_forbidden" {
		t.Fatalf("policy bypassed candidate write guard: %v", err)
	}
	if f.activityUpserts != 0 || f.dailyUpserts != 0 {
		t.Fatal("candidate polluted active tables")
	}
}

func TestCalibrationCandidateIntentCannotOverwriteActiveOrFallbackKey(t *testing.T) {
	three, four := 3, 4
	for _, tc := range []struct {
		name   string
		policy storage.RunningCalibrationPolicy
		allow  bool
	}{{"default-gate", storage.RunningCalibrationPolicy{ActiveVersion: 3, CandidateVersion: &three, FallbackVersion: 3}, false}, {"isolated-active-alias", storage.RunningCalibrationPolicy{ActiveVersion: 3, CandidateVersion: &three, FallbackVersion: 3}, true}, {"isolated-fallback-alias", storage.RunningCalibrationPolicy{ActiveVersion: 4, CandidateVersion: &three, FallbackVersion: 3}, true}, {"isolated-candidate-active-alias", storage.RunningCalibrationPolicy{ActiveVersion: 4, CandidateVersion: &four, FallbackVersion: 3}, true}} {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeStore{policy: &tc.policy}
			_, err := runJob(t, NewCalibrationWithOptions(f, CalibrationOptions{AllowCandidatePersistence: tc.allow}), `{"selection_mode":"candidate"}`)
			if err == nil {
				t.Fatal("candidate intent reused active or fallback snapshot key")
			}
			if f.snapUpserted || f.zonesReplaced {
				t.Fatal("candidate persistence overwrote active data")
			}
		})
	}
}

func TestComputeUnavailableHistoryPreservesSyncBatchEcho(t *testing.T) {
	f := &fakeStore{}
	out, err := runJob(t, NewCompute(f), `{"mode":"incremental","label_ids":["new-history"],"health_dates":["20261115"]}`)
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Status string   `json:"status"`
		Labels []string `json:"label_ids"`
		Health []string `json:"health_dates"`
	}
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatal(err)
	}
	if result.Status != "unavailable_historical_calibration" || !slices.Equal(result.Labels, []string{"new-history"}) || !slices.Equal(result.Health, []string{"20261115"}) {
		t.Fatalf("unavailable result lost sync batch %s", out)
	}
	if f.activityUpserts != 0 || f.dailyUpserts != 0 {
		t.Fatal("unavailable history wrote active derived rows")
	}
}
