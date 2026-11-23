package storage

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"
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
	seedThumbActivityAt(t, st, uid, labelID, gps, time.Now().UTC())
}

// seedThumbActivityAt is seedThumbActivity with a pinned activity date, for
// queries that filter on the Shanghai day.
func seedThumbActivityAt(t *testing.T, st *Store, uid, labelID string, gps [][2]float64, date time.Time) {
	t.Helper()
	ctx := context.Background()
	activity := Activity{
		UserID: uid, LabelID: labelID, SportType: 100, Date: date,
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

// seedLegacyThumbURL stamps a route_thumb_url the way the retired PNG pipeline
// left it (devops#829): the column is frozen legacy now, so tests that need one
// write it directly instead of through a store method.
func seedLegacyThumbURL(t *testing.T, st *Store, uid, labelID, url string) {
	t.Helper()
	if err := st.db.WithContext(context.Background()).Model(&Activity{}).
		Where("user_id = ? AND label_id = ?", uid, labelID).
		Update("route_thumb_url", url).Error; err != nil {
		t.Fatalf("seed legacy URL: %v", err)
	}
}

// A resync must not strip the shape the route_shapes step already produced, nor
// resurrect or clear the frozen legacy URL column. The provider payload never
// carries these columns, and UpdateAll would write their zero value over them
// on every resync.
func TestUpsertActivityPreservesRouteThumbColumns(t *testing.T) {
	st, _, uid := openBlobTestStore(t)
	ctx := context.Background()
	t.Cleanup(func() {
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&Activity{})
	})

	seedThumbActivity(t, st, uid, "run-1", [][2]float64{{31.2, 121.4}, {31.2001, 121.4001}})
	const polyline = `[[5,95],[95,5]]`
	const url = "https://cdn.example/thumbnails/run-1.png"
	if err := st.SetActivityRouteThumbJSON(ctx, uid, "run-1", polyline); err != nil {
		t.Fatalf("set route thumb json: %v", err)
	}
	seedLegacyThumbURL(t, st, uid, "run-1", url)

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

// The shape candidates key on route_thumb_json, not route_thumb_url
// (devops#830): a row rendered before the dual-write carries a URL but no
// polyline, and it must still be selected — the URL says a PNG exists, not that
// a shape does. Rows without GPS stay out, and a filled shape drops out, which
// is what makes the fill idempotent for both the sync step and the backfill.
func TestRouteThumbShapeCandidatesSelectOnlyRowsMissingJSON(t *testing.T) {
	st, _, uid := openBlobTestStore(t)
	ctx := context.Background()
	t.Cleanup(func() {
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
	// fill's whole reason to exist — a URL-keyed query would skip it.
	seedLegacyThumbURL(t, st, uid, "shape-gap", "https://cdn.example/thumbnails/shape-gap.png")
	if err := st.SetActivityRouteThumbJSON(ctx, uid, "done", `[[5,95],[95,5]]`); err != nil {
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
// the row is an old client's image until the long tail dies out, and no writer
// may clobber it — after the retirement nothing writes the URL column at all.
func TestSetActivityRouteThumbJSONPreservesURL(t *testing.T) {
	st, _, uid := openBlobTestStore(t)
	ctx := context.Background()
	t.Cleanup(func() {
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&Activity{})
	})
	seedThumbActivity(t, st, uid, "png-era", [][2]float64{{31.2, 121.4}})

	const url = "https://cdn.example/thumbnails/png-era.png"
	seedLegacyThumbURL(t, st, uid, "png-era", url)

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

// A v2 object as the worker writes it (EncodeV2's format). MySQL re-serializes
// JSON columns on write, so what matters for the recompute predicate is the
// "v" member, not the byte form.
const v2ShapeJSON = `{"v":2,"strokes":[[[5.0,95.0],[95.0,5.0]]],"start":[5.0,95.0],"end":[95.0,5.0],"short":10.0,"long":90.0,"travel":127.3}`

// The recompute candidates key on the stored shape's version (devops#1037):
// a NULL shape and a legacy v1 array are both stale, a current-version object
// is not, and rows without GPS stay out. Upgrading the stale rows empties the
// candidate set — the recompute's idempotency contract at the SQL level.
func TestRouteThumbRecomputeCandidatesSelectStaleVersions(t *testing.T) {
	st, _, uid := openBlobTestStore(t)
	ctx := context.Background()
	t.Cleanup(func() {
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&Activity{})
	})

	outdoor := [][2]float64{{31.2, 121.4}, {31.2001, 121.4001}}
	seedThumbActivity(t, st, uid, "never-filled", outdoor)
	seedThumbActivity(t, st, uid, "legacy-v1", outdoor)
	seedThumbActivity(t, st, uid, "current-v2", outdoor)
	seedThumbActivity(t, st, uid, "indoor", nil)
	if err := st.SetActivityRouteThumbJSON(ctx, uid, "legacy-v1", `[[5,95],[95,5]]`); err != nil {
		t.Fatalf("seed v1 shape: %v", err)
	}
	if err := st.SetActivityRouteThumbJSON(ctx, uid, "current-v2", v2ShapeJSON); err != nil {
		t.Fatalf("seed v2 shape: %v", err)
	}

	candidateSet := func() map[string]bool {
		ids, err := st.RouteThumbRecomputeCandidates(ctx, uid, RouteThumbRecomputeScope{})
		if err != nil {
			t.Fatalf("recompute candidates: %v", err)
		}
		set := make(map[string]bool, len(ids))
		for _, id := range ids {
			set[id] = true
		}
		return set
	}

	if got := candidateSet(); len(got) != 2 || !got["never-filled"] || !got["legacy-v1"] {
		t.Fatalf("recompute candidates = %v, want {never-filled, legacy-v1}", got)
	}

	for _, id := range []string{"never-filled", "legacy-v1"} {
		if err := st.SetActivityRouteThumbJSON(ctx, uid, id, v2ShapeJSON); err != nil {
			t.Fatalf("upgrade %s: %v", id, err)
		}
	}
	if got := candidateSet(); len(got) != 0 {
		t.Fatalf("after upgrading, recompute candidates = %v, want none", got)
	}
}

// The recompute window narrows the candidate set by Shanghai activity day —
// the same convention the activity list's date_from/date_to use.
func TestRouteThumbRecomputeCandidatesHonorDateWindow(t *testing.T) {
	st, _, uid := openBlobTestStore(t)
	ctx := context.Background()
	t.Cleanup(func() {
		st.db.WithContext(ctx).Where("user_id = ?", uid).Delete(&Activity{})
	})

	outdoor := [][2]float64{{31.2, 121.4}, {31.2001, 121.4001}}
	// 01:00 UTC = 09:00 Shanghai the same day, so the Shanghai day is the
	// pinned date regardless of when the test runs.
	seedThumbActivityAt(t, st, uid, "october", outdoor, time.Date(2026, 10, 5, 1, 0, 0, 0, time.UTC))
	seedThumbActivityAt(t, st, uid, "november", outdoor, time.Date(2026, 11, 5, 1, 0, 0, 0, time.UTC))
	seedThumbActivityAt(t, st, uid, "december", outdoor, time.Date(2026, 12, 5, 1, 0, 0, 0, time.UTC))

	ids, err := st.RouteThumbRecomputeCandidates(ctx, uid, RouteThumbRecomputeScope{
		DateFrom: "2026-11-01", DateTo: "2026-11-30",
	})
	if err != nil {
		t.Fatalf("recompute candidates: %v", err)
	}
	if len(ids) != 1 || ids[0] != "november" {
		t.Fatalf("windowed recompute candidates = %v, want [november]", ids)
	}

	// One-sided windows bound only the side they name.
	ids, err = st.RouteThumbRecomputeCandidates(ctx, uid, RouteThumbRecomputeScope{DateFrom: "2026-11-01"})
	if err != nil {
		t.Fatalf("recompute candidates: %v", err)
	}
	if len(ids) != 2 || ids[0] != "december" || ids[1] != "november" {
		t.Fatalf("since-November candidates = %v, want [december november] (date DESC)", ids)
	}
}
