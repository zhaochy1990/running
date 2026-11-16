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
	"strconv"
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

// KeyPrefix is the shared prefix of every v1 BlobKey.
const KeyPrefix = "ts/v1/"

// V2KeyPrefix is the shared prefix of every v2 immutable key (devops#1005).
const V2KeyPrefix = "ts/v2/"

// AllKeyPrefixes returns both layout prefixes — the listing scopes the audit
// and the GC reconcile over. A function (not a var) so no caller can mutate
// the shared slice.
func AllKeyPrefixes() []string { return []string{KeyPrefix, V2KeyPrefix} }

// V2BlobKey is the immutable object key for one activity's points under the
// write-isolation path (devops#1005): ts/v2/{user_id}/{label_id}/r{revision}-
// {sha16}.json.gz, where revision is the binding revision the writer proved it
// held and sha16 is the first 16 hex chars of the content sha256. Content-
// addressed: identical points under the same binding map to the same key (an
// idempotent overwrite of identical bytes), while genuinely different content
// lands at a different key and the row's pointer moves forward — the old
// object is left unreferenced for the GC instead of being mutated in place.
// The {user_id} segment keeps the per-user erasure sweep a prefix operation.
func V2BlobKey(userID, labelID string, revision int64, sha256 string) string {
	short := sha256
	if len(short) > 16 {
		short = short[:16]
	}
	return fmt.Sprintf("ts/v2/%s/%s/r%d-%s.json.gz", userID, labelID, revision, short)
}

// ParseBlobKey reverses BlobKey, recovering (userID, labelID) from a listed
// object key. The second return is false when the key is not BlobKey-shaped
// (wrong prefix, wrong suffix, or not exactly three non-empty segments) —
// the GC treats such keys as malformed and never deletes them.
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

// ParseV2BlobKey reverses V2BlobKey, recovering (userID, labelID, revision,
// sha16). ok is false when the key is not V2BlobKey-shaped.
func ParseV2BlobKey(key string) (userID, labelID string, revision int64, sha16 string, ok bool) {
	if !strings.HasPrefix(key, V2KeyPrefix) || !strings.HasSuffix(key, ".json.gz") {
		return "", "", 0, "", false
	}
	body := strings.TrimSuffix(strings.TrimPrefix(key, V2KeyPrefix), ".json.gz")
	parts := strings.Split(body, "/")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || !strings.HasPrefix(parts[2], "r") {
		return "", "", 0, "", false
	}
	dash := strings.Index(parts[2], "-")
	if dash < 0 {
		return "", "", 0, "", false
	}
	rev, err := strconv.ParseInt(parts[2][1:dash], 10, 64)
	if err != nil || rev < 1 || parts[2][dash+1:] == "" {
		return "", "", 0, "", false
	}
	return parts[0], parts[1], rev, parts[2][dash+1:], true
}

// ParseAnyBlobKey parses either layout, returning (userID, labelID, ok).
func ParseAnyBlobKey(key string) (userID, labelID string, ok bool) {
	userID, labelID, ok = ParseBlobKey(key)
	if ok {
		return userID, labelID, true
	}
	userID, labelID, _, _, ok = ParseV2BlobKey(key)
	return userID, labelID, ok
}
