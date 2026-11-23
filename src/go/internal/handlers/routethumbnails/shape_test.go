package routethumbnails

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/storage"
	"github.com/zhaochy1990/stride/internal/thumbnail"
)

const testUser = "f10bc353-01ab-4db1-af9f-d9305ea9a532"

// legacyV1Shape is a stored v1 single-polyline array, the pre-upgrade
// serialization historical rows carry.
var legacyV1Shape = `[[5.0,95.0],[95.0,5.0]]`

// fakeShapeStore mirrors the storage semantics the handlers rely on: the sync
// step's candidate list is derived from which rows still have no
// route_thumb_json, the backfill's from which rows hold a shape older than the
// current algorithm version (a NULL counts, so does a v1 array), and both
// writes change what the next run sees — which is exactly the idempotency
// contract under test.
type fakeShapeStore struct {
	timeseries map[string][]storage.TimeseriesPoint
	// rows holds every activity; nil = route_thumb_json still missing.
	rows map[string]*string
	// dates is the activity date per row, in Shanghai YYYY-MM-DD form, for
	// the recompute window filter.
	dates       map[string]string
	failPersist map[string]error

	gotScope storage.RouteThumbRecomputeScope
	// calls counts every store method invocation: a payload the backfill
	// refuses must leave it at zero.
	calls int
}

func (f *fakeShapeStore) RouteThumbShapeCandidates(_ context.Context, _ string) ([]string, error) {
	f.calls++
	var ids []string
	for id, shape := range f.rows {
		if shape == nil {
			ids = append(ids, id)
		}
	}
	return ids, nil
}

// RouteThumbRecomputeCandidates mirrors the storage predicate: a row is stale
// when its stored shape's version is below the current one (absent counts),
// and a date window drops rows outside it.
func (f *fakeShapeStore) RouteThumbRecomputeCandidates(_ context.Context, _ string, scope storage.RouteThumbRecomputeScope) ([]string, error) {
	f.calls++
	f.gotScope = scope
	var ids []string
	for id, shape := range f.rows {
		if shape != nil && *shape != "" {
			var probe struct {
				V int `json:"v"`
			}
			if err := json.Unmarshal([]byte(*shape), &probe); err == nil && probe.V >= thumbnail.ShapeVersion {
				continue // current (or newer) version: not a recompute candidate
			}
		}
		if scope.DateFrom != "" && f.dates[id] < scope.DateFrom {
			continue
		}
		if scope.DateTo != "" && f.dates[id] > scope.DateTo {
			continue
		}
		ids = append(ids, id)
	}
	return ids, nil
}

func (f *fakeShapeStore) ActivityTimeseries(_ context.Context, _, labelID string) ([]storage.TimeseriesPoint, error) {
	f.calls++
	return f.timeseries[labelID], nil
}

func (f *fakeShapeStore) SetActivityRouteThumbJSON(_ context.Context, _, labelID, thumbJSON string) error {
	f.calls++
	if err := f.failPersist[labelID]; err != nil {
		return err
	}
	f.rows[labelID] = &thumbJSON
	return nil
}

// gpsTrace builds a walkable trace: enough distinct fixes to clear
// MinGPSSamples, spread far enough that the shape has non-zero extent.
// Timestamps are centiseconds, the storage unit — one per index, so
// consecutive fixes sit 0.01 s apart and never split the trace.
func gpsTrace(n int) []storage.TimeseriesPoint {
	points := make([]storage.TimeseriesPoint, n)
	for i := range n {
		lat, lon := 31.20+float64(i)*0.0005, 121.40+float64(i)*0.0005
		points[i] = storage.TimeseriesPoint{
			Timestamp: int64Pointer(int64(i)), GPSLat: float64Pointer(lat), GPSLon: float64Pointer(lon),
		}
	}
	return points
}

