package storage

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

// iptr is a local int-pointer helper (fptr/sptr live in sibling test files).
func iptr(v int) *int { return &v }

// seedUser returns a fresh random UUID so each integration test operates on an
// isolated tenant partition of the shared MySQL fixture.
func seedUser() string { return uuid.NewString() }

func TestDailyHealthWindow_OrderAndLimit(t *testing.T) {
	st := openTestStore(t)
	if err := st.AutoMigrateWatch(context.Background()); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	ctx := context.Background()
	uid := seedUser()

	for _, d := range []string{"2026-05-07", "2026-05-08", "2026-05-09"} {
		if err := st.UpsertDailyHealth(ctx, &DailyHealth{UserID: uid, Date: d, RHR: iptr(45), Provider: "coros"}); err != nil {
			t.Fatalf("seed daily_health %s: %v", d, err)
		}
	}

	rows, err := st.DailyHealthWindow(ctx, uid, 2)
	if err != nil {
		t.Fatalf("DailyHealthWindow: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("len = %d, want 2 (limited)", len(rows))
	}
	// newest-first
	if rows[0].Date != "2026-05-09" || rows[1].Date != "2026-05-08" {
		t.Fatalf("order = %q,%q, want newest-first 05-09,05-08", rows[0].Date, rows[1].Date)
	}
}

func TestDailyTrainingLoadSeries_OldestFirst(t *testing.T) {
	st := openTestStore(t)
	if err := st.AutoMigrateWatch(context.Background()); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	ctx := context.Background()
	uid := seedUser()
	now := time.Now().UTC()

	rows := []DailyTrainingLoad{
		{UserID: uid, Date: "2026-05-07", AlgorithmVersion: 1, CoverageStatus: "complete", ComputedAt: now},
		{UserID: uid, Date: "2026-05-08", AlgorithmVersion: 1, CoverageStatus: "complete", ComputedAt: now},
		{UserID: uid, Date: "2026-05-09", AlgorithmVersion: 1, CoverageStatus: "unknown", ComputedAt: now},
	}
	if err := st.ReplaceDailyTrainingLoad(ctx, uid, rows); err != nil {
		t.Fatalf("seed daily_training_load: %v", err)
	}

	series, err := st.DailyTrainingLoadSeries(ctx, uid, 2)
	if err != nil {
		t.Fatalf("DailyTrainingLoadSeries: %v", err)
	}
	if len(series) != 2 {
		t.Fatalf("len = %d, want 2 (limited)", len(series))
	}
	// last 2 by date DESC, then reversed → oldest-first within the window
	if series[0].Date != "2026-05-08" || series[1].Date != "2026-05-09" {
		t.Fatalf("order = %q,%q, want 05-08,05-09", series[0].Date, series[1].Date)
	}
}

func TestLatestUsableDailyTrainingLoad_SkipsUnknown_Unbounded(t *testing.T) {
	st := openTestStore(t)
	if err := st.AutoMigrateWatch(context.Background()); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	ctx := context.Background()
	uid := seedUser()
	now := time.Now().UTC()

	// Newest row is an unknown placeholder; the latest usable is the 05-08 row.
	rows := []DailyTrainingLoad{
		{UserID: uid, Date: "2026-05-08", AlgorithmVersion: 1, CoverageStatus: "complete", ChronicLoad: 30, ComputedAt: now},
		{UserID: uid, Date: "2026-05-09", AlgorithmVersion: 1, CoverageStatus: "unknown", ComputedAt: now},
		{UserID: uid, Date: "2026-05-10", AlgorithmVersion: 1, CoverageStatus: "unknown", ComputedAt: now},
	}
	if err := st.ReplaceDailyTrainingLoad(ctx, uid, rows); err != nil {
		t.Fatalf("seed: %v", err)
	}

	got, err := st.LatestUsableDailyTrainingLoad(ctx, uid)
	if err != nil {
		t.Fatalf("LatestUsableDailyTrainingLoad: %v", err)
	}
	if got == nil || got.Date != "2026-05-08" {
		t.Fatalf("latest usable = %+v, want 05-08 (skipping unknown)", got)
	}
}

func TestDailyTrainingLoadWithPrior_SevenDayLookback(t *testing.T) {
	st := openTestStore(t)
	if err := st.AutoMigrateWatch(context.Background()); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	ctx := context.Background()
	uid := seedUser()
	now := time.Now().UTC()

	// 8 consecutive days 05-01..05-08, chronic = day-of-month so the 7-day
	// lookback is easy to assert (chronic 05-08 = 8, prior 05-01 = 1).
	var rows []DailyTrainingLoad
	for day := 1; day <= 8; day++ {
		rows = append(rows, DailyTrainingLoad{
			UserID: uid, Date: time.Date(2026, 5, day, 0, 0, 0, 0, time.UTC).Format("2006-01-02"),
			AlgorithmVersion: 1, CoverageStatus: "complete", ChronicLoad: float64(day), ComputedAt: now,
		})
	}
	if err := st.ReplaceDailyTrainingLoad(ctx, uid, rows); err != nil {
		t.Fatalf("seed: %v", err)
	}

	out, err := st.DailyTrainingLoadWithPrior(ctx, uid, 8)
	if err != nil {
		t.Fatalf("DailyTrainingLoadWithPrior: %v", err)
	}
	if len(out) != 8 {
		t.Fatalf("len = %d, want 8", len(out))
	}
	// oldest-first: out[0] is 05-01 (no prior in set), out[7] is 05-08 (prior 05-01 chronic=1)
	if out[0].PriorChronic != nil {
		t.Fatalf("05-01 prior = %v, want nil (no 7-day-prior row)", *out[0].PriorChronic)
	}
	last := out[7]
	if last.Row.Date != "2026-05-08" {
		t.Fatalf("last row date = %q, want 05-08", last.Row.Date)
	}
	if last.PriorChronic == nil || *last.PriorChronic != 1 {
		t.Fatalf("05-08 prior chronic = %v, want 1 (05-01)", last.PriorChronic)
	}
}

func TestLatestRunningCalibrationSnapshotForVersion(t *testing.T) {
	st := openTestStore(t)
	if err := st.AutoMigrateWatch(context.Background()); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	ctx := context.Background()
	uid := seedUser()
	now := time.Now().UTC()

	// v3 past snapshot, v3 far-future snapshot, and a NEWER-dated v99 (a stale
	// prior/other-version row that must not shadow the current-version baseline).
	if _, err := st.UpsertRunningCalibrationSnapshot(ctx, &RunningCalibrationSnapshot{
		UserID: uid, AsOfDate: "2020-01-01", AlgorithmVersion: 3,
		ThresholdHRConfidence: "high", ThresholdSpeedConfidence: "high",
		RHRBaseline: fptr(44), ComputedAt: now,
	}); err != nil {
		t.Fatalf("seed v3 past: %v", err)
	}
	if _, err := st.UpsertRunningCalibrationSnapshot(ctx, &RunningCalibrationSnapshot{
		UserID: uid, AsOfDate: "2999-01-01", AlgorithmVersion: 3,
		ThresholdHRConfidence: "high", ThresholdSpeedConfidence: "high",
		RHRBaseline: fptr(50), ComputedAt: now,
	}); err != nil {
		t.Fatalf("seed v3 future: %v", err)
	}
	if _, err := st.UpsertRunningCalibrationSnapshot(ctx, &RunningCalibrationSnapshot{
		UserID: uid, AsOfDate: "2100-01-01", AlgorithmVersion: 99,
		ThresholdHRConfidence: "high", ThresholdSpeedConfidence: "high",
		RHRBaseline: fptr(99), ComputedAt: now,
	}); err != nil {
		t.Fatalf("seed v99: %v", err)
	}

	// as_of today, version 3 → the 2020 v3 snapshot (future v3 and v99 excluded).
	asOf := time.Now().UTC().Format("2006-01-02")
	got, err := st.LatestRunningCalibrationSnapshotForVersion(ctx, uid, 3, asOf)
	if err != nil {
		t.Fatalf("as-of today: %v", err)
	}
	if got == nil || got.AsOfDate != "2020-01-01" || got.AlgorithmVersion != 3 {
		t.Fatalf("as-of today = %+v, want the 2020 v3 snapshot", got)
	}

	// no as_of bound, version 3 → newest v3 (the 2999 one), NOT the newer-dated v99.
	got, err = st.LatestRunningCalibrationSnapshotForVersion(ctx, uid, 3, "")
	if err != nil {
		t.Fatalf("no as-of: %v", err)
	}
	if got == nil || got.AsOfDate != "2999-01-01" || got.AlgorithmVersion != 3 {
		t.Fatalf("no as-of = %+v, want the 2999 v3 snapshot (v99 must not shadow)", got)
	}
}

func TestCalibrationZonesForSnapshot_ReturnsBothTables(t *testing.T) {
	st := openTestStore(t)
	if err := st.AutoMigrateWatch(context.Background()); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	ctx := context.Background()
	uid := seedUser()
	now := time.Now().UTC()

	snapID, err := st.UpsertRunningCalibrationSnapshot(ctx, &RunningCalibrationSnapshot{
		UserID: uid, AsOfDate: "2026-05-09", AlgorithmVersion: 1,
		ThresholdHRConfidence: "high", ThresholdSpeedConfidence: "high", ComputedAt: now,
	})
	if err != nil {
		t.Fatalf("seed snapshot: %v", err)
	}
	pace := []RunningCalibrationPaceZone{{Name: "easy", MinSpeedMps: fptr(2.78), MaxSpeedMps: fptr(3.33), Confidence: "high"}}
	hr := []RunningCalibrationHRZone{{Name: "easy", MinBpm: fptr(130), MaxBpm: fptr(145), Confidence: "high"}}
	if err := st.ReplaceCalibrationZones(ctx, uid, snapID, pace, hr); err != nil {
		t.Fatalf("seed zones: %v", err)
	}

	gotPace, gotHR, err := st.CalibrationZonesForSnapshot(ctx, uid, snapID)
	if err != nil {
		t.Fatalf("CalibrationZonesForSnapshot: %v", err)
	}
	if len(gotPace) != 1 || gotPace[0].Name != "easy" {
		t.Fatalf("pace zones = %+v, want one easy", gotPace)
	}
	if len(gotHR) != 1 || gotHR[0].Name != "easy" {
		t.Fatalf("hr zones = %+v, want one easy", gotHR)
	}
}

func TestLatestHRVDate_IgnoresNullLastNight(t *testing.T) {
	st := openTestStore(t)
	if err := st.AutoMigrateWatch(context.Background()); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	ctx := context.Background()
	uid := seedUser()

	// Newest row has a null last_night_avg; the latest usable date is 05-08.
	if err := st.UpsertDailyHRV(ctx, &DailyHRV{UserID: uid, Date: "2026-05-08", Provider: "coros", LastNightAvg: iptr(60)}); err != nil {
		t.Fatalf("seed 05-08: %v", err)
	}
	if err := st.UpsertDailyHRV(ctx, &DailyHRV{UserID: uid, Date: "2026-05-09", Provider: "coros", LastNightAvg: nil}); err != nil {
		t.Fatalf("seed 05-09: %v", err)
	}

	got, err := st.LatestHRVDate(ctx, uid)
	if err != nil {
		t.Fatalf("LatestHRVDate: %v", err)
	}
	if got != "2026-05-08" {
		t.Fatalf("latest hrv date = %q, want 2026-05-08 (05-09 has null last_night_avg)", got)
	}
}
