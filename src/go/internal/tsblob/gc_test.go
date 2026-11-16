// gc_test.go drives the orphan collector with a MemStore (fresh objects, tiny
// grace window) and a FileStore (real mtimes backdated with os.Chtimes, the
// default 7-day window) — no MySQL, no real bucket. Liveness is the
// referenced-key set (devops#1005): objects not named by an activities
// pointer are orphans; fresh upload intents protect in-flight Puts.
package tsblob

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/zhaochy1990/stride/internal/job"
	"github.com/zhaochy1990/stride/internal/tsstore"
)

// fakeGCStore answers the referenced-set / intent queries from maps.
type fakeGCStore struct {
	referenced map[string]bool
	intents    map[string]bool
	swept      int64
}

func (f *fakeGCStore) ListReferencedTSBlobKeys(context.Context) (map[string]bool, error) {
	if f.referenced == nil {
		return map[string]bool{}, nil
	}
	return f.referenced, nil
}

func (f *fakeGCStore) ListActiveUploadIntents(_ context.Context, _ time.Time) (map[string]bool, error) {
	if f.intents == nil {
		return map[string]bool{}, nil
	}
	return f.intents, nil
}

func (f *fakeGCStore) SweepStaleUploadIntents(_ context.Context, _ time.Time) (int64, error) {
	f.swept = int64(len(f.intents))
	f.intents = nil
	return f.swept, nil
}

func putGCObject(t *testing.T, ts tsstore.Store, key string) {
	t.Helper()
	userID, labelID, ok := tsstore.ParseAnyBlobKey(key)
	if !ok {
		t.Fatalf("putGCObject: key %s is not blob-key shaped", key)
	}
	payload, _, err := tsstore.EncodePoints(userID, labelID, nil)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if err := ts.Put(context.Background(), key, payload); err != nil {
		t.Fatalf("put %s: %v", key, err)
	}
}

func gcHasObject(t *testing.T, ts tsstore.Store, key string) bool {
	t.Helper()
	_, err := ts.Get(context.Background(), key)
	if err == nil {
		return true
	}
	if errors.Is(err, tsstore.ErrNotFound) {
		return false
	}
	t.Fatalf("get %s: %v", key, err)
	return false
}

func TestGC_OrphansDeletedReferencedKept(t *testing.T) {
	ts := tsstore.NewMemStore()
	live1 := tsstore.BlobKey("u1", "live-1")
	live2 := tsstore.V2BlobKey("u1", "live-2", 3, "abc123def4567890")
	orphan := tsstore.BlobKey("u2", "orphan-1")
	for _, k := range []string{live1, live2, orphan} {
		putGCObject(t, ts, k)
	}
	store := &fakeGCStore{referenced: map[string]bool{live1: true, live2: true}}

	gc := NewGC(store, ts)
	gc.olderThan = timeMillisecondWindow()
	report, err := gc.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if report.Scanned != 3 || report.Orphans != 1 || report.Deleted != 1 || report.KeptReferenced != 2 {
		t.Fatalf("report = %+v, want scanned=3 orphans=1 deleted=1 kept_referenced=2", report)
	}
	if gcHasObject(t, ts, orphan) {
		t.Fatal("orphan still in the bucket after GC")
	}
	for _, live := range []string{live1, live2} {
		if !gcHasObject(t, ts, live) {
			t.Fatalf("live object %s deleted by GC", live)
		}
	}
}

// TestGC_SupersededPointerMeansOrphan pins the devops#1005 rule change: an
// object whose label still has an activities row is STILL an orphan when the
// row's pointer names a different key (the immutable re-publish case).
func TestGC_SupersededPointerMeansOrphan(t *testing.T) {
	ts := tsstore.NewMemStore()
	v1 := tsstore.BlobKey("u1", "act-1")
	v2 := tsstore.V2BlobKey("u1", "act-1", 2, "feedfacebeef")
	putGCObject(t, ts, v1) // the pre-republish fixed-key object
	putGCObject(t, ts, v2) // the current pointer target
	store := &fakeGCStore{referenced: map[string]bool{v2: true}}

	gc := NewGC(store, ts)
	gc.olderThan = timeMillisecondWindow()
	report, err := gc.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if report.KeptReferenced != 1 || report.Orphans != 1 || report.Deleted != 1 {
		t.Fatalf("report = %+v, want kept_referenced=1(v2) orphans=1(v1) deleted=1", report)
	}
	if gcHasObject(t, ts, v1) {
		t.Fatal("superseded v1 object survived — label existence must not keep it")
	}
	if !gcHasObject(t, ts, v2) {
		t.Fatal("current pointer target deleted")
	}
}