// gapTrace builds a 20-fix trace whose middle interval is gapCentiseconds
// centiseconds long: fixes 0..9 walk one street, fixes 10..19 walk another,
// and the two halves are offset so both survive as drawn ground.
func gapTrace(gapCentiseconds int64) []storage.TimeseriesPoint {
	points := make([]storage.TimeseriesPoint, 20)
	ts := int64(0)
	for i := range points {
		if i == 10 {
			ts += gapCentiseconds
		} else if i > 0 {
			ts += 100 // 1 s per fix otherwise
		}
		lat, lon := 31.20+float64(i%10)*0.0005, 121.40+float64(i)*0.0005
		points[i] = storage.TimeseriesPoint{
			Timestamp: int64Pointer(ts), GPSLat: float64Pointer(lat), GPSLon: float64Pointer(lon),
		}
	}
	return points
}

func noopHeartbeat(string, int) error { return nil }

func int64Pointer(v int64) *int64       { return &v }
func float64Pointer(v float64) *float64 { return &v }

func runShapeBackfill(t *testing.T, store *fakeShapeStore, inputJSON string) string {
	t.Helper()
	h := NewShapeBackfill(store)
	result, err := h(context.Background(), &job.Job{UserID: testUser, InputJSON: inputJSON}, noopHeartbeat)
	if err != nil {
		t.Fatalf("shape backfill: %v", err)
	}
	return result
}

func decodeShapeResult(t *testing.T, result string) shapeResult {
	t.Helper()
	var got shapeResult
	if err := json.Unmarshal([]byte(result), &got); err != nil {
		t.Fatalf("decode result %s: %v", result, err)
	}
	return got
}

// rejectShapeBackfill runs the backfill over a payload it must refuse: the job
// has to fail with a permanent bad_payload and must not have touched the store
// on the way. It returns the permanent error for message assertions.
func rejectShapeBackfill(t *testing.T, store *fakeShapeStore, inputJSON string) *job.PermanentError {
	t.Helper()
	_, err := NewShapeBackfill(store)(context.Background(), &job.Job{UserID: testUser, InputJSON: inputJSON}, noopHeartbeat)
	pe, ok := job.AsPermanent(err)
	if !ok || pe.Code != "bad_payload" {
		t.Fatalf("input %s: err = %v, want permanent bad_payload", inputJSON, err)
	}
	if store.calls != 0 {
		t.Fatalf("input %s: rejected payload reached the store (%d calls)", inputJSON, store.calls)
	}
	return pe
}

// decodeStoredV2 decodes a stored shape with the production decoder and fails
// the test if the row is not a valid current-version object.
func decodeStoredV2(t *testing.T, id string, stored *string) *thumbnail.ShapeV2 {
	t.Helper()
	if stored == nil {
		t.Fatalf("activity %s still has no route_thumb_json", id)
	}
	shape, err := thumbnail.DecodeV2(*stored)
	if err != nil {
		t.Fatalf("activity %s shape %q is not a v2 shape: %v", id, *stored, err)
	}
	return shape
}

// The happy path: every drawable candidate gets a shape written, and the stored
// value satisfies the acceptance contract — a current-version multi-stroke
// object whose total vertex count stays inside the budget and whose
// coordinates stay inside the [0,Viewbox] frame.
func TestShapeBackfillFillsMissingShapes(t *testing.T) {
	trace := gpsTrace(40)
	store := &fakeShapeStore{
		timeseries: map[string][]storage.TimeseriesPoint{
			"old-run": trace,
			"png-era": trace, // already has a URL, still no shape: still a candidate
		},
		rows: map[string]*string{"old-run": nil, "png-era": nil},
	}

	got := decodeShapeResult(t, runShapeBackfill(t, store, ""))
	if got.Candidates != 2 || got.Generated != 2 || got.NoGPS != 0 || got.Failed != 0 {
		t.Fatalf("result = %+v, want 2 candidates generated, nothing skipped or failed", got)
	}
	if got.Version != thumbnail.ShapeVersion {
		t.Fatalf("result version = %d, want %d", got.Version, thumbnail.ShapeVersion)
	}

	for _, id := range []string{"old-run", "png-era"} {
		shape := decodeStoredV2(t, id, store.rows[id])
		if shape.TotalPoints() == 0 || shape.TotalPoints() > thumbnail.TargetPoints {
			t.Fatalf("activity %s has %d points, want 1..%d", id, shape.TotalPoints(), thumbnail.TargetPoints)
		}
		for _, stroke := range shape.Strokes {
			for _, p := range stroke {
				if p.X < 0 || p.X > float64(thumbnail.Viewbox) || p.Y < 0 || p.Y > float64(thumbnail.Viewbox) {
					t.Fatalf("activity %s point (%v,%v) outside the [0,%d] viewbox", id, p.X, p.Y, thumbnail.Viewbox)
				}
			}
		}
	}
}

