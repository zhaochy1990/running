// tsread_test.go exercises the Phase 2 pointer-first read (devops#786):
// blob-served reads equal row reads, the LRU collapses repeat reads into one
// GET, a resync invalidates by checksum, and every blob-side failure falls
// back to rows. Integration tests gate on STRIDE_WORKER_TEST_MYSQL_DSN like
// the rest of the storage suite; the blob backend is always in-memory — never
// a real bucket.
package storage

import (
	"context"
	"testing"

	"github.com/zhaochy1990/stride/internal/tsstore"
)

// countingBlobStore wraps the MemStore to count GETs — the LRU assertions
// read "how many times did the backend actually get hit".
type countingBlobStore struct {
	*tsstore.MemStore
	gets int
}

func (c *countingBlobStore) Get(ctx context.Context, key string) ([]byte, error) {
	c.gets++
	return c.MemStore.Get(ctx, key)
}

// blobTestRows builds a small point set with GPS, HR, and running-dynamics
// columns so the blob round-trip has non-trivial content.
func blobTestRows(lat, lon float64) []TimeseriesPoint {
	hr := 142
	spd := 3.2
	gct := 240.5
	slope := 2
	return []TimeseriesPoint{
		{Timestamp: i64ptr(1), GPSLat: fptr(lat), GPSLon: fptr(lon)},
		{Timestamp: i64ptr(2), HeartRate: iptr(hr), Speed: fptr(spd)},
		{Timestamp: i64ptr(3), GroundContactTimeMs: fptr(gct), Slope: &slope},
	}
}

// assertPointsEqual compares the data columns (not the surrogate ID, which the
// blob path legitimately does not carry) in order.
func assertPointsEqual(t *testing.T, got, want []TimeseriesPoint) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("points len = %d, want %d", len(got), len(want))
	}
	for i := range want {
		g, w := got[i], want[i]
		if g.UserID != w.UserID || g.LabelID != w.LabelID {
			t.Fatalf("point %d tenant = %s/%s, want %s/%s", i, g.UserID, g.LabelID, w.UserID, w.LabelID)
		}
		if g.Timestamp == nil || w.Timestamp == nil || *g.Timestamp != *w.Timestamp {
			t.Fatalf("point %d timestamp = %v, want %v", i, g.Timestamp, w.Timestamp)
		}
		for name, pair := range map[string][2]*float64{
			"distance": {g.Distance, w.Distance}, "speed": {g.Speed, w.Speed},
			"adjusted_pace": {g.AdjustedPace, w.AdjustedPace}, "altitude": {g.Altitude, w.Altitude},
			"gct": {g.GroundContactTimeMs, w.GroundContactTimeMs}, "vosc": {g.VerticalOscillationMm, w.VerticalOscillationMm},
			"vratio": {g.VerticalRatioPct, w.VerticalRatioPct}, "cdl": {g.CadenceLengthCm, w.CadenceLengthCm},
			"lat": {g.GPSLat, w.GPSLat}, "lon": {g.GPSLon, w.GPSLon},
		} {
			if (pair[0] == nil) != (pair[1] == nil) {
				t.Fatalf("point %d %s = %v, want %v", i, name, pair[0], pair[1])
			}
			if pair[0] != nil && *pair[0] != *pair[1] {
				t.Fatalf("point %d %s = %v, want %v", i, name, *pair[0], *pair[1])
			}
		}
		for name, pair := range map[string][2]*int{
			"hr": {g.HeartRate, w.HeartRate}, "cad": {g.Cadence, w.Cadence},
			"pwr": {g.Power, w.Power}, "slope": {g.Slope, w.Slope}, "hlvl": {g.HeartLevel, w.HeartLevel},
		} {
			if (pair[0] == nil) != (pair[1] == nil) {
				t.Fatalf("point %d %s = %v, want %v", i, name, pair[0], pair[1])
			}
			if pair[0] != nil && *pair[0] != *pair[1] {
				t.Fatalf("point %d %s = %v, want %v", i, name, *pair[0], *pair[1])
			}
		}
	}
}

