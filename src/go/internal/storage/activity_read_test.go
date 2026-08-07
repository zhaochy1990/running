package storage

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

// openWatchTestStore is openTestStore plus the watch/compute migration the
// activity read surface needs (activities, laps, zones, activity_training_load).
// Skips without STRIDE_WORKER_TEST_MYSQL_DSN.
func openWatchTestStore(t *testing.T) *Store {
	t.Helper()
	st := openTestStore(t)
	if err := st.AutoMigrateWatch(context.Background()); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	return st
}

// seedActivity upserts one activity (with optional children) for a user. It
// stamps a non-null SyncedAt so the not-null column is satisfied.
func seedActivity(t *testing.T, st *Store, uid string, a *Activity, laps []Lap, ts []TimeseriesPoint, zones []ActivityWatchZone) {
	t.Helper()
	a.UserID = uid
	if a.SyncedAt.IsZero() {
		a.SyncedAt = time.Now().UTC().Truncate(time.Microsecond)
	}
	if err := st.UpsertActivity(context.Background(), a, laps, ts, zones); err != nil {
		t.Fatalf("seed activity %s: %v", a.LabelID, err)
	}
}

// TestListActivities_FilterOrderPaginate is gated on a live MySQL
// (STRIDE_WORKER_TEST_MYSQL_DSN). It seeds a fresh per-test user so the page,
// count, category filter, and newest-first order are asserted in isolation.
func TestListActivities_FilterOrderPaginate(t *testing.T) {
	st := openWatchTestStore(t)
	ctx := context.Background()
	uid := uuid.NewString()

	// Three runs on distinct days + one strength session.
	seedActivity(t, st, uid, &Activity{
		LabelID: "run-1", SportType: 100, SportName: sptr("Run"),
		Date: time.Date(2026, 3, 1, 2, 0, 0, 0, time.UTC), DistanceM: f(3000), DurationS: f(1200),
	}, nil, nil, nil)
	seedActivity(t, st, uid, &Activity{
		LabelID: "run-2", SportType: 100, SportName: sptr("Run"),
		Date: time.Date(2026, 3, 3, 2, 0, 0, 0, time.UTC), DistanceM: f(8000), DurationS: f(2400),
	}, nil, nil, nil)
	seedActivity(t, st, uid, &Activity{
		LabelID: "run-3", SportType: 100, SportName: sptr("Run"),
		Date: time.Date(2026, 3, 5, 2, 0, 0, 0, time.UTC), DistanceM: f(12000), DurationS: f(3600),
	}, nil, nil, nil)
	seedActivity(t, st, uid, &Activity{
		LabelID: "str-1", SportType: 402, SportName: sptr("Strength"),
		Date: time.Date(2026, 3, 4, 2, 0, 0, 0, time.UTC), DistanceM: f(0), DurationS: f(1800),
	}, nil, nil, nil)

	// Unfiltered: all four, newest first.
	page, err := st.ListActivities(ctx, uid, ActivityListParams{Offset: 0, Limit: 50})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if page.Total != 4 {
		t.Fatalf("total = %d, want 4", page.Total)
	}
	if len(page.Rows) != 4 || page.Rows[0].LabelID != "run-3" || page.Rows[3].LabelID != "run-1" {
		t.Fatalf("order wrong: %s..%s", page.Rows[0].LabelID, page.Rows[len(page.Rows)-1].LabelID)
	}

	// Category=run excludes the strength row.
	runOnly, err := st.ListActivities(ctx, uid, ActivityListParams{Limit: 50, SportCategory: "run"})
	if err != nil {
		t.Fatalf("list run: %v", err)
	}
	if runOnly.Total != 3 {
		t.Fatalf("run total = %d, want 3", runOnly.Total)
	}

	// min_distance_km=5 keeps only run-2 (8k) and run-3 (12k).
	far, err := st.ListActivities(ctx, uid, ActivityListParams{Limit: 50, MinDistanceKm: f(5)})
	if err != nil {
		t.Fatalf("list far: %v", err)
	}
	if far.Total != 2 {
		t.Fatalf("min-distance total = %d, want 2", far.Total)
	}

	// Pagination: limit 2 offset 1 → rows 2,3 of the newest-first list.
	// Order by date DESC is [run-3(03-05), str-1(03-04), run-2(03-03), run-1(03-01)],
	// so offset 1 yields [str-1, run-2].
	pageB, err := st.ListActivities(ctx, uid, ActivityListParams{Offset: 1, Limit: 2})
	if err != nil {
		t.Fatalf("list page B: %v", err)
	}
	if pageB.Total != 4 {
		t.Fatalf("page B total = %d, want 4 (count ignores paging)", pageB.Total)
	}
	if len(pageB.Rows) != 2 || pageB.Rows[0].LabelID != "str-1" || pageB.Rows[1].LabelID != "run-2" {
		t.Fatalf("page B rows wrong: %+v", labelIDs(pageB.Rows))
	}
}

