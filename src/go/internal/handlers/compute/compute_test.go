package compute

import (
	"context"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/compute/trainingload"
	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

const testUser = "f10bc353-01ab-4db1-af9f-d9305ea9a532"

// fakeStore satisfies both CalibrationStore and ComputeStore with in-memory data
// and records which write paths ran.
type fakeStore struct {
	acts   []storage.Activity
	health []storage.DailyHealth
	snap   *storage.RunningCalibrationSnapshot // returned by LatestRunningCalibrationSnapshot
	prior  *storage.DailyTrainingLoad          // returned by DailyTrainingLoadBefore
	pbs    []storage.PersonalBest              // existing PBs

	// recorded calls
	snapUpserted     bool
	zonesReplaced    bool
	activityUpserts  int
	dailyUpserts     int
	dailyRows        []storage.DailyTrainingLoad
	pbReplaced       bool
	pbUpserted       bool
	priorReadForDate string
}

// --- calibration inputs (calibrationsource.Reader) ---
func (f *fakeStore) ActivitiesInWindow(_ context.Context, _, _ string, _, _ time.Time) ([]storage.Activity, error) {
	return f.acts, nil
}
func (f *fakeStore) ActivityTimeseries(_ context.Context, _, _ string) ([]storage.TimeseriesPoint, error) {
	return nil, nil
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
func (f *fakeStore) AllRunningActivities(_ context.Context, _ string) ([]storage.Activity, error) {
	return f.acts, nil
}
func (f *fakeStore) DailyTrainingLoadBefore(_ context.Context, _, date string) (*storage.DailyTrainingLoad, error) {
	f.priorReadForDate = date
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

// --- compute ---

func TestCompute_NoCalibration_Permanent(t *testing.T) {
	f := &fakeStore{snap: nil} // no baseline yet
	_, err := runJob(t, NewCompute(f), `{"mode":"full"}`)
	if pe, ok := job.AsPermanent(err); !ok || pe.Code != "no_calibration" {
		t.Fatalf("want permanent no_calibration, got %v", err)
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

func TestCompute_Incremental_NoLabels_Noop(t *testing.T) {
	f := &fakeStore{snap: &storage.RunningCalibrationSnapshot{ID: 7}}
	if _, err := runJob(t, NewCompute(f), `{"mode":"incremental"}`); err != nil {
		t.Fatalf("compute incremental noop: %v", err)
	}
	if f.activityUpserts != 0 || f.dailyUpserts != 0 || f.pbUpserted {
		t.Fatalf("no label_ids should be a no-op, got %+v", f)
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