// The v2 gap rule is wired through the centisecond storage timestamps: a
// 31-second interval (3100 cs) splits the trace into two strokes, a 29-second
// one (2900 cs) does not. If the /100 conversion were lost, both would split
// (or neither would), so this pins the unit handoff between storage and the
// algorithm.
func TestShapeBackfillSplitsTraceAtGPSGapSeconds(t *testing.T) {
	for _, tc := range []struct {
		gapCentiseconds int64
		wantStrokes     int
	}{
		{gapCentiseconds: 2900, wantStrokes: 1}, // 29 s: below the split threshold
		{gapCentiseconds: 3100, wantStrokes: 2}, // 31 s: above it
	} {
		store := &fakeShapeStore{
			timeseries: map[string][]storage.TimeseriesPoint{"gap-run": gapTrace(tc.gapCentiseconds)},
			rows:       map[string]*string{"gap-run": nil},
		}
		decodeShapeResult(t, runShapeBackfill(t, store, ""))
		shape := decodeStoredV2(t, "gap-run", store.rows["gap-run"])
		if len(shape.Strokes) != tc.wantStrokes {
			t.Fatalf("gap %d cs = %d strokes, want %d", tc.gapCentiseconds, len(shape.Strokes), tc.wantStrokes)
		}
	}
}

// A trace with no timestamps at all (all NULL) must still produce one shape:
// an unknown interval is not a long interval, so the v2 reduction never splits.
func TestShapeBackfillTraceWithoutTimestampsDoesNotSplit(t *testing.T) {
	points := gpsTrace(20)
	for i := range points {
		points[i].Timestamp = nil
	}
	store := &fakeShapeStore{
		timeseries: map[string][]storage.TimeseriesPoint{"no-ts": points},
		rows:       map[string]*string{"no-ts": nil},
	}
	decodeShapeResult(t, runShapeBackfill(t, store, ""))
	shape := decodeStoredV2(t, "no-ts", store.rows["no-ts"])
	if len(shape.Strokes) != 1 {
		t.Fatalf("timestamp-less trace = %d strokes, want 1", len(shape.Strokes))
	}
}

// Activities whose trace has too few valid fixes are counted and skipped
// WITHOUT a write: the column keeps meaning "a drawable shape", so the client
// keeps its icon fallback and a rerun sees the row again.
func TestShapeBackfillSkipsUndrawableTraceWithoutWriting(t *testing.T) {
	store := &fakeShapeStore{
		timeseries: map[string][]storage.TimeseriesPoint{
			"short":    gpsTrace(thumbnail.MinGPSSamples - 1),
			"drawable": gpsTrace(30),
		},
		rows: map[string]*string{"short": nil, "drawable": nil},
	}

	got := decodeShapeResult(t, runShapeBackfill(t, store, ""))
	if got.Candidates != 2 || got.Generated != 1 || got.NoGPS != 1 {
		t.Fatalf("result = %+v, want 1 generated 1 no_gps", got)
	}
	if store.rows["short"] != nil {
		t.Fatalf("undrawable activity was written: %q", *store.rows["short"])
	}
}

