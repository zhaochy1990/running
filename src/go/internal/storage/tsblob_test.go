// tsblob_test.go exercises the Phase 1 dual-write (devops#785 AC1): the
// blob-before-transaction ordering, the four pointer columns, the preserveEmpty
// semantics, and the backfill/audit/GC query surface. Integration tests are
// gated on STRIDE_WORKER_TEST_MYSQL_DSN like the rest of the storage suite;
// the blob backend is always a MemStore — never a real bucket.
package storage

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/tsstore"
)

// openBlobTestStore is openTestStore plus the watch migration and a MemStore
// injected as the ts blob backend. It also fabricates the test's scratch user
// id and wipes that user's watch rows on cleanup — the gated MySQL may be a
// shared scratch database, and whole-world assertions (the tsblob backfill
// test's audit) need previous runs' users gone. (DeleteUserData is not the
// tool here: it sweeps every user-owned table in one transaction, and this
// minimal schema has not migrated them all.)
func openBlobTestStore(t *testing.T) (*Store, *tsstore.MemStore, string) {
	t.Helper()
	st := openTestStore(t)
	if err := st.AutoMigrateWatch(context.Background()); err != nil {
		t.Fatalf("automigrate watch: %v", err)
	}
	ts := tsstore.NewMemStore()
	st.SetTSBlobStore(ts)
	n := time.Now().UnixNano()
	uid := fmt.Sprintf("b1a2c3d4-%04d-4000-8000-%012d", n%10000, n%1_000_000_000_000)
	t.Cleanup(func() {
		for _, model := range []any{&TimeseriesPoint{}, &Lap{}, &ActivityWatchZone{}, &Activity{}} {
			_ = st.db.Where("user_id = ?", uid).Delete(model).Error
		}
	})
	return st, ts, uid
}

func blobActivity(uid, label string) *Activity {
	return &Activity{
		UserID: uid, LabelID: label, SportType: 100,
		Date:     time.Date(2026, 10, 1, 1, 2, 3, 0, time.UTC),
		Provider: "coros", SyncedAt: time.Now().UTC(),
	}
}

func tsPoint(sec int64, lat, lon *float64) TimeseriesPoint {
	return TimeseriesPoint{Timestamp: &sec, GPSLat: lat, GPSLon: lon}
}

func readActivity(t *testing.T, st *Store, uid, label string) *Activity {
	t.Helper()
	a, err := st.ActivityByID(context.Background(), uid, label)
	if err != nil || a == nil {
		t.Fatalf("read activity %s/%s: %v", uid, label, err)
	}
	return a
}

// TestUpsertActivity_DualWriteStampsPointerColumns is AC1's main path: with
// points present, the blob is written first and the row's four pointer columns
// land with the upsert; the timeseries rows are still written (dual-write).
func TestUpsertActivity_DualWriteStampsPointerColumns(t *testing.T) {
	st, ts, uid := openBlobTestStore(t)
	ctx := context.Background()
	lat, lon := 31.13, 121.4
	tsRows := []TimeseriesPoint{
		tsPoint(1, &lat, &lon),
		tsPoint(2, nil, nil),
		{Timestamp: func() *int64 { v := int64(3); return &v }(), HeartRate: func() *int { v := 150; return &v }()},
	}
	if err := st.UpsertActivity(ctx, blobActivity(uid, "a1"), nil, tsRows, nil); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	a := readActivity(t, st, uid, "a1")
	wantKey := tsstore.BlobKey(uid, "a1")
	if a.TsBlobKey == nil || *a.TsBlobKey != wantKey {
		t.Fatalf("ts_blob_key = %v, want %s", a.TsBlobKey, wantKey)
	}
	if a.TsPointCount == nil || *a.TsPointCount != 3 {
		t.Fatalf("ts_point_count = %v, want 3", a.TsPointCount)
	}
	if a.TsSHA256 == nil || len(*a.TsSHA256) != 64 {
		t.Fatalf("ts_sha256 = %v, want 64 hex chars", a.TsSHA256)
	}
	if a.HasGPS == nil || !*a.HasGPS {
		t.Fatalf("has_gps = %v, want true (first point carries a valid fix)", a.HasGPS)
	}

	// The blob decodes and carries the same checksum the row records.
	blob, err := tsstore.DecodePoints(mustGetBlob(t, ts, wantKey))
	if err != nil {
		t.Fatalf("decode blob: %v", err)
	}
	if blob.SHA256 != *a.TsSHA256 {
		t.Fatalf("blob sha %s != row ts_sha256 %s", blob.SHA256, *a.TsSHA256)
	}
	if blob.PointCount != 3 || len(blob.Points) != 3 {
		t.Fatalf("blob count = %d/%d, want 3/3", blob.PointCount, len(blob.Points))
	}

	// Rows are still written — the migration is a dual-write, not a cutover.
	rows, err := st.ActivityTimeseriesRows(ctx, uid, "a1")
	if err != nil || len(rows) != 3 {
		t.Fatalf("timeseries rows after upsert = %d (err %v), want 3", len(rows), err)
	}
}