// TestTSPointCacheHitMissEvict is the pure-unit LRU contract: no DB.
func TestTSPointCacheHitMissEvict(t *testing.T) {
	c := newTSPointCache(2)
	pts := func(n int) []TimeseriesPoint {
		return []TimeseriesPoint{{Timestamp: i64ptr(int64(n))}}
	}
	c.put("k1", "s1", pts(1))
	if got, ok := c.get("k1", "s1"); !ok || len(got) != 1 {
		t.Fatalf("get(k1) after put = (%v, %v), want hit", got, ok)
	}
	// A different sha for the same key is a miss (the blob was overwritten)
	// and drops the entry.
	if _, ok := c.get("k1", "s2"); ok {
		t.Fatal("get(k1) with changed sha hit; want miss")
	}
	if _, ok := c.get("k1", "s1"); ok {
		t.Fatal("get(k1) with the original sha still hit after invalidation; want miss")
	}
	// Capacity 2: k4 evicts the least recently used (k2).
	c.put("k2", "s2", pts(2))
	c.put("k3", "s3", pts(3))
	c.get("k2", "s2") // k2 fresh, k3 is now LRU
	c.put("k4", "s4", pts(4))
	for _, hit := range []string{"k2", "k4"} {
		if _, ok := c.get(hit, "s"+hit[1:]); !ok {
			t.Fatalf("get(%s) after eviction = miss, want hit", hit)
		}
	}
	if _, ok := c.get("k3", "s3"); ok {
		t.Fatal("get(k3) after eviction hit; want miss (it was the LRU entry)")
	}
}

// TestActivityTimeseriesServesFromBlobWithLRU is AC1's main path: a stamped
// activity serves from the blob, the content equals the rows, and repeat
// reads (the four-source full-compute shape) GET once.
func TestActivityTimeseriesServesFromBlobWithLRU(t *testing.T) {
	st, ts, uid := openBlobTestStore(t)
	ctx := context.Background()
	counting := &countingBlobStore{MemStore: ts}
	st.SetTSBlobStore(counting)

	rows := blobTestRows(31.13, 121.4)
	if err := st.UpsertActivity(ctx, blobActivity(uid, "r1"), nil, rows, nil); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	for i := 1; i <= 3; i++ { // calibration/ability/load/PB all re-read the same activity
		got, err := st.ActivityTimeseries(ctx, uid, "r1")
		if err != nil {
			t.Fatalf("read %d: %v", i, err)
		}
		assertPointsEqual(t, got, rows)
	}
	if counting.gets != 1 {
		t.Fatalf("backend GETs = %d after 3 reads, want 1 (LRU)", counting.gets)
	}
	// The row read is untouched and separate.
	rowRead, err := st.ActivityTimeseriesRows(ctx, uid, "r1")
	if err != nil || len(rowRead) != len(rows) {
		t.Fatalf("rows read = %d (err %v), want %d", len(rowRead), err, len(rows))
	}
	if counting.gets != 1 {
		t.Fatalf("backend GETs = %d after the row read, want 1", counting.gets)
	}
}

// TestActivityTimeseriesResyncInvalidatesCache: a resync overwrites the blob
// at the same deterministic key with new content and a new checksum; the next
// read must re-GET and serve the new points, never the stale cache entry.
func TestActivityTimeseriesResyncInvalidatesCache(t *testing.T) {
	st, ts, uid := openBlobTestStore(t)
	ctx := context.Background()
	counting := &countingBlobStore{MemStore: ts}
	st.SetTSBlobStore(counting)

	v1 := blobTestRows(31.13, 121.4)
	if err := st.UpsertActivity(ctx, blobActivity(uid, "r1"), nil, v1, nil); err != nil {
		t.Fatalf("upsert v1: %v", err)
	}
	if got, err := st.ActivityTimeseries(ctx, uid, "r1"); err != nil {
		t.Fatalf("read v1: %v", err)
	} else {
		assertPointsEqual(t, got, v1)
	}

	hr := 171
	v2 := []TimeseriesPoint{
		{Timestamp: i64ptr(1), HeartRate: iptr(hr)},
		{Timestamp: i64ptr(2), HeartRate: iptr(hr)},
	}
	if err := st.UpsertActivity(ctx, blobActivity(uid, "r1"), nil, v2, nil); err != nil {
		t.Fatalf("upsert v2: %v", err)
	}
	got, err := st.ActivityTimeseries(ctx, uid, "r1")
	if err != nil {
		t.Fatalf("read v2: %v", err)
	}
	assertPointsEqual(t, got, v2)
	if counting.gets != 2 {
		t.Fatalf("backend GETs = %d, want 2 (one per version)", counting.gets)
	}
}

