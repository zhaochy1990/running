package tsstore

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// TestFileStore_Smoke is the dev/local backend's contract check: the same
// codec bytes go in and out of a plain directory, with the same key layout,
// the same ErrNotFound sentinel, and idempotent deletes. No bucket involved.
func TestFileStore_Smoke(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	ctx := context.Background()

	const userID, labelID = "user-1", "label-1"
	key := BlobKey(userID, labelID)
	if err := store.Put(ctx, key, mustEncode(t, userID, labelID, fixturePoints())); err != nil {
		t.Fatalf("Put: %v", err)
	}
	// The object landed at the mirrored path on disk.
	onDisk := filepath.Join(dir, "ts", "v1", userID, labelID+".json.gz")
	if _, err := os.Stat(onDisk); err != nil {
		t.Fatalf("object not at mirrored path %s: %v", onDisk, err)
	}
	blob, err := DecodePoints(mustGet(t, store, key))
	if err != nil {
		t.Fatalf("DecodePoints: %v", err)
	}
	if blob.UserID != userID || blob.PointCount != 2 {
		t.Fatalf("metadata = %s/%s count=%d", blob.UserID, blob.LabelID, blob.PointCount)
	}

	mustPut(t, store, "ts/v1/user-2/other.json.gz")
	var keys []string
	if err := store.List(ctx, "ts/v1/", func(info ObjectInfo) error {
		keys = append(keys, info.Key)
		if info.ModTime.IsZero() {
			t.Errorf("List ModTime for %s is zero, want the file mtime", info.Key)
		}
		return nil
	}); err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(keys) != 2 {
		t.Fatalf("List found %d keys, want 2: %v", len(keys), keys)
	}

	if _, err := store.Get(ctx, "ts/v1/user-1/nope.json.gz"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get missing = %v, want ErrNotFound", err)
	}
	if err := store.Delete(ctx, key, key); err != nil { // second delete: already gone
		t.Fatalf("idempotent Delete: %v", err)
	}
	if _, err := store.Get(ctx, key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after delete = %v, want ErrNotFound", err)
	}
}

func TestFileStore_RejectsTraversalKeys(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	ctx := context.Background()
	for _, key := range []string{"../escape.json.gz", "ts/../../escape.json.gz", "/abs.json.gz", "ts//x", ""} {
		if err := store.Put(ctx, key, []byte("x")); err == nil {
			t.Errorf("Put(%q) accepted a traversal/invalid key", key)
		}
	}
}

func TestFileStore_RequiresDir(t *testing.T) {
	if _, err := NewFileStore(""); err == nil {
		t.Fatal("NewFileStore(\"\") succeeded, want error")
	}
}