// TestGC_ActiveUploadIntentProtects checks the "active upload" judgement: a
// fresh intent keeps an otherwise-orphaned object alive.
func TestGC_ActiveUploadIntentProtects(t *testing.T) {
	ts := tsstore.NewMemStore()
	inflight := tsstore.V2BlobKey("u1", "act-9", 1, "0123456789abcdef")
	putGCObject(t, ts, inflight)
	store := &fakeGCStore{intents: map[string]bool{inflight: true}}

	gc := NewGC(store, ts)
	gc.olderThan = timeMillisecondWindow()
	report, err := gc.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if report.KeptIntent != 1 || report.Orphans != 0 || report.Deleted != 0 {
		t.Fatalf("report = %+v, want kept_intent=1 orphans=0 deleted=0", report)
	}
	if !gcHasObject(t, ts, inflight) {
		t.Fatal("actively-uploading object deleted")
	}
}

func TestGC_DryRunDeletesNothing(t *testing.T) {
	ts := tsstore.NewMemStore()
	orphan := tsstore.BlobKey("u1", "orphan-1")
	putGCObject(t, ts, orphan)
	gc := NewGC(&fakeGCStore{}, ts)
	gc.olderThan = timeMillisecondWindow()
	report, err := gc.Run(context.Background(), true)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if report.Orphans != 1 || report.Deleted != 0 || !report.DryRun {
		t.Fatalf("dry-run report = %+v, want orphans=1 deleted=0", report)
	}
	if !gcHasObject(t, ts, orphan) {
		t.Fatal("dry-run deleted an object")
	}
}

// TestGC_GraceWindowWithFileStore exercises the default 7-day rule against
// real filesystem mtimes: an 8-day-old orphan goes, a 1-day-old orphan stays.
func TestGC_GraceWindowWithFileStore(t *testing.T) {
	dir := t.TempDir()
	ts, err := tsstore.NewFileStore(dir)
	if err != nil {
		t.Fatalf("filestore: %v", err)
	}
	oldOrphan := tsstore.BlobKey("u1", "old-orphan")
	freshOrphan := tsstore.BlobKey("u1", "fresh-orphan")
	putGCObject(t, ts, oldOrphan)
	putGCObject(t, ts, freshOrphan)
	old := time.Now().UTC().Add(-8 * 24 * time.Hour)
	if err := os.Chtimes(filepath.Join(dir, "ts", "v1", "u1", "old-orphan.json.gz"), old, old); err != nil {
		t.Fatalf("chtimes: %v", err)
	}

	gc := NewGC(&fakeGCStore{}, ts) // default olderThan = 7d
	report, err := gc.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if report.Scanned != 2 || report.Orphans != 1 || report.Deleted != 1 || report.KeptRecent != 1 {
		t.Fatalf("report = %+v, want scanned=2 orphans=1(deletable) deleted=1(old) kept_recent=1(fresh)", report)
	}
	if gcHasObject(t, ts, oldOrphan) {
		t.Fatal("8-day-old orphan survived the default window")
	}
	if !gcHasObject(t, ts, freshOrphan) {
		t.Fatal("1-day-old orphan deleted inside the grace window")
	}
}

func TestGC_MalformedKeysKeptAndCounted(t *testing.T) {
	ts := tsstore.NewMemStore()
	// Under a listing prefix but not key-shaped in either layout: wrong
	// suffix, stray segment, no suffix at all, and a v2 dir without the
	// r{rev}-{hash} leaf.
	for _, key := range []string{
		"ts/v1/u1/a.json", "ts/v1/u1/x/b.json.gz", "ts/v1/u1",
		"ts/v2/u1/a/b.json.gz",
	} {
		if err := ts.Put(context.Background(), key, []byte("x")); err != nil {
			t.Fatalf("put %s: %v", key, err)
		}
	}
	gc := NewGC(&fakeGCStore{}, ts)
	gc.olderThan = timeMillisecondWindow()
	report, err := gc.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if report.Malformed != 4 || report.Scanned != 0 || report.Deleted != 0 {
		t.Fatalf("report = %+v, want malformed=4 scanned=0 deleted=0", report)
	}
}