// TestUpsertActivity_COROSEmptyTSWritesEmptyBlob: a non-preserving upsert with
// no points legitimately rewrites the activity to zero points — an empty blob
// (point_count=0) replaces whatever was there, matching the row semantics.
func TestUpsertActivity_COROSEmptyTSWritesEmptyBlob(t *testing.T) {
	st, ts, uid := openBlobTestStore(t)
	ctx := context.Background()
	lat, lon := 31.0, 121.0
	if err := st.UpsertActivity(ctx, blobActivity(uid, "a1"), nil, []TimeseriesPoint{tsPoint(1, &lat, &lon)}, nil); err != nil {
		t.Fatalf("upsert with points: %v", err)
	}

	a := blobActivity(uid, "a1") // same identity, empty payload this time
	if err := st.UpsertActivity(ctx, a, nil, nil, nil); err != nil {
		t.Fatalf("upsert empty: %v", err)
	}
	got := readActivity(t, st, uid, "a1")
	if got.TsPointCount == nil || *got.TsPointCount != 0 {
		t.Fatalf("ts_point_count = %v, want 0", got.TsPointCount)
	}
	if got.HasGPS == nil || *got.HasGPS {
		t.Fatalf("has_gps = %v, want false for an empty blob", got.HasGPS)
	}
	blob, err := tsstore.DecodePoints(mustGetBlob(t, ts, tsstore.BlobKey(uid, "a1")))
	if err != nil || blob.PointCount != 0 {
		t.Fatalf("blob after empty rewrite = %+v (err %v), want 0 points", blob, err)
	}
	if rows, _ := st.ActivityTimeseriesRows(ctx, uid, "a1"); len(rows) != 0 {
		t.Fatalf("rows after empty rewrite = %d, want 0", len(rows))
	}
}

// TestUpsertActivity_GarminEmptyDetailsPreservesPointer: the preserve-empty
// upsert with no points must not touch the blob or the pointer columns an
// earlier full sync stamped.
func TestUpsertActivity_GarminEmptyDetailsPreservesPointer(t *testing.T) {
	st, ts, uid := openBlobTestStore(t)
	ctx := context.Background()
	lat, lon := 31.0, 121.0
	full := blobActivity(uid, "g1")
	if err := st.UpsertActivityPreservingEmptyChildren(ctx, full, nil, []TimeseriesPoint{tsPoint(1, &lat, &lon), tsPoint(2, &lat, &lon)}, nil); err != nil {
		t.Fatalf("full sync: %v", err)
	}
	stamped := readActivity(t, st, uid, "g1")
	if stamped.TsBlobKey == nil {
		t.Fatal("full sync did not stamp a pointer")
	}
	payloadBefore := mustGetBlob(t, ts, *stamped.TsBlobKey)

	// Garmin empty-details path: same identity, no children, preserving.
	empty := blobActivity(uid, "g1")
	empty.Name = strptr("summary-only refresh")
	if err := st.UpsertActivityPreservingEmptyChildren(ctx, empty, nil, nil, nil); err != nil {
		t.Fatalf("empty-details sync: %v", err)
	}
	after := readActivity(t, st, uid, "g1")
	if after.TsBlobKey == nil || *after.TsBlobKey != *stamped.TsBlobKey ||
		after.TsPointCount == nil || *after.TsPointCount != *stamped.TsPointCount ||
		after.TsSHA256 == nil || *after.TsSHA256 != *stamped.TsSHA256 ||
		after.HasGPS == nil || *after.HasGPS != *stamped.HasGPS {
		t.Fatalf("pointer columns changed by preserve-empty upsert:\nbefore %+v\nafter  %+v", stamped, after)
	}
	if got := mustGetBlob(t, ts, *stamped.TsBlobKey); string(got) != string(payloadBefore) {
		t.Fatal("blob payload changed by preserve-empty upsert")
	}
	if rows, _ := st.ActivityTimeseriesRows(ctx, uid, "g1"); len(rows) != 2 {
		t.Fatalf("rows after preserve-empty = %d, want 2 (preserved)", len(rows))
	}
}