// The recompute candidate set is what makes the backfill a version upgrade:
// a NULL row and a legacy v1 row are both selected, a row already holding the
// current version is not. After the run everything carries the current
// version, so a rerun sees no candidates and writes nothing — the idempotency
// contract.
func TestShapeBackfillRecomputesStaleVersionsIdempotently(t *testing.T) {
	v1 := legacyV1Shape
	v2 := `{"v":2,"strokes":[[5.0,95.0],[95.0,5.0]],"start":[5.0,95.0],"end":[95.0,5.0],"short":10.0,"long":90.0,"travel":127.3}`
	store := &fakeShapeStore{
		timeseries: map[string][]storage.TimeseriesPoint{
			"missing": gpsTrace(20),
			"legacy":  gpsTrace(20),
			"current": gpsTrace(20),
		},
		rows: map[string]*string{"missing": nil, "legacy": &v1, "current": &v2},
	}

	got := decodeShapeResult(t, runShapeBackfill(t, store, ""))
	if got.Candidates != 2 || got.Generated != 2 {
		t.Fatalf("result = %+v, want the NULL and v1 rows recomputed (2 candidates), the v2 row left alone", got)
	}
	decodeStoredV2(t, "legacy", store.rows["legacy"])

	if got := decodeShapeResult(t, runShapeBackfill(t, store, "")); got.Candidates != 0 || got.Generated != 0 {
		t.Fatalf("rerun = %+v, want zero candidates — the recompute is not idempotent", got)
	}
}

// The date window narrows the recompute: rows outside [from,to] keep their
// stale shape this run, rows inside are upgraded, and the scope reaches the
// store verbatim.
func TestShapeBackfillHonorsDateWindow(t *testing.T) {
	store := &fakeShapeStore{
		timeseries: map[string][]storage.TimeseriesPoint{
			"october":  gpsTrace(20),
			"november": gpsTrace(20),
		},
		rows:  map[string]*string{"october": nil, "november": nil},
		dates: map[string]string{"october": "2026-10-05", "november": "2026-11-20"},
	}

	got := decodeShapeResult(t, runShapeBackfill(t, store, `{"date_from":"2026-11-01","date_to":"2026-11-30"}`))
	if got.Candidates != 1 || got.Generated != 1 {
		t.Fatalf("result = %+v, want only the November row in the window", got)
	}
	if store.rows["october"] != nil {
		t.Fatal("out-of-window row was recomputed")
	}
	decodeStoredV2(t, "november", store.rows["november"])
	if store.gotScope.DateFrom != "2026-11-01" || store.gotScope.DateTo != "2026-11-30" {
		t.Fatalf("scope forwarded = %+v, want the parsed window", store.gotScope)
	}

	// Rerunning the very same window is the documented no-op: the November row
	// now carries the current version and drops out of the candidate set.
	if got := decodeShapeResult(t, runShapeBackfill(t, store, `{"date_from":"2026-11-01","date_to":"2026-11-30"}`)); got.Candidates != 0 || got.Generated != 0 {
		t.Fatalf("rerun over the same window = %+v, want a no-op", got)
	}
	if store.rows["october"] != nil {
		t.Fatal("rerun over the same window reached the out-of-window row")
	}
}

// Both spellings of the empty payload mean an explicit full recompute of the
// athlete's stale set: no input at all (what the other empty-payload tests
// send), and a bare object. {} carries no key the unknown-key guard could
// refuse, and it must stay the unbounded request rather than become a
// rejection.
func TestShapeBackfillEmptyObjectIsAFullRecompute(t *testing.T) {
	store := &fakeShapeStore{
		timeseries: map[string][]storage.TimeseriesPoint{"october": gpsTrace(20), "november": gpsTrace(20)},
		rows:       map[string]*string{"october": nil, "november": nil},
		dates:      map[string]string{"october": "2026-10-05", "november": "2026-11-20"},
	}

	got := decodeShapeResult(t, runShapeBackfill(t, store, `{}`))
	if got.Candidates != 2 || got.Generated != 2 {
		t.Fatalf("result = %+v, want every stale row recomputed regardless of date", got)
	}
	decodeStoredV2(t, "october", store.rows["october"])
	decodeStoredV2(t, "november", store.rows["november"])
}