// TestListActivities_MonthlySummaries checks the Shanghai-month bucketing,
// run-only distance sum, and the UTC→Shanghai boundary that shifts a late-UTC
// activity into the next civil month.
func TestListActivities_MonthlySummaries(t *testing.T) {
	st := openWatchTestStore(t)
	ctx := context.Background()
	uid := uuid.NewString()

	// A run + a strength in Shanghai March.
	seedActivity(t, st, uid, &Activity{
		LabelID: "m-run", SportType: 100, SportName: sptr("Run"),
		Date: time.Date(2026, 3, 10, 2, 0, 0, 0, time.UTC), DistanceM: f(5000), DurationS: f(1800),
	}, nil, nil, nil)
	seedActivity(t, st, uid, &Activity{
		LabelID: "m-str", SportType: 402, SportName: sptr("Strength"),
		Date: time.Date(2026, 3, 12, 2, 0, 0, 0, time.UTC), DistanceM: f(0), DurationS: f(1200),
	}, nil, nil, nil)
	// Boundary: 2026-03-31 20:00 UTC == 2026-04-01 04:00 Shanghai → month "2026-04".
	seedActivity(t, st, uid, &Activity{
		LabelID: "m-boundary", SportType: 100, SportName: sptr("Run"),
		Date: time.Date(2026, 3, 31, 20, 0, 0, 0, time.UTC), DistanceM: f(2000), DurationS: f(900),
	}, nil, nil, nil)

	page, err := st.ListActivities(ctx, uid, ActivityListParams{Limit: 50})
	if err != nil {
		t.Fatalf("list: %v", err)
	}

	mar, ok := page.MonthlySummaries["2026-03"]
	if !ok {
		t.Fatalf("2026-03 summary missing: %+v", page.MonthlySummaries)
	}
	if mar.ActivityCount != 2 {
		t.Fatalf("march count = %d, want 2 (run + strength)", mar.ActivityCount)
	}
	// Run-only distance: 5000m / 1000 = 5.0 km (strength excluded).
	if mar.TotalRunKm < 4.999 || mar.TotalRunKm > 5.001 {
		t.Fatalf("march run km = %v, want 5.0", mar.TotalRunKm)
	}
	if mar.RunDurationS != 1800 {
		t.Fatalf("march run duration = %d, want 1800 (strength excluded)", mar.RunDurationS)
	}
	if mar.DurationS != 3000 {
		t.Fatalf("march duration = %d, want 3000 (1800+1200)", mar.DurationS)
	}

	apr, ok := page.MonthlySummaries["2026-04"]
	if !ok {
		t.Fatalf("2026-04 summary missing (boundary activity misclassified): %+v", page.MonthlySummaries)
	}
	if apr.ActivityCount != 1 {
		t.Fatalf("april count = %d, want 1 (the boundary run)", apr.ActivityCount)
	}
}

// TestListActivities_DateWindow checks the Shanghai-day date_from/date_to bounds.
func TestListActivities_DateWindow(t *testing.T) {
	st := openWatchTestStore(t)
	ctx := context.Background()
	uid := uuid.NewString()

	for _, d := range []int{1, 5, 10} {
		seedActivity(t, st, uid, &Activity{
			LabelID: "d-" + time.Month(1).String() + itoa(d), SportType: 100, SportName: sptr("Run"),
			Date: time.Date(2026, 5, d, 2, 0, 0, 0, time.UTC), DistanceM: f(1000), DurationS: f(600),
		}, nil, nil, nil)
	}

	page, err := st.ListActivities(ctx, uid, ActivityListParams{Limit: 50, DateFrom: "2026-05-03", DateTo: "2026-05-08"})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if page.Total != 1 {
		t.Fatalf("windowed total = %d, want 1 (only day 5)", page.Total)
	}
}

// TestActivityByID_And_NotFound checks the single-row read and the (nil,nil)
// absent contract the API layer maps to 404.
func TestActivityByID_And_NotFound(t *testing.T) {
	st := openWatchTestStore(t)
	ctx := context.Background()
	uid := uuid.NewString()

	seedActivity(t, st, uid, &Activity{
		LabelID: "one", SportType: 100, SportName: sptr("Run"),
		Date: time.Date(2026, 6, 1, 2, 0, 0, 0, time.UTC), DistanceM: f(4000), DurationS: f(1500),
	}, nil, nil, nil)

	got, err := st.ActivityByID(ctx, uid, "one")
	if err != nil {
		t.Fatalf("by id: %v", err)
	}
	if got == nil || got.LabelID != "one" {
		t.Fatalf("by id = %+v, want label one", got)
	}

	missing, err := st.ActivityByID(ctx, uid, "nope")
	if err != nil {
		t.Fatalf("by id missing: %v", err)
	}
	if missing != nil {
		t.Fatalf("absent activity must be (nil,nil), got %+v", missing)
	}
}