// TestUpsertActivity_BlobPutFailureFailsUpsert: a failing Put must fail the
// whole upsert (the MQ retry path) and must not leave a stamped row.
func TestUpsertActivity_BlobPutFailureFailsUpsert(t *testing.T) {
	st, _, uid := openBlobTestStore(t)
	st.SetTSBlobStore(failingBlobStore{MemStore: tsstore.NewMemStore()})
	ctx := context.Background()
	lat := 31.0
	err := st.UpsertActivity(ctx, blobActivity(uid, "a1"), nil, []TimeseriesPoint{tsPoint(1, &lat, &lat)}, nil)
	if err == nil {
		t.Fatal("upsert succeeded despite blob Put failure")
	}
	if exists, _ := st.ActivityExists(ctx, uid, "a1"); exists {
		t.Fatal("activity row written despite blob Put failure")
	}
}

// failingBlobStore fails every Put and passes everything else through to a
// real MemStore — the error-injection backend.
type failingBlobStore struct{ *tsstore.MemStore }

func (failingBlobStore) Put(context.Context, string, []byte) error {
	return errors.New("injected put failure")
}

// TestUpsertActivity_NoBlobStoreOmitsPointer: a Store without an injected
// backend (CLI/legacy paths) must not wipe a stamped pointer either.
func TestUpsertActivity_NoBlobStoreOmitsPointer(t *testing.T) {
	st, _, uid := openBlobTestStore(t)
	ctx := context.Background()
	lat := 31.0
	if err := st.UpsertActivity(ctx, blobActivity(uid, "a1"), nil, []TimeseriesPoint{tsPoint(1, &lat, &lat)}, nil); err != nil {
		t.Fatalf("upsert with blob store: %v", err)
	}
	before := readActivity(t, st, uid, "a1")

	st.SetTSBlobStore(nil)
	// Point-carrying upsert without a backend: rows update, pointer survives.
	if err := st.UpsertActivity(ctx, blobActivity(uid, "a1"), nil, []TimeseriesPoint{tsPoint(2, &lat, &lat)}, nil); err != nil {
		t.Fatalf("upsert without blob store: %v", err)
	}
	after := readActivity(t, st, uid, "a1")
	if after.TsBlobKey == nil || *after.TsBlobKey != *before.TsBlobKey {
		t.Fatalf("ts_blob_key = %v after backend-less upsert, want preserved %v", after.TsBlobKey, before.TsBlobKey)
	}
}

func mustGetBlob(t *testing.T, ts *tsstore.MemStore, key string) []byte {
	t.Helper()
	b, err := ts.Get(context.Background(), key)
	if err != nil {
		t.Fatalf("get blob %s: %v", key, err)
	}
	return b
}