// TestGC_BatchesOverTheCap seeds 2*gcBatchSize+7 orphans for one user and
// checks every batch goes and nothing else breaks.
func TestGC_BatchesOverTheCap(t *testing.T) {
	ts := tsstore.NewMemStore()
	const n = 2*gcBatchSize + 7
	for i := 0; i < n; i++ {
		putGCObject(t, ts, tsstore.BlobKey("u1", fmt.Sprintf("orphan-%04d", i)))
	}
	gc := NewGC(&fakeGCStore{}, ts)
	gc.olderThan = timeMillisecondWindow()
	report, err := gc.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if report.Orphans != int64(n) || report.Deleted != int64(n) {
		t.Fatalf("report orphans=%d deleted=%d, want %d/%d", report.Orphans, report.Deleted, n, n)
	}
}

// TestGCJobHandler_PayloadAndResult drives the job-handler wrapper: the
// dry-run DEFAULT (nil flag deletes nothing), the explicit false, and the
// permanent-error paths.
func TestGCJobHandler_PayloadAndResult(t *testing.T) {
	ts := tsstore.NewMemStore()
	orphan1 := tsstore.BlobKey("u1", "orphan-1")
	orphan2 := tsstore.BlobKey("u1", "orphan-2")
	putGCObject(t, ts, orphan1)
	putGCObject(t, ts, orphan2)
	handler := NewGCJobHandler(&fakeGCStore{}, ts)
	hb := func(string, int) error { return nil }
	gcJob := func(input string) *job.Job {
		return &job.Job{ID: "j1", Type: GCJobType, Status: job.StatusQueued, InputJSON: input}
	}

	got, err := handler(context.Background(), gcJob(`{"dry_run":true}`), hb)
	if err != nil {
		t.Fatalf("dry-run handler: %v", err)
	}
	if !strings.Contains(got, `"dry_run":true`) {
		t.Fatalf("result %s lacks dry_run:true", got)
	}
	if !gcHasObject(t, ts, orphan1) {
		t.Fatal("dry-run handler deleted an object")
	}

	// DEFAULT: no payload at all still deletes nothing (devops#1005 AC4).
	got, err = handler(context.Background(), gcJob(``), hb)
	if err != nil {
		t.Fatalf("default handler: %v", err)
	}
	if !strings.Contains(got, `"dry_run":true`) {
		t.Fatalf("result %s lacks the dry_run:true default", got)
	}
	if !gcHasObject(t, ts, orphan2) {
		t.Fatal("payload-less handler deleted an object — dry-run must be the default")
	}

	// Explicit opt-in deletes (let the 1ms window pass the objects' mtimes).
	time.Sleep(2 * time.Millisecond)
	got, err = handler(context.Background(), gcJob(`{"dry_run":false,"older-than":"1ms"}`), hb)
	if err != nil {
		t.Fatalf("older-than handler: %v", err)
	}
	if !strings.Contains(got, `"deleted":2`) {
		t.Fatalf("result %s lacks deleted:2", got)
	}

	if _, err := handler(context.Background(), gcJob(`not json`), hb); err == nil {
		t.Fatal("garbage payload accepted")
	}
	if _, err := handler(context.Background(), gcJob(`{"older-than":"-1h"}`), hb); err == nil {
		t.Fatal("negative older-than accepted")
	}
}

// timeMillisecondWindow returns a 1ms grace window after letting the wall
// clock move past every object this test Put, so "everything is older than
// the cutoff" holds deterministically (a 1ns window can tie with the last
// Put's timestamp on coarse clocks).
func timeMillisecondWindow() time.Duration {
	time.Sleep(2 * time.Millisecond)
	return time.Millisecond
}
