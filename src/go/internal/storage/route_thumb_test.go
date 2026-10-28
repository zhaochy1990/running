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

// seedThumbActivity writes one activity plus a synthetic timeseries through the
// dual-write upsert, so the has_gps flag is stamped exactly as production
// stamps it. A nil lat/lon produces a payload with no GPS fix — the dropped
// satellite lock case.
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

func routeThumbCandidateSet(t *testing.T, st *Store, uid string, force bool) map[string]bool {
	t.Helper()
	ids, err := st.RouteThumbCandidates(context.Background(), uid, force)
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
	// openBlobTestStore (not openTestStore): the has_gps predicate the query
	// uses since devops#786 is only stamped when a blob backend is injected,
	// and the dual-write through UpsertActivity is what stamps it.
	st, _, uid := openBlobTestStore(t)
	ctx := context.Background()
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
	seedThumbActivity(t, st, uid, "gps-dropped", [][2]float64{{0, 0}, {0, 0}}) // rows exist, every fix is the null island
	seedThumbActivity(t, st, other, "someone-else", outdoor)                   // a different athlete

	if got := routeThumbCandidateSet(t, st, uid, false); len(got) != 1 || !got["outdoor"] {
		t.Fatalf("candidates = %v, want only {outdoor}", got)
	}

	// An activity whose has_gps is still NULL — pre-backfill stock (or a store
	// with no blob backend) — is not a candidate yet: the deployment gate is
	// that the backfill drains before this predicate ships (devops#786 AC3).
	legacy := &Activity{UserID: uid, LabelID: "legacy-null-hasgps", SportType: 100, Date: time.Now().UTC(), Provider: "test", SyncedAt: time.Now().UTC()}
	if err := st.db.WithContext(ctx).Create(legacy).Error; err != nil {
		t.Fatalf("seed legacy row: %v", err)
	}
	legacyPts := []TimeseriesPoint{{UserID: uid, LabelID: "legacy-null-hasgps", Timestamp: i64ptr(1), GPSLat: fptr(31.3), GPSLon: fptr(121.5)}}
	if err := st.db.WithContext(ctx).Create(&legacyPts).Error; err != nil {
		t.Fatalf("seed legacy points: %v", err)
	}
	if got := routeThumbCandidateSet(t, st, uid, false); len(got) != 1 || !got["outdoor"] {
		t.Fatalf("candidates with an unstamped legacy row = %v, want only {outdoor}", got)
	}

	// Recording a thumbnail drops the activity out of the candidate set, which is
	// what makes a routine sync a no-op rather than a full re-render.
	if err := st.SetActivityRouteThumb(ctx, uid, "outdoor", `[[5,95],[95,5]]`, "https://cdn.example/thumbnails/x.png"); err != nil {
		t.Fatalf("set route thumb: %v", err)
	}
	if got := routeThumbCandidateSet(t, st, uid, false); len(got) != 0 {
		t.Fatalf("after writing a thumbnail, candidates = %v, want none", got)
	}

	// force re-selects it, which is how a rendering change gets regenerated. It
	// still excludes activities with no GPS: forcing cannot conjure a trace.
	if got := routeThumbCandidateSet(t, st, uid, true); len(got) != 1 || !got["outdoor"] {
		t.Fatalf("forced candidates = %v, want only {outdoor}", got)
	}
}

