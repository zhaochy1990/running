package storage

import (
	"errors"
	"reflect"
	"sort"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/zhaochy1990/stride/internal/utils/timefmt"
)

// The cache key must account for corrections even when a sync's label list
// is incomplete. Exercising the two real watch write paths also covers retries.
func TestV3EvidenceWindow(t *testing.T) {
	ctx := t.Context()
	st := openTestStore(t)
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatal(err)
	}
	uid := uuid.NewString()
	for _, table := range []string{"activities", "laps", "running_calibration_v3_evidence", "daily_health"} {
		addUserTableCleanup(t, st, table, uid)
	}
	day := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	activity := Activity{UserID: uid, LabelID: "run", Date: day.Add(-7 * time.Hour), SportType: 100, Provider: "coros", SyncedAt: day}
	lap := Lap{LapType: "lap", LapIndex: 0}
	upsert := func(laps []Lap, points []TimeseriesPoint) {
		t.Helper()
		if err := st.UpsertActivity(ctx, &activity, laps, points, nil); err != nil {
			t.Fatal(err)
		}
	}
	upsert([]Lap{lap}, nil)
	var visits []string
	v := V3EvidenceVisitor{
		Running: func(Activity) bool { return true },
		Reuse:   func(b []byte) bool { visits = append(visits, "reuse"); return string(b) == "ok" },
		Build: func(Activity, []TimeseriesPoint, []Lap) ([]byte, error) {
			visits = append(visits, "build")
			return []byte("ok"), nil
		},
	}
	visit := func(asOf time.Time, version int, want ...string) {
		t.Helper()
		visits = nil
		_, err := st.VisitV3CalibrationWindow(ctx, uid, asOf.AddDate(0, 0, -180), asOf, version, v)
		if err != nil || !reflect.DeepEqual(want, visits) {
			t.Fatalf("want %v, got %v (%v)", want, visits, err)
		}
	}
	for _, date := range []string{"20260302", "20260303", "2026-06-01", "20260601", "2026-06-02", " 20260601"} {
		if err := st.UpsertDailyHealth(ctx, &DailyHealth{UserID: uid, Provider: "test", Date: date, RHR: iptr(50)}); err != nil {
			t.Fatal(err)
		}
	}
	// Both spellings count independently; retain legacy padded rows for
	// parseHealthDay while canonical dates outside the 90-day window drop.
	health, err := st.VisitV3CalibrationWindow(ctx, uid, day, day, 1, V3EvidenceVisitor{Running: func(Activity) bool { return false }})
	if err != nil {
		t.Fatal(err)
	}
	var dates []string
	for _, h := range health {
		dates = append(dates, h.Date)
	}
	sort.Strings(dates)
	if !reflect.DeepEqual(dates, []string{" 20260601", "2026-06-01", "20260303", "20260601"}) {
		t.Fatalf("RHR dates: %v", dates)
	}
	visit(day.AddDate(0, 0, -1), 1)
	visit(day, 1, "build")
	visit(day, 1, "reuse")
	// A Garmin-style partial write preserves both blob and lap content.
	if err := st.UpsertActivityPreservingEmptyChildren(ctx, &activity, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	visit(day, 1, "reuse")
	lap.DurationS = fptr(1800)
	if err := st.UpsertActivityPreservingEmptyChildren(ctx, &activity, []Lap{lap}, nil, nil); err != nil {
		t.Fatal(err)
	}
	visit(day, 1, "build")
	// Update just the samples, then just the activity summary.
	if err := st.UpsertActivityPreservingEmptyChildren(ctx, &activity, nil, []TimeseriesPoint{{HeartRate: iptr(180)}}, nil); err != nil {
		t.Fatal(err)
	}
	visit(day, 1, "build")
	activity.AvgHR = iptr(166)
	if err := st.UpsertActivityPreservingEmptyChildren(ctx, &activity, nil, nil, nil); err != nil {
		t.Fatal(err)
	}
	visit(day, 1, "build")
	// Once a newer format misses, a failed rebuild must leave the old row usable.
	broken := v
	fail := errors.New("failed extraction")
	broken.Build = func(Activity, []TimeseriesPoint, []Lap) ([]byte, error) { return nil, fail }
	if _, err := st.VisitV3CalibrationWindow(ctx, uid, day, day, 2, broken); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	visit(day, 1, "reuse")
	visit(day, 2, "build")
	visit(day.AddDate(0, 0, 180), 2, "reuse")
	visit(day.AddDate(0, 0, 181), 2)
	var count int64
	if err := st.db.Model(&V3CalibrationEvidence{}).Where("user_id=?", uid).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("expired cache count=%d err=%v", count, err)
	}
	// A blob key with no checksum can still be read by the full reader,
	// but two reads under that same key need not have identical content.
	if err := st.db.Model(&Activity{}).Where("user_id=?", uid).UpdateColumn("ts_sha256", nil).Error; err != nil {
		t.Fatal(err)
	}
	visit(day, 2, "build")
	visit(day, 2, "build")
	// A correction can backdate a run into the window. Deleting the source
	// then removes it from consideration immediately, before cache expiry.
	activity.Date = day.AddDate(0, 0, 3)
	upsert(nil, nil)
	visit(day.AddDate(0, 0, 181), 2, "build")
	if err := st.db.Where("user_id=? AND label_id=?", uid, activity.LabelID).Delete(&Activity{}).Error; err != nil {
		t.Fatal(err)
	}
	visit(timefmt.ShanghaiDay(activity.Date), 2)
	if err := st.db.Model(&V3CalibrationEvidence{}).Where("user_id=?", uid).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("deleted activity retained cache count=%d err=%v", count, err)
	}
}
