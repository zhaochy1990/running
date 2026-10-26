// gc_test.go drives the orphan collector with a MemStore (fresh objects, tiny
// grace window) and a FileStore (real mtimes backdated with os.Chtimes, the
// default 7-day window) — no MySQL, no real bucket.
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

// fakeGCStore answers existence queries from a set.
type fakeGCStore struct{ rows map[string]map[string]bool }

func (f *fakeGCStore) ExistingLabels(_ context.Context, userID string, _ []string) (map[string]bool, error) {
	return f.rows[userID], nil
}

func putGCObject(t *testing.T, ts tsstore.Store, userID, labelID string) {
	t.Helper()
	payload, _, err := tsstore.EncodePoints(userID, labelID, nil)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if err := ts.Put(context.Background(), tsstore.BlobKey(userID, labelID), payload); err != nil {
		t.Fatalf("put %s/%s: %v", userID, labelID, err)
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

func TestGC_OrphansDeletedRowsKept(t *testing.T) {
	ts := tsstore.NewMemStore()
	putGCObject(t, ts, "u1", "live-1")
	putGCObject(t, ts, "u1", "live-2")
	putGCObject(t, ts, "u2", "orphan-1") // u2 has no activities rows at all
	store := &fakeGCStore{rows: map[string]map[string]bool{
		"u1": {"live-1": true, "live-2": true},
	}}

	gc := NewGC(store, ts)
	gc.olderThan = timeMillisecondWindow()
	report, err := gc.Run(context.Background(), false)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if report.Scanned != 3 || report.Orphans != 1 || report.Deleted != 1 || report.KeptRows != 2 {
		t.Fatalf("report = %+v, want scanned=3 orphans=1 deleted=1 kept_rows=2", report)
	}
	if gcHasObject(t, ts, tsstore.BlobKey("u2", "orphan-1")) {
		t.Fatal("orphan still in the bucket after GC")
	}
	for _, live := range []string{"live-1", "live-2"} {
		if !gcHasObject(t, ts, tsstore.BlobKey("u1", live)) {
			t.Fatalf("live object %s deleted by GC", live)
		}
	}
}

func TestGC_DryRunDeletesNothing(t *testing.T) {
	ts := tsstore.NewMemStore()
	putGCObject(t, ts, "u1", "orphan-1")
	gc := NewGC(&fakeGCStore{}, ts)
	gc.olderThan = timeMillisecondWindow()
	report, err := gc.Run(context.Background(), true)
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if report.Orphans != 1 || report.Deleted != 0 || !report.DryRun {
		t.Fatalf("dry-run report = %+v, want orphans=1 deleted=0", report)
	}
	if !gcHasObject(t, ts, tsstore.BlobKey("u1", "orphan-1")) {
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
	putGCObject(t, ts, "u1", "old-orphan")
	putGCObject(t, ts, "u1", "fresh-orphan")
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
	if gcHasObject(t, ts, tsstore.BlobKey("u1", "old-orphan")) {
		t.Fatal("8-day-old orphan survived the default window")
	}
	if !gcHasObject(t, ts, tsstore.BlobKey("u1", "fresh-orphan")) {
		t.Fatal("1-day-old orphan deleted inside the grace window")
	}
}

func TestGC_MalformedKeysKeptAndCounted(t *testing.T) {
	ts := tsstore.NewMemStore()
	// Under the listing prefix but not BlobKey-shaped: wrong suffix, stray
	// segment, no suffix at all.
	for _, key := range []string{"ts/v1/u1/a.json", "ts/v1/u1/x/b.json.gz", "ts/v1/u1"} {
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
	if report.Malformed != 3 || report.Scanned != 0 || report.Deleted != 0 {
		t.Fatalf("report = %+v, want malformed=3 scanned=0 deleted=0", report)
	}
}

// TestGC_BatchesOverTheCap seeds 2*gcBatchSize+7 orphans for one user and
// checks every batch goes and nothing else breaks.
func TestGC_BatchesOverTheCap(t *testing.T) {
	ts := tsstore.NewMemStore()
	const n = 2*gcBatchSize + 7
	for i := 0; i < n; i++ {
		putGCObject(t, ts, "u1", fmt.Sprintf("orphan-%04d", i))
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

// TestGCJobHandler_PayloadAndResult drives the job-handler wrapper: default
// input, dry-run flag, and the permanent-error paths.
func TestGCJobHandler_PayloadAndResult(t *testing.T) {
	ts := tsstore.NewMemStore()
	putGCObject(t, ts, "u1", "orphan-1")
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
	if !gcHasObject(t, ts, tsstore.BlobKey("u1", "orphan-1")) {
		t.Fatal("dry-run handler deleted an object")
	}

	got, err = handler(context.Background(), gcJob(`{"older-than":"1ns"}`), hb)
	if err != nil {
		t.Fatalf("older-than handler: %v", err)
	}
	if !strings.Contains(got, `"deleted":1`) {
		t.Fatalf("result %s lacks deleted:1", got)
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