// A malformed window fails permanently instead of quietly matching nothing.
func TestShapeBackfillRejectsBadDateWindow(t *testing.T) {
	store := &fakeShapeStore{}
	for _, in := range []string{`{"date_from":"2026/11/01"}`, `{"date_to":"not-a-date"}`, `{"date_from":"2026-13-01"}`, `{"date_from":`} {
		rejectShapeBackfill(t, store, in)
	}
}

// A reversed window (date_from later than date_to) matches no rows, so before
// the order guard the job "succeeded" with zero candidates — indistinguishable
// from the documented no-op rerun over the same window. It is an operator error:
// fail permanently, before anything is read or written.
func TestShapeBackfillRejectsReversedDateWindow(t *testing.T) {
	store := &fakeShapeStore{
		timeseries: map[string][]storage.TimeseriesPoint{"stale-run": gpsTrace(20)},
		rows:       map[string]*string{"stale-run": nil},
		dates:      map[string]string{"stale-run": "2026-11-20"},
	}
	pe := rejectShapeBackfill(t, store, `{"date_from":"2026-12-31","date_to":"2026-01-01"}`)
	if pe.Error() != "route shapes: date_from must not be after date_to" {
		t.Fatalf("err = %q, want the reversed-window message", pe.Error())
	}
}

// Equal bounds are a single-day window, not a reversed one: the order guard is
// strictly greater-than, so a one-day recompute still runs.
func TestShapeBackfillAcceptsSingleDayWindow(t *testing.T) {
	store := &fakeShapeStore{
		timeseries: map[string][]storage.TimeseriesPoint{"that-day": gpsTrace(20), "next-day": gpsTrace(20)},
		rows:       map[string]*string{"that-day": nil, "next-day": nil},
		dates:      map[string]string{"that-day": "2026-11-20", "next-day": "2026-11-21"},
	}

	got := decodeShapeResult(t, runShapeBackfill(t, store, `{"date_from":"2026-11-20","date_to":"2026-11-20"}`))
	if got.Candidates != 1 || got.Generated != 1 {
		t.Fatalf("result = %+v, want only the row on 2026-11-20 recomputed", got)
	}
	decodeStoredV2(t, "that-day", store.rows["that-day"])
	if store.rows["next-day"] != nil {
		t.Fatal("row outside the single-day window was recomputed")
	}
}

// Unknown keys are refused, not dropped. A plain Unmarshal ignores them, so a
// mistyped window (from/to) would decode as the empty payload — whose meaning
// is "recompute the whole stale set" — and one typo would turn a bounded
// recompute into an unbounded one. The message names every offending key and
// only those: the recognized keys next to them are not reported.
func TestShapeBackfillRejectsUnknownInputKeys(t *testing.T) {
	for _, tc := range []struct{ input, wantMessage string }{
		{`{"from":"2026-11-01","to":"2026-11-03"}`, "route shapes: unknown keys: from, to (accepted: date_from, date_to)"},
		{`{"date_from":"2026-11-01","date_to":"2026-11-03","dry_run":true}`, "route shapes: unknown keys: dry_run (accepted: date_from, date_to)"},
	} {
		store := &fakeShapeStore{
			timeseries: map[string][]storage.TimeseriesPoint{"stale-run": gpsTrace(20)},
			rows:       map[string]*string{"stale-run": nil},
			dates:      map[string]string{"stale-run": "2026-11-02"},
		}
		pe := rejectShapeBackfill(t, store, tc.input)
		if pe.Error() != tc.wantMessage {
			t.Fatalf("input %s: err = %q, want %q", tc.input, pe.Error(), tc.wantMessage)
		}
	}
}

