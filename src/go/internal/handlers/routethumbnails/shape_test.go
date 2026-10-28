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

// fakeShapeStore mirrors the storage semantics the handler relies on: the
// candidate list is derived from which rows still have no route_thumb_json, so
// writes made by one run change what the next run sees — which is exactly the
// idempotency contract under test.
type fakeShapeStore struct {
	timeseries map[string][]storage.TimeseriesPoint
	// rows holds every activity; nil = route_thumb_json still missing.
	rows        map[string]*string
	failPersist map[string]error
}

func (f *fakeShapeStore) RouteThumbShapeCandidates(_ context.Context, _ string) ([]string, error) {
	var ids []string
	for id, shape := range f.rows {
		if shape == nil {
			ids = append(ids, id)
		}
	}
	return ids, nil
}

func (f *fakeShapeStore) ActivityTimeseries(_ context.Context, _, labelID string) ([]storage.TimeseriesPoint, error) {
	return f.timeseries[labelID], nil
}

func (f *fakeShapeStore) SetActivityRouteThumbJSON(_ context.Context, _, labelID, thumbJSON string) error {
	if err := f.failPersist[labelID]; err != nil {
		return err
	}
	f.rows[labelID] = &thumbJSON
	return nil
}

// gpsTrace builds a walkable trace: enough distinct fixes to clear
// MinGPSSamples, spread far enough that the shape has non-zero extent.
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

func noopHeartbeat(string, int) error { return nil }

func runShapeBackfill(t *testing.T, store *fakeShapeStore) string {
	t.Helper()
	h := NewShapeBackfill(store)
	result, err := h(context.Background(), &job.Job{UserID: testUser}, noopHeartbeat)
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

// The happy path: every drawable candidate gets a shape written, and the stored
// value satisfies the acceptance contract — a JSON polyline of at most
// TargetPoints points inside the [0,Viewbox] frame.
func TestShapeBackfillFillsMissingShapes(t *testing.T) {
	trace := gpsTrace(40)
	store := &fakeShapeStore{
		timeseries: map[string][]storage.TimeseriesPoint{
			"old-run": trace,
			"png-era": trace, // already has a URL, still no shape: still a candidate
		},
		rows: map[string]*string{"old-run": nil, "png-era": nil},
	}

	got := decodeShapeResult(t, runShapeBackfill(t, store))
	if got.Candidates != 2 || got.Generated != 2 || got.NoGPS != 0 || got.Failed != 0 {
		t.Fatalf("result = %+v, want 2 candidates generated, nothing skipped or failed", got)
	}

	for _, id := range []string{"old-run", "png-era"} {
		shape := store.rows[id]
		if shape == nil {
			t.Fatalf("activity %s still has no route_thumb_json", id)
		}
		var points [][2]float64
		if err := json.Unmarshal([]byte(*shape), &points); err != nil {
			t.Fatalf("activity %s shape %q is not a polyline: %v", id, *shape, err)
		}
		if len(points) == 0 || len(points) > thumbnail.TargetPoints {
			t.Fatalf("activity %s has %d points, want 1..%d", id, len(points), thumbnail.TargetPoints)
		}
		for _, p := range points {
			for _, v := range p {
				if v < 0 || v > float64(thumbnail.Viewbox) {
					t.Fatalf("activity %s point %v outside the [0,%d] viewbox", id, p, thumbnail.Viewbox)
				}
			}
		}
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

	got := decodeShapeResult(t, runShapeBackfill(t, store))
	if got.Candidates != 2 || got.Generated != 1 || got.NoGPS != 1 {
		t.Fatalf("result = %+v, want 1 generated 1 no_gps", got)
	}
	if store.rows["short"] != nil {
		t.Fatalf("undrawable activity was written: %q", *store.rows["short"])
	}
}

// The candidate query is what makes the job idempotent: after a run drains the
// gaps, a rerun sees no candidates and writes nothing.
func TestShapeBackfillRerunIsANoop(t *testing.T) {
	store := &fakeShapeStore{
		timeseries: map[string][]storage.TimeseriesPoint{"old-run": gpsTrace(20)},
		rows:       map[string]*string{"old-run": nil},
	}
	if got := decodeShapeResult(t, runShapeBackfill(t, store)); got.Generated != 1 {
		t.Fatalf("first run = %+v, want 1 generated", got)
	}

	if got := decodeShapeResult(t, runShapeBackfill(t, store)); got.Candidates != 0 || got.Generated != 0 {
		t.Fatalf("rerun = %+v, want zero candidates — the job is not idempotent", got)
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

func int64Pointer(v int64) *int64       { return &v }
func float64Pointer(v float64) *float64 { return &v }
