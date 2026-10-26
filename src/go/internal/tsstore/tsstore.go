// Package tsstore stores per-activity timeseries blobs on an object store
// (design: stride-devops docs/designs/timeseries-blob-migration.md; devops#784
// is the Phase 0 foundation — this package exists, nothing writes through it
// yet).
//
// Three backends share the EncodePoints/DecodePoints codec so unit tests
// exercise the exact production format: COS (production bucket), a plain
// directory (dev/local convenience), and an in-memory map (tests).
//
// tsstore deliberately does not import internal/storage: Phase 1 injects a
// Store into the storage write path, so the dependency may only point the
// other way. That is why Point is a local mirror of
// storage.TimeseriesPoint's data columns rather than an import.
package tsstore

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

// ErrNotFound is returned by Store.Get for a key that does not exist. It is a
// package sentinel (not a per-backend error) so read paths can branch on a
// single errors.Is — during the migration the read side uses it to fall back
// to row storage.
var ErrNotFound = errors.New("tsstore: object not found")

// ObjectInfo describes one listed object: its key and the last-modified time
// the backend reports. ModTime is the zero time when a backend genuinely
// cannot report it (no backend in this package does that). The orphan GC uses
// it for its age threshold; every backend stamps it at Put time.
type ObjectInfo struct {
	Key     string
	ModTime time.Time
}

// Store is the object-store surface for timeseries blobs.
//
// Put is an idempotent overwrite: the sync upsert maps "delete-then-insert the
// whole activity" onto "replace the single object at the deterministic key".
// Delete is idempotent — removing a missing key is not an error. List walks
// every key under prefix; iteration order is unspecified, and an error
// returned by fn aborts the walk and is returned as-is (callers may use that
// to stop early with their own sentinel).
type Store interface {
	Put(ctx context.Context, key string, payload []byte) error
	Get(ctx context.Context, key string) ([]byte, error)
	List(ctx context.Context, prefix string, fn func(ObjectInfo) error) error
	Delete(ctx context.Context, keys ...string) error
}

// BlobKey is the deterministic object key for one activity's points:
// ts/v1/{user_id}/{label_id}.json.gz. The versioned prefix means a future v2
// layout is additive — readers keyed off the activities.ts_blob_key pointer
// never need to re-derive it.
func BlobKey(userID, labelID string) string {
	return fmt.Sprintf("ts/v1/%s/%s.json.gz", userID, labelID)
}

// KeyPrefix is the shared prefix of every BlobKey — the listing scope for the
// bucket-vs-pointer reconciliation and the orphan GC.
const KeyPrefix = "ts/v1/"

// ParseBlobKey reverses BlobKey, recovering (userID, labelID) from a listed
// object key. The second return is false when the key is not BlobKey-shaped
// (wrong prefix, wrong suffix, or not exactly three non-empty segments) — the
// GC treats such keys as malformed and never deletes them.
func ParseBlobKey(key string) (userID, labelID string, ok bool) {
	if !strings.HasPrefix(key, KeyPrefix) || !strings.HasSuffix(key, ".json.gz") {
		return "", "", false
	}
	body := strings.TrimSuffix(strings.TrimPrefix(key, KeyPrefix), ".json.gz")
	parts := strings.Split(body, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}