// Partial success, matching the PNG handler: one failing activity fails the job
// with the per-activity error, but the result still reports what did land and
// the successful write stays written.
func TestShapeBackfillReportsFailuresButKeepsSuccesses(t *testing.T) {
	wantErr := errors.New("cynosdb went away")
	store := &fakeShapeStore{
		timeseries: map[string][]storage.TimeseriesPoint{
			"doomed": gpsTrace(20),
			"fine":   gpsTrace(20),
		},
		rows:        map[string]*string{"doomed": nil, "fine": nil},
		failPersist: map[string]error{"doomed": wantErr},
	}

	h := NewShapeBackfill(store)
	result, err := h(context.Background(), &job.Job{UserID: testUser}, noopHeartbeat)
	if err == nil || !strings.Contains(err.Error(), "doomed") || !errors.Is(err, wantErr) {
		t.Fatalf("err = %v, want the doomed activity's error joined in", err)
	}
	got := decodeShapeResult(t, result)
	if got.Generated != 1 || got.Failed != 1 {
		t.Fatalf("result = %+v, want 1 generated 1 failed", got)
	}
	if store.rows["fine"] == nil {
		t.Fatal("the successful activity must stay written despite the sibling failure")
	}
}

// A malformed partition fails permanently rather than retrying a doomed scan.
func TestShapeBackfillRejectsNonUUIDUser(t *testing.T) {
	h := NewShapeBackfill(&fakeShapeStore{})
	_, err := h(context.Background(), &job.Job{UserID: "not-a-uuid"}, noopHeartbeat)
	pe, ok := job.AsPermanent(err)
	if !ok || pe.Code != "bad_partition" {
		t.Fatalf("err = %v, want permanent bad_partition", err)
	}
}

// The sync step must stay a gap fill, not a historical rewrite: a legacy v1
// row next to a missing one is left alone, so version upgrades happen only
// through the operator-triggered backfill (devops#1037).
func TestShapesStepDoesNotUpgradeStaleVersions(t *testing.T) {
	v1 := legacyV1Shape
	store := &fakeShapeStore{
		timeseries: map[string][]storage.TimeseriesPoint{
			"legacy": gpsTrace(20),
			"fresh":  gpsTrace(20),
		},
		rows: map[string]*string{"legacy": &v1, "fresh": nil},
	}

	h := NewShapes(store)
	result, err := h(context.Background(), &job.Job{UserID: testUser}, noopHeartbeat)
	if err != nil {
		t.Fatalf("shapes step: %v", err)
	}
	got := decodeShapeResult(t, result)
	if got.Candidates != 1 || got.Generated != 1 {
		t.Fatalf("result = %+v, want only the missing row filled", got)
	}
	if store.rows["legacy"] == nil || *store.rows["legacy"] != legacyV1Shape {
		t.Fatalf("sync step rewrote the legacy row: %v", store.rows["legacy"])
	}
	decodeStoredV2(t, "fresh", store.rows["fresh"])
}

// The stored v2 object carries what the activity list needs to replay the
// shape: the real start and end fix, and the width metrics a client combines
// with its display size.
func TestShapeBackfillShapeCarriesEndpointsAndWidthMetrics(t *testing.T) {
	store := &fakeShapeStore{
		timeseries: map[string][]storage.TimeseriesPoint{"run": gpsTrace(30)},
		rows:       map[string]*string{"run": nil},
	}
	decodeShapeResult(t, runShapeBackfill(t, store, ""))
	shape := decodeStoredV2(t, "run", store.rows["run"])

	for _, p := range []thumbnail.Point{shape.Start, shape.End} {
		if p.X < 0 || p.X > float64(thumbnail.Viewbox) || p.Y < 0 || p.Y > float64(thumbnail.Viewbox) {
			t.Fatalf("endpoint (%v,%v) outside the viewbox", p.X, p.Y)
		}
	}
	if shape.Long <= 0 || shape.Short < 0 || shape.Short > shape.Long || shape.Travel <= 0 {
		t.Fatalf("width metrics = short %v long %v travel %v, want 0<=short<=long, positive long/travel",
			shape.Short, shape.Long, shape.Travel)
	}
	if w := thumbnail.StrokeWidth(36, shape.Short, shape.Long, shape.Travel); w <= 0 || w > 36.0/30 {
		t.Fatalf("stroke width at 36 px = %v, want (0, 1.2]", w)
	}
}