// TestActivityChildren checks laps-by-type filtering + lap_index order, watch
// zone (zone_type, zone_index) order, and the training-load read.
func TestActivityChildren(t *testing.T) {
	st := openWatchTestStore(t)
	ctx := context.Background()
	uid := uuid.NewString()

	laps := []Lap{
		{LabelID: "c", LapIndex: 1, LapType: "autoKm", DistanceM: f(1000)},
		{LabelID: "c", LapIndex: 0, LapType: "autoKm", DistanceM: f(1000)},
		{LabelID: "c", LapIndex: 0, LapType: "type2", ExerciseType: i(3), Mode: i(1)},
	}
	zones := []ActivityWatchZone{
		{LabelID: "c", ZoneType: "power", ZoneIndex: 1, ZoneTypeRaw: 2},
		{LabelID: "c", ZoneType: "hr", ZoneIndex: 2, ZoneTypeRaw: 1},
		{LabelID: "c", ZoneType: "hr", ZoneIndex: 1, ZoneTypeRaw: 1},
	}
	seedActivity(t, st, uid, &Activity{
		LabelID: "c", SportType: 100, SportName: sptr("Run"),
		Date: time.Date(2026, 7, 1, 2, 0, 0, 0, time.UTC), DistanceM: f(2000), DurationS: f(900),
	}, laps, nil, zones)

	// autoKm laps ordered by lap_index.
	km, err := st.ActivityLapsByType(ctx, uid, "c", "autoKm")
	if err != nil {
		t.Fatalf("laps autoKm: %v", err)
	}
	if len(km) != 2 || km[0].LapIndex != 0 || km[1].LapIndex != 1 {
		t.Fatalf("autoKm order wrong: %+v", km)
	}

	// type2 segment isolated from the autoKm laps.
	segs, err := st.ActivityLapsByType(ctx, uid, "c", "type2")
	if err != nil {
		t.Fatalf("laps type2: %v", err)
	}
	if len(segs) != 1 || segs[0].ExerciseType == nil || *segs[0].ExerciseType != 3 {
		t.Fatalf("type2 wrong: %+v", segs)
	}

	// Zones ordered by (zone_type, zone_index): hr#1, hr#2, power#1.
	zs, err := st.ActivityWatchZones(ctx, uid, "c")
	if err != nil {
		t.Fatalf("zones: %v", err)
	}
	if len(zs) != 3 ||
		zs[0].ZoneType != "hr" || zs[0].ZoneIndex != 1 ||
		zs[1].ZoneType != "hr" || zs[1].ZoneIndex != 2 ||
		zs[2].ZoneType != "power" {
		t.Fatalf("zone order wrong: %+v", zoneKeys(zs))
	}

	// Training load: absent → (nil,nil), then present after a replace.
	tl, err := st.ActivityTrainingLoad(ctx, uid, "c")
	if err != nil {
		t.Fatalf("training load absent: %v", err)
	}
	if tl != nil {
		t.Fatalf("training load must be nil before write, got %+v", tl)
	}
	if err := st.ReplaceActivityTrainingLoad(ctx, uid, []ActivityTrainingLoad{{
		UserID: uid, LabelID: "c", ActivityDate: "2026-07-01", AlgorithmVersion: 2,
		ComputedAt: time.Now().UTC().Truncate(time.Microsecond),
	}}); err != nil {
		t.Fatalf("replace training load: %v", err)
	}
	tl, err = st.ActivityTrainingLoad(ctx, uid, "c")
	if err != nil {
		t.Fatalf("training load present: %v", err)
	}
	if tl == nil || tl.LabelID != "c" {
		t.Fatalf("training load = %+v, want label c", tl)
	}
}

// --- tiny helpers ------------------------------------------------------------

func sptr(s string) *string { return &s }
func f(v float64) *float64  { return &v }
func i(v int) *int          { return &v }

func labelIDs(rows []Activity) []string {
	out := make([]string, len(rows))
	for i, r := range rows {
		out[i] = r.LabelID
	}
	return out
}

func zoneKeys(zs []ActivityWatchZone) []string {
	out := make([]string, len(zs))
	for i, z := range zs {
		out[i] = z.ZoneType + "#" + itoa(z.ZoneIndex)
	}
	return out
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b [20]byte
	pos := len(b)
	for n > 0 {
		pos--
		b[pos] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		pos--
		b[pos] = '-'
	}
	return string(b[pos:])
}