// TestActivityTimeseriesFallsBackToRows: every blob-side failure — missing
// object, corrupt payload, checksum drift, count drift — must still answer
// from the timeseries rows (the dual-write keeps them authoritative), not
// error.
func TestActivityTimeseriesFallsBackToRows(t *testing.T) {
	seed := func(t *testing.T) (*Store, *countingBlobStore, string, []TimeseriesPoint) {
		st, ts, uid := openBlobTestStore(t)
		ctx := context.Background()
		counting := &countingBlobStore{MemStore: ts}
		st.SetTSBlobStore(counting)
		rows := blobTestRows(31.13, 121.4)
		if err := st.UpsertActivity(ctx, blobActivity(uid, "f1"), nil, rows, nil); err != nil {
			t.Fatalf("upsert: %v", err)
		}
		return st, counting, uid, rows
	}
	ctx := context.Background()

	t.Run("missing object", func(t *testing.T) {
		st, _, uid, rows := seed(t)
		a := readActivity(t, st, uid, "f1")
		if err := st.tsBlob.Delete(ctx, *a.TsBlobKey); err != nil {
			t.Fatalf("delete blob: %v", err)
		}
		got, err := st.ActivityTimeseries(ctx, uid, "f1")
		if err != nil {
			t.Fatalf("read after blob delete: %v", err)
		}
		assertPointsEqual(t, got, rows)
	})

	t.Run("corrupt payload", func(t *testing.T) {
		st, _, uid, rows := seed(t)
		a := readActivity(t, st, uid, "f1")
		if err := st.tsBlob.Put(ctx, *a.TsBlobKey, []byte("not a gzip blob")); err != nil {
			t.Fatalf("corrupt blob: %v", err)
		}
		got, err := st.ActivityTimeseries(ctx, uid, "f1")
		if err != nil {
			t.Fatalf("read after corruption: %v", err)
		}
		assertPointsEqual(t, got, rows)
	})

	t.Run("checksum drift", func(t *testing.T) {
		st, _, uid, rows := seed(t)
		if err := st.db.WithContext(ctx).Model(&Activity{}).
			Where("user_id = ? AND label_id = ?", uid, "f1").
			Update("ts_sha256", "deadbeef").Error; err != nil {
			t.Fatalf("tamper sha: %v", err)
		}
		got, err := st.ActivityTimeseries(ctx, uid, "f1")
		if err != nil {
			t.Fatalf("read after sha tamper: %v", err)
		}
		assertPointsEqual(t, got, rows)
	})

	t.Run("point count drift", func(t *testing.T) {
		st, _, uid, rows := seed(t)
		if err := st.db.WithContext(ctx).Model(&Activity{}).
			Where("user_id = ? AND label_id = ?", uid, "f1").
			Update("ts_point_count", 999).Error; err != nil {
			t.Fatalf("tamper count: %v", err)
		}
		got, err := st.ActivityTimeseries(ctx, uid, "f1")
		if err != nil {
			t.Fatalf("read after count tamper: %v", err)
		}
		assertPointsEqual(t, got, rows)
	})
}

// TestActivityTimeseriesUnmigratedServesFromRows: an activity without a blob
// pointer (pre-backfill stock, or written by a store with no backend) reads
// from the rows without touching the blob backend at all.
func TestActivityTimeseriesUnmigratedServesFromRows(t *testing.T) {
	st, ts, uid := openBlobTestStore(t)
	ctx := context.Background()
	counting := &countingBlobStore{MemStore: ts}
	st.SetTSBlobStore(counting)

	legacy := blobActivity(uid, "legacy")
	if err := st.db.WithContext(ctx).Create(legacy).Error; err != nil {
		t.Fatalf("seed legacy activity: %v", err)
	}
	rows := blobTestRows(31.13, 121.4)
	for i := range rows {
		rows[i].UserID, rows[i].LabelID = uid, "legacy"
	}
	if err := st.db.WithContext(ctx).Create(&rows).Error; err != nil {
		t.Fatalf("seed legacy points: %v", err)
	}

	got, err := st.ActivityTimeseries(ctx, uid, "legacy")
	if err != nil {
		t.Fatalf("read legacy: %v", err)
	}
	assertPointsEqual(t, got, rows)
	if counting.gets != 0 {
		t.Fatalf("backend GETs = %d for an unmigrated activity, want 0", counting.gets)
	}
}

// TestActivityTimeseriesMissingActivityReturnsEmpty: the pointer query's
// not-found branch must keep the old read's contract — an absent activity is
// an empty point set, not an error, and never a blob GET.
func TestActivityTimeseriesMissingActivityReturnsEmpty(t *testing.T) {
	st, ts, uid := openBlobTestStore(t)
	counting := &countingBlobStore{MemStore: ts}
	st.SetTSBlobStore(counting)

	got, err := st.ActivityTimeseries(context.Background(), uid, "never-synced")
	if err != nil {
		t.Fatalf("read missing activity: %v", err)
	}
	if len(got) != 0 {
		t.Fatalf("points for a missing activity = %d, want 0", len(got))
	}
	if counting.gets != 0 {
		t.Fatalf("backend GETs = %d for a missing activity, want 0", counting.gets)
	}
}
