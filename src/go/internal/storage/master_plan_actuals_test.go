package storage

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/zhaochy1990/stride/internal/compute/trainingload"
)

func migrateActuals(t *testing.T, st *Store) {
	t.Helper()
	if err := st.db.WithContext(context.Background()).AutoMigrate(&Activity{}, &DailyTrainingLoad{}); err != nil {
		t.Fatalf("automigrate activities/daily_training_load: %v", err)
	}
}

func fp(v float64) *float64 { return &v }
func ip(v int) *int         { return &v }

// seedRun inserts one running activity. The instant is at 12:00 UTC (20:00
// Shanghai) so its Shanghai day equals the date part, clear of the 00:00–07:59
// boundary.
func seedRun(t *testing.T, st *Store, uid, label, dayISO string, distM, durS, pace float64, hr int) {
	t.Helper()
	inst, err := time.Parse(time.RFC3339, dayISO+"T12:00:00Z")
	if err != nil {
		t.Fatalf("parse date: %v", err)
	}
	a := &Activity{
		UserID: uid, LabelID: label, SportType: 100, Date: inst, SyncedAt: time.Now().UTC(),
		DistanceM: fp(distM), DurationS: fp(durS), AvgPaceSKm: fp(pace), AvgHR: ip(hr),
	}
	if err := st.db.WithContext(context.Background()).Create(a).Error; err != nil {
		t.Fatalf("seed run: %v", err)
	}
}

func seedNonRun(t *testing.T, st *Store, uid, label, dayISO string) {
	t.Helper()
	inst, _ := time.Parse(time.RFC3339, dayISO+"T12:00:00Z")
	a := &Activity{UserID: uid, LabelID: label, SportType: 402, Date: inst, SyncedAt: time.Now().UTC(), DistanceM: fp(9000)}
	if err := st.db.WithContext(context.Background()).Create(a).Error; err != nil {
		t.Fatalf("seed non-run: %v", err)
	}
}

func seedDose(t *testing.T, st *Store, uid, day, status string, dose float64) {
	seedDoseVersion(t, st, uid, day, status, dose, trainingload.ModelVersion)
}

func seedDoseVersion(t *testing.T, st *Store, uid, day, status string, dose float64, version int) {
	t.Helper()
	row := &DailyTrainingLoad{
		UserID: uid, Date: day, AlgorithmVersion: version,
		TrainingDose: dose, CoverageStatus: status, ComputedAt: time.Now().UTC(),
	}
	if err := st.db.WithContext(context.Background()).Create(row).Error; err != nil {
		t.Fatalf("seed dose: %v", err)
	}
}

func TestRunningWeekSummaries(t *testing.T) {
	st := openTestStore(t)
	migrateActuals(t, st)
	ctx := context.Background()
	uid := uuid.NewString()

	// Two runs in the Shanghai week 06-01..06-07 (15km total, weighted pace 300,
	// weighted hr = (150*3000 + 160*1500)/4500 = 153.33 -> 153).
	seedRun(t, st, uid, "a", "2026-06-02", 10000, 3000, 300, 150)
	seedRun(t, st, uid, "b", "2026-06-04", 5000, 1500, 300, 160)
	// A strength activity (excluded) and another user's run (excluded).
	seedNonRun(t, st, uid, "c", "2026-06-03")
	seedRun(t, st, uuid.NewString(), "x", "2026-06-02", 99000, 9000, 300, 150)

	windows := []WeekWindow{{Index: 2, From: "2026-06-01", To: "2026-06-07"}}
	got, err := st.RunningWeekSummaries(ctx, uid, windows)
	if err != nil {
		t.Fatalf("running summaries: %v", err)
	}
	s, ok := got[2]
	if !ok {
		t.Fatalf("week 2 missing")
	}
	if s.RunCount != 2 || s.DistanceKm != 15.0 || s.TotalDurationS != 4500 {
		t.Errorf("summary = %+v, want count 2 / 15.0km / 4500s", s)
	}
	if s.AvgPaceSKm == nil || *s.AvgPaceSKm != 300 {
		t.Errorf("avg_pace = %v, want 300", s.AvgPaceSKm)
	}
	if s.AvgHR == nil || *s.AvgHR != 153 {
		t.Errorf("avg_hr = %v, want 153 (duration-weighted)", s.AvgHR)
	}

	// A window with no runs is omitted entirely.
	empty, _ := st.RunningWeekSummaries(ctx, uid, []WeekWindow{{Index: 9, From: "2027-01-01", To: "2027-01-07"}})
	if len(empty) != 0 {
		t.Errorf("empty window should be omitted, got %v", empty)
	}
}

func TestTrainingDoseWeekSummaries(t *testing.T) {
	st := openTestStore(t)
	migrateActuals(t, st)
	ctx := context.Background()
	uid := uuid.NewString()

	// A 7-day window with 4 available days (1 partial), one 'unknown' excluded.
	seedDose(t, st, uid, "2026-06-01", "complete", 100)
	seedDose(t, st, uid, "2026-06-02", "complete", 120)
	seedDose(t, st, uid, "2026-06-03", "partial", 80)
	seedDoseVersion(t, st, uid, "2026-06-04", "rest_confirmed", 0, trainingload.ModelVersion-1)
	seedDose(t, st, uid, "2026-06-05", "unknown", 999) // excluded (no dose contributed)

	got, err := st.TrainingDoseWeekSummaries(ctx, uid, []WeekWindow{{Index: 2, From: "2026-06-01", To: "2026-06-07"}})
	if err != nil {
		t.Fatalf("dose summaries: %v", err)
	}
	d := got[2]
	if d.Dose == nil || *d.Dose != 300.0 {
		t.Errorf("dose = %v, want 300 (100+120+80+0, unknown excluded)", d.Dose)
	}
	if d.Coverage != 0.571 { // 4/7
		t.Errorf("coverage = %v, want 0.571", d.Coverage)
	}
	if d.Status != "partial" { // has a partial day + not fully covered
		t.Errorf("status = %q, want partial", d.Status)
	}

	// A fully-covered 1-day window with a single complete day -> complete.
	seedDose(t, st, uid, "2026-06-08", "complete", 50)
	full, _ := st.TrainingDoseWeekSummaries(ctx, uid, []WeekWindow{{Index: 3, From: "2026-06-08", To: "2026-06-08"}})
	if full[3].Status != "complete" || full[3].Coverage != 1.0 || full[3].Dose == nil || *full[3].Dose != 50.0 {
		t.Errorf("full week = %+v, want complete / 1.0 / 50", full[3])
	}

	// No data at all -> unknown, nil dose, zero coverage.
	none, _ := st.TrainingDoseWeekSummaries(ctx, uid, []WeekWindow{{Index: 9, From: "2027-01-01", To: "2027-01-07"}})
	if none[9].Status != "unknown" || none[9].Dose != nil || none[9].Coverage != 0 {
		t.Errorf("no-data week = %+v, want unknown / nil / 0", none[9])
	}
}