// The write must land both columns: the URL is what the miniprogram renders, the
// polyline is what the web client draws, and the thumbnail job owns both.
func TestSetActivityRouteThumbWritesBothColumns(t *testing.T) {
	st, _, uid := openBlobTestStore(t)
	ctx := context.Background()
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
	st, _, uid := openBlobTestStore(t)
	ctx := context.Background()
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

// The shape backfill's candidates key on route_thumb_json, not route_thumb_url
// (devops#830): a row rendered before the dual-write carries a URL but no
// polyline, and it must still be selected — the URL says a PNG exists, not that
// a shape does. Rows without GPS stay out, and a filled shape drops out, which
// is what makes the backfill idempotent.
func TestRouteThumbShapeCandidatesSelectOnlyRowsMissingJSON(t *testing.T) {
	st, _, uid := openBlobTestStore(t)
	ctx := context.Background()
	t.Cleanup(func() {
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&TimeseriesPoint{})
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&Activity{})
	})

	outdoor := [][2]float64{{31.2, 121.4}, {31.2001, 121.4001}}
	seedThumbActivity(t, st, uid, "shape-gap", outdoor)
	seedThumbActivity(t, st, uid, "done", outdoor)
	seedThumbActivity(t, st, uid, "indoor", nil)

	shapeCandidates := func() map[string]bool {
		ids, err := st.RouteThumbShapeCandidates(ctx, uid)
		if err != nil {
			t.Fatalf("route thumb shape candidates: %v", err)
		}
		set := make(map[string]bool, len(ids))
		for _, id := range ids {
			set[id] = true
		}
		return set
	}

	// A row with a URL but no polyline (the pre-dual-write era) is the shape
	// backfill's whole reason to exist — the PNG candidate query skips it.
	if err := st.db.WithContext(ctx).Model(&Activity{}).
		Where("user_id = ? AND label_id = ?", uid, "shape-gap").
		Update("route_thumb_url", "https://cdn.example/thumbnails/shape-gap.png").Error; err != nil {
		t.Fatalf("seed legacy URL: %v", err)
	}
	if err := st.SetActivityRouteThumb(ctx, uid, "done", `[[5,95],[95,5]]`, "https://cdn.example/thumbnails/done.png"); err != nil {
		t.Fatalf("seed finished row: %v", err)
	}

	if got := shapeCandidates(); len(got) != 1 || !got["shape-gap"] {
		t.Fatalf("shape candidates = %v, want only {shape-gap}", got)
	}

	// Filling the shape drops the row out — the idempotency contract.
	if err := st.SetActivityRouteThumbJSON(ctx, uid, "shape-gap", `[[5,95],[95,5]]`); err != nil {
		t.Fatalf("set route thumb json: %v", err)
	}
	if got := shapeCandidates(); len(got) != 0 {
		t.Fatalf("after filling the shape, candidates = %v, want none", got)
	}
}

// The shape write must touch only its own column: a legacy PNG URL already on
// the row is the miniprogram's image until the vector switch, and the
// compute-only backfill must not clobber it.
func TestSetActivityRouteThumbJSONPreservesURL(t *testing.T) {
	st, _, uid := openBlobTestStore(t)
	ctx := context.Background()
	t.Cleanup(func() {
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&TimeseriesPoint{})
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&Activity{})
	})
	seedThumbActivity(t, st, uid, "png-era", [][2]float64{{31.2, 121.4}})

	const url = "https://cdn.example/thumbnails/png-era.png"
	if err := st.db.WithContext(ctx).Model(&Activity{}).
		Where("user_id = ? AND label_id = ?", uid, "png-era").
		Update("route_thumb_url", url).Error; err != nil {
		t.Fatalf("seed legacy URL: %v", err)
	}

	const shape = `[[5,95],[95,5]]`
	if err := st.SetActivityRouteThumbJSON(ctx, uid, "png-era", shape); err != nil {
		t.Fatalf("set route thumb json: %v", err)
	}

	var row Activity
	if err := st.db.WithContext(ctx).
		Where("user_id = ? AND label_id = ?", uid, "png-era").First(&row).Error; err != nil {
		t.Fatalf("read back: %v", err)
	}
	assertJSONColumn(t, row.RouteThumbJSON, shape)
	if row.RouteThumbURL == nil || *row.RouteThumbURL != url {
		t.Fatalf("route_thumb_url = %v, want %q preserved", row.RouteThumbURL, url)
	}
}
