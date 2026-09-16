package storage

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
)

func i64ptr(v int64) *int64 { return &v }

// assertJSONColumn compares semantically, not as raw text: route_thumb_json is a
// MySQL JSON column, and MySQL re-serializes it on write (`[[5,95],[95,5]]` reads
// back as `[[5, 95], [95, 5]]`). Clients parse it as JSON, so the whitespace is
// irrelevant, but a byte comparison here would fail on a correct value.
func assertJSONColumn(t *testing.T, got *string, want string) {
	t.Helper()
	if got == nil {
		t.Fatalf("column is NULL, want %s", want)
	}
	var gotVal, wantVal any
	if err := json.Unmarshal([]byte(*got), &gotVal); err != nil {
		t.Fatalf("stored value %q is not JSON: %v", *got, err)
	}
	if err := json.Unmarshal([]byte(want), &wantVal); err != nil {
		t.Fatalf("want value %q is not JSON: %v", want, err)
	}
	if !reflect.DeepEqual(gotVal, wantVal) {
		t.Fatalf("column = %s, want %s", *got, want)
	}
}

// seedThumbActivity writes one activity plus a synthetic timeseries. A nil lat/lon
// produces a row that exists but has no GPS fix, which is how the timeseries
// table represents a dropped satellite lock.
func seedThumbActivity(t *testing.T, st *Store, uid, labelID string, gps [][2]float64) {
	t.Helper()
	ctx := context.Background()
	activity := Activity{
		UserID: uid, LabelID: labelID, SportType: 100, Date: time.Now().UTC(),
		Provider: "test", SyncedAt: time.Now().UTC(),
	}
	points := make([]TimeseriesPoint, len(gps))
	for i, p := range gps {
		points[i] = TimeseriesPoint{Timestamp: i64ptr(int64(i))}
		if p[0] != 0 || p[1] != 0 {
			points[i].GPSLat, points[i].GPSLon = fptr(p[0]), fptr(p[1])
		}
	}
	if err := st.UpsertActivity(ctx, &activity, nil, points, nil); err != nil {
		t.Fatalf("upsert %s: %v", labelID, err)
	}
}

func routeThumbCandidateSet(t *testing.T, st *Store, uid string) map[string]bool {
	t.Helper()
	ids, err := st.RouteThumbCandidates(context.Background(), uid)
	if err != nil {
		t.Fatalf("route thumb candidates: %v", err)
	}
	set := make(map[string]bool, len(ids))
	for _, id := range ids {
		set[id] = true
	}
	return set
}

// Candidates are the activities that still have no thumbnail and that have a GPS
// fix to draw. Both halves matter: the first makes a rerun a no-op, the second
// keeps activities with no trace from being re-read on every sync forever.
func TestRouteThumbCandidatesSelectsOnlyOutdoorActivitiesMissingAThumbnail(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	uid := uuid.NewString()
	other := uuid.NewString()
	t.Cleanup(func() {
		for _, u := range []string{uid, other} {
			st.db.WithContext(ctx).Where("user_id = ?", u).Delete(&TimeseriesPoint{})
			st.db.WithContext(ctx).Where("user_id = ?", u).Delete(&Activity{})
		}
	})

	outdoor := [][2]float64{{31.2, 121.4}, {31.2001, 121.4001}}
	seedThumbActivity(t, st, uid, "outdoor", outdoor)
	seedThumbActivity(t, st, uid, "indoor", nil)                               // no timeseries rows at all
	seedThumbActivity(t, st, uid, "gps-dropped", [][2]float64{{0, 0}, {0, 0}}) // rows exist, every fix is NULL
	seedThumbActivity(t, st, other, "someone-else", outdoor)                   // a different athlete

	if got := routeThumbCandidateSet(t, st, uid); len(got) != 1 || !got["outdoor"] {
		t.Fatalf("candidates = %v, want only {outdoor}", got)
	}

	// Recording a thumbnail drops the activity out of the candidate set, which is
	// what makes a routine sync a no-op rather than a full re-render.
	if err := st.SetActivityRouteThumb(ctx, uid, "outdoor", `[[5,95],[95,5]]`, "https://cdn.example/thumbnails/x.png"); err != nil {
		t.Fatalf("set route thumb: %v", err)
	}
	if got := routeThumbCandidateSet(t, st, uid); len(got) != 0 {
		t.Fatalf("after writing a thumbnail, candidates = %v, want none", got)
	}
}

// The write must land both columns: the URL is what the miniprogram renders, the
// polyline is what the web client draws, and the thumbnail job owns both.
func TestSetActivityRouteThumbWritesBothColumns(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	uid := uuid.NewString()
	t.Cleanup(func() {
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&TimeseriesPoint{})
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&Activity{})
	})
	seedThumbActivity(t, st, uid, "run-1", [][2]float64{{31.2, 121.4}})

	const polyline = `[[5,95],[95,5]]`
	const url = "https://cdn.example/thumbnails/run-1.png"
	if err := st.SetActivityRouteThumb(ctx, uid, "run-1", polyline, url); err != nil {
		t.Fatalf("set route thumb: %v", err)
	}

	var row Activity
	if err := st.db.WithContext(ctx).
		Where("user_id = ? AND label_id = ?", uid, "run-1").First(&row).Error; err != nil {
		t.Fatalf("read back: %v", err)
	}
	assertJSONColumn(t, row.RouteThumbJSON, polyline)
	if row.RouteThumbURL == nil || *row.RouteThumbURL != url {
		t.Fatalf("route_thumb_url = %v, want %q", row.RouteThumbURL, url)
	}
}

// A resync must not strip a thumbnail the job already produced. The provider
// payload never carries these columns, and UpdateAll would write their zero
// value over them on every resync.
func TestUpsertActivityPreservesRouteThumbnail(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	if err := st.AutoMigrateWatch(ctx); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	uid := uuid.NewString()
	t.Cleanup(func() {
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&TimeseriesPoint{})
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&Activity{})
	})

	seedThumbActivity(t, st, uid, "run-1", [][2]float64{{31.2, 121.4}, {31.2001, 121.4001}})
	const polyline = `[[5,95],[95,5]]`
	const url = "https://cdn.example/thumbnails/run-1.png"
	if err := st.SetActivityRouteThumb(ctx, uid, "run-1", polyline, url); err != nil {
		t.Fatalf("set route thumb: %v", err)
	}

	// Re-sync the same activity exactly as a provider would: a fresh Activity
	// with no thumbnail fields set, and no child collections.
	resync := Activity{
		UserID: uid, LabelID: "run-1", SportType: 100, Date: time.Now().UTC(),
		Provider: "test", SyncedAt: time.Now().UTC(),
	}
	if err := st.UpsertActivityPreservingEmptyChildren(ctx, &resync, nil, nil, nil); err != nil {
		t.Fatalf("resync: %v", err)
	}

	var row Activity
	if err := st.db.WithContext(ctx).
		Where("user_id = ? AND label_id = ?", uid, "run-1").First(&row).Error; err != nil {
		t.Fatalf("read back: %v", err)
	}
	assertJSONColumn(t, row.RouteThumbJSON, polyline)
	if row.RouteThumbURL == nil || *row.RouteThumbURL != url {
		t.Fatalf("resync wiped route_thumb_url: %v", row.RouteThumbURL)
	}
}