// TestTSBlobBackfillQuerySurface walks the backfill/audit/GC storage methods
// through their intended sequence: page unmigrated, stamp (guarded), page
// again, aggregate counters, list pointers, check existing labels.
func TestTSBlobBackfillQuerySurface(t *testing.T) {
	st, _, uid := openBlobTestStore(t)
	ctx := context.Background()
	// Assertions are scoped to this user: the shared scratch DB may hold other
	// runs' users (a crashed test leaks its own cleanup).

	// Seed via the dual-write path: two stamped activities, one pending (no
	// points ever written is fine — the row still exists unmigrated).
	lat := 31.0
	if err := st.UpsertActivity(ctx, blobActivity(uid, "l1"), nil, []TimeseriesPoint{tsPoint(1, &lat, &lat), tsPoint(2, &lat, &lat)}, nil); err != nil {
		t.Fatalf("upsert l1: %v", err)
	}
	if err := st.UpsertActivity(ctx, blobActivity(uid, "l3"), nil, nil, nil); err != nil {
		t.Fatalf("upsert l3: %v", err)
	}
	// l2 is pending: stamped rows can also come from a backend-less upsert.
	st.SetTSBlobStore(nil)
	if err := st.UpsertActivity(ctx, blobActivity(uid, "l2"), nil, []TimeseriesPoint{tsPoint(1, &lat, &lat)}, nil); err != nil {
		t.Fatalf("upsert l2: %v", err)
	}
	st.SetTSBlobStore(tsstore.NewMemStore())

	users, err := st.UnmigratedActivityUsers(ctx)
	if err != nil {
		t.Fatalf("UnmigratedActivityUsers: %v", err)
	}
	// Scoped-membership, not whole-list: other suites may share the gated DB.
	found := false
	for _, u := range users {
		if u == uid {
			found = true
		}
	}
	if !found {
		t.Fatalf("UnmigratedActivityUsers = %v, want it to contain %s", users, uid)
	}

	var got []string
	after := ""
	for {
		page, err := st.PageUserActivitiesWithoutTSBlob(ctx, uid, after, 1)
		if err != nil {
			t.Fatalf("page: %v", err)
		}
		if len(page) == 0 {
			break
		}
		got = append(got, page[0].LabelID)
		after = page[0].LabelID
	}
	if len(got) != 1 || got[0] != "l2" {
		t.Fatalf("unmigrated page = %v, want [l2] (keyset, ascending)", got)
	}

	// Stamp l2 the way the backfill would; the guard makes a double stamp lose.
	key := tsstore.BlobKey(uid, "l2")
	ok, err := st.StampTSBlobColumns(ctx, uid, "l2", key, 1, "sum", true)
	if err != nil || !ok {
		t.Fatalf("first stamp = (%v, %v), want (true, nil)", ok, err)
	}
	ok, err = st.StampTSBlobColumns(ctx, uid, "l2", key, 1, "sum", true)
	if err != nil || ok {
		t.Fatalf("second stamp = (%v, %v), want (false, nil) — guard must hold", ok, err)
	}

	audits, err := st.TSBlobUserAudits(ctx)
	if err != nil {
		t.Fatalf("TSBlobUserAudits: %v", err)
	}
	var a *TSBlobUserAudit
	for i := range audits {
		if audits[i].UserID == uid {
			a = &audits[i]
			break
		}
	}
	if a == nil {
		t.Fatalf("audits had no row for %s: %+v", uid, audits)
	}
	// l1: 2 points; l2: 1 point stamped; l3: 0 points (empty blob stamped by
	// its own dual-write upsert). Rows = 3 (l1's 2 + l2's 1), blob sum = 3.
	if a.RowPoints != 3 || a.BlobPoints != 3 || a.Migrated != 3 || a.Unmigrated != 0 {
		t.Fatalf("audit counters = %+v, want rows=3 blob=3 migrated=3 pending=0", a)
	}
	if !a.PointSumOK || !a.CompleteOK {
		t.Fatalf("audit verdicts = pointSum:%v complete:%v, want both true", a.PointSumOK, a.CompleteOK)
	}

	pointers, err := st.ListTSBlobPointers(ctx)
	if err != nil {
		t.Fatalf("ListTSBlobPointers: %v", err)
	}
	var mine int
	for _, p := range pointers {
		if p.UserID == uid {
			mine++
		}
	}
	if mine != 3 {
		t.Fatalf("pointers for %s = %d, want 3", uid, mine)
	}
	existing, err := st.ExistingLabels(ctx, uid, []string{"l1", "l2", "missing"})
	if err != nil {
		t.Fatalf("ExistingLabels: %v", err)
	}
	if !existing["l1"] || !existing["l2"] || existing["missing"] {
		t.Fatalf("ExistingLabels = %v", existing)
	}
}
