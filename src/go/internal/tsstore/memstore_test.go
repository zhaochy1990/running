package tsstore

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

// TestMemStore_CodecRoundTrip is the AC round-trip: encode → Put → Get →
// decode must reproduce every column, and the stored bytes must be the exact
// production format (gzip JSON v1) — memstore adds nothing in between.
func TestMemStore_CodecRoundTrip(t *testing.T) {
	const userID, labelID = "user-1", "label-1"
	store := NewMemStore()
	ctx := context.Background()

	key := BlobKey(userID, labelID)
	if err := store.Put(ctx, key, mustEncode(t, userID, labelID, fixturePoints())); err != nil {
		t.Fatalf("Put: %v", err)
	}
	blob, err := DecodePoints(mustGet(t, store, key))
	if err != nil {
		t.Fatalf("DecodePoints: %v", err)
	}
	if blob.UserID != userID || blob.LabelID != labelID || blob.PointCount != 2 {
		t.Fatalf("metadata = %s/%s count=%d, want %s/%s count=2", blob.UserID, blob.LabelID, blob.PointCount, userID, labelID)
	}
	if !reflect.DeepEqual(blob.Points, fixturePoints()) {
		t.Errorf("points = %+v, want the encoded fixture back", blob.Points)
	}
}

func mustGet(t *testing.T, store Store, key string) []byte {
	t.Helper()
	b, err := store.Get(context.Background(), key)
	if err != nil {
		t.Fatalf("Get %s: %v", key, err)
	}
	return b
}

func TestMemStore_ErrNotFound(t *testing.T) {
	store := NewMemStore()
	_, err := store.Get(context.Background(), BlobKey("u", "missing"))
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get missing = %v, want ErrNotFound", err)
	}
}

func TestMemStore_PutIsIdempotentOverwrite(t *testing.T) {
	store := NewMemStore()
	ctx := context.Background()
	key := BlobKey("u", "l")

	first := mustEncode(t, "u", "l", fixturePoints())
	if err := store.Put(ctx, key, first); err != nil {
		t.Fatalf("Put 1: %v", err)
	}
	second := mustEncode(t, "u", "l", []Point{})
	if err := store.Put(ctx, key, second); err != nil {
		t.Fatalf("Put 2: %v", err)
	}
	blob, err := DecodePoints(mustGet(t, store, key))
	if err != nil {
		t.Fatalf("DecodePoints: %v", err)
	}
	if blob.PointCount != 0 {
		t.Fatalf("after overwrite point_count = %d, want 0", blob.PointCount)
	}
}

func TestMemStore_ListAndDelete(t *testing.T) {
	store := NewMemStore()
	ctx := context.Background()
	mustPut(t, store, "ts/v1/u1/a.json.gz")
	mustPut(t, store, "ts/v1/u1/b.json.gz")
	mustPut(t, store, "ts/v1/u2/c.json.gz")
	mustPut(t, store, "other/x.json.gz")

	var got []string
	if err := store.List(ctx, "ts/v1/u1/", func(key string) error {
		got = append(got, key)
		return nil
	}); err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(got) != 2 || got[0] != "ts/v1/u1/a.json.gz" || got[1] != "ts/v1/u1/b.json.gz" {
		t.Fatalf("List = %v, want the two u1 keys in lexicographic order", got)
	}

	// Delete is idempotent: an already-missing key is not an error.
	if err := store.Delete(ctx, "ts/v1/u2/c.json.gz", "ts/v1/u2/c.json.gz"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := store.Get(ctx, "ts/v1/u2/c.json.gz"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after delete = %v, want ErrNotFound", err)
	}
}

func TestMemStore_ListFnErrorPassesThrough(t *testing.T) {
	store := NewMemStore()
	mustPut(t, store, "ts/v1/u/a.json.gz")
	stop := errors.New("caller stop")
	err := store.List(context.Background(), "ts/v1/", func(string) error { return stop })
	if !errors.Is(err, stop) {
		t.Fatalf("List fn error = %v, want passthrough of %v", err, stop)
	}
}

func mustPut(t *testing.T, store Store, key string) {
	t.Helper()
	if err := store.Put(context.Background(), key, []byte("x")); err != nil {
		t.Fatalf("Put %s: %v", key, err)
	}
}
